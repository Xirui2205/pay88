import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma, SimWallet, SweepExecution, SweepRule, Transfer } from '@prisma/client';
import {
  amountToMinor,
  minorToAmount,
  type CreateTransferInput,
  type SweepRuleInput,
} from '@telebirr/contracts';
import type { MerchantAuthContext } from '../auth/auth.types';
import { ApiException } from '../common/api-exception';
import { addisFinancialDay } from '../fleet/sim-selection.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { PrismaService } from '../infra/prisma.service';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';
import { comparePersonNames } from '../parsers/name-normalizer';
import { loadPlatformPolicy } from '../configuration/platform-policy';

type ExecutionWithRelations = SweepExecution & { transfer: Transfer; simWallet: SimWallet };
const activeExecutionStatuses = ['queued', 'device_started', 'committed', 'provider_pending', 'unknown', 'manual_review'] as const;

@Injectable()
export class SweepsService {
  private readonly logger = new Logger(SweepsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly withdrawals: WithdrawalsService,
  ) {}

  async create(auth: MerchantAuthContext, input: SweepRuleInput, idempotencyKey: string) {
    return (
      await this.idempotency.execute({
        auth,
        operation: 'sweep_rules.create',
        key: idempotencyKey,
        referenceKey: input.name,
        payload: input,
        execute: async (transaction) => {
          await this.assertGroupAccess(transaction, auth.merchantId, input.group_id);
          const rule = await transaction.sweepRule.create({
            data: {
              merchantId: auth.merchantId,
              environment: auth.environment,
              groupId: input.group_id,
              name: input.name,
              destinationType: input.destination_type,
              destinationPhone: input.destination_phone,
              destinationName: input.destination_name,
              highWaterMinor: amountToMinor(input.high_water_balance),
              targetBalanceMinor: amountToMinor(input.target_balance),
              maxPerRunMinor: amountToMinor(input.max_per_run),
              minimumIntervalSeconds: input.minimum_interval_seconds,
              proposedBy: auth.apiKeyId,
            },
          });
          await this.auditRule(transaction, rule, auth.apiKeyId, 'merchant_api_key', 'sweep_rule.create', 'Submitted for platform approval');
          return viewRule(rule);
        },
      })
    ).result;
  }

  async update(auth: MerchantAuthContext, id: string, input: SweepRuleInput, idempotencyKey: string) {
    return (
      await this.idempotency.execute({
        auth,
        operation: `sweep_rules.update:${id}`,
        key: idempotencyKey,
        referenceKey: id,
        payload: input,
        execute: async (transaction) => {
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sweep-rule:${id}`}))`;
          const current = await this.requireMerchantRule(transaction, auth, id);
          await this.assertGroupAccess(transaction, auth.merchantId, input.group_id);
          const updated = await transaction.sweepRule.update({
            where: { id },
            data: {
              groupId: input.group_id,
              name: input.name,
              destinationType: input.destination_type,
              destinationPhone: input.destination_phone,
              destinationName: input.destination_name,
              highWaterMinor: amountToMinor(input.high_water_balance),
              targetBalanceMinor: amountToMinor(input.target_balance),
              maxPerRunMinor: amountToMinor(input.max_per_run),
              minimumIntervalSeconds: input.minimum_interval_seconds,
              enabled: true,
              status: 'pending',
              version: { increment: 1 },
              proposedBy: auth.apiKeyId,
              approvedBy: null,
              approvalReason: null,
              approvedAt: null,
            },
          });
          await this.auditRule(transaction, updated, auth.apiKeyId, 'merchant_api_key', 'sweep_rule.update', `Replaced version ${current.version}; platform reapproval required`);
          return viewRule(updated);
        },
      })
    ).result;
  }

  async disable(auth: MerchantAuthContext, id: string, reason: string, idempotencyKey: string) {
    return (
      await this.idempotency.execute({
        auth,
        operation: `sweep_rules.disable:${id}`,
        key: idempotencyKey,
        referenceKey: id,
        payload: { reason },
        execute: async (transaction) => {
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sweep-rule:${id}`}))`;
          const current = await this.requireMerchantRule(transaction, auth, id);
          if (current.status === 'disabled') return viewRule(current);
          const updated = await transaction.sweepRule.update({ where: { id }, data: { enabled: false, status: 'disabled' } });
          await this.auditRule(transaction, updated, auth.apiKeyId, 'merchant_api_key', 'sweep_rule.disable', reason);
          return viewRule(updated);
        },
      })
    ).result;
  }

  async get(auth: MerchantAuthContext, id: string) {
    return viewRule(await this.requireMerchantRule(this.prisma, auth, id));
  }

  async list(auth: MerchantAuthContext) {
    const rules = await this.prisma.sweepRule.findMany({
      where: { merchantId: auth.merchantId, environment: auth.environment },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rules.map(viewRule);
  }

  async listForAdmin(status?: string) {
    const allowed = ['pending', 'approved', 'rejected', 'disabled'];
    if (status && !allowed.includes(status)) throw new ApiException('validation_error', 'Invalid sweep-rule status', HttpStatus.BAD_REQUEST);
    const rules = await this.prisma.sweepRule.findMany({
      where: status ? { status: status as SweepRule['status'] } : undefined,
      include: { merchant: { select: { name: true, slug: true } }, group: { select: { name: true, code: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rules.map((rule) => ({ ...viewRule(rule), merchant: rule.merchant, group: rule.group }));
  }

  async approve(id: string, reason: string, reviewer = 'platform-admin') {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sweep-rule:${id}`}))`;
      const rule = await transaction.sweepRule.findUnique({ where: { id } });
      if (!rule) throw new ApiException('not_found', 'Sweep rule was not found', HttpStatus.NOT_FOUND);
      if (rule.status === 'approved') return viewRule(rule);
      if (rule.status !== 'pending') throw new ApiException('invalid_state', 'Only a pending sweep rule can be approved', HttpStatus.CONFLICT);
      await this.assertDestinationNotFleet(transaction, rule.destinationPhone);
      await this.assertApprovedDestination(transaction, rule);
      const updated = await transaction.sweepRule.update({
        where: { id },
        data: { status: 'approved', enabled: true, approvedBy: reviewer, approvalReason: reason, approvedAt: new Date() },
      });
      await this.auditRule(transaction, updated, reviewer, 'platform_admin', 'sweep_rule.approve', reason);
      return viewRule(updated);
    }, { isolationLevel: 'Serializable' });
  }

  async reject(id: string, reason: string, reviewer = 'platform-admin') {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sweep-rule:${id}`}))`;
      const rule = await transaction.sweepRule.findUnique({ where: { id } });
      if (!rule) throw new ApiException('not_found', 'Sweep rule was not found', HttpStatus.NOT_FOUND);
      if (rule.status === 'rejected') return viewRule(rule);
      if (rule.status !== 'pending') throw new ApiException('invalid_state', 'Only a pending sweep rule can be rejected', HttpStatus.CONFLICT);
      const updated = await transaction.sweepRule.update({
        where: { id },
        data: { status: 'rejected', enabled: false, approvedBy: reviewer, approvalReason: reason, approvedAt: new Date() },
      });
      await this.auditRule(transaction, updated, reviewer, 'platform_admin', 'sweep_rule.reject', reason);
      return viewRule(updated);
    }, { isolationLevel: 'Serializable' });
  }

  async executeNow(id: string, reason: string, reviewer = 'platform-admin') {
    return this.executeRule(id, true, reviewer, reason);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async orchestrateApprovedRules(): Promise<void> {
    const rules = await this.prisma.sweepRule.findMany({
      where: { status: 'approved', enabled: true, environment: 'live' },
      select: { id: true },
      orderBy: { lastExecutedAt: { sort: 'asc', nulls: 'first' } },
      take: 500,
    });
    for (const rule of rules) {
      try {
        await this.executeRule(rule.id, false, 'sweep-orchestrator', 'Approved high-water rule');
      } catch (error) {
        this.logger.warn(`Sweep rule ${rule.id} was skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async executeRule(id: string, strict: boolean, actorId: string, reason: string) {
    const rule = await this.prisma.sweepRule.findUnique({ where: { id } });
    if (!rule) throw new ApiException('not_found', 'Sweep rule was not found', HttpStatus.NOT_FOUND);
    if (rule.status !== 'approved' || !rule.enabled) {
      if (strict) throw new ApiException('invalid_state', 'Sweep rule is not approved and enabled', HttpStatus.CONFLICT);
      return [];
    }
    if (rule.environment !== 'live') {
      if (strict) throw new ApiException('invalid_state', 'Sweep execution requires a live rule', HttpStatus.CONFLICT);
      return [];
    }
    const policy = await loadPlatformPolicy(this.prisma);
    const balanceCutoff = new Date(Date.now() - policy.balanceStaleSeconds * 1000);
    const heartbeatCutoff = new Date(Date.now() - 90_000);
    const candidates = await this.prisma.simWallet.findMany({
      where: {
        status: 'active',
        mainBalanceMinor: { gt: rule.highWaterMinor },
        lastBalanceAt: { gte: balanceCutoff },
        device: {
          groupId: rule.groupId,
          status: 'online',
          lastHeartbeatAt: { gte: heartbeatCutoff },
          lastPermissionsOk: true,
          lastAccessibilityOk: true,
        },
      },
      orderBy: { mainBalanceMinor: 'desc' },
      take: 250,
    });
    const executions: ReturnType<typeof viewExecution>[] = [];
    const errors: unknown[] = [];
    for (const candidate of candidates) {
      try {
        const execution = await this.executeCandidate(rule.id, candidate.id, actorId, reason);
        if (execution) executions.push(viewExecution(execution));
      } catch (error) {
        errors.push(error);
        this.logger.warn(`Sweep candidate ${candidate.id} was skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Each candidate is dispatched in its own serializable transaction. Never
    // report the whole evaluation as failed after an earlier transfer committed.
    if (strict && executions.length === 0 && errors[0]) throw errors[0];
    return executions;
  }

  private async executeCandidate(ruleId: string, simWalletId: string, actorId: string, reason: string): Promise<ExecutionWithRelations | null> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sweep:${ruleId}:${simWalletId}`}))`;
      const rule = await transaction.sweepRule.findUnique({ where: { id: ruleId }, include: { group: true } });
      if (!rule || rule.status !== 'approved' || !rule.enabled || rule.environment !== 'live') return null;
      // Fleet policies can change after a sweep rule is approved. Revalidate
      // group access inside the same serializable transaction that reserves
      // and dispatches funds so a stale rule cannot move liquidity from a
      // group that has since been dedicated to another merchant.
      await this.assertGroupAccess(transaction, rule.merchantId, rule.groupId);
      // Recheck at the point of execution. A destination can become an enrolled
      // fleet number after rule approval unless both sides enforce the invariant.
      await this.assertDestinationNotFleet(transaction, rule.destinationPhone);
      await this.assertApprovedDestination(transaction, rule);
      const sim = await transaction.simWallet.findUnique({ where: { id: simWalletId }, include: { device: true } });
      if (!sim || sim.device.groupId !== rule.groupId || sim.status !== 'active' || sim.device.status !== 'online') return null;
      const policy = await loadPlatformPolicy(transaction);
      if (!sim.lastBalanceAt || sim.lastBalanceAt < new Date(Date.now() - policy.balanceStaleSeconds * 1000) || !sim.device.lastHeartbeatAt || sim.device.lastHeartbeatAt < new Date(Date.now() - 90_000)) return null;
      const recentCutoff = new Date(Date.now() - rule.minimumIntervalSeconds * 1000);
      const prior = await transaction.sweepExecution.findFirst({
        where: {
          ruleId,
          simWalletId,
          OR: [{ status: { in: [...activeExecutionStatuses] } }, { createdAt: { gte: recentCutoff } }],
        },
        include: { transfer: true, simWallet: true },
        orderBy: { createdAt: 'desc' },
      });
      if (prior) return null;
      const config = await transaction.merchantConfig.upsert({ where: { merchantId: rule.merchantId }, update: {}, create: { merchantId: rule.merchantId } });
      const activeTransfers = await transaction.transfer.aggregate({
        where: { simWalletId, status: { in: ['accepted', 'queued', 'device_assigned', 'device_started', 'committed', 'provider_pending', 'unknown', 'manual_review'] } },
        _sum: { amountMinor: true, reserveProviderFeeMinor: true },
      });
      const financialDay = addisFinancialDay(new Date());
      const sentToday = sim.financialDay && addisFinancialDay(sim.financialDay).valueOf() === financialDay.valueOf() ? sim.sentTodayMinor : 0n;
      const pendingDaily = (activeTransfers._sum.amountMinor ?? 0n) + (activeTransfers._sum.reserveProviderFeeMinor ?? 0n);
      const remainingDaily = rule.group.dailyLimitMinor - sentToday - pendingDaily - config.reserveProviderFeeMinor;
      if (remainingDaily <= 0n) return null;
      const amountMinor = calculateSweepAmount({
        balanceMinor: sim.mainBalanceMinor,
        reservedMinor: sim.reservedBalanceMinor + config.reserveProviderFeeMinor,
        safetyMinor: rule.group.safetyBalanceMinor,
        highWaterMinor: rule.highWaterMinor,
        targetMinor: rule.targetBalanceMinor,
        maxPerRunMinor: remainingDaily < rule.maxPerRunMinor ? remainingDaily : rule.maxPerRunMinor,
      });
      if (amountMinor <= 0n) return null;
      const bucket = Math.floor(Date.now() / (rule.minimumIntervalSeconds * 1000));
      const idempotencyKey = `sweep:${rule.id}:${sim.id}:${rule.version}:${bucket}`;
      const existing = await transaction.sweepExecution.findUnique({ where: { idempotencyKey }, include: { transfer: true, simWallet: true } });
      if (existing) return existing;
      const transferInput: CreateTransferInput = {
        account_number: rule.destinationPhone,
        expected_name: rule.destinationName,
        customer_id: 'automatic-sweep',
        destination_type: 'registered',
        amount: minorToAmount(amountMinor),
        currency: 'ETB',
        reference: `SWP:${rule.id}:${sim.id}:${rule.version}:${bucket}`,
        bank_code: '855',
        metadata: { intent_type: 'automatic_sweep', sweep_rule_id: rule.id, sweep_rule_version: rule.version },
      };
      const transfer = await this.withdrawals.queueTransfer(
        transaction,
        { merchantId: rule.merchantId, environment: rule.environment },
        transferInput,
        { operationKind: 'automatic_sweep', financialMode: financialModeForDestination(rule.destinationType), priority: 200, simOverride: sim },
      );
      const execution = await transaction.sweepExecution.create({
        data: {
          ruleId: rule.id,
          simWalletId: sim.id,
          transferId: transfer.id,
          idempotencyKey,
          amountMinor,
          status: executionStatusFromTransfer(transfer.status),
          completedAt: ['success', 'failed'].includes(transfer.status) ? new Date() : undefined,
        },
        include: { transfer: true, simWallet: true },
      });
      await transaction.sweepRule.update({ where: { id: rule.id }, data: { lastExecutedAt: new Date() } });
      await transaction.auditLog.create({
        data: {
          merchantId: rule.merchantId,
          actorType: actorId === 'sweep-orchestrator' ? 'system' : 'platform_admin',
          actorId,
          action: 'sweep_execution.dispatch',
          targetType: 'sweep_execution',
          targetId: execution.id,
          reason,
          metadata: { rule_id: rule.id, rule_version: rule.version, sim_wallet_id: sim.id, transfer_id: transfer.id, amount: minorToAmount(amountMinor) },
        },
      });
      await transaction.outboxEvent.create({
        data: {
          aggregateType: 'sweep_execution',
          aggregateId: execution.id,
          eventType: 'sweep.updated',
          payload: { reference: transfer.reference, rule_id: rule.id, transfer_reference: transfer.reference, status: transfer.status === 'success' ? 'success' : transfer.status === 'failed' ? 'failed' : 'pending', p2p_status: execution.status },
        },
      });
      return execution;
    }, { isolationLevel: 'Serializable', timeout: 20_000 });
  }

  private async requireMerchantRule(
    transaction: Prisma.TransactionClient | PrismaService,
    auth: Pick<MerchantAuthContext, 'merchantId' | 'environment'>,
    id: string,
  ): Promise<SweepRule> {
    const rule = await transaction.sweepRule.findFirst({ where: { id, merchantId: auth.merchantId, environment: auth.environment } });
    if (!rule) throw new ApiException('not_found', 'Sweep rule was not found', HttpStatus.NOT_FOUND);
    return rule;
  }

  private async assertGroupAccess(transaction: Prisma.TransactionClient, merchantId: string, groupId: string): Promise<void> {
    const group = await transaction.deviceGroup.findUnique({ where: { id: groupId }, include: { merchants: true } });
    if (!group) throw new ApiException('not_found', 'Device group was not found', HttpStatus.NOT_FOUND);
    if (group.code === 'TEST-SIMULATOR') {
      throw new ApiException('forbidden', 'The test simulator group cannot be used by sweep rules', HttpStatus.FORBIDDEN);
    }
    const ownPolicy = group.merchants.some((policy) => policy.merchantId === merchantId);
    if (!ownPolicy && group.merchants.some((policy) => policy.dedicated)) {
      throw new ApiException('forbidden', 'The device group is not available to this merchant', HttpStatus.FORBIDDEN);
    }
  }

  private async assertDestinationNotFleet(transaction: Prisma.TransactionClient, destinationPhone: string): Promise<void> {
    const enrolled = await transaction.simWallet.findUnique({ where: { phoneNumber: destinationPhone } });
    if (enrolled) {
      throw new ApiException('invalid_state', 'A sweep destination cannot be an enrolled fleet SIM', HttpStatus.CONFLICT);
    }
  }

  private async assertApprovedDestination(transaction: Prisma.TransactionClient, rule: SweepRule): Promise<void> {
    const treasury = await transaction.treasuryWallet.findUnique({
      where: { environment_phoneNumber: { environment: rule.environment, phoneNumber: rule.destinationPhone } },
    });
    if (rule.destinationType === 'platform_treasury') {
      if (!treasury || treasury.status !== 'active' || treasury.merchantId !== null || comparePersonNames(treasury.accountName, rule.destinationName).decision !== 'match') {
        throw new ApiException('invalid_state', 'Platform-treasury sweeps require a matching preapproved active treasury wallet', HttpStatus.CONFLICT);
      }
      return;
    }
    if (!treasury || treasury.status !== 'active' || treasury.merchantId !== rule.merchantId || comparePersonNames(treasury.accountName, rule.destinationName).decision !== 'match') {
      throw new ApiException('invalid_state', 'Merchant-owned sweeps require a matching preapproved active wallet owned by this merchant', HttpStatus.CONFLICT);
    }
  }

  private async auditRule(
    transaction: Prisma.TransactionClient,
    rule: SweepRule,
    actorId: string,
    actorType: string,
    action: string,
    reason: string,
  ): Promise<void> {
    await transaction.auditLog.create({
      data: {
        merchantId: rule.merchantId,
        actorType,
        actorId,
        action,
        targetType: 'sweep_rule',
        targetId: rule.id,
        reason,
        metadata: { version: rule.version, status: rule.status, group_id: rule.groupId, destination_type: rule.destinationType },
      },
    });
  }
}

export function calculateSweepAmount(input: {
  balanceMinor: bigint;
  reservedMinor: bigint;
  safetyMinor: bigint;
  highWaterMinor: bigint;
  targetMinor: bigint;
  maxPerRunMinor: bigint;
}): bigint {
  const usable = input.balanceMinor - input.reservedMinor - input.safetyMinor;
  if (usable <= input.highWaterMinor) return 0n;
  const excess = usable - input.targetMinor;
  if (excess <= 0n || input.maxPerRunMinor <= 0n) return 0n;
  return excess < input.maxPerRunMinor ? excess : input.maxPerRunMinor;
}

export function financialModeForDestination(destinationType: SweepRule['destinationType']): 'merchant_debit' | 'internal_move' {
  return destinationType === 'merchant_owned' ? 'merchant_debit' : 'internal_move';
}

function executionStatusFromTransfer(status: string): SweepExecution['status'] {
  if (status === 'success' || status === 'failed' || status === 'unknown' || status === 'manual_review') return status;
  if (status === 'device_started' || status === 'committed' || status === 'provider_pending') return status;
  return 'queued';
}

function viewRule(rule: SweepRule) {
  return {
    id: rule.id,
    name: rule.name,
    group_id: rule.groupId,
    environment: rule.environment,
    status: rule.status,
    enabled: rule.enabled,
    version: rule.version,
    destination_type: rule.destinationType,
    destination_phone: rule.destinationPhone,
    destination_name: rule.destinationName,
    high_water_balance: minorToAmount(rule.highWaterMinor),
    target_balance: minorToAmount(rule.targetBalanceMinor),
    max_per_run: minorToAmount(rule.maxPerRunMinor),
    minimum_interval_seconds: rule.minimumIntervalSeconds,
    approval_reason: rule.approvalReason,
    approved_at: rule.approvedAt?.toISOString() ?? null,
    last_executed_at: rule.lastExecutedAt?.toISOString() ?? null,
    created_at: rule.createdAt.toISOString(),
    updated_at: rule.updatedAt.toISOString(),
  };
}

function viewExecution(execution: ExecutionWithRelations) {
  return {
    id: execution.id,
    rule_id: execution.ruleId,
    sim_wallet_id: execution.simWalletId,
    transfer_reference: execution.transfer.reference,
    amount: minorToAmount(execution.amountMinor),
    status: execution.status,
    created_at: execution.createdAt.toISOString(),
    completed_at: execution.completedAt?.toISOString() ?? null,
  };
}
