import { HttpStatus, Injectable } from '@nestjs/common';
import type { MerchantUserRole, RuntimeEnvironment } from '@prisma/client';
import { minorToAmount } from '@telebirr/contracts';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type { PortalAuthContext } from '../auth/auth.types';
import { ApiException } from '../common/api-exception';
import { sha256 } from '../common/crypto';
import { PrismaService } from '../infra/prisma.service';
import { CacheService } from '../infra/cache.service';
import { LEDGER_CODES } from '../ledger/ledger.service';

const SESSION_HOURS = 12;

function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function maskPhone(phone: string): string {
  return phone.length < 7 ? '***' : `${phone.slice(0, 4)}••••${phone.slice(-3)}`;
}

function requireManagement(auth: PortalAuthContext): void {
  if (auth.role === 'support') {
    throw new ApiException('forbidden', 'Owner or administrator access is required', HttpStatus.FORBIDDEN);
  }
}

@Injectable()
export class PortalService {
  constructor(private readonly prisma: PrismaService, private readonly cache: CacheService) {}

  async login(input: { email: string; password: string; merchantSlug?: string }, requestInfo: { ip?: string; userAgent?: string }) {
    const email = normalizeEmail(input.email);
    const throttleKey = `auth:merchant:${sha256(`${requestInfo.ip ?? 'unknown'}:${email}`).slice(0, 32)}`;
    if (await this.cache.increment(throttleKey, 600) > 8) {
      throw new ApiException('too_many_attempts', 'Too many sign-in attempts. Try again later', HttpStatus.TOO_MANY_REQUESTS);
    }
    const users = await this.prisma.merchantUser.findMany({
      where: {
        email,
        status: 'active',
        merchant: { status: 'active', ...(input.merchantSlug ? { slug: input.merchantSlug } : {}) },
      },
      include: { merchant: true },
      take: 2,
    });
    const user = users.length === 1 ? users[0] : null;
    if (!user || !(await argon2.verify(user.passwordHash, input.password))) {
      throw new ApiException('invalid_credentials', 'Email, password, or merchant is invalid', HttpStatus.UNAUTHORIZED);
    }
    const token = `mps_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60_000);
    const session = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.merchantSession.create({
        data: {
          userId: user.id,
          tokenHash: sha256(token),
          expiresAt,
          ipAddress: requestInfo.ip?.slice(0, 64),
          userAgent: requestInfo.userAgent?.slice(0, 500),
        },
      });
      await transaction.merchantUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await transaction.auditLog.create({
        data: { merchantId: user.merchantId, actorType: 'merchant_user', actorId: user.id, action: 'portal.login', targetType: 'merchant_session', targetId: created.id },
      });
      return created;
    });
    await this.cache.delete(throttleKey);
    return {
      session_token: token,
      expires_at: session.expiresAt.toISOString(),
      user: { id: user.id, email: user.email, display_name: user.displayName, role: user.role },
      merchant: { id: user.merchant.id, slug: user.merchant.slug, name: user.merchant.name },
    };
  }

  async logout(auth: PortalAuthContext) {
    await this.prisma.merchantSession.updateMany({ where: { id: auth.sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    return { logged_out: true };
  }

  me(auth: PortalAuthContext) {
    return {
      user: { id: auth.userId, email: auth.email, display_name: auth.displayName, role: auth.role },
      merchant: { id: auth.merchantId, slug: auth.merchantSlug, name: auth.merchantName },
    };
  }

  async invite(auth: PortalAuthContext, input: { email: string; role: MerchantUserRole }) {
    requireManagement(auth);
    if (input.role === 'owner' && auth.role !== 'owner') {
      throw new ApiException('forbidden', 'Only an owner can invite another owner', HttpStatus.FORBIDDEN);
    }
    const email = normalizeEmail(input.email);
    const existing = await this.prisma.merchantUser.findUnique({ where: { merchantId_email: { merchantId: auth.merchantId, email } } });
    if (existing) throw new ApiException('user_exists', 'A merchant user with this email already exists', HttpStatus.CONFLICT);
    const token = `mi_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + 72 * 60 * 60_000);
    const invitation = await this.prisma.$transaction(async (transaction) => {
      await transaction.merchantInvitation.updateMany({
        where: { merchantId: auth.merchantId, email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const created = await transaction.merchantInvitation.create({
        data: { merchantId: auth.merchantId, email, role: input.role, tokenHash: sha256(token), invitedById: auth.userId, expiresAt },
      });
      await transaction.auditLog.create({
        data: { merchantId: auth.merchantId, actorType: 'merchant_user', actorId: auth.userId, action: 'portal.user_invited', targetType: 'merchant_invitation', targetId: created.id, metadata: { email, role: input.role } },
      });
      return created;
    });
    return { id: invitation.id, email, role: input.role, invitation_token: token, expires_at: expiresAt.toISOString() };
  }

  async acceptInvitation(input: { token: string; displayName: string; password: string }, requestInfo: { ip?: string; userAgent?: string }) {
    const invitation = await this.prisma.merchantInvitation.findUnique({
      where: { tokenHash: sha256(input.token) },
      include: { merchant: true },
    });
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date() || invitation.merchant.status !== 'active') {
      throw new ApiException('invalid_invitation', 'The invitation is invalid or expired', HttpStatus.GONE);
    }
    const passwordHash = await argon2.hash(input.password);
    const sessionToken = `mps_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60_000);
    const result = await this.prisma.$transaction(async (transaction) => {
      const claim = await transaction.merchantInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date() },
      });
      if (claim.count !== 1) throw new ApiException('invalid_invitation', 'The invitation was already used', HttpStatus.CONFLICT);
      const user = await transaction.merchantUser.create({
        data: { merchantId: invitation.merchantId, email: invitation.email, displayName: input.displayName.trim(), passwordHash, role: invitation.role },
      });
      const session = await transaction.merchantSession.create({
        data: { userId: user.id, tokenHash: sha256(sessionToken), expiresAt, ipAddress: requestInfo.ip?.slice(0, 64), userAgent: requestInfo.userAgent?.slice(0, 500) },
      });
      await transaction.auditLog.create({
        data: { merchantId: invitation.merchantId, actorType: 'merchant_user', actorId: user.id, action: 'portal.invitation_accepted', targetType: 'merchant_user', targetId: user.id },
      });
      return { user, session };
    });
    return {
      session_token: sessionToken,
      expires_at: result.session.expiresAt.toISOString(),
      user: { id: result.user.id, email: result.user.email, display_name: result.user.displayName, role: result.user.role },
      merchant: { id: invitation.merchant.id, slug: invitation.merchant.slug, name: invitation.merchant.name },
    };
  }

  async users(auth: PortalAuthContext) {
    requireManagement(auth);
    const [users, invitations] = await Promise.all([
      this.prisma.merchantUser.findMany({ where: { merchantId: auth.merchantId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.merchantInvitation.findMany({ where: { merchantId: auth.merchantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } }),
    ]);
    return {
      users: users.map((user) => ({ id: user.id, email: user.email, display_name: user.displayName, role: user.role, status: user.status, last_login_at: user.lastLoginAt?.toISOString() ?? null })),
      pending_invitations: invitations.map((item) => ({ id: item.id, email: item.email, role: item.role, expires_at: item.expiresAt.toISOString() })),
    };
  }

  async summary(auth: PortalAuthContext, environment: RuntimeEnvironment) {
    const [accounts, openTransfers, openDeposits, physical] = await Promise.all([
      this.prisma.ledgerAccount.findMany({ where: { merchantId: auth.merchantId, environment, code: { in: [LEDGER_CODES.available, LEDGER_CODES.reserved] } } }),
      this.prisma.transfer.aggregate({ where: { merchantId: auth.merchantId, environment, status: { in: ['accepted', 'queued', 'device_assigned', 'device_started', 'committed', 'provider_pending', 'unknown', 'manual_review'] } }, _count: true, _sum: { amountMinor: true } }),
      this.prisma.depositIntent.count({ where: { merchantId: auth.merchantId, environment, status: { in: ['awaiting_payment', 'late_grace', 'matching', 'manual_review'] } } }),
      this.prisma.simWallet.aggregate({
        where: {
          status: 'active',
          device: {
            status: { in: ['online', 'degraded'] },
            lastHeartbeatAt: { gt: new Date(Date.now() - 90_000) },
            hardwareSerial: environment === 'live' ? { not: 'VIRTUAL-TEST-DEVICE' } : 'VIRTUAL-TEST-DEVICE',
            group: {
              ...(environment === 'live' ? { code: { not: 'TEST-SIMULATOR' } } : { code: 'TEST-SIMULATOR' }),
              OR: [{ merchants: { some: { merchantId: auth.merchantId } } }, { merchants: { none: { dedicated: true } } }],
            },
          },
        },
        _count: true,
        _sum: { mainBalanceMinor: true, reservedBalanceMinor: true },
      }),
    ]);
    const account = new Map(accounts.map((item) => [item.code, item.balanceMinor]));
    const spendable = (physical._sum.mainBalanceMinor ?? 0n) - (physical._sum.reservedBalanceMinor ?? 0n);
    const physicalLiquidity = physical._count === 0 ? 'Unavailable' : spendable < (openTransfers._sum.amountMinor ?? 0n) ? 'Limited' : 'Healthy';
    return {
      environment,
      available: minorToAmount(account.get(LEDGER_CODES.available) ?? 0n),
      reserved: minorToAmount(account.get(LEDGER_CODES.reserved) ?? 0n),
      pending: minorToAmount(openTransfers._sum.amountMinor ?? 0n),
      physical_liquidity: physicalLiquidity,
      open_withdrawals: openTransfers._count,
      open_deposits: openDeposits,
      updated_at: new Date().toISOString(),
    };
  }

  async transactions(auth: PortalAuthContext, environment: RuntimeEnvironment, limit: number) {
    const [deposits, transfers] = await Promise.all([
      this.prisma.depositIntent.findMany({ where: { merchantId: auth.merchantId, environment }, orderBy: { createdAt: 'desc' }, take: limit }),
      this.prisma.transfer.findMany({ where: { merchantId: auth.merchantId, environment }, orderBy: { createdAt: 'desc' }, take: limit }),
    ]);
    return [...deposits.map((item) => ({ id: item.id, reference: item.txRef, kind: 'deposit', customer_id: item.customerId, customer_phone: maskPhone(item.customerPhone), amount: minorToAmount(item.amountMinor), credited_amount: item.creditedAmountMinor === null ? null : minorToAmount(item.creditedAmountMinor), status: ['success', 'failed'].includes(item.status) ? item.status : 'pending', p2p_status: item.status, created_at: item.createdAt.toISOString() })),
      ...transfers.map((item) => ({ id: item.id, reference: item.reference, kind: 'withdrawal', customer_id: item.customerId, customer_phone: maskPhone(item.destinationPhone), amount: minorToAmount(item.amountMinor), credited_amount: null, status: ['success', 'failed', 'cancelled'].includes(item.status) ? (item.status === 'cancelled' ? 'failed' : item.status) : 'pending', p2p_status: item.status, created_at: item.createdAt.toISOString() }))]
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, limit);
  }

  async apiKeys(auth: PortalAuthContext, environment: RuntimeEnvironment) {
    requireManagement(auth);
    const keys = await this.prisma.apiKey.findMany({ where: { merchantId: auth.merchantId, environment }, orderBy: { createdAt: 'desc' } });
    return keys.map((key) => ({ id: key.id, environment: key.environment, label: key.label, prefix: key.prefix, active: !key.revokedAt, created_at: key.createdAt.toISOString(), last_used_at: key.lastUsedAt?.toISOString() ?? null, revoked_at: key.revokedAt?.toISOString() ?? null }));
  }

  async createApiKey(auth: PortalAuthContext, environment: RuntimeEnvironment, label: string) {
    requireManagement(auth);
    const prefix = `sk_${environment}_${randomBytes(6).toString('hex')}`;
    const secret = `${prefix}.${randomBytes(32).toString('base64url')}`;
    const created = await this.prisma.$transaction(async (transaction) => {
      const key = await transaction.apiKey.create({ data: { merchantId: auth.merchantId, environment, label, prefix, secretHash: await argon2.hash(secret) } });
      await transaction.auditLog.create({ data: { merchantId: auth.merchantId, actorType: 'merchant_user', actorId: auth.userId, action: 'api_key.created', targetType: 'api_key', targetId: key.id, metadata: { environment, label, prefix } } });
      return key;
    });
    return { id: created.id, environment, label, prefix, secret_key: secret, created_at: created.createdAt.toISOString() };
  }

  async revokeApiKey(auth: PortalAuthContext, keyId: string) {
    requireManagement(auth);
    const key = await this.prisma.apiKey.findFirst({ where: { id: keyId, merchantId: auth.merchantId } });
    if (!key) throw new ApiException('not_found', 'API key was not found', HttpStatus.NOT_FOUND);
    if (!key.revokedAt) {
      await this.prisma.$transaction([
        this.prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } }),
        this.prisma.auditLog.create({ data: { merchantId: auth.merchantId, actorType: 'merchant_user', actorId: auth.userId, action: 'api_key.revoked', targetType: 'api_key', targetId: key.id } }),
      ]);
    }
    return { id: key.id, revoked: true };
  }

  async webhookLogs(auth: PortalAuthContext, environment: RuntimeEnvironment) {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { merchantId: auth.merchantId, environment },
      include: { deliveries: { include: { outboxEvent: true }, orderBy: { createdAt: 'desc' }, take: 100 } },
      orderBy: { createdAt: 'desc' },
    });
    return endpoints.map((endpoint) => ({
      id: endpoint.id,
      url: endpoint.url,
      enabled: endpoint.enabled,
      created_at: endpoint.createdAt.toISOString(),
      deliveries: endpoint.deliveries.map((delivery) => ({ id: delivery.id, event_id: delivery.outboxEventId, event_type: delivery.outboxEvent.eventType, status: delivery.status, attempt: delivery.attempt, response_code: delivery.responseCode, created_at: delivery.createdAt.toISOString(), delivered_at: delivery.deliveredAt?.toISOString() ?? null })),
    }));
  }
}
