import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import argon2 from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { amountToMinor, minorToAmount } from '@telebirr/contracts';
import { ApiException } from '../common/api-exception';
import { sha256 } from '../common/crypto';
import { PrismaService } from '../infra/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { addisFinancialDay } from '../fleet/sim-selection.service';
import { loadPlatformPolicy } from '../configuration/platform-policy';
import { CURRENT_DEVICE_PROFILE_VERSION_TEXT } from '../devices/device-profile-version';
import { comparePersonNames } from '../parsers/name-normalizer';

const deviceQualificationKeys = ['device_permissions', 'accessibility_enabled', 'openclaw_paired', 'reboot_survival'] as const;
const simQualificationKeys = ['sms_attribution', 'ussd_subscription', 'balance_query', 'transfer_confirmation'] as const;

export function calculateFleetCapacity(
  onlineQualifiedPhones: number,
  sessionSeconds: number[],
  safetyFactor: number,
  queuedWithdrawals: number,
) {
  const clean = sessionSeconds.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const p95SessionSeconds = clean.length
    ? clean[Math.min(clean.length - 1, Math.ceil(clean.length * 0.95) - 1)]!
    : 30;
  const boundedSafetyFactor = Math.min(0.95, Math.max(0.1, safetyFactor));
  const theoreticalPerMinute = onlineQualifiedPhones * 60 / p95SessionSeconds;
  const usablePerMinute = theoreticalPerMinute * boundedSafetyFactor;
  return {
    online_qualified_phones: onlineQualifiedPhones,
    measured_sessions: clean.length,
    p95_session_seconds: Number(p95SessionSeconds.toFixed(1)),
    safety_factor: Number(boundedSafetyFactor.toFixed(2)),
    theoretical_per_minute: Number(theoreticalPerMinute.toFixed(1)),
    usable_per_minute: Number(usablePerMinute.toFixed(1)),
    queued_withdrawals: queuedWithdrawals,
    estimated_queue_wait_seconds: usablePerMinute > 0 ? Math.ceil(queuedWithdrawals / usablePerMinute * 60) : null,
  };
}

export function recoverySimIdentityMatches(
  enrolled: { slot: number; iccid: string; phoneNumber: string; accountName: string },
  observed: { slot: number; iccid: string; phoneNumber: string; accountName: string } | undefined,
): boolean {
  return Boolean(
    observed &&
    observed.slot === enrolled.slot &&
    observed.iccid === enrolled.iccid &&
    observed.phoneNumber === enrolled.phoneNumber &&
    comparePersonNames(enrolled.accountName, observed.accountName).decision === 'match',
  );
}

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService) {}

  async dashboard() {
    const platformPolicy = await loadPlatformPolicy(this.prisma);
    const now = new Date();
    const today = addisFinancialDay(now);
    const heartbeatCutoff = new Date(now.valueOf() - 90_000);
    const sessionCutoff = new Date(now.valueOf() - 24 * 60 * 60_000);
    const [merchants, devices, sims, deposits, transfers, cases, onlinePhones, sessions, queuedWithdrawals, todayDeposits, todayTransfers, ledgerViolations, liveCustody, treasuryCustody, treasuryWalletBalances] = await Promise.all([
      this.prisma.merchant.count({ where: { status: 'active' } }),
      this.prisma.device.groupBy({ by: ['status'], _count: true }),
      this.prisma.simWallet.aggregate({
        where: { device: { group: { code: { not: 'TEST-SIMULATOR' } } } },
        _count: true,
        _sum: { mainBalanceMinor: true, reservedBalanceMinor: true },
      }),
      this.prisma.depositIntent.groupBy({ by: ['status'], _count: true, _sum: { creditedAmountMinor: true } }),
      this.prisma.transfer.groupBy({ by: ['status'], _count: true, _sum: { amountMinor: true } }),
      this.prisma.reconciliationCase.count({ where: { status: { in: ['open', 'proposed'] } } }),
      this.prisma.device.count({
        where: {
          status: 'online',
          lastPermissionsOk: true,
          lastAccessibilityOk: true,
          lastHeartbeatAt: { gte: heartbeatCutoff },
          sims: { some: { status: { in: ['active', 'payout_stale'] } } },
        },
      }),
      this.prisma.deviceJob.findMany({
        where: {
          type: { not: 'balance_query' },
          state: 'succeeded',
          startedAt: { gte: sessionCutoff, not: null },
          completedAt: { not: null },
        },
        select: { startedAt: true, completedAt: true },
        orderBy: { completedAt: 'desc' },
        take: 5_000,
      }),
      this.prisma.transfer.count({ where: { status: { in: ['accepted', 'queued', 'device_assigned'] } } }),
      this.prisma.depositIntent.aggregate({
        where: { status: 'success', updatedAt: { gte: today } },
        _count: true,
        _sum: { creditedAmountMinor: true },
      }),
      this.prisma.transfer.aggregate({
        where: { status: 'success', completedAt: { gte: today } },
        _count: true,
        _sum: { amountMinor: true },
      }),
      this.prisma.$queryRaw<Array<{ violations: bigint }>>`
        SELECT COUNT(*)::bigint AS violations
        FROM (
          SELECT "journalId"
          FROM "LedgerEntry"
          GROUP BY "journalId"
          HAVING SUM(CASE WHEN direction = 'D' THEN "amountMinor" ELSE 0 END)
               <> SUM(CASE WHEN direction = 'C' THEN "amountMinor" ELSE 0 END)
        ) AS unbalanced
      `,
      this.prisma.ledgerAccount.aggregate({
        where: { environment: 'live', code: 'telebirr_custody' },
        _sum: { balanceMinor: true },
      }),
      this.prisma.ledgerAccount.aggregate({
        where: { environment: 'live', code: 'treasury_custody' },
        _sum: { balanceMinor: true },
      }),
      this.prisma.treasuryWallet.aggregate({
        where: { environment: 'live', status: { in: ['active', 'quarantined'] } },
        _sum: { predictedBalanceMinor: true },
      }),
    ]);
    const durations = sessions.flatMap((session) => session.startedAt && session.completedAt
      ? [(session.completedAt.valueOf() - session.startedAt.valueOf()) / 1000]
      : []);
    const safetyFactor = platformPolicy.capacitySafetyFactor;
    const capacity = calculateFleetCapacity(onlinePhones, durations, safetyFactor, queuedWithdrawals);
    const physicalMinor = sims._sum.mainBalanceMinor ?? 0n;
    const custodyMinor = liveCustody._sum.balanceMinor ?? 0n;
    const driftMinor = physicalMinor - custodyMinor;
    return {
      merchants,
      devices: Object.fromEntries(devices.map((item) => [item.status, item._count])),
      sims: { count: sims._count, main_balance: minorToAmount(sims._sum.mainBalanceMinor ?? 0n), reserved: minorToAmount(sims._sum.reservedBalanceMinor ?? 0n) },
      deposits: deposits.map((item) => ({ status: item.status, count: item._count, credited: minorToAmount(item._sum.creditedAmountMinor ?? 0n) })),
      transfers: transfers.map((item) => ({ status: item.status, count: item._count, amount: minorToAmount(item._sum.amountMinor ?? 0n) })),
      open_cases: cases,
      today: {
        deposit_count: todayDeposits._count,
        deposit_amount: minorToAmount(todayDeposits._sum.creditedAmountMinor ?? 0n),
        withdrawal_count: todayTransfers._count,
        withdrawal_amount: minorToAmount(todayTransfers._sum.amountMinor ?? 0n),
        processed_amount: minorToAmount((todayDeposits._sum.creditedAmountMinor ?? 0n) + (todayTransfers._sum.amountMinor ?? 0n)),
        net_inflow: minorToAmount((todayDeposits._sum.creditedAmountMinor ?? 0n) - (todayTransfers._sum.amountMinor ?? 0n)),
      },
      capacity,
      reconciliation: {
        unbalanced_journals: Number(ledgerViolations[0]?.violations ?? 0n),
        physical_balance: minorToAmount(physicalMinor),
        live_custody_balance: minorToAmount(custodyMinor),
        treasury_custody_balance: minorToAmount(treasuryCustody._sum.balanceMinor ?? 0n),
        treasury_predicted_balance: minorToAmount(treasuryWalletBalances._sum.predictedBalanceMinor ?? 0n),
        treasury_ledger_drift: minorToAmount((treasuryWalletBalances._sum.predictedBalanceMinor ?? 0n) - (treasuryCustody._sum.balanceMinor ?? 0n)),
        total_custody_balance: minorToAmount(custodyMinor + (treasuryCustody._sum.balanceMinor ?? 0n)),
        physical_custody_drift: minorToAmount(driftMinor),
      },
    };
  }

  async operations(kind: 'jobs' | 'deposits' | 'withdrawals') {
    if (kind === 'deposits') {
      const records = await this.prisma.depositIntent.findMany({ include: { merchant: { select: { name: true } }, simWallet: { include: { device: { select: { name: true } } } } }, orderBy: { createdAt: 'desc' }, take: 500 });
      return records.map((record) => ({ id: record.id, merchant: record.merchant.name, reference: record.txRef, customer: `${record.customerPhone.slice(0, 5)}••••${record.customerPhone.slice(-3)}`, amount: minorToAmount(record.amountMinor), status: ['success', 'failed'].includes(record.status) ? record.status : 'pending', p2p_status: record.status, created_at: record.createdAt.toISOString(), device: record.simWallet.device.name }));
    }
    if (kind === 'withdrawals') {
      const records = await this.prisma.transfer.findMany({ include: { merchant: { select: { name: true } }, simWallet: { include: { device: { select: { name: true } } } } }, orderBy: { createdAt: 'desc' }, take: 500 });
      return records.map((record) => ({ id: record.id, merchant: record.merchant.name, reference: record.reference, customer: `${record.destinationPhone.slice(0, 5)}••••${record.destinationPhone.slice(-3)}`, amount: minorToAmount(record.amountMinor), status: ['success', 'failed', 'cancelled'].includes(record.status) ? record.status : 'pending', p2p_status: record.status, created_at: record.createdAt.toISOString(), device: record.simWallet?.device.name ?? null }));
    }
    const records = await this.prisma.deviceJob.findMany({ include: { device: { select: { name: true } }, simWallet: { select: { slot: true } }, transferAttempt: { include: { transfer: { include: { merchant: { select: { name: true } } } } } } }, orderBy: { createdAt: 'desc' }, take: 500 });
    return records.map((record) => ({ id: record.id, merchant: record.transferAttempt?.transfer.merchant.name ?? 'System', reference: record.transferAttempt?.transfer.reference ?? record.id, customer: record.type.replaceAll('_', ' '), amount: record.transferAttempt ? minorToAmount(record.transferAttempt.transfer.amountMinor) : '0.00', status: record.state === 'succeeded' ? 'success' : record.state === 'failed' ? 'failed' : record.state, p2p_status: record.state, created_at: record.createdAt.toISOString(), device: record.device ? `${record.device.name} · S${record.simWallet.slot + 1}` : null }));
  }

  async merchants() {
    const merchants = await this.prisma.merchant.findMany({
      include: { users: { select: { id: true } }, groupPolicies: { include: { group: { select: { id: true, name: true } } } }, ledgerAccounts: { where: { environment: 'live', code: 'merchant_available' } } },
      orderBy: { name: 'asc' },
    });
    return merchants.map((merchant) => ({ id: merchant.id, slug: merchant.slug, name: merchant.name, status: merchant.status, user_count: merchant.users.length, fleet_policies: merchant.groupPolicies.map((policy) => ({ group_id: policy.group.id, group: policy.group.name, dedicated: policy.dedicated, priority: policy.priority })), available: minorToAmount(merchant.ledgerAccounts[0]?.balanceMinor ?? 0n), created_at: merchant.createdAt.toISOString() }));
  }

  async audit() {
    const rows = await this.prisma.auditLog.findMany({ include: { merchant: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 500 });
    return rows.map((row) => ({ id: row.id, merchant: row.merchant?.name ?? null, actor_type: row.actorType, actor_id: row.actorId, action: row.action, target_type: row.targetType, target_id: row.targetId, reason: row.reason, metadata: row.metadata, created_at: row.createdAt.toISOString() }));
  }

  async createMerchant(input: { slug: string; name: string; ownerEmail: string; actorId: string; initialTestBalance?: string }) {
    const defaults = await loadPlatformPolicy(this.prisma);
    const secrets = await Promise.all(['test', 'live'].map(async (environment) => {
      const prefix = `sk_${environment}_${randomBytes(6).toString('hex')}`;
      const raw = `${prefix}.${randomBytes(32).toString('base64url')}`;
      return { environment: environment as 'test' | 'live', prefix, raw, hash: await argon2.hash(raw) };
    }));
    const invitationToken = `mi_${randomBytes(32).toString('base64url')}`;
    const invitationExpiresAt = new Date(Date.now() + 72 * 60 * 60_000);
    return this.prisma.$transaction(async (transaction) => {
      const merchant = await transaction.merchant.create({ data: {
        slug: input.slug,
        name: input.name,
        config: { create: { depositCountdownSeconds: defaults.defaultDepositCountdownSeconds, depositLateGraceSeconds: defaults.defaultDepositLateGraceSeconds } },
      } });
      for (const secret of secrets) {
        await transaction.apiKey.create({
          data: { merchantId: merchant.id, environment: secret.environment, label: `${secret.environment} default`, prefix: secret.prefix, secretHash: secret.hash },
        });
      }
      if (input.initialTestBalance) {
        await this.ledger.creditDeposit(transaction, { merchantId: merchant.id, environment: 'test' }, randomUUID(), amountToMinor(input.initialTestBalance));
      }
      const invitation = await transaction.merchantInvitation.create({ data: { merchantId: merchant.id, email: input.ownerEmail.trim().toLocaleLowerCase('en-US'), role: 'owner', tokenHash: sha256(invitationToken), expiresAt: invitationExpiresAt } });
      await transaction.auditLog.create({ data: { merchantId: merchant.id, actorType: 'platform_staff', actorId: input.actorId, action: 'merchant.created', targetType: 'merchant', targetId: merchant.id, metadata: { owner_email: invitation.email } } });
      return { id: merchant.id, slug: merchant.slug, name: merchant.name, owner_invitation: { id: invitation.id, email: invitation.email, token: invitationToken, expires_at: invitation.expiresAt.toISOString() }, keys: secrets.map(({ environment, raw }) => ({ environment, secret_key: raw })) };
    });
  }

  async createLocation(input: { code: string; name: string }) {
    return this.prisma.fleetLocation.create({ data: input });
  }

  async createGroup(input: { locationId: string; code: string; name: string }) {
    const defaults = await loadPlatformPolicy(this.prisma);
    return this.prisma.deviceGroup.create({ data: {
      locationId: input.locationId, code: input.code, name: input.name,
      dailyLimitMinor: defaults.dailyLimitMinor, walletCeilingMinor: defaults.walletCeilingMinor,
      safetyBalanceMinor: defaults.safetyBalanceMinor, safetyHeadroomMinor: defaults.safetyHeadroomMinor,
    } });
  }

  async upsertMerchantGroupPolicy(groupId: string, merchantId: string, dedicated: boolean, priority: number, actorId: string, reason: string) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`merchant-group-policy:${merchantId}:${groupId}`}))`;
      const [group, merchant] = await Promise.all([
        transaction.deviceGroup.findUnique({ where: { id: groupId }, select: { id: true, name: true } }),
        transaction.merchant.findUnique({ where: { id: merchantId }, select: { id: true, name: true } }),
      ]);
      if (!group || !merchant) throw new ApiException('not_found', 'Merchant or fleet group was not found', HttpStatus.NOT_FOUND);
      const policy = await transaction.merchantGroupPolicy.upsert({
        where: { merchantId_groupId: { merchantId, groupId } },
        update: { dedicated, priority },
        create: { merchantId, groupId, dedicated, priority },
      });
      await transaction.auditLog.create({ data: { merchantId, actorType: 'platform_staff', actorId, action: 'fleet.merchant_group_policy_upserted', targetType: 'device_group', targetId: groupId, reason, metadata: { group: group.name, merchant: merchant.name, dedicated, priority } } });
      return { merchant_id: merchantId, group_id: groupId, group: group.name, dedicated: policy.dedicated, priority: policy.priority };
    }, { isolationLevel: 'Serializable' });
  }

  async removeMerchantGroupPolicy(groupId: string, merchantId: string, actorId: string, reason: string) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`merchant-group-policy:${merchantId}:${groupId}`}))`;
      const removed = await transaction.merchantGroupPolicy.deleteMany({ where: { merchantId, groupId } });
      if (removed.count !== 1) throw new ApiException('not_found', 'Merchant fleet policy was not found', HttpStatus.NOT_FOUND);
      await transaction.auditLog.create({ data: { merchantId, actorType: 'platform_staff', actorId, action: 'fleet.merchant_group_policy_removed', targetType: 'device_group', targetId: groupId, reason } });
      return { removed: true, merchant_id: merchantId, group_id: groupId };
    }, { isolationLevel: 'Serializable' });
  }

  async createDevice(input: {
    groupId: string;
    name: string;
    model?: string;
    actorId: string;
    sims: Array<{ slot: number; iccid: string; phoneNumber: string; accountName: string }>;
  }) {
    const reservedDestination = await this.prisma.sweepRule.findFirst({
      where: {
        destinationPhone: { in: input.sims.map((sim) => sim.phoneNumber) },
        status: { in: ['pending', 'approved'] },
      },
      select: { id: true, destinationPhone: true },
    });
    if (reservedDestination) {
      throw new ApiException(
        'invalid_state',
        `SIM ${reservedDestination.destinationPhone} is reserved as a sweep destination`,
        HttpStatus.CONFLICT,
      );
    }
    const treasuryDestination = await this.prisma.treasuryWallet.findFirst({
      where: { phoneNumber: { in: input.sims.map((sim) => sim.phoneNumber) }, status: { in: ['pending', 'active'] } },
      select: { phoneNumber: true },
    });
    if (treasuryDestination) {
      throw new ApiException('invalid_state', `SIM ${treasuryDestination.phoneNumber} is reserved as a treasury wallet`, HttpStatus.CONFLICT);
    }
    const activationCode = randomBytes(9).toString('base64url');
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const device = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.device.create({
        data: {
          groupId: input.groupId,
          name: input.name,
          model: input.model,
          sims: {
            create: input.sims.map((sim) => ({
              slot: sim.slot,
              iccid: sim.iccid,
              iccidHash: sha256(sim.iccid),
              phoneNumber: sim.phoneNumber,
              telebirrAccountName: sim.accountName,
            })),
          },
        },
        include: { sims: true },
      });
      await transaction.deviceActivationCode.create({ data: { deviceId: created.id, codeHash: sha256(activationCode), expiresAt } });
      const run = await transaction.deviceQualificationRun.create({
        data: {
          deviceId: created.id,
          checks: {
            create: [
              ...deviceQualificationKeys.map((key) => ({ key })),
              ...created.sims.flatMap((sim) => simQualificationKeys.map((key) => ({ key, simWalletId: sim.id }))),
            ],
          },
        },
      });
      await transaction.auditLog.create({ data: { actorType: 'platform_staff', actorId: input.actorId, action: 'device.created', targetType: 'device', targetId: created.id, metadata: { qualification_run_id: run.id, sim_count: created.sims.length } } });
      return { ...created, qualificationRunId: run.id };
    });
    return { id: device.id, name: device.name, model: device.model, status: device.status, sims: device.sims.map((sim) => ({ id: sim.id, slot: sim.slot, phone_number: sim.phoneNumber, account_name: sim.telebirrAccountName, status: sim.status })), activation_code: activationCode, activation_expires_at: expiresAt.toISOString(), qualification_run_id: device.qualificationRunId };
  }

  async regenerateActivationCode(deviceId: string, actorId: string) {
    const activationCode = randomBytes(9).toString('base64url');
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    await this.prisma.$transaction(async (transaction) => {
      const device = await transaction.device.findUnique({ where: { id: deviceId } });
      if (!device) throw new ApiException('not_found', 'Device was not found', HttpStatus.NOT_FOUND);
      if (device.authTokenHash) throw new ApiException('invalid_state', 'An activated device must be recovered through the credential-rotation procedure', HttpStatus.CONFLICT);
      await transaction.deviceActivationCode.updateMany({ where: { deviceId, consumedAt: null }, data: { consumedAt: new Date() } });
      await transaction.deviceActivationCode.create({ data: { deviceId, codeHash: sha256(activationCode), expiresAt } });
      await transaction.auditLog.create({ data: { actorType: 'platform_staff', actorId, action: 'device.activation_code_regenerated', targetType: 'device', targetId: deviceId } });
    });
    return { device_id: deviceId, activation_code: activationCode, activation_expires_at: expiresAt.toISOString() };
  }

  async qualification(deviceId: string) {
    const run = await this.prisma.deviceQualificationRun.findFirst({
      where: { deviceId },
      include: { device: { include: { sims: { orderBy: { slot: 'asc' } } } }, checks: { include: { simWallet: { select: { slot: true, phoneNumber: true } } }, orderBy: [{ simWalletId: 'asc' }, { key: 'asc' }] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!run) throw new ApiException('not_found', 'Qualification run was not found', HttpStatus.NOT_FOUND);
    return this.qualificationView(run);
  }

  async startQualification(deviceId: string, actorId: string) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`device-qualification:${deviceId}`}))`;
      const device = await transaction.device.findUnique({ where: { id: deviceId }, include: { sims: true } });
      if (!device) throw new ApiException('not_found', 'Device was not found', HttpStatus.NOT_FOUND);
      const active = await transaction.deviceQualificationRun.findFirst({ where: { deviceId, status: { in: ['pending', 'running', 'passed'] } }, include: { device: { include: { sims: { orderBy: { slot: 'asc' } } } }, checks: { include: { simWallet: { select: { slot: true, phoneNumber: true } } } } }, orderBy: { createdAt: 'desc' } });
      if (active) {
        if (active.status === 'pending') await transaction.deviceQualificationRun.update({ where: { id: active.id }, data: { status: 'running', startedAt: new Date() } });
        return this.qualificationView({ ...active, status: active.status === 'pending' ? 'running' : active.status, startedAt: active.startedAt ?? new Date() });
      }
      const run = await transaction.deviceQualificationRun.create({
        data: {
          deviceId,
          status: 'running',
          startedAt: new Date(),
          checks: { create: [...deviceQualificationKeys.map((key) => ({ key })), ...device.sims.flatMap((sim) => simQualificationKeys.map((key) => ({ key, simWalletId: sim.id })))] },
        },
        include: { device: { include: { sims: { orderBy: { slot: 'asc' } } } }, checks: { include: { simWallet: { select: { slot: true, phoneNumber: true } } } } },
      });
      await transaction.device.update({ where: { id: deviceId }, data: { status: 'qualifying' } });
      await transaction.simWallet.updateMany({ where: { deviceId }, data: { status: 'pending' } });
      await transaction.auditLog.create({ data: { actorType: 'platform_staff', actorId, action: 'device.qualification_started', targetType: 'device_qualification', targetId: run.id } });
      return this.qualificationView(run);
    });
  }

  async recordQualificationCheck(runId: string, checkId: string, input: { status: 'passed' | 'failed'; evidenceReference: string; notes?: string }, actorId: string) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`qualification-run:${runId}`}))`;
      const run = await transaction.deviceQualificationRun.findUnique({ where: { id: runId } });
      if (!run) throw new ApiException('not_found', 'Qualification run was not found', HttpStatus.NOT_FOUND);
      if (!['pending', 'running', 'passed', 'failed'].includes(run.status)) throw new ApiException('invalid_state', 'Qualification run is already finalized', HttpStatus.CONFLICT);
      const check = await transaction.deviceQualificationCheck.findFirst({ where: { id: checkId, runId } });
      if (!check) throw new ApiException('not_found', 'Qualification check was not found', HttpStatus.NOT_FOUND);
      await transaction.deviceQualificationCheck.update({ where: { id: check.id }, data: { status: input.status, evidence: { reference: input.evidenceReference, notes: input.notes ?? null }, observedAt: new Date(), recordedBy: actorId } });
      const checks = await transaction.deviceQualificationCheck.findMany({ where: { runId } });
      const complete = checks.every((item) => item.id === check.id || item.status !== 'pending');
      const allPassed = checks.every((item) => item.id === check.id ? input.status === 'passed' : item.status === 'passed');
      const status = complete ? (allPassed ? 'passed' : 'failed') : 'running';
      await transaction.deviceQualificationRun.update({ where: { id: runId }, data: { status, startedAt: run.startedAt ?? new Date(), completedAt: complete ? new Date() : null } });
      await transaction.auditLog.create({ data: { actorType: 'platform_staff', actorId, action: 'device.qualification_check_recorded', targetType: 'device_qualification_check', targetId: check.id, reason: input.notes, metadata: { run_id: runId, status: input.status, evidence_reference: input.evidenceReference } } });
      const updated = await transaction.deviceQualificationRun.findUniqueOrThrow({ where: { id: runId }, include: { device: { include: { sims: { orderBy: { slot: 'asc' } } } }, checks: { include: { simWallet: { select: { slot: true, phoneNumber: true } } }, orderBy: [{ simWalletId: 'asc' }, { key: 'asc' }] } } });
      return this.qualificationView(updated);
    });
  }

  async approveQualification(runId: string, reason: string, actorId: string) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`qualification-run:${runId}`}))`;
      const run = await transaction.deviceQualificationRun.findUnique({ where: { id: runId }, include: { device: true, checks: true } });
      if (!run) throw new ApiException('not_found', 'Qualification run was not found', HttpStatus.NOT_FOUND);
      if (run.status !== 'passed' || run.checks.some((check) => check.status !== 'passed')) throw new ApiException('invalid_state', 'Every mandatory qualification check must pass before approval', HttpStatus.CONFLICT);
      const latest = await transaction.deviceQualificationRun.findFirst({ where: { deviceId: run.deviceId }, orderBy: { createdAt: 'desc' } });
      if (latest?.id !== run.id) throw new ApiException('invalid_state', 'Only the latest qualification run can be approved', HttpStatus.CONFLICT);
      if (!run.device.lastHeartbeatAt || run.device.lastHeartbeatAt < new Date(Date.now() - 90_000) || !run.device.lastPermissionsOk || !run.device.lastAccessibilityOk || !run.device.openclawPaired) {
        throw new ApiException('invalid_state', 'Device must be online with permissions, Accessibility, and OpenClaw healthy at approval time', HttpStatus.CONFLICT);
      }
      const unsafeSims = await transaction.simWallet.count({ where: { deviceId: run.deviceId, status: { in: ['quarantined', 'disabled'] } } });
      if (unsafeSims > 0) throw new ApiException('invalid_state', 'A quarantined or disabled SIM cannot be approved', HttpStatus.CONFLICT);
      await transaction.deviceQualificationRun.update({ where: { id: run.id }, data: { status: 'approved', approvedAt: new Date(), approvedBy: actorId, approvalReason: reason } });
      await transaction.simWallet.updateMany({ where: { deviceId: run.deviceId, status: 'pending' }, data: { status: 'active' } });
      await transaction.device.update({ where: { id: run.deviceId }, data: { status: 'online' } });
      await transaction.auditLog.create({ data: { actorType: 'platform_staff', actorId, action: 'device.qualification_approved', targetType: 'device_qualification', targetId: run.id, reason } });
      const updated = await transaction.deviceQualificationRun.findUniqueOrThrow({ where: { id: run.id }, include: { device: { include: { sims: { orderBy: { slot: 'asc' } } } }, checks: { include: { simWallet: { select: { slot: true, phoneNumber: true } } }, orderBy: [{ simWalletId: 'asc' }, { key: 'asc' }] } } });
      return this.qualificationView(updated);
    });
  }

  async rejectQualification(runId: string, reason: string, actorId: string) {
    const run = await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.deviceQualificationRun.findUnique({ where: { id: runId } });
      if (!current) throw new ApiException('not_found', 'Qualification run was not found', HttpStatus.NOT_FOUND);
      if (['approved', 'rejected'].includes(current.status)) throw new ApiException('invalid_state', 'Qualification run is already finalized', HttpStatus.CONFLICT);
      const updated = await transaction.deviceQualificationRun.update({ where: { id: runId }, data: { status: 'rejected', completedAt: new Date(), approvedBy: actorId, approvalReason: reason } });
      await transaction.device.update({ where: { id: current.deviceId }, data: { status: 'qualifying' } });
      await transaction.simWallet.updateMany({ where: { deviceId: current.deviceId }, data: { status: 'pending' } });
      await transaction.auditLog.create({ data: { actorType: 'platform_staff', actorId, action: 'device.qualification_rejected', targetType: 'device_qualification', targetId: runId, reason } });
      return updated;
    });
    return this.qualification(run.deviceId);
  }

  private qualificationView(run: {
    id: string;
    deviceId: string;
    status: string;
    startedAt: Date | null;
    completedAt: Date | null;
    approvedAt: Date | null;
    approvedBy: string | null;
    approvalReason: string | null;
    createdAt: Date;
    device: { id: string; name: string; status: string; lastHeartbeatAt: Date | null; lastPermissionsOk: boolean; lastAccessibilityOk: boolean; openclawPaired: boolean; agentVersion: string | null; ussdProfileVersion: string | null; sims: Array<{ id: string; slot: number; iccid: string; phoneNumber: string; telebirrAccountName: string; status: string }> };
    checks: Array<{ id: string; simWalletId: string | null; key: string; status: string; evidence: unknown; observedAt: Date | null; recordedBy: string | null; simWallet: { slot: number; phoneNumber: string } | null }>;
  }) {
    return {
      id: run.id,
      device_id: run.deviceId,
      status: run.status,
      started_at: run.startedAt?.toISOString() ?? null,
      completed_at: run.completedAt?.toISOString() ?? null,
      approved_at: run.approvedAt?.toISOString() ?? null,
      approved_by: run.approvedBy,
      approval_reason: run.approvalReason,
      created_at: run.createdAt.toISOString(),
      device: {
        id: run.device.id,
        name: run.device.name,
        status: run.device.status,
        last_heartbeat_at: run.device.lastHeartbeatAt?.toISOString() ?? null,
        permissions_ok: run.device.lastPermissionsOk,
        accessibility_ok: run.device.lastAccessibilityOk,
        openclaw_paired: run.device.openclawPaired,
        agent_version: run.device.agentVersion,
        ussd_profile_version: run.device.ussdProfileVersion,
        sims: run.device.sims.map((sim) => ({ id: sim.id, slot: sim.slot, iccid_masked: `${sim.iccid.slice(0, 6)}••••${sim.iccid.slice(-4)}`, phone_number: sim.phoneNumber, account_name: sim.telebirrAccountName, status: sim.status })),
      },
      checks: run.checks.map((check) => ({ id: check.id, key: check.key, status: check.status, sim_wallet_id: check.simWalletId, sim_slot: check.simWallet?.slot ?? null, evidence: check.evidence, observed_at: check.observedAt?.toISOString() ?? null, recorded_by: check.recordedBy })),
    };
  }

  async fleet() {
    const locations = await this.prisma.fleetLocation.findMany({
      include: {
        groups: {
          include: {
            devices: { include: { sims: { orderBy: { slot: 'asc' } } }, orderBy: { name: 'asc' } },
            merchants: { select: { merchantId: true, dedicated: true, priority: true } },
          },
        },
      },
      orderBy: { name: 'asc' },
    });
    return locations.map((location) => ({
      id: location.id,
      name: location.name,
      code: location.code,
      timezone: location.timezone,
      groups: location.groups.map((group) => ({
        id: group.id,
        name: group.name,
        code: group.code,
        daily_limit: minorToAmount(group.dailyLimitMinor),
        wallet_ceiling: minorToAmount(group.walletCeilingMinor),
        safety_balance: minorToAmount(group.safetyBalanceMinor),
        safety_headroom: minorToAmount(group.safetyHeadroomMinor),
        merchant_policies: group.merchants.map((policy) => ({ merchant_id: policy.merchantId, dedicated: policy.dedicated, priority: policy.priority })),
        devices: group.devices.map((device) => ({
          id: device.id,
          name: device.name,
          model: device.model,
          status: device.status,
          last_heartbeat_at: device.lastHeartbeatAt?.toISOString() ?? null,
          battery_percent: device.batteryPercent,
          temperature_celsius: device.temperatureCelsius?.toString() ?? null,
          agent_version: device.agentVersion,
          ussd_profile_version: device.ussdProfileVersion,
          openclaw_paired: device.openclawPaired,
          permissions_ok: device.lastPermissionsOk,
          accessibility_ok: device.lastAccessibilityOk,
          sims: device.sims.map((sim) => ({
            id: sim.id,
            slot: sim.slot,
            phone_number_masked: `${sim.phoneNumber.slice(0, 5)}••••${sim.phoneNumber.slice(-3)}`,
            account_name: sim.telebirrAccountName,
            status: sim.status,
            main_balance: minorToAmount(sim.mainBalanceMinor),
            reserved_balance: minorToAmount(sim.reservedBalanceMinor),
            sent_today: minorToAmount(sim.sentTodayMinor),
            received_today: minorToAmount(sim.receivedTodayMinor),
            last_balance_at: sim.lastBalanceAt?.toISOString() ?? null,
            last_sms_at: sim.lastSmsAt?.toISOString() ?? null,
          })),
        })),
      })),
    }));
  }

  async treasuryWallets() {
    const wallets = await this.prisma.treasuryWallet.findMany({ include: { merchant: { select: { name: true } } }, orderBy: { createdAt: 'desc' } });
    return wallets.map((wallet) => ({
      id: wallet.id,
      merchant: wallet.merchant?.name ?? 'Platform treasury',
      environment: wallet.environment,
      phone_number: wallet.phoneNumber,
      account_name: wallet.accountName,
      status: wallet.status,
      predicted_balance: minorToAmount(wallet.predictedBalanceMinor),
      confirmed_balance: wallet.confirmedBalanceMinor === null ? null : minorToAmount(wallet.confirmedBalanceMinor),
      last_confirmed_at: wallet.lastConfirmedAt?.toISOString() ?? null,
    }));
  }

  async createTreasuryWallet(input: { merchantId?: string; environment: 'test' | 'live'; phoneNumber: string; accountName: string; actorId: string; reason: string }) {
    const enrolled = await this.prisma.simWallet.findUnique({ where: { phoneNumber: input.phoneNumber } });
    if (enrolled) throw new ApiException('invalid_state', 'A treasury destination cannot be an enrolled fleet SIM', HttpStatus.CONFLICT);
    return this.prisma.$transaction(async (transaction) => {
      const wallet = await transaction.treasuryWallet.upsert({
        where: { environment_phoneNumber: { environment: input.environment, phoneNumber: input.phoneNumber } },
        update: { merchantId: input.merchantId, accountName: input.accountName, status: 'active', approvedBy: input.actorId, approvedAt: new Date() },
        create: { merchantId: input.merchantId, environment: input.environment, phoneNumber: input.phoneNumber, accountName: input.accountName, status: 'active', approvedBy: input.actorId, approvedAt: new Date() },
      });
      await transaction.auditLog.create({ data: { merchantId: input.merchantId, actorType: 'platform_staff', actorId: input.actorId, action: 'treasury_wallet.approve', targetType: 'treasury_wallet', targetId: wallet.id, reason: input.reason, metadata: { environment: input.environment, phone_number_suffix: input.phoneNumber.slice(-4) } } });
      return { id: wallet.id, status: wallet.status, phone_number: wallet.phoneNumber, account_name: wallet.accountName };
    });
  }

  async confirmTreasuryBalance(walletId: string, balance: string, reason: string, actorId: string) {
    const amountMinor = BigInt(balance.replace('.', ''));
    return this.prisma.$transaction(async (transaction) => {
      const wallet = await transaction.treasuryWallet.update({ where: { id: walletId }, data: { predictedBalanceMinor: amountMinor, confirmedBalanceMinor: amountMinor, lastConfirmedAt: new Date() } });
      await transaction.auditLog.create({ data: { merchantId: wallet.merchantId, actorType: 'platform_staff', actorId, action: 'treasury_wallet.balance_confirmed', targetType: 'treasury_wallet', targetId: wallet.id, reason, metadata: { balance_minor: amountMinor.toString() } } });
      return { id: wallet.id, predicted_balance: minorToAmount(wallet.predictedBalanceMinor), confirmed_balance: minorToAmount(amountMinor), last_confirmed_at: wallet.lastConfirmedAt?.toISOString() ?? new Date().toISOString() };
    });
  }

  async queueBalance(simId: string) {
    const sim = await this.prisma.simWallet.findUnique({ where: { id: simId }, include: { device: true } });
    if (!sim) throw new ApiException('not_found', 'SIM wallet was not found', HttpStatus.NOT_FOUND);
    const existing = await this.prisma.deviceJob.findFirst({ where: { simWalletId: sim.id, type: 'balance_query', state: { in: ['queued', 'leased', 'device_started', 'committed', 'provider_pending'] } } });
    if (existing) return existing;
    return this.prisma.$transaction(async (transaction) => {
      const fenced = await transaction.simWallet.update({ where: { id: sim.id }, data: { nextFencingToken: { increment: 1n } } });
      return transaction.deviceJob.create({
        data: {
          type: 'balance_query',
          state: 'queued',
          priority: 100,
          deviceId: sim.deviceId,
          simWalletId: sim.id,
          profileVersion: CURRENT_DEVICE_PROFILE_VERSION_TEXT,
          payload: { sim_iccid: sim.iccid },
          fencingToken: fenced.nextFencingToken,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        },
      });
    });
  }

  async quarantine(deviceId: string, reason: string, actorId: string) {
    return this.prisma.$transaction(async (transaction) => {
      const device = await transaction.device.update({ where: { id: deviceId }, data: { status: 'quarantined' } });
      await transaction.simWallet.updateMany({ where: { deviceId }, data: { status: 'quarantined' } });
      await transaction.auditLog.create({ data: { actorType: 'platform_staff', actorId, action: 'device.quarantine', targetType: 'device', targetId: deviceId, reason } });
      return device;
    });
  }

  async beginDeviceRecovery(input: {
    deviceId: string;
    identities: Array<{ slot: number; iccid: string; phoneNumber: string; accountName: string }>;
    replacementHardware: boolean;
    reason: string;
    actorId: string;
  }) {
    const activationCode = randomBytes(9).toString('base64url');
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`device-recovery:${input.deviceId}`}))`;
      const device = await transaction.device.findUnique({ where: { id: input.deviceId }, include: { sims: { orderBy: { slot: 'asc' } } } });
      if (!device) throw new ApiException('not_found', 'Device was not found', HttpStatus.NOT_FOUND);
      if (!['quarantined', 'retired'].includes(device.status)) {
        throw new ApiException('invalid_state', 'Only a quarantined or retired device can enter credential recovery', HttpStatus.CONFLICT);
      }
      if (device.sims.length !== input.identities.length) {
        throw new ApiException('identity_mismatch', 'Every enrolled SIM identity must be verified during recovery', HttpStatus.CONFLICT);
      }
      for (const enrolled of device.sims) {
        const observed = input.identities.find((identity) => identity.slot === enrolled.slot);
        if (!recoverySimIdentityMatches(
          { slot: enrolled.slot, iccid: enrolled.iccid, phoneNumber: enrolled.phoneNumber, accountName: enrolled.telebirrAccountName },
          observed,
        )) {
          throw new ApiException('identity_mismatch', `SIM ${enrolled.slot + 1} identity does not match enrollment`, HttpStatus.CONFLICT);
        }
      }
      const simIds = device.sims.map((sim) => sim.id);
      const [activeJobs, activeTransfers, activeDeposits] = await Promise.all([
        transaction.deviceJob.count({
          where: { simWalletId: { in: simIds }, type: { notIn: ['balance_query', 'unknown_reconciliation'] }, state: { in: ['queued', 'leased', 'device_started', 'committed', 'provider_pending'] } },
        }),
        transaction.transfer.count({
          where: { simWalletId: { in: simIds }, status: { in: ['accepted', 'queued', 'device_assigned', 'device_started', 'committed', 'provider_pending', 'unknown', 'manual_review'] } },
        }),
        transaction.depositIntent.count({
          where: { simWalletId: { in: simIds }, status: { in: ['awaiting_payment', 'late_grace', 'matching', 'manual_review'] } },
        }),
      ]);
      if (activeJobs || activeTransfers || activeDeposits) {
        throw new ApiException('device_has_unresolved_financial_work', 'Resolve or expire every assigned financial operation before recovering this device', HttpStatus.CONFLICT, {
          active_jobs: activeJobs,
          active_transfers: activeTransfers,
          active_deposits: activeDeposits,
        });
      }
      await transaction.deviceActivationCode.updateMany({ where: { deviceId: device.id, consumedAt: null }, data: { consumedAt: new Date() } });
      await transaction.deviceQualificationRun.updateMany({
        where: { deviceId: device.id, status: { in: ['pending', 'running', 'passed', 'failed'] } },
        data: { status: 'rejected', completedAt: new Date(), approvalReason: 'Superseded by credential recovery', approvedBy: input.actorId },
      });
      await transaction.deviceJob.updateMany({
        where: { simWalletId: { in: simIds }, type: { in: ['balance_query', 'unknown_reconciliation'] }, state: { in: ['queued', 'leased', 'device_started', 'committed', 'provider_pending'] } },
        data: { state: 'cancelled', completedAt: new Date(), errorCode: 'DEVICE_CREDENTIAL_RECOVERY' },
      });
      const run = await transaction.deviceQualificationRun.create({
        data: {
          deviceId: device.id,
          status: 'pending',
          checks: { create: [...deviceQualificationKeys.map((key) => ({ key })), ...device.sims.flatMap((sim) => simQualificationKeys.map((key) => ({ key, simWalletId: sim.id })))] },
        },
      });
      await transaction.device.update({
        where: { id: device.id },
        data: {
          status: 'qualifying',
          authTokenHash: null,
          certificateFingerprint: null,
          activeUssdJobId: null,
          lastHeartbeatAt: null,
          lastPermissionsOk: false,
          lastAccessibilityOk: false,
          openclawPaired: false,
          ...(input.replacementHardware ? { hardwareSerial: null, imei1: null, imei2: null, buildFingerprint: null } : {}),
        },
      });
      await transaction.simWallet.updateMany({
        where: { deviceId: device.id },
        data: { status: 'pending', subscriptionId: null, lastBalanceAt: null, lastBalanceSource: 'recovery_requires_refresh' },
      });
      await transaction.deviceActivationCode.create({ data: { deviceId: device.id, codeHash: sha256(activationCode), expiresAt } });
      await transaction.auditLog.create({
        data: {
          actorType: 'platform_staff',
          actorId: input.actorId,
          action: 'device.recovery_started',
          targetType: 'device',
          targetId: device.id,
          reason: input.reason,
          metadata: { replacement_hardware: input.replacementHardware, qualification_run_id: run.id, sim_count: device.sims.length },
        },
      });
      return {
        device_id: device.id,
        activation_code: activationCode,
        activation_expires_at: expiresAt.toISOString(),
        qualification_run_id: run.id,
        required_next_steps: ['activate_device', 'verify_both_sim_identities', 'complete_qualification_checks', 'query_fresh_balances', 'platform_approve'],
      };
    }, { isolationLevel: 'Serializable', timeout: 20_000 });
  }

  async retireDevice(deviceId: string, reason: string, actorId: string) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`device-retire:${deviceId}`}))`;
      const device = await transaction.device.findUnique({ where: { id: deviceId }, include: { sims: true } });
      if (!device) throw new ApiException('not_found', 'Device was not found', HttpStatus.NOT_FOUND);
      if (device.status === 'retired') return { device_id: device.id, status: device.status };
      const simIds = device.sims.map((sim) => sim.id);
      const unresolved = await transaction.transfer.count({ where: { simWalletId: { in: simIds }, status: { in: ['accepted', 'queued', 'device_assigned', 'device_started', 'committed', 'provider_pending', 'unknown', 'manual_review'] } } });
      const activeDeposits = await transaction.depositIntent.count({ where: { simWalletId: { in: simIds }, status: { in: ['awaiting_payment', 'late_grace', 'matching', 'manual_review'] } } });
      if (unresolved || activeDeposits || device.activeUssdJobId) {
        throw new ApiException('device_has_unresolved_financial_work', 'Resolve or expire every assigned financial operation before retiring this device', HttpStatus.CONFLICT, { active_transfers: unresolved, active_deposits: activeDeposits });
      }
      await transaction.deviceActivationCode.updateMany({ where: { deviceId, consumedAt: null }, data: { consumedAt: new Date() } });
      await transaction.deviceJob.updateMany({ where: { simWalletId: { in: simIds }, type: { in: ['balance_query', 'unknown_reconciliation'] }, state: { in: ['queued', 'leased', 'device_started', 'committed', 'provider_pending'] } }, data: { state: 'cancelled', completedAt: new Date(), errorCode: 'DEVICE_RETIRED' } });
      await transaction.simWallet.updateMany({ where: { deviceId }, data: { status: 'disabled', subscriptionId: null } });
      await transaction.device.update({ where: { id: deviceId }, data: { status: 'retired', authTokenHash: null, certificateFingerprint: null, activeUssdJobId: null } });
      await transaction.auditLog.create({ data: { actorType: 'platform_staff', actorId, action: 'device.retired', targetType: 'device', targetId: deviceId, reason, metadata: { sim_count: device.sims.length } } });
      return { device_id: device.id, status: 'retired', reenrollment: 'Use the audited recover endpoint with verified SIM identities and replacement_hardware=true' };
    }, { isolationLevel: 'Serializable' });
  }

  async cases(status?: 'open' | 'proposed' | 'resolved' | 'rejected') {
    const cases = await this.prisma.reconciliationCase.findMany({ where: status ? { status } : undefined, orderBy: { createdAt: 'desc' }, take: 500 });
    const transferIds = cases.filter((item) => item.referenceType === 'transfer').map((item) => item.referenceId);
    const receiptIds = cases.filter((item) => item.referenceType === 'sms_receipt').map((item) => item.referenceId);
    const [transfers, receipts] = await Promise.all([
      this.prisma.transfer.findMany({
        where: { id: { in: transferIds } },
        include: {
          merchant: { select: { id: true, name: true } },
          simWallet: { include: { device: { select: { id: true, name: true } } } },
          attempts: { include: { deviceJob: true }, orderBy: { attemptNumber: 'asc' } },
        },
      }),
      this.prisma.smsReceipt.findMany({ where: { id: { in: receiptIds } }, include: { simWallet: { include: { device: { select: { id: true, name: true } } } } } }),
    ]);
    const transferById = new Map(transfers.map((item) => [item.id, item]));
    const receiptById = new Map(receipts.map((item) => [item.id, item]));
    return cases.map((item) => {
      const transfer = transferById.get(item.referenceId);
      const receipt = receiptById.get(item.referenceId);
      return {
        id: item.id,
        type: item.type,
        status: item.status,
        merchant_id: item.merchantId,
        reference_type: item.referenceType,
        reference_id: item.referenceId,
        evidence: item.evidence,
        proposal: item.proposal,
        resolution: item.resolution,
        created_at: item.createdAt.toISOString(),
        updated_at: item.updatedAt.toISOString(),
        transfer: transfer ? {
          id: transfer.id,
          merchant: transfer.merchant,
          reference: transfer.reference,
          status: transfer.status,
          amount: minorToAmount(transfer.amountMinor),
          destination_phone_masked: `${transfer.destinationPhone.slice(0, 5)}••••${transfer.destinationPhone.slice(-3)}`,
          expected_name: transfer.expectedName,
          resolved_name: transfer.resolvedName,
          provider_transaction_id: transfer.providerTransactionId,
          provider_fee: transfer.providerFeeMinor === null ? null : minorToAmount(transfer.providerFeeMinor),
          provider_vat: transfer.providerVatMinor === null ? null : minorToAmount(transfer.providerVatMinor),
          committed_at: transfer.committedAt?.toISOString() ?? null,
          created_at: transfer.createdAt.toISOString(),
          sim: transfer.simWallet ? { id: transfer.simWallet.id, device_id: transfer.simWallet.device.id, device_name: transfer.simWallet.device.name, slot: transfer.simWallet.slot, main_balance: minorToAmount(transfer.simWallet.mainBalanceMinor), last_balance_at: transfer.simWallet.lastBalanceAt?.toISOString() ?? null } : null,
          attempts: transfer.attempts.map((attempt) => ({ attempt_number: attempt.attemptNumber, outcome: attempt.outcome, error_code: attempt.errorCode, started_at: attempt.startedAt?.toISOString() ?? null, committed_at: attempt.committedAt?.toISOString() ?? null, completed_at: attempt.completedAt?.toISOString() ?? null, job: attempt.deviceJob ? { id: attempt.deviceJob.id, state: attempt.deviceJob.state, error_code: attempt.deviceJob.errorCode, last_screen_text: attempt.deviceJob.lastScreenText } : null })),
        } : null,
        receipt: receipt ? { id: receipt.id, sender: receipt.sender, type: receipt.type, amount: receipt.amountMinor === null ? null : minorToAmount(receipt.amountMinor), provider_transaction_id: receipt.providerTransactionId, counterparty_name: receipt.counterpartyName, counterparty_phone_suffix: receipt.counterpartyPhoneSuffix, provider_occurred_at: receipt.providerOccurredAt?.toISOString() ?? null, received_at: receipt.receivedAt.toISOString(), evidence_object_key: receipt.evidenceObjectKey, sim: { id: receipt.simWallet.id, device_name: receipt.simWallet.device.name, slot: receipt.simWallet.slot } } : null,
      };
    });
  }

  async resolveDeposit(caseId: string, depositId: string, reason: string, actorId: string) {
    return this.prisma.$transaction(async (transaction) => {
      const reconciliation = await transaction.reconciliationCase.findUnique({ where: { id: caseId } });
      if (!reconciliation || !['open', 'proposed'].includes(reconciliation.status)) {
        throw new ApiException('invalid_state', 'Reconciliation case is not open', HttpStatus.CONFLICT);
      }
      if (!['unmatched_deposit', 'ambiguous_deposit'].includes(reconciliation.type) || reconciliation.referenceType !== 'sms_receipt') {
        throw new ApiException('invalid_state', 'Case is not an unmatched deposit receipt', HttpStatus.CONFLICT);
      }
      const [receipt, deposit] = await Promise.all([
        transaction.smsReceipt.findUnique({ where: { id: reconciliation.referenceId } }),
        transaction.depositIntent.findUnique({ where: { id: depositId } }),
      ]);
      if (!receipt?.amountMinor || !receipt.providerTransactionId || !deposit || deposit.providerTransactionId || deposit.matchedReceiptId) {
        throw new ApiException('invalid_state', 'Receipt or deposit cannot be resolved', HttpStatus.CONFLICT);
      }
      const evidence = reconciliation.evidence as Record<string, unknown>;
      const suspenseMerchantId = String(evidence.suspense_merchant_id ?? '');
      const suspenseEnvironment = String(evidence.suspense_environment ?? 'live') as 'test' | 'live';
      if (!suspenseMerchantId) throw new ApiException('invalid_state', 'Case has no suspense journal owner', HttpStatus.CONFLICT);
      await this.ledger.releaseSuspenseToMerchant(
        transaction,
        { merchantId: suspenseMerchantId, environment: suspenseEnvironment },
        { merchantId: deposit.merchantId, environment: deposit.environment },
        reconciliation.id,
        receipt.amountMinor,
      );
      await transaction.depositIntent.update({
        where: { id: deposit.id },
        data: {
          status: 'success',
          creditedAmountMinor: receipt.amountMinor,
          matchedReceiptId: receipt.id,
          providerTransactionId: receipt.providerTransactionId,
        },
      });
      await transaction.reconciliationCase.update({ where: { id: reconciliation.id }, data: { status: 'resolved', resolution: { action: 'credit_deposit', deposit_id: deposit.id, reason } } });
      await transaction.auditLog.create({ data: { merchantId: deposit.merchantId, actorType: 'platform_staff', actorId, action: 'reconciliation.credit_deposit', targetType: 'deposit', targetId: deposit.id, reason } });
      await transaction.outboxEvent.create({
        data: {
          aggregateType: 'deposit',
          aggregateId: deposit.id,
          eventType: isMerchantTopupMetadata(deposit.metadata) ? 'topup.updated' : 'deposit.updated',
          payload: { tx_ref: deposit.txRef, status: 'success', p2p_status: 'success', manual_resolution: true },
        },
      });
      return { case_id: reconciliation.id, deposit_id: deposit.id, credited_amount: minorToAmount(receipt.amountMinor), status: 'resolved' };
    });
  }
}

function isMerchantTopupMetadata(metadata: Prisma.JsonValue | null): boolean {
  return Boolean(metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata._p2p_intent_kind === 'merchant_topup');
}
