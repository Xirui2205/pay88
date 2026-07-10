import { HttpStatus, Injectable } from '@nestjs/common';
import type { ConfigurationChangeStatus, Prisma } from '@prisma/client';
import { minorToAmount } from '@telebirr/contracts';
import { ApiException } from '../common/api-exception';
import { PrismaService } from '../infra/prisma.service';

export type ConfigurationScope = 'platform_defaults' | 'merchant' | 'device_group';

@Injectable()
export class ConfigurationService {
  constructor(private readonly prisma: PrismaService) {}

  async propose(scopeType: ConfigurationScope, scopeId: string, proposed: Record<string, unknown>, actorId: string, reason: string) {
    const normalized = normalizeConfiguration(scopeType, proposed);
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`configuration:${scopeType}:${scopeId}`}))`;
      await this.assertScopeExists(transaction, scopeType, scopeId);
      const last = await transaction.configurationChange.findFirst({ where: { scopeType, scopeId }, orderBy: { version: 'desc' } });
      const change = await transaction.configurationChange.create({ data: { scopeType, scopeId, version: (last?.version ?? 0) + 1, proposed: normalized as Prisma.InputJsonValue, proposedBy: actorId } });
      await transaction.auditLog.create({ data: { actorType: actorId.startsWith('portal:') ? 'merchant_user' : 'platform_staff', actorId, action: 'configuration.proposed', targetType: 'configuration_change', targetId: change.id, reason, metadata: { scope_type: scopeType, scope_id: scopeId, version: change.version } } });
      return view(change);
    });
  }

  async list(input: { scopeType?: ConfigurationScope; scopeId?: string; status?: ConfigurationChangeStatus } = {}) {
    const rows = await this.prisma.configurationChange.findMany({ where: { scopeType: input.scopeType, scopeId: input.scopeId, status: input.status }, orderBy: { createdAt: 'desc' }, take: 500 });
    return rows.map(view);
  }

  async activeMerchant(merchantId: string) {
    const value = await this.prisma.merchantConfig.findUnique({ where: { merchantId } });
    if (!value) throw new ApiException('not_found', 'Merchant configuration was not found', HttpStatus.NOT_FOUND);
    return {
      allow_alternate_withdrawal_phone: value.allowAlternateWithdrawalPhone,
      deposit_minimum: minorToAmount(value.depositMinimumMinor),
      deposit_maximum: minorToAmount(value.depositMaximumMinor),
      wrong_amount_tolerance: minorToAmount(value.wrongAmountToleranceMinor),
      reserve_provider_fee: minorToAmount(value.reserveProviderFeeMinor),
      gateway_fee_flat: minorToAmount(value.gatewayFeeFlatMinor),
      deposit_countdown_seconds: value.depositCountdownSeconds,
      deposit_late_grace_seconds: value.depositLateGraceSeconds,
      technical_difficulty_message: value.technicalDifficultyMessage,
    };
  }

  async approve(id: string, actorId: string, reason: string) {
    return this.review(id, 'approved', actorId, reason);
  }

  async reject(id: string, actorId: string, reason: string) {
    return this.review(id, 'rejected', actorId, reason);
  }

  private async review(id: string, decision: 'approved' | 'rejected', actorId: string, reason: string) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`configuration-change:${id}`}))`;
      const change = await transaction.configurationChange.findUnique({ where: { id } });
      if (!change) throw new ApiException('not_found', 'Configuration change was not found', HttpStatus.NOT_FOUND);
      if (change.status !== 'pending') throw new ApiException('invalid_state', 'Configuration change was already reviewed', HttpStatus.CONFLICT);
      if (decision === 'approved') await this.apply(transaction, change.scopeType as ConfigurationScope, change.scopeId, change.proposed as Record<string, unknown>, actorId);
      const updated = await transaction.configurationChange.update({ where: { id }, data: { status: decision, reviewedBy: actorId, reviewReason: reason, reviewedAt: new Date() } });
      await transaction.auditLog.create({ data: { actorType: 'platform_staff', actorId, action: `configuration.${decision}`, targetType: 'configuration_change', targetId: id, reason, metadata: { scope_type: change.scopeType, scope_id: change.scopeId, version: change.version } } });
      return view(updated);
    }, { isolationLevel: 'Serializable' });
  }

  private async apply(transaction: Prisma.TransactionClient, scopeType: ConfigurationScope, scopeId: string, proposed: Record<string, unknown>, actorId: string) {
    if (scopeType === 'platform_defaults') {
      await transaction.platformSetting.upsert({ where: { key: 'fleet.defaults' }, update: { value: proposed as Prisma.InputJsonValue, version: { increment: 1 }, updatedBy: actorId }, create: { key: 'fleet.defaults', value: proposed as Prisma.InputJsonValue, updatedBy: actorId } });
      return;
    }
    if (scopeType === 'device_group') {
      await transaction.deviceGroup.update({ where: { id: scopeId }, data: {
        dailyLimitMinor: minor(String(proposed.daily_transfer_cap)), walletCeilingMinor: minor(String(proposed.wallet_ceiling)),
        safetyBalanceMinor: minor(String(proposed.safety_balance)), safetyHeadroomMinor: minor(String(proposed.safety_headroom)),
      } });
      return;
    }
    await transaction.merchantConfig.upsert({ where: { merchantId: scopeId }, update: merchantData(proposed), create: { merchantId: scopeId, ...merchantData(proposed) } });
  }

  private async assertScopeExists(transaction: Prisma.TransactionClient, scopeType: ConfigurationScope, scopeId: string) {
    if (scopeType === 'platform_defaults') {
      if (scopeId !== 'platform') throw new ApiException('validation_error', 'Platform defaults use scope_id=platform', HttpStatus.UNPROCESSABLE_ENTITY);
      return;
    }
    const exists = scopeType === 'merchant'
      ? await transaction.merchant.findUnique({ where: { id: scopeId }, select: { id: true } })
      : await transaction.deviceGroup.findUnique({ where: { id: scopeId }, select: { id: true } });
    if (!exists) throw new ApiException('not_found', 'Configuration scope was not found', HttpStatus.NOT_FOUND);
  }
}

export function normalizeConfiguration(scopeType: ConfigurationScope, input: Record<string, unknown>): Record<string, unknown> {
  if (scopeType === 'platform_defaults' || scopeType === 'device_group') {
    const result: Record<string, unknown> = {
      daily_transfer_cap: money(input.daily_transfer_cap), wallet_ceiling: money(input.wallet_ceiling),
      safety_balance: money(input.safety_balance, true), safety_headroom: money(input.safety_headroom, true),
    };
    if (scopeType === 'platform_defaults') {
      result.balance_stale_seconds = integer(input.balance_stale_seconds, 300, 10_800);
      result.capacity_safety_factor = decimal(input.capacity_safety_factor, 0.1, 0.95);
      result.default_deposit_countdown_seconds = integer(input.default_deposit_countdown_seconds, 60, 3_600);
      result.default_deposit_late_grace_seconds = integer(input.default_deposit_late_grace_seconds, 0, 7_200);
    }
    if (minor(String(result.wallet_ceiling)) <= minor(String(result.safety_balance)) + minor(String(result.safety_headroom))) {
      throw new ApiException('validation_error', 'Wallet ceiling must exceed the combined safety balance and headroom', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return result;
  }
  const result = {
    allow_alternate_withdrawal_phone: Boolean(input.allow_alternate_withdrawal_phone),
    deposit_minimum: money(input.deposit_minimum), deposit_maximum: money(input.deposit_maximum),
    wrong_amount_tolerance: money(input.wrong_amount_tolerance, true), reserve_provider_fee: money(input.reserve_provider_fee, true),
    gateway_fee_flat: money(input.gateway_fee_flat, true), deposit_countdown_seconds: integer(input.deposit_countdown_seconds, 60, 3_600),
    deposit_late_grace_seconds: integer(input.deposit_late_grace_seconds, 0, 7_200),
    technical_difficulty_message: text(input.technical_difficulty_message, 5, 500),
  };
  if (minor(result.deposit_minimum) > minor(result.deposit_maximum)) {
    throw new ApiException('validation_error', 'Deposit minimum cannot exceed deposit maximum', HttpStatus.UNPROCESSABLE_ENTITY);
  }
  if (minor(result.wrong_amount_tolerance) > minor(result.deposit_maximum)) {
    throw new ApiException('validation_error', 'Wrong-amount tolerance cannot exceed the deposit maximum', HttpStatus.UNPROCESSABLE_ENTITY);
  }
  return result;
}

function merchantData(value: Record<string, unknown>) {
  return {
    allowAlternateWithdrawalPhone: Boolean(value.allow_alternate_withdrawal_phone),
    depositMinimumMinor: minor(String(value.deposit_minimum)), depositMaximumMinor: minor(String(value.deposit_maximum)),
    wrongAmountToleranceMinor: minor(String(value.wrong_amount_tolerance)), reserveProviderFeeMinor: minor(String(value.reserve_provider_fee)),
    gatewayFeeFlatMinor: minor(String(value.gateway_fee_flat)), depositCountdownSeconds: Number(value.deposit_countdown_seconds),
    depositLateGraceSeconds: Number(value.deposit_late_grace_seconds), technicalDifficultyMessage: String(value.technical_difficulty_message),
  };
}

function money(value: unknown, allowZero = false): string {
  const result = typeof value === 'string' && /^(0|[1-9]\d*)\.\d{2}$/.test(value) ? value : '';
  if (!result || (!allowZero && minor(result) <= 0n)) throw new ApiException('validation_error', 'Configuration money fields require canonical ETB values', HttpStatus.UNPROCESSABLE_ENTITY);
  return result;
}
function minor(value: string): bigint { return BigInt(value.replace('.', '')); }
function integer(value: unknown, min: number, max: number): number { if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new ApiException('validation_error', 'Configuration integer is outside its allowed range', HttpStatus.UNPROCESSABLE_ENTITY); return Number(value); }
function decimal(value: unknown, min: number, max: number): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new ApiException('validation_error', 'Configuration decimal is outside its allowed range', HttpStatus.UNPROCESSABLE_ENTITY); return value; }
function text(value: unknown, min: number, max: number): string { const result = typeof value === 'string' ? value.trim() : ''; if (result.length < min || result.length > max) throw new ApiException('validation_error', 'Configuration text is outside its allowed range', HttpStatus.UNPROCESSABLE_ENTITY); return result; }
function view(change: { id: string; scopeType: string; scopeId: string; version: number; proposed: Prisma.JsonValue; status: ConfigurationChangeStatus; proposedBy: string; reviewedBy: string | null; reviewReason: string | null; reviewedAt: Date | null; createdAt: Date }) { return { id: change.id, scope_type: change.scopeType, scope_id: change.scopeId, version: change.version, proposed: change.proposed, status: change.status, proposed_by: change.proposedBy, reviewed_by: change.reviewedBy, review_reason: change.reviewReason, reviewed_at: change.reviewedAt?.toISOString() ?? null, created_at: change.createdAt.toISOString() }; }
