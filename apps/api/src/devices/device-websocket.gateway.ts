import { HttpAdapterHost } from '@nestjs/core';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import argon2 from 'argon2';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { jobStatusEventSchema } from '@telebirr/contracts';
import { constantTimeEqual, sha256 } from '../common/crypto';
import { stringifyJsonSafe } from '../common/json-serialization';
import { toJsonCompatible } from '../common/json-serialization';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../infra/prisma.service';
import { comparePersonNames } from '../parsers/name-normalizer';
import { SmsIngestionService } from '../sms/sms-ingestion.service';
import { DeviceJobsService, operatorControlledDeviceStatus } from './device-jobs.service';
import { DeviceProfilesService } from './device-profiles.service';
import { EvidenceStoreService } from '../sms/evidence-store.service';
import { encryptEvidence, sanitizeUssdEvidence, ussdDiagnosticLabel } from '../common/evidence-crypto';
import { AlertsService } from '../alerts/alerts.service';
import { deviceMtlsRequired } from '../auth/device-ingress.guard';
import { CURRENT_DEVICE_PROFILE_VERSION } from './device-profile-version';

export const deviceWsHeartbeatSchema = z.object({
  device_id: z.string().uuid(),
  sent_at_ms: z.number().int().positive(),
  agent_version: z.string().max(32),
  app_version: z.string().max(32),
  protocol_version: z.literal('1'),
  android_sdk: z.number().int().min(26),
  android_version: z.string().max(32),
  build_fingerprint: z.string().max(255),
  manufacturer: z.string().max(100),
  model: z.string().max(100),
  battery_percent: z.number().int().min(0).max(100).nullable(),
  charging: z.boolean(),
  temperature_celsius: z.number().min(-20).max(100).nullable(),
  network_type: z.string().max(32),
  accessibility_ok: z.boolean(),
  permissions_ok: z.boolean(),
  openclaw_paired: z.boolean(),
  permissions: z.record(z.string(), z.boolean()),
  ussd_profile_version: z.string().max(500),
  profiles: z.array(z.object({ id: z.string(), version: z.number().int().positive() })),
  sims: z.array(z.object({
    iccid: z.string().regex(/^\d{10,24}$/),
    iccid_hash: z.string().min(8).max(128),
    telebirr_number: z.string(),
    number_suffix: z.string().max(8),
    registered_name: z.string().min(1).max(200),
    slot_index: z.number().int().min(0).max(1),
    subscription_id: z.number().int(),
    state: z.string().max(32),
    customer_e_money_minor: z.number().int().nonnegative().safe().nullable(),
    incentive_minor: z.number().int().nonnegative().safe().nullable(),
    fuel_payment_minor: z.number().int().nonnegative().safe().nullable(),
    pocket_money_minor: z.number().int().nonnegative().safe().nullable(),
    balance_captured_at_ms: z.number().int().positive().nullable(),
    balance_source: z.string().max(32).nullable(),
  })).min(1).max(2),
});

export const deviceSpoolBatchSchema = z.object({
  type: z.literal('spool_batch'),
  device_id: z.string().uuid(),
  events: z.array(z.object({
    id: z.string().uuid(),
    kind: z.string().max(64),
    created_at_ms: z.number().int().positive(),
    payload: z.unknown(),
  })).max(100),
});

const ussdScreenEvidenceSchema = z.object({
  job_id: z.string().uuid(),
  step_id: z.string().min(1).max(128),
  screen: z.string().min(1).max(8_000),
  captured_at_ms: z.number().int().positive(),
});

const smsAttributionFailureSchema = z.object({
  received_at_ms: z.number().int().positive(),
  reason: z.string().min(1).max(120),
  raw_message: z.string().min(1).max(8_000),
});

const smsEvidenceSchema = z.object({
  sender: z.string().min(1).max(32),
  received_at_ms: z.number().int().positive(),
  subscription_id: z.number().int(),
  sim_iccid_hash: z.string().regex(/^[a-f0-9]{64}$/),
  raw_message: z.string().min(1).max(8000),
});
export const profileInstallResultSchema = z.object({
  profile_id: z.string().min(3).max(64).nullable(),
  profile_version: z.number().int().positive().nullable(),
  key_id: z.string().min(1).max(64).nullable(),
  result: z.enum(['installed', 'rejected']),
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(500),
  observed_at_ms: z.number().int().positive(),
  installed_profiles: z.array(z.object({ id: z.string().min(3).max(64), version: z.number().int().positive() })).max(20),
  server_envelope: z.unknown().optional(),
});

const jobAcceptanceSchema = z.object({
  job_id: z.string().uuid().optional(),
  result: z.enum(['accepted', 'duplicate', 'rejected']),
  state: z.string().max(40).optional(),
  code: z.string().max(80).optional(),
});
export const leaseRenewalRequestSchema = z.object({
  type: z.literal('lease_renewal_request'),
  job_id: z.string().min(8).max(128),
  fencing_token: z.number().int().positive().safe(),
});

@Injectable()
export class DeviceWebSocketGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DeviceWebSocketGateway.name);
  private readonly sockets = new Map<string, WebSocket>();
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 });
  private server?: Server;
  private readonly upgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void this.upgrade(request, socket, head);
  };

  constructor(
    @Inject(HttpAdapterHost) private readonly adapter: HttpAdapterHost,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DeviceJobsService) private readonly jobs: DeviceJobsService,
    @Inject(DeviceProfilesService) private readonly profiles: DeviceProfilesService,
    @Inject(SmsIngestionService) private readonly sms: SmsIngestionService,
    @Inject(EvidenceStoreService) private readonly evidence: EvidenceStoreService,
    @Inject(AlertsService) private readonly alerts: AlertsService,
  ) {}

  onApplicationBootstrap(): void {
    this.server = this.adapter.httpAdapter.getHttpServer() as Server;
    this.server.on('upgrade', this.upgradeHandler);
  }

  onApplicationShutdown(): void {
    this.server?.off('upgrade', this.upgradeHandler);
    for (const socket of this.sockets.values()) socket.close(1001, 'server_shutdown');
    this.wss.close();
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://device.local').pathname;
    if (path !== '/v1/device/connect') return;
    try {
      const deviceId = String(request.headers['x-device-id'] ?? '');
      const token = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const protocol = String(request.headers['x-device-protocol'] ?? '');
      const requireMtls = deviceMtlsRequired();
      if (requireMtls) {
        const ingressSecret = String(request.headers['x-device-ingress-secret'] ?? '');
        const expectedIngressSecret = process.env.DEVICE_MTLS_PROXY_SECRET ?? '';
        if (!expectedIngressSecret || !ingressSecret || !constantTimeEqual(ingressSecret, expectedIngressSecret)) throw new Error('untrusted_ingress');
      }
      const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
      if (!device?.authTokenHash || protocol !== '1' || !(await argon2.verify(device.authTokenHash, token))) throw new Error('unauthorized');
      if (device.status === 'quarantined' || device.status === 'retired') throw new Error('device_disabled');
      const fingerprint = String(request.headers['x-client-cert-sha256'] ?? '').toLowerCase();
      if (requireMtls && (request.headers['x-client-cert-verified'] !== 'SUCCESS' || !/^[a-f0-9]{64}$/.test(fingerprint))) {
        throw new Error('mtls_required');
      }
      if (requireMtls && device.certificateFingerprint && (!fingerprint || !constantTimeEqual(fingerprint, device.certificateFingerprint.toLowerCase()))) {
        throw new Error('certificate_mismatch');
      }
      if (requireMtls && !device.certificateFingerprint) {
        await this.prisma.device.updateMany({ where: { id: device.id, certificateFingerprint: null }, data: { certificateFingerprint: fingerprint } });
        const pinned = await this.prisma.device.findUnique({ where: { id: device.id }, select: { certificateFingerprint: true } });
        if (!pinned?.certificateFingerprint || !constantTimeEqual(fingerprint, pinned.certificateFingerprint.toLowerCase())) throw new Error('certificate_mismatch');
      }
      this.wss.handleUpgrade(request, socket, head, (webSocket) => this.connected(deviceId, webSocket, {
        authTokenHash: device.authTokenHash!,
        certificateFingerprint: fingerprint,
      }));
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  }

  private connected(deviceId: string, socket: WebSocket, identity: { authTokenHash: string; certificateFingerprint: string }): void {
    const previous = this.sockets.get(deviceId);
    if (previous && previous !== socket) previous.close(4001, 'replaced');
    this.sockets.set(deviceId, socket);
    let chain = Promise.resolve();
    const authorizationTimer = setInterval(() => {
      void this.connectionAuthorized(deviceId, identity).then((authorized) => {
        if (!authorized && socket.readyState === WebSocket.OPEN) socket.close(4003, 'device_authorization_revoked');
      }).catch(() => {
        if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'authorization_check_failed');
      });
    }, 10_000);
    authorizationTimer.unref();
    socket.on('message', (data, binary) => {
      if (binary) return socket.close(1003, 'text_json_only');
      chain = chain.then(async () => {
        if (!(await this.connectionAuthorized(deviceId, identity))) {
          socket.close(4003, 'device_authorization_revoked');
          return;
        }
        await this.message(deviceId, socket, data.toString());
      }).catch((error) => {
        this.logger.warn(`Device ${deviceId} message rejected: ${(error as Error).message}`);
      });
    });
    socket.on('close', () => {
      clearInterval(authorizationTimer);
      if (this.sockets.get(deviceId) === socket) this.sockets.delete(deviceId);
    });
    socket.on('error', () => undefined);
  }

  private async connectionAuthorized(deviceId: string, identity: { authTokenHash: string; certificateFingerprint: string }): Promise<boolean> {
    const current = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { authTokenHash: true, certificateFingerprint: true, status: true },
    });
    if (!current?.authTokenHash || current.authTokenHash !== identity.authTokenHash || current.status === 'retired') return false;
    if (deviceMtlsRequired() && current.certificateFingerprint) {
      if (!identity.certificateFingerprint) return false;
      if (!constantTimeEqual(current.certificateFingerprint.toLowerCase(), identity.certificateFingerprint.toLowerCase())) return false;
    }
    return true;
  }

  private async message(deviceId: string, socket: WebSocket, raw: string): Promise<void> {
    const message = JSON.parse(raw) as Record<string, unknown>;
    if (message.type === 'hello') {
      if (message.device_id !== deviceId || message.protocol_version !== '1') throw new Error('invalid_hello');
      for (const envelope of this.profiles.allSignedProfiles()) this.send(socket, { type: 'profile_install', envelope });
      return;
    }
    if (message.type === 'heartbeat') {
      const heartbeat = deviceWsHeartbeatSchema.parse(message.payload);
      if (heartbeat.device_id !== deviceId) throw new Error('heartbeat_device_mismatch');
      await this.applyHeartbeat(deviceId, heartbeat);
      const installed = new Set(heartbeat.profiles.map((profile) => `${profile.id}:${profile.version}`));
      const profilesReady = [
        `telebirr.send-money.v1:${CURRENT_DEVICE_PROFILE_VERSION}`,
        `telebirr.merchant-settlement.v1:${CURRENT_DEVICE_PROFILE_VERSION}`,
        `telebirr.automatic-sweep.v1:${CURRENT_DEVICE_PROFILE_VERSION}`,
        `telebirr.emergency-liquidity-move.v1:${CURRENT_DEVICE_PROFILE_VERSION}`,
        `telebirr.balance-query.v1:${CURRENT_DEVICE_PROFILE_VERSION}`,
      ].every((profile) => installed.has(profile));
      if (profilesReady) await this.sendLeaseOrJob(deviceId, socket);
      else for (const envelope of this.profiles.allSignedProfiles()) this.send(socket, { type: 'profile_install', envelope });
      return;
    }
    if (message.type === 'spool_batch') {
      const batch = deviceSpoolBatchSchema.parse(message);
      if (batch.device_id !== deviceId) throw new Error('spool_device_mismatch');
      const acknowledged: string[] = [];
      for (const event of batch.events) {
        try {
          await this.processSpoolEvent(deviceId, event);
          acknowledged.push(event.id);
        } catch (error) {
          this.logger.warn(`Spool event ${event.id} deferred: ${(error as Error).message}`);
          // ACK only the successfully processed prefix. Later events can be
          // causally dependent (DEVICE_STARTED -> PIN_SUBMITTED -> SMS), so
          // accepting past a transient failure could strand settlement
          // evidence or reorder a financial boundary permanently.
          break;
        }
      }
      this.send(socket, { type: 'spool_ack', event_ids: acknowledged });
      await this.sendLeaseOrJob(deviceId, socket);
      return;
    }
    if (message.type === 'lease_renewal_request') {
      const renewalRequest = leaseRenewalRequestSchema.parse(message);
      const renewal = await this.jobs.renewActiveForConnection(deviceId, renewalRequest.job_id, renewalRequest.fencing_token);
      if (renewal) this.send(socket, { type: 'lease_renewal', envelope: renewal });
    }
  }

  private async sendLeaseOrJob(deviceId: string, socket: WebSocket): Promise<void> {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId }, select: { activeUssdJobId: true, status: true } });
    if (!device || device.status !== 'online' || device.activeUssdJobId) return;
    const job = await this.jobs.leaseNext(deviceId);
    if (job) this.send(socket, { type: 'job', envelope: job });
  }

  private async processSpoolEvent(
    deviceId: string,
    event: z.infer<typeof deviceSpoolBatchSchema>['events'][number],
  ): Promise<void> {
    if (event.kind === 'JOB_STATUS') {
      const payload = jobStatusEventSchema.parse(event.payload);
      await this.jobs.reportFromSpool(deviceId, payload, event.id);
      await this.prisma.$transaction(async (transaction) => {
        const inbox = await transaction.inboxEvent.createMany({
          data: [{ source: 'device_response_audit', externalId: event.id, payloadHash: sha256(stringifyJsonSafe(payload)) }],
          skipDuplicates: true,
        });
        if (inbox.count === 0) return;
        await transaction.auditLog.create({
          data: {
            actorType: 'device_agent', actorId: deviceId, action: 'device.job_status_response',
            targetType: 'device_job', targetId: payload.job_id,
            metadata: { event_id: event.id, api_response: toJsonCompatible(payload) as Prisma.InputJsonValue },
          },
        });
      });
      return;
    }
    if (event.kind === 'JOB_ACCEPTANCE') {
      const payload = jobAcceptanceSchema.parse(event.payload);
      await this.prisma.$transaction(async (transaction) => {
        const inbox = await transaction.inboxEvent.createMany({
          data: [{ source: 'device_response_audit', externalId: event.id, payloadHash: sha256(stringifyJsonSafe(payload)) }],
          skipDuplicates: true,
        });
        if (inbox.count === 0) return;
        await transaction.auditLog.create({
          data: {
            actorType: 'device_agent', actorId: deviceId, action: 'device.job_acceptance_response',
            targetType: payload.job_id ? 'device_job' : 'device', targetId: payload.job_id ?? deviceId,
            metadata: { event_id: event.id, api_response: toJsonCompatible(payload) as Prisma.InputJsonValue },
          },
        });
      });
      return;
    }
    if (event.kind === 'PROFILE_INSTALL_RESULT') {
      const payload = profileInstallResultSchema.parse(event.payload);
      const now = new Date();
      const observedAt = payload.observed_at_ms > now.valueOf() + 60_000 ? now : new Date(payload.observed_at_ms);
      const metadata = {
        event_id: event.id,
        observed_at: observedAt.toISOString(),
        api_response: toJsonCompatible(payload) as Prisma.InputJsonValue,
      };
      await this.prisma.$transaction(async (transaction) => {
        const inbox = await transaction.inboxEvent.createMany({
          data: [{ source: 'profile_install_result', externalId: event.id, payloadHash: sha256(stringifyJsonSafe(payload)) }],
          skipDuplicates: true,
        });
        if (inbox.count === 0) return;
        await transaction.device.update({
          where: { id: deviceId },
          data: { lastProfileInstallResult: toJsonCompatible(payload) as Prisma.InputJsonValue },
        });
        await transaction.auditLog.create({
          data: {
            actorType: 'device_agent', actorId: deviceId,
            action: payload.result === 'installed' ? 'device.profile_installed' : 'device.profile_rejected',
            targetType: 'device', targetId: deviceId,
            reason: payload.message,
            metadata,
          },
        });
      });
      return;
    }
    if (event.kind === 'SMS_EVIDENCE') {
      const evidence = smsEvidenceSchema.parse(event.payload);
      const sim = await this.prisma.simWallet.findUnique({ where: { iccidHash: evidence.sim_iccid_hash } });
      if (!sim || sim.deviceId !== deviceId) throw new Error('sms_sim_mismatch');
      await this.sms.ingest(deviceId, {
        event_id: event.id,
        received_at: new Date(evidence.received_at_ms).toISOString(),
        sender: evidence.sender,
        subscription_id: evidence.subscription_id,
        sim_iccid: sim.iccid,
        body: evidence.raw_message,
      });
      return;
    }
    if (event.kind === 'SMS_ATTRIBUTION_FAILURE') {
      const payload = smsAttributionFailureSchema.parse(event.payload);
      const now = new Date();
      const reportedAt = new Date(payload.received_at_ms);
      const futureClock = payload.received_at_ms > now.valueOf() + 60_000;
      const receivedAt = futureClock ? now : reportedAt;
      const inserted = await this.prisma.$transaction(async (transaction) => {
        const evidence = await transaction.unattributedSmsEvidence.createMany({
          data: [{
            eventId: event.id,
            deviceId,
            encryptedBody: encryptEvidence(payload.raw_message),
            bodyHash: sha256(payload.raw_message),
            reason: payload.reason,
            receivedAt,
          }],
          skipDuplicates: true,
        });
        if (evidence.count !== 1) return false;
        await transaction.inboxEvent.upsert({
          where: { source_externalId: { source: 'sms_attribution_failure', externalId: event.id } },
          update: {},
          create: { source: 'sms_attribution_failure', externalId: event.id, payloadHash: sha256(JSON.stringify(payload)) },
        });
        await transaction.reconciliationCase.create({
          data: {
            type: 'sms_attribution_failure',
            referenceType: 'unattributed_sms',
            referenceId: event.id,
            evidence: { reason: payload.reason, received_at: receivedAt.toISOString(), device_id: deviceId, future_clock: futureClock },
          },
        });
        // Attribution uncertainty means the handset cannot prove which SIM
        // received a financial message. Quarantine both enrolled SIMs until a
        // platform operator verifies subscription/ICCID mapping.
        await transaction.device.update({ where: { id: deviceId }, data: { status: 'quarantined' } });
        await transaction.simWallet.updateMany({ where: { deviceId }, data: { status: 'quarantined' } });
        return true;
      });
      if (inserted) {
        void this.evidence.persistUnattributedSmsByEvent(event.id);
        await this.alerts.notify('reconciliation_drift', 'A device could not attribute a Telebirr SMS to a SIM and was quarantined', {
          device_id: deviceId,
          reason: payload.reason,
          future_clock: futureClock,
        });
      }
      return;
    }
    if (event.kind === 'USSD_SCREEN_EVIDENCE') {
      const payload = ussdScreenEvidenceSchema.parse(event.payload);
      const screen = sanitizeUssdEvidence(payload.screen);
      const now = new Date();
      const futureClock = payload.captured_at_ms > now.valueOf() + 60_000;
      const capturedAt = futureClock ? now : new Date(payload.captured_at_ms);
      await this.prisma.$transaction(async (transaction) => {
        const job = await transaction.deviceJob.findFirst({ where: { id: payload.job_id, deviceId } });
        if (!job) throw new Error('ussd_evidence_job_mismatch');
        await transaction.ussdEvidence.upsert({
          where: { eventId: event.id },
          update: {},
          create: {
            eventId: event.id,
            deviceId,
            deviceJobId: job.id,
            stepId: payload.step_id,
            encryptedScreen: encryptEvidence(screen),
            screenHash: sha256(screen),
            capturedAt,
          },
        });
        if (futureClock) {
          await transaction.device.update({ where: { id: deviceId }, data: { status: 'quarantined' } });
          await transaction.simWallet.update({ where: { id: job.simWalletId }, data: { status: 'quarantined' } });
        }
        const latest = await transaction.ussdEvidence.findFirst({ where: { deviceJobId: job.id }, orderBy: { capturedAt: 'desc' } });
        if (latest?.eventId === event.id) await transaction.deviceJob.update({ where: { id: job.id }, data: { lastScreenText: ussdDiagnosticLabel(screen) } });
      });
      void this.evidence.persistUssdByEvent(event.id);
      if (futureClock) {
        await this.alerts.notify('reconciliation_drift', 'A device reported a future USSD evidence timestamp and was quarantined', {
          device_id: deviceId,
          job_id: payload.job_id,
        });
      }
      return;
    }
    throw new Error(`unsupported_spool_event_kind:${event.kind}`);
  }

  private async applyHeartbeat(deviceId: string, heartbeat: z.infer<typeof deviceWsHeartbeatSchema>): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const currentDevice = await transaction.device.findUnique({ where: { id: deviceId }, select: { status: true } });
      if (!currentDevice || currentDevice.status === 'retired') throw new Error('device_disabled');
      const enrolled = await transaction.simWallet.findMany({ where: { deviceId } });
      // Quarantine is an operator/security state. A heartbeat may add new
      // reasons to quarantine, but it can never promote a quarantined handset.
      let quarantine = currentDevice.status === 'quarantined' || enrolled.length !== heartbeat.sims.length || heartbeat.sent_at_ms > Date.now() + 60_000;
      for (const reported of heartbeat.sims) {
        const sim = enrolled.find((candidate) => candidate.iccidHash === reported.iccid_hash);
        if (
          !sim ||
          sim.iccid !== reported.iccid ||
          sim.slot !== reported.slot_index ||
          sim.phoneNumber !== reported.telebirr_number ||
          comparePersonNames(sim.telebirrAccountName, reported.registered_name).decision !== 'match'
        ) {
          quarantine = true;
          if (sim) await transaction.simWallet.update({ where: { id: sim.id }, data: { status: 'quarantined' } });
          continue;
        }
        if (reported.state.toLocaleLowerCase('en-US') === 'quarantined') quarantine = true;
        await transaction.simWallet.update({
          where: { id: sim.id },
          data: {
            subscriptionId: reported.subscription_id,
            ...(reported.state.toLocaleLowerCase('en-US') === 'quarantined' ? { status: 'quarantined' } : {}),
          },
        });
      }
      const permissionsOk = heartbeat.permissions_ok && Object.values(heartbeat.permissions).every(Boolean);
      await transaction.device.update({
        where: { id: deviceId },
        data: {
          status: operatorControlledDeviceStatus({ quarantine, operatorOnline: currentDevice.status === 'online' }),
          lastHeartbeatAt: new Date(),
          lastPermissionsOk: permissionsOk,
          lastAccessibilityOk: heartbeat.accessibility_ok,
          openclawPaired: heartbeat.openclaw_paired,
          agentVersion: heartbeat.agent_version,
          ussdProfileVersion: heartbeat.ussd_profile_version,
          buildFingerprint: heartbeat.build_fingerprint,
          batteryPercent: heartbeat.battery_percent,
          charging: heartbeat.charging,
          temperatureCelsius: heartbeat.temperature_celsius,
          networkType: heartbeat.network_type,
          lastHeartbeatPayload: toJsonCompatible(heartbeat) as Prisma.InputJsonValue,
        },
      });
    });
  }

  private send(socket: WebSocket, value: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(stringifyJsonSafe(value));
  }
}
