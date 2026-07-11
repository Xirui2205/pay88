import { HttpStatus, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma, RuntimeEnvironment } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { ApiException } from '../common/api-exception';
import { hmacHex, sha256 } from '../common/crypto';
import { stringifyJsonSafe } from '../common/json-serialization';
import type { MerchantAuthContext } from '../auth/auth.types';
import { MessageBusService } from '../infra/message-bus.service';
import { PrismaService } from '../infra/prisma.service';
import { WebhookSecretService } from './webhook-secret.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { AlertsService } from '../alerts/alerts.service';
import { WebhookHttpClientService } from './webhook-http-client.service';
import { WebhookUrlPolicyService } from './webhook-url-policy.service';

type WebhookDeliveryRecord = Prisma.WebhookDeliveryGetPayload<{ include: { endpoint: true; outboxEvent: true } }>;

interface ClaimedWebhookDelivery {
  delivery: WebhookDeliveryRecord;
  leaseToken: string;
}

const DELIVERY_LEASE_MS = 30_000;

@Injectable()
export class WebhooksService {
  private processing = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: WebhookSecretService,
    private readonly bus: MessageBusService,
    private readonly idempotency: IdempotencyService,
    private readonly alerts: AlertsService,
    private readonly urlPolicy: WebhookUrlPolicyService,
    private readonly httpClient: WebhookHttpClientService,
  ) {}

  async register(auth: MerchantAuthContext, url: string, idempotencyKey: string) {
    // Do not make an exact idempotent replay depend on current DNS availability.
    // A changed payload is still rejected by the locked idempotency transaction.
    const prior = await this.prisma.idempotencyRecord.findFirst({
      where: {
        merchantId: auth.merchantId,
        environment: auth.environment,
        operation: 'webhooks.register',
        key: { in: [idempotencyKey, `__reference__:${sha256(url)}`] },
      },
      select: { id: true },
    });
    if (!prior) {
      // Resolve at registration to reject obvious SSRF targets before persisting.
      // Delivery resolves again and pins the actual connection, which handles DNS
      // changes without trusting a historical result.
      await this.urlPolicy.resolve(url);
    }
    return (
      await this.idempotency.execute<{ id: string; url: string; enabled: boolean; secret: string; created_at: string }>({
        auth,
        operation: 'webhooks.register',
        key: idempotencyKey,
        referenceKey: sha256(url),
        payload: { url },
        storeResult: (result: { id: string; url: string; enabled: boolean; secret: string; created_at: string }) => ({ endpoint_id: result.id }),
        replayResult: async (stored, transaction) => {
          const endpointId = String((stored as { endpoint_id?: unknown }).endpoint_id ?? '');
          const endpoint = await transaction.webhookEndpoint.findFirst({
            where: { id: endpointId, merchantId: auth.merchantId, environment: auth.environment },
          });
          if (!endpoint) throw new ApiException('invalid_state', 'The idempotent webhook endpoint no longer exists', HttpStatus.CONFLICT);
          return {
            id: endpoint.id,
            url: endpoint.url,
            enabled: endpoint.enabled,
            secret: this.secrets.decrypt(endpoint.encryptedSecret),
            created_at: endpoint.createdAt.toISOString(),
          };
        },
        execute: async (transaction) => {
          const secret = `whsec_${randomBytes(32).toString('base64url')}`;
          const endpoint = await transaction.webhookEndpoint.create({
            data: {
              merchantId: auth.merchantId,
              environment: auth.environment,
              url,
              secretHash: sha256(secret),
              encryptedSecret: this.secrets.encrypt(secret),
            },
          });
          return { id: endpoint.id, url: endpoint.url, enabled: endpoint.enabled, secret, created_at: endpoint.createdAt.toISOString() };
        },
      })
    ).result;
  }

  async list(auth: MerchantAuthContext) {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { merchantId: auth.merchantId, environment: auth.environment },
      orderBy: { createdAt: 'desc' },
    });
    return endpoints.map((endpoint) => ({ id: endpoint.id, url: endpoint.url, enabled: endpoint.enabled, created_at: endpoint.createdAt.toISOString() }));
  }

  async setEnabled(auth: MerchantAuthContext, endpointId: string, enabled: boolean) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`webhook-endpoint:${endpointId}`}))`;
      const endpoint = await transaction.webhookEndpoint.findFirst({ where: { id: endpointId, merchantId: auth.merchantId, environment: auth.environment } });
      if (!endpoint) throw new ApiException('not_found', 'Webhook endpoint was not found', HttpStatus.NOT_FOUND);
      const updated = await transaction.webhookEndpoint.update({ where: { id: endpoint.id }, data: { enabled } });
      if (!enabled) {
        await transaction.webhookDelivery.updateMany({
          where: { endpointId: endpoint.id, status: { in: ['pending', 'processing'] } },
          data: { status: 'dead', leaseToken: null, leaseExpiresAt: null, responseBody: 'Endpoint disabled by merchant' },
        });
      }
      await transaction.auditLog.create({ data: { merchantId: auth.merchantId, actorType: auth.apiKeyId.startsWith('portal:') ? 'merchant_user' : 'merchant_api_key', actorId: auth.apiKeyId.replace(/^portal:/, ''), action: enabled ? 'webhook.enabled' : 'webhook.disabled', targetType: 'webhook_endpoint', targetId: endpoint.id } });
      return { id: updated.id, url: updated.url, enabled: updated.enabled, updated_at: updated.updatedAt.toISOString() };
    }, { isolationLevel: 'Serializable' });
  }

  async rotateSecret(auth: MerchantAuthContext, endpointId: string, idempotencyKey: string) {
    return (
      await this.idempotency.execute<{ id: string; secret: string; rotated_at: string }>({
        auth,
        operation: 'webhooks.rotate_secret',
        key: idempotencyKey,
        payload: { endpointId },
        // An idempotent replay must return the exact one-time secret generated
        // by the original attempt. Keep only its application-encrypted form in
        // the idempotency record, never the plaintext signing secret.
        storeResult: (result) => ({
          endpoint_id: result.id,
          encrypted_secret: this.secrets.encrypt(result.secret),
          rotated_at: result.rotated_at,
        }),
        replayResult: async (stored, transaction) => {
          const value = stored as { endpoint_id?: unknown; encrypted_secret?: unknown; rotated_at?: unknown };
          const endpointIdFromResult = String(value.endpoint_id ?? '');
          const endpoint = await transaction.webhookEndpoint.findFirst({
            where: { id: endpointIdFromResult, merchantId: auth.merchantId, environment: auth.environment },
          });
          if (!endpoint || typeof value.encrypted_secret !== 'string') {
            throw new ApiException('invalid_state', 'The idempotent webhook rotation result is no longer available', HttpStatus.CONFLICT);
          }
          return {
            id: endpoint.id,
            secret: this.secrets.decrypt(value.encrypted_secret),
            rotated_at: String(value.rotated_at ?? endpoint.updatedAt.toISOString()),
          };
        },
        execute: async (transaction) => {
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`webhook-endpoint:${endpointId}`}))`;
          const endpoint = await transaction.webhookEndpoint.findFirst({
            where: { id: endpointId, merchantId: auth.merchantId, environment: auth.environment },
          });
          if (!endpoint) throw new ApiException('not_found', 'Webhook endpoint was not found', HttpStatus.NOT_FOUND);
          const secret = `whsec_${randomBytes(32).toString('base64url')}`;
          const rotatedAt = new Date();
          await transaction.webhookEndpoint.update({
            where: { id: endpoint.id },
            data: { secretHash: sha256(secret), encryptedSecret: this.secrets.encrypt(secret) },
          });
          await transaction.webhookDelivery.updateMany({
            where: { endpointId: endpoint.id, status: 'processing' },
            data: { status: 'pending', leaseToken: null, leaseExpiresAt: null, nextAttemptAt: rotatedAt },
          });
          await transaction.auditLog.create({
            data: {
              merchantId: auth.merchantId,
              actorType: auth.apiKeyId.startsWith('portal:') ? 'merchant_user' : 'merchant_api_key',
              actorId: auth.apiKeyId.replace(/^portal:/, ''),
              action: 'webhook.secret_rotated',
              targetType: 'webhook_endpoint',
              targetId: endpoint.id,
            },
          });
          return { id: endpoint.id, secret, rotated_at: rotatedAt.toISOString() };
        },
      })
    ).result;
  }

  async replay(auth: MerchantAuthContext, deliveryId: string, idempotencyKey: string) {
    return (
      await this.idempotency.execute({
        auth,
        operation: 'webhooks.replay',
        key: idempotencyKey,
        referenceKey: deliveryId,
        payload: { deliveryId },
        execute: async (transaction) => {
          const delivery = await transaction.webhookDelivery.findFirst({
            where: { id: deliveryId, endpoint: { merchantId: auth.merchantId, environment: auth.environment } },
          });
          if (!delivery) throw new ApiException('not_found', 'Webhook delivery was not found', HttpStatus.NOT_FOUND);
          const now = new Date();
          const reset = await transaction.webhookDelivery.updateMany({
            where: {
              id: delivery.id,
              OR: [
                { status: { not: 'processing' } },
                { leaseExpiresAt: null },
                { leaseExpiresAt: { lte: now } },
              ],
            },
            data: {
              status: 'pending',
              nextAttemptAt: now,
              leaseToken: null,
              leaseExpiresAt: null,
              deliveredAt: null,
              responseCode: null,
              responseBody: null,
            },
          });
          if (reset.count !== 1) {
            throw new ApiException('invalid_state', 'Webhook delivery is already in progress', HttpStatus.CONFLICT);
          }
          return { accepted: true };
        },
      })
    ).result;
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.expandOutbox();
      await this.deliverPending();
      const backlog = await this.prisma.webhookDelivery.count({ where: { status: 'pending' } });
      const threshold = Number(process.env.WEBHOOK_BACKLOG_ALERT_THRESHOLD ?? 100);
      if (backlog > threshold) {
        await this.alerts.notify('webhook_backlog', 'Webhook delivery backlog exceeded the configured threshold', { backlog, threshold });
      }
    } finally {
      this.processing = false;
    }
  }

  private async expandOutbox(): Promise<void> {
    const events = await this.prisma.outboxEvent.findMany({ where: { publishedAt: null }, orderBy: { createdAt: 'asc' }, take: 100 });
    for (const event of events) {
      const owner = await this.aggregateOwner(event.aggregateType, event.aggregateId);
      if (!owner) {
        await this.prisma.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } });
        continue;
      }
      await this.prisma.$transaction(async (transaction) => {
        const endpoints = await transaction.webhookEndpoint.findMany({
          where: { merchantId: owner.merchantId, environment: owner.environment, enabled: true },
        });
        for (const endpoint of endpoints) {
          await transaction.webhookDelivery.upsert({
            where: { outboxEventId_endpointId: { outboxEventId: event.id, endpointId: endpoint.id } },
            update: {},
            create: { outboxEventId: event.id, endpointId: endpoint.id },
          });
        }
      });
      await this.bus.publish(event.eventType, { id: event.id, aggregate_id: event.aggregateId });
      await this.prisma.outboxEvent.updateMany({ where: { id: event.id, publishedAt: null }, data: { publishedAt: new Date() } });
    }
  }

  private async aggregateOwner(type: string, id: string): Promise<{ merchantId: string; environment: RuntimeEnvironment } | null> {
    if (type === 'deposit') {
      const deposit = await this.prisma.depositIntent.findUnique({ where: { id }, select: { merchantId: true, environment: true } });
      return deposit;
    }
    if (type === 'transfer') {
      const transfer = await this.prisma.transfer.findUnique({ where: { id }, select: { merchantId: true, environment: true } });
      return transfer;
    }
    if (type === 'settlement') {
      const settlement = await this.prisma.settlementRequest.findUnique({ where: { id }, select: { merchantId: true, environment: true } });
      return settlement;
    }
    if (type === 'sweep_execution') {
      const execution = await this.prisma.sweepExecution.findUnique({
        where: { id },
        select: { rule: { select: { merchantId: true, environment: true } } },
      });
      return execution?.rule ?? null;
    }
    return null;
  }

  private async deliverPending(): Promise<void> {
    const now = new Date();
    const candidates = await this.prisma.webhookDelivery.findMany({
      where: {
        endpoint: { enabled: true },
        OR: [
          { status: 'pending', nextAttemptAt: { lte: now } },
          { status: 'processing', OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
        ],
      },
      select: { id: true },
      orderBy: { nextAttemptAt: 'asc' },
      take: 100,
    });

    const claims: ClaimedWebhookDelivery[] = [];
    for (const candidate of candidates) {
      if (claims.length >= 50) break;
      const claim = await this.claimDelivery(candidate.id, now);
      if (claim) claims.push(claim);
    }
    await Promise.all(claims.map((claim) => this.deliver(claim)));
  }

  private async claimDelivery(id: string, now = new Date()): Promise<ClaimedWebhookDelivery | null> {
    const leaseToken = randomBytes(24).toString('hex');
    const leaseExpiresAt = new Date(now.valueOf() + DELIVERY_LEASE_MS);
    const claimed = await this.prisma.webhookDelivery.updateMany({
      where: {
        id,
        endpoint: { enabled: true },
        OR: [
          { status: 'pending', nextAttemptAt: { lte: now } },
          { status: 'processing', OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
        ],
      },
      data: { status: 'processing', leaseToken, leaseExpiresAt },
    });
    if (claimed.count !== 1) return null;

    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id },
      include: { endpoint: true, outboxEvent: true },
    });
    return delivery ? { delivery, leaseToken } : null;
  }

  private async finishClaim(
    id: string,
    leaseToken: string,
    data: Prisma.WebhookDeliveryUpdateManyMutationInput,
  ): Promise<boolean> {
    const result = await this.prisma.webhookDelivery.updateMany({
      where: { id, status: 'processing', leaseToken },
      data: { ...data, leaseToken: null, leaseExpiresAt: null },
    });
    return result.count === 1;
  }

  private async deliver(claim: ClaimedWebhookDelivery): Promise<void> {
    const { delivery, leaseToken } = claim;
    const owner = await this.aggregateOwner(delivery.outboxEvent.aggregateType, delivery.outboxEvent.aggregateId);
    if (!owner) {
      await this.finishClaim(delivery.id, leaseToken, {
        status: 'dead',
        attempt: { increment: 1 },
        responseBody: 'Webhook aggregate no longer exists',
      });
      return;
    }
    const currentEndpoint = await this.prisma.webhookEndpoint.findUnique({ where: { id: delivery.endpointId } });
    if (!currentEndpoint?.enabled) {
      await this.finishClaim(delivery.id, leaseToken, { status: 'dead', responseBody: 'Endpoint disabled before delivery' });
      return;
    }
    const payloadRecord = delivery.outboxEvent.payload as Record<string, unknown>;
    const body = stringifyJsonSafe({
      event_id: delivery.outboxEvent.id,
      schema_version: '1.0',
      event_type: delivery.outboxEvent.eventType,
      attempt: delivery.attempt + 1,
      created_at: delivery.outboxEvent.createdAt.toISOString(),
      merchant_id: owner.merchantId,
      environment: owner.environment,
      reference: String(payloadRecord.tx_ref ?? payloadRecord.reference ?? delivery.outboxEvent.aggregateId),
      status: payloadRecord.status ?? 'pending',
      p2p_status: payloadRecord.p2p_status ?? 'manual_review',
      data: payloadRecord,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const secret = this.secrets.decrypt(currentEndpoint.encryptedSecret);
    const signature = hmacHex(secret, `${timestamp}.${body}`);
    let responseCode: number | undefined;
    let responseBody: string | undefined;
    try {
      // Resolve on every attempt and connect to the validated address directly.
      // The original hostname remains the TLS SNI and Host header, preventing a
      // DNS rebinding between validation and socket creation. The low-level
      // client intentionally has no redirect-following behavior.
      const target = await this.urlPolicy.resolve(delivery.endpoint.url);
      const renewed = await this.prisma.webhookDelivery.updateMany({
        where: { id: delivery.id, status: 'processing', leaseToken },
        data: { leaseExpiresAt: new Date(Date.now() + DELIVERY_LEASE_MS) },
      });
      if (renewed.count !== 1) return;
      const response = await this.httpClient.post(
        target,
        {
          'content-type': 'application/json',
          'x-p2p-timestamp': timestamp,
          'x-p2p-signature': `v1=${signature}`,
          'user-agent': 'Telebirr-P2P-Webhook/1.0',
        },
        body,
      );
      responseCode = response.status;
      responseBody = response.body;
      if (response.ok) {
        await this.finishClaim(delivery.id, leaseToken, {
          status: 'delivered',
          attempt: { increment: 1 },
          responseCode,
          responseBody,
          deliveredAt: new Date(),
        });
        return;
      }
    } catch (error) {
      responseBody = (error as Error).message.slice(0, 2000);
    }
    const attempt = delivery.attempt + 1;
    const ageMs = Date.now() - delivery.createdAt.valueOf();
    const exhausted = ageMs >= 24 * 60 * 60 * 1000;
    await this.finishClaim(delivery.id, leaseToken, {
      status: exhausted ? 'dead' : 'pending',
      attempt,
      responseCode,
      responseBody,
      nextAttemptAt: new Date(Date.now() + Math.min(60 * 60_000, 2 ** Math.min(attempt, 10) * 1000)),
    });
  }

}
