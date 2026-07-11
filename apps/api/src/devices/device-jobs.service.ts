import { HttpStatus, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { DeviceJob, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { sha256, stableJson } from '../common/crypto';
import { ApiException } from '../common/api-exception';
import { PrismaService } from '../infra/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { deviceJobPayloadSchema, type ActivationRequest, type DeviceHeartbeat, type DeviceJobReport, type JobStatusEvent } from '@telebirr/contracts';
import { comparePersonNames } from '../parsers/name-normalizer';
import { DeviceSigningService } from './device-signing.service';
import { AlertsService } from '../alerts/alerts.service';
import { loadPlatformPolicy } from '../configuration/platform-policy';
import { addisFinancialDay } from '../fleet/sim-selection.service';
import { CURRENT_DEVICE_PROFILE_VERSION_TEXT } from './device-profile-version';
import { ussdDiagnosticLabel } from '../common/evidence-crypto';

const allowedTransitions: Record<string, string[]> = {
  leased: ['device_started', 'failed', 'cancelled'],
  device_started: ['committed', 'failed', 'cancelled'],
  committed: ['provider_pending', 'succeeded', 'failed', 'unknown'],
  provider_pending: ['succeeded', 'failed', 'unknown'],
};

export function financiallySafeReportState(
  reportedState: DeviceJob['state'],
  committedAt: Date | null,
  priorState: DeviceJob['state'] = 'leased',
  moneyMoving = true,
): DeviceJob['state'] {
  // A USSD success screen is not settlement evidence. Keep the operation in
  // provider-pending until the trusted 127 SMS proves success or expiry moves
  // it to unknown for reconciliation.
  if (reportedState === 'succeeded') return 'provider_pending';
  // A device_started report can reach the cloud before the handset persists
  // and uploads PIN_SUBMITTED. Once that boundary was observed, a later
  // failure/cancellation is not proof that money did not move.
  if (moneyMoving && (reportedState === 'failed' || reportedState === 'cancelled') && (committedAt !== null || priorState !== 'leased')) return 'unknown';
  return reportedState;
}

export function boundedJobObservedAt(reportedAtMs: number, serverReceivedAt: Date, jobCreatedAt: Date): { observedAt: Date; clockInvalid: boolean } {
  const lowerBound = jobCreatedAt.valueOf() - 60_000;
  const upperBound = serverReceivedAt.valueOf() + 60_000;
  const clockInvalid = !Number.isFinite(reportedAtMs) || reportedAtMs < lowerBound || reportedAtMs > upperBound;
  return { observedAt: clockInvalid ? serverReceivedAt : new Date(reportedAtMs), clockInvalid };
}

export function jobExpiryDisposition(state: DeviceJob['state'], committedAt: Date | null): 'release_precommit' | 'hold_unknown' {
  // Once the handset has acknowledged device_started, it may persist its local
  // PIN_SUBMITTED marker and enter the PIN before the cloud receives the next
  // spooled report. Expiry must therefore treat started money jobs as a
  // possible commit and hold every reservation for reconciliation.
  return committedAt !== null || state === 'leased' || state === 'device_started' || state === 'committed' || state === 'provider_pending' ? 'hold_unknown' : 'release_precommit';
}

export function qualificationControlledDeviceStatus(input: { quarantine: boolean; qualificationApproved: boolean; everySimApproved: boolean; permissionsOk: boolean; accessibilityOk: boolean }): 'quarantined' | 'qualifying' | 'online' | 'degraded' {
  if (input.quarantine) return 'quarantined';
  if (!input.qualificationApproved || !input.everySimApproved) return 'qualifying';
  return input.permissionsOk && input.accessibilityOk ? 'online' : 'degraded';
}

export function simRetainsQualification(status: string): boolean {
  return status === 'active' || status === 'payout_stale';
}

export function shouldReleaseDeviceLockAfterReport(effectiveState: DeviceJob['state']): boolean {
  return effectiveState === 'failed' || effectiveState === 'unknown' || effectiveState === 'cancelled';
}

export type PrecommitNameDisposition =
  | { kind: 'none' }
  | { kind: 'uncertain' | 'mismatch'; deterministic: ReturnType<typeof comparePersonNames>; expectedName: string; providerName: string };

/**
 * A handset may intentionally stop at the receiver-name screen before it ever
 * displays or submits the PIN.  Treat that result as pre-commit only when the
 * complete, backend-verifiable tuple agrees: exact state/reason, the job was
 * merely device_started, no commit marker exists, the expected name is exactly
 * the name stored on the transfer, and our own deterministic comparison agrees
 * with the handset's requested disposition.  Every malformed or generic
 * post-start failure remains unknown.
 */
export function classifyPrecommitNameDisposition(input: {
  priorState: DeviceJob['state'];
  committedAt: Date | null;
  reportedState: DeviceJob['state'];
  errorCode: string;
  storedExpectedName: string | null;
  reportedExpectedName?: string;
  providerReceiverName?: string;
}): PrecommitNameDisposition {
  if (input.priorState !== 'device_started' || input.committedAt !== null || !input.storedExpectedName) return { kind: 'none' };
  const expectedName = input.reportedExpectedName ?? '';
  const providerName = input.providerReceiverName?.trim() ?? '';
  if (expectedName !== input.storedExpectedName || !providerName) return { kind: 'none' };

  const deterministic = comparePersonNames(input.storedExpectedName, providerName);
  if (
    input.reportedState === 'cancelled' &&
    input.errorCode === 'RequestNameReview' &&
    deterministic.decision === 'uncertain'
  ) {
    return { kind: 'uncertain', deterministic, expectedName, providerName };
  }
  if (
    input.reportedState === 'failed' &&
    input.errorCode === 'ReceiverMismatch' &&
    deterministic.decision === 'mismatch'
  ) {
    return { kind: 'mismatch', deterministic, expectedName, providerName };
  }
  return { kind: 'none' };
}

export function jobStatusInboxDisposition(existingHash: string | null, incomingHash: string): 'process' | 'duplicate' | 'conflict' {
  if (existingHash === null) return 'process';
  return existingHash === incomingHash ? 'duplicate' : 'conflict';
}

interface SpoolStatusContext {
  eventId: string;
  payloadHash: string;
  event: JobStatusEvent;
}

@Injectable()
export class DeviceJobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly signing: DeviceSigningService,
    private readonly alerts: AlertsService,
  ) {}

  async activate(input: ActivationRequest, certificateFingerprint?: string) {
    const codeHash = sha256(input.activation_code.trim());
    const token = randomBytes(32).toString('base64url');
    const tokenHash = await argon2.hash(token);
    const device = await this.prisma.$transaction(async (transaction) => {
      const activation = await transaction.deviceActivationCode.findFirst({
        where: { codeHash, consumedAt: null, expiresAt: { gt: new Date() } },
      });
      if (!activation) throw new ApiException('forbidden', 'Activation code is invalid or expired', HttpStatus.FORBIDDEN);
      const claim = await transaction.deviceActivationCode.updateMany({
        where: { id: activation.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (claim.count !== 1) throw new ApiException('forbidden', 'Activation code was already consumed', HttpStatus.FORBIDDEN);
      return transaction.device.update({
        where: { id: activation.deviceId },
        data: {
          hardwareSerial: input.hardware_serial,
          model: `${input.manufacturer} ${input.model}`.trim(),
          buildFingerprint: input.build_fingerprint,
          agentVersion: input.app_version,
          authTokenHash: tokenHash,
          ...(certificateFingerprint ? { certificateFingerprint } : {}),
          status: 'qualifying',
        },
        include: { sims: { orderBy: { slot: 'asc' } } },
      });
    }, { isolationLevel: 'Serializable' });
    const publicApi = (process.env.PUBLIC_BASE_URL ?? process.env.PUBLIC_API_URL ?? 'https://localhost:3000').replace(/\/$/, '');
    const websocketUrl = process.env.DEVICE_GATEWAY_URL ?? `${publicApi.replace(/^http/i, 'ws')}/v1/device/connect`;
    return {
      device_id: device.id,
      device_token: token,
      websocket_url: websocketUrl,
      heartbeat_interval_seconds: 30,
      key_id: this.signing.keyId,
      signing_public_key_pem: this.signing.publicKeyPem,
      sims: device.sims.map((sim) => ({
        iccid: sim.iccid,
        telebirr_number: sim.phoneNumber,
        registered_name: sim.telebirrAccountName,
        expected_slot_index: sim.slot,
      })),
    };
  }

  async heartbeat(deviceId: string, heartbeat: DeviceHeartbeat): Promise<void> {
    if (heartbeat.device_id !== deviceId) throw new ApiException('forbidden', 'Heartbeat device ID does not match credentials', HttpStatus.FORBIDDEN);
    await this.prisma.$transaction(async (transaction) => {
      let quarantine = new Date(heartbeat.sent_at).valueOf() > Date.now() + 60_000;
      const enrolled = await transaction.simWallet.findMany({ where: { deviceId } });
      const reportedIccids = new Set(heartbeat.sims.map((sim) => sim.iccid));
      if (enrolled.some((sim) => !reportedIccids.has(sim.iccid))) quarantine = true;
      for (const identity of heartbeat.sims) {
        const sim = await transaction.simWallet.findUnique({ where: { iccid: identity.iccid } });
        if (
          !sim ||
          sim.deviceId !== deviceId ||
          sim.slot !== identity.slot ||
          sim.phoneNumber !== identity.phone_number ||
          comparePersonNames(sim.telebirrAccountName, identity.telebirr_account_name).decision !== 'match'
        ) {
          quarantine = true;
          if (sim) await transaction.simWallet.update({ where: { id: sim.id }, data: { status: 'quarantined' } });
          continue;
        }
        await transaction.simWallet.update({
          where: { id: sim.id },
          data: {
            subscriptionId: identity.subscription_id,
            telebirrAccountName: identity.telebirr_account_name,
          },
        });
      }
      const openQualification = await transaction.deviceQualificationRun.findFirst({ where: { deviceId, status: { in: ['pending', 'running'] } }, orderBy: { createdAt: 'desc' } });
      if (openQualification) {
        await transaction.deviceQualificationRun.update({ where: { id: openQualification.id }, data: { status: 'running', startedAt: openQualification.startedAt ?? new Date() } });
        const observedAt = new Date();
        for (const [key, passed] of [
          ['device_permissions', heartbeat.permissions_ok],
          ['accessibility_enabled', heartbeat.accessibility_ok],
        ] as const) {
          await transaction.deviceQualificationCheck.updateMany({
            where: { runId: openQualification.id, key },
            data: { status: passed ? 'passed' : 'failed', evidence: { source: 'signed_device_heartbeat', value: passed }, observedAt, recordedBy: `device:${deviceId}` },
          });
        }
      }
      const approvedQualification = await transaction.deviceQualificationRun.findFirst({ where: { deviceId, status: 'approved' }, select: { id: true } });
      const everySimApproved = enrolled.length > 0 && enrolled.every((sim) => simRetainsQualification(sim.status));
      await transaction.device.update({
        where: { id: deviceId },
        data: {
          agentVersion: heartbeat.agent_version,
          ussdProfileVersion: heartbeat.ussd_profile_version,
          buildFingerprint: heartbeat.build_fingerprint,
          lastHeartbeatAt: new Date(),
          lastPermissionsOk: heartbeat.permissions_ok,
          lastAccessibilityOk: heartbeat.accessibility_ok,
          openclawPaired: heartbeat.openclaw_paired,
          batteryPercent: Math.round(heartbeat.battery_percent),
          charging: heartbeat.charging,
          temperatureCelsius: heartbeat.temperature_celsius,
          networkType: heartbeat.network_type,
          status: qualificationControlledDeviceStatus({ quarantine, qualificationApproved: Boolean(approvedQualification), everySimApproved, permissionsOk: heartbeat.permissions_ok, accessibilityOk: heartbeat.accessibility_ok }),
        },
      });
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async expireFinancialJobs(): Promise<number> {
    const unknownReferences: string[] = [];
    const expiredCount = await this.prisma.$transaction(async (transaction) => {
      const lock = await transaction.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('device-job-expiry-sweeper')) AS acquired`;
      if (!lock[0]?.acquired) return 0;
      const jobs = await transaction.deviceJob.findMany({
        where: {
          state: { in: ['queued', 'leased', 'device_started', 'committed', 'provider_pending'] },
          OR: [
            { expiresAt: { lte: new Date() } },
            { leaseExpiresAt: { not: null, lte: new Date() } },
          ],
        },
        include: { transferAttempt: { include: { transfer: true } } },
        orderBy: { expiresAt: 'asc' },
        take: 250,
      });
      for (const job of jobs) {
        const attempt = job.transferAttempt;
        if (!attempt) {
          await transaction.deviceJob.update({ where: { id: job.id }, data: { state: 'failed', completedAt: new Date(), errorCode: 'JOB_EXPIRED_PRECOMMIT' } });
          await transaction.device.updateMany({ where: { activeUssdJobId: job.id }, data: { activeUssdJobId: null } });
          continue;
        }
        const transfer = attempt.transfer;
        if (['success', 'failed', 'unknown', 'manual_review', 'cancelled'].includes(transfer.status)) {
          const terminalJobState = transfer.status === 'success' ? 'succeeded' : transfer.status === 'failed' || transfer.status === 'cancelled' ? 'failed' : 'unknown';
          await transaction.deviceJob.update({ where: { id: job.id }, data: { state: terminalJobState, completedAt: new Date(), errorCode: 'JOB_EXPIRED_AFTER_TRANSFER_TERMINAL' } });
          await transaction.device.updateMany({ where: { activeUssdJobId: job.id }, data: { activeUssdJobId: null } });
          continue;
        }
        const disposition = jobExpiryDisposition(job.state, job.committedAt);
        const observedAt = new Date();
        if (disposition === 'hold_unknown') {
          const possibleCommitAt = job.committedAt ?? job.startedAt ?? job.createdAt;
          await transaction.deviceJob.update({ where: { id: job.id }, data: { state: 'unknown', committedAt: possibleCommitAt, completedAt: observedAt, errorCode: 'JOB_EXPIRED_AFTER_START_POSSIBLE_COMMIT' } });
          await transaction.transfer.update({ where: { id: transfer.id }, data: { status: 'unknown', committedAt: transfer.committedAt ?? possibleCommitAt } });
          await transaction.transferAttempt.update({ where: { id: attempt.id }, data: { committedAt: attempt.committedAt ?? possibleCommitAt, completedAt: observedAt, outcome: 'unknown', errorCode: 'JOB_EXPIRED_AFTER_START_POSSIBLE_COMMIT' } });
          await transaction.reconciliationCase.create({
            data: {
              merchantId: transfer.merchantId,
              type: 'unknown_payout',
              referenceType: 'transfer',
              referenceId: transfer.id,
              evidence: { job_id: job.id, reason: 'job_expired_after_start_possible_commit', possible_commit_at: possibleCommitAt.toISOString() },
            },
          });
          await this.updateExpiredLinkedOperation(transaction, transfer, 'unknown', observedAt);
          await this.emitExpiredTransferEvent(transaction, transfer, 'pending', 'unknown');
          unknownReferences.push(transfer.reference);
        } else {
          const auth = { merchantId: transfer.merchantId, environment: transfer.environment } as const;
          if (transfer.financialMode === 'merchant_debit') {
            await this.ledger.releaseWithdrawalReservation(
              transaction,
              auth,
              transfer.id,
              transfer.amountMinor + transfer.reserveProviderFeeMinor + transfer.gatewayFeeMinor,
            );
          } else {
            await this.ledger.releaseInternalMoveFee(transaction, auth, transfer.id, transfer.reserveProviderFeeMinor);
          }
          await transaction.simWallet.update({
            where: { id: job.simWalletId },
            data: { reservedBalanceMinor: { decrement: transfer.amountMinor + transfer.reserveProviderFeeMinor } },
          });
          await transaction.deviceJob.update({ where: { id: job.id }, data: { state: 'failed', completedAt: observedAt, errorCode: 'JOB_EXPIRED_PRECOMMIT' } });
          await transaction.transfer.update({ where: { id: transfer.id }, data: { status: 'failed', completedAt: observedAt } });
          await transaction.transferAttempt.update({ where: { id: attempt.id }, data: { completedAt: observedAt, outcome: 'failed', errorCode: 'JOB_EXPIRED_PRECOMMIT' } });
          await this.updateExpiredLinkedOperation(transaction, transfer, 'failed', observedAt);
          await this.emitExpiredTransferEvent(transaction, transfer, 'failed', 'failed');
        }
        await transaction.device.updateMany({ where: { activeUssdJobId: job.id }, data: { activeUssdJobId: null } });
      }
      return jobs.length;
    }, { isolationLevel: 'Serializable', timeout: 30_000 });
    for (const reference of unknownReferences) {
      await this.alerts.notify('unknown_payout', 'A payout job expired after device start; PIN submission is possible', { reference });
    }
    return expiredCount;
  }

  async leaseNext(deviceId: string) {
    let unknownReference: string | null = null;
    const result = await this.prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`device:${deviceId}`}))`;
        const device = await transaction.device.findUniqueOrThrow({ where: { id: deviceId } });
        if (device.status !== 'online' || !device.lastPermissionsOk || !device.lastAccessibilityOk) return null;
        if (device.activeUssdJobId) {
          const active = await transaction.deviceJob.findUnique({ where: { id: device.activeUssdJobId } });
          if (active && active.leaseExpiresAt && active.leaseExpiresAt > new Date()) return this.envelope(active);
          if (active && (active.committedAt || active.state === 'provider_pending' || (['leased', 'device_started'].includes(active.state) && !['balance_query', 'unknown_reconciliation'].includes(active.type)))) {
            unknownReference = await this.markExpiredCommittedUnknown(transaction, active);
          } else if (active) {
            const fencingToken = await this.allocateFence(transaction, active.simWalletId);
            await transaction.deviceJob.update({
              where: { id: active.id },
              data: { state: 'queued', deviceId: null, leaseOwner: null, leaseExpiresAt: null, attempt: { increment: 1 }, fencingToken },
            });
            await transaction.transferAttempt.updateMany({ where: { deviceJobId: active.id }, data: { fencingToken } });
          }
          await transaction.device.update({ where: { id: deviceId }, data: { activeUssdJobId: null } });
        }

        // Signed flow profiles are immutable. Upgrade only queued jobs that
        // have never been delivered, allocate a new fence, and leave every
        // leased/started/committed legacy attempt untouched for reconciliation.
        const legacyQueuedJobs = await transaction.deviceJob.findMany({
          where: {
            state: 'queued',
            profileVersion: { not: CURRENT_DEVICE_PROFILE_VERSION_TEXT },
            expiresAt: { gt: new Date() },
            simWallet: { deviceId },
          },
          select: { id: true, simWalletId: true },
          orderBy: { createdAt: 'asc' },
          take: 100,
        });
        for (const legacy of legacyQueuedJobs) {
          const fencingToken = await this.allocateFence(transaction, legacy.simWalletId);
          const upgraded = await transaction.deviceJob.updateMany({
            where: { id: legacy.id, state: 'queued', profileVersion: { not: CURRENT_DEVICE_PROFILE_VERSION_TEXT } },
            data: { profileVersion: CURRENT_DEVICE_PROFILE_VERSION_TEXT, fencingToken, signature: null },
          });
          if (upgraded.count === 1) {
            await transaction.transferAttempt.updateMany({ where: { deviceJobId: legacy.id }, data: { fencingToken } });
            await transaction.auditLog.create({
              data: {
                actorType: 'system',
                actorId: 'device-profile-upgrader',
                action: 'device_job.profile_upgraded_precommit',
                targetType: 'device_job',
                targetId: legacy.id,
                reason: `Queued job upgraded to signed profile ${CURRENT_DEVICE_PROFILE_VERSION_TEXT} before delivery`,
              },
            });
          }
        }

        const policy = await loadPlatformPolicy(transaction);
        const balanceCutoff = new Date(Date.now() - policy.balanceStaleSeconds * 1000);
        const job = await transaction.deviceJob.findFirst({
          where: {
            state: 'queued',
            profileVersion: CURRENT_DEVICE_PROFILE_VERSION_TEXT,
            expiresAt: { gt: new Date() },
            OR: [{ deviceId: null }, { deviceId }],
            AND: [{
              OR: [
                {
                  type: { in: ['balance_query', 'unknown_reconciliation'] },
                  simWallet: { deviceId, status: { in: ['pending', 'active', 'payout_stale'] } },
                },
                {
                  type: { notIn: ['balance_query', 'unknown_reconciliation'] },
                  simWallet: { deviceId, status: 'active', lastBalanceAt: { gte: balanceCutoff } },
                },
              ],
            }],
          },
          orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        });
        if (!job) return null;
        const leased = await transaction.deviceJob.update({
          where: { id: job.id },
          data: { state: 'leased', deviceId, leaseOwner: deviceId, leaseExpiresAt: new Date(Date.now() + 45_000) },
        });
        await transaction.device.update({ where: { id: deviceId }, data: { activeUssdJobId: leased.id } });
        return this.envelope(leased);
      },
      { isolationLevel: 'Serializable' },
    );
    if (unknownReference) {
      await this.alerts.notify('unknown_payout', 'A delivered payout lease expired; PIN submission is possible', { reference: unknownReference });
    }
    return result;
  }

  async renew(deviceId: string, jobId: string, fencingToken: number) {
    const result = await this.prisma.deviceJob.updateMany({
      where: { id: jobId, deviceId, fencingToken: BigInt(fencingToken), state: { in: ['leased', 'device_started', 'committed', 'provider_pending'] } },
      data: { leaseExpiresAt: new Date(Date.now() + 45_000) },
    });
    if (result.count !== 1) throw new ApiException('invalid_state', 'Job lease or fencing token is stale', HttpStatus.CONFLICT);
    return { lease_expires_at: new Date(Date.now() + 45_000).toISOString() };
  }

  async report(deviceId: string, jobId: string, report: DeviceJobReport, spoolContext?: SpoolStatusContext): Promise<void> {
    const state = report.state;
    const serverReceivedAt = new Date();
    let unknownReference: string | null = null;
    let invalidClock = false;
    await this.prisma.$transaction(async (transaction) => {
      const job = await transaction.deviceJob.findUnique({
        where: { id: jobId },
        include: { transferAttempt: { include: { transfer: true } } },
      });
      if (!job || job.deviceId !== deviceId || job.fencingToken !== BigInt(report.fencing_token)) {
        throw new ApiException('invalid_state', 'Job lease or fencing token is stale', HttpStatus.CONFLICT);
      }
      if (!spoolContext && !['balance_query', 'unknown_reconciliation'].includes(job.type)) {
        // Financial transitions must arrive through the monotonic WebSocket
        // spool so their event ID, signed-job operation identity and atomic
        // inbox marker are enforced. The legacy HTTPS endpoint is retained
        // only for non-money diagnostic jobs.
        throw new ApiException('financial_status_requires_spool', 'Money-moving job reports require the durable device spool', HttpStatus.CONFLICT);
      }
      if (spoolContext) {
        const existing = await transaction.inboxEvent.findUnique({
          where: { source_externalId: { source: 'device_job_status', externalId: spoolContext.eventId } },
        });
        const replayDisposition = jobStatusInboxDisposition(existing?.payloadHash ?? null, spoolContext.payloadHash);
        if (replayDisposition === 'duplicate') return;
        if (replayDisposition === 'conflict') {
          throw new ApiException('duplicate_event_conflict', 'Device status event ID was reused with a different payload', HttpStatus.CONFLICT);
        }
        const source = job.payload as Record<string, unknown>;
        const expectedOperationId = String(source.transfer_id ?? source.financial_operation_id ?? job.id);
        if (spoolContext.event.financial_operation_id !== expectedOperationId) {
          throw new ApiException('invalid_state', 'Device status financial operation does not match the signed job', HttpStatus.CONFLICT);
        }
      }
      const precommitNameDisposition = spoolContext
        ? classifyPrecommitNameDisposition({
            priorState: job.state,
            committedAt: job.committedAt,
            reportedState: state,
            errorCode: spoolContext.event.error_code,
            storedExpectedName: job.transferAttempt?.transfer.expectedName ?? null,
            reportedExpectedName: spoolContext.event.expected_receiver_name,
            providerReceiverName: spoolContext.event.provider_receiver_name,
          })
        : { kind: 'none' } as const;
      const boundedTime = boundedJobObservedAt(report.observed_at_ms, serverReceivedAt, job.createdAt);
      const observedAt = boundedTime.observedAt;
      invalidClock = boundedTime.clockInvalid;
      if (invalidClock) {
        await transaction.device.update({ where: { id: deviceId }, data: { status: 'quarantined' } });
        await transaction.simWallet.update({ where: { id: job.simWalletId }, data: { status: 'quarantined' } });
      }
      if (job.state === 'unknown' && job.transferAttempt && ['device_started', 'committed', 'provider_pending', 'succeeded', 'failed', 'unknown'].includes(state)) {
        // Durable handset evidence can arrive after the expiry sweeper has
        // already moved a started operation to unknown. Preserve the unknown
        // financial state and held reservations, but retain the late evidence
        // so a trusted provider SMS can still match and staff can reconcile it.
        const possibleCommitAt = ['committed', 'provider_pending', 'succeeded'].includes(state)
          ? (job.committedAt ?? observedAt)
          : job.committedAt;
        await transaction.deviceJob.update({
          where: { id: job.id },
          data: {
            committedAt: possibleCommitAt,
            lastScreenText: ussdDiagnosticLabel(report.screen_text),
            errorCode: report.error_code || job.errorCode,
          },
        });
        if (possibleCommitAt) {
          await transaction.transfer.updateMany({
            where: { id: job.transferAttempt.transferId, committedAt: null },
            data: { committedAt: possibleCommitAt },
          });
          await transaction.transferAttempt.updateMany({
            where: { id: job.transferAttempt.id, committedAt: null },
            data: { committedAt: possibleCommitAt },
          });
        }
        if (spoolContext) await this.persistSpoolStatusOutcome(transaction, job, spoolContext, precommitNameDisposition);
        return;
      }
      if (!allowedTransitions[job.state]?.includes(state)) {
        if (job.state === state) {
          if (spoolContext) await this.persistSpoolStatusOutcome(transaction, job, spoolContext, precommitNameDisposition);
          return;
        }
        throw new ApiException('invalid_state', `Cannot transition ${job.state} to ${state}`, HttpStatus.CONFLICT);
      }
      if (state === 'device_started' && !['balance_query', 'unknown_reconciliation'].includes(job.type)) {
        const policy = await loadPlatformPolicy(transaction);
        const cutoff = new Date(Date.now() - policy.balanceStaleSeconds * 1000);
        const heartbeatCutoff = new Date(Date.now() - 90_000);
        const eligible = await transaction.simWallet.findFirst({
          where: {
            id: job.simWalletId,
            status: 'active',
            lastBalanceAt: { gte: cutoff },
            device: {
              id: deviceId,
              status: 'online',
              lastHeartbeatAt: { gte: heartbeatCutoff },
              lastPermissionsOk: true,
              lastAccessibilityOk: true,
            },
          },
          select: {
            id: true,
            mainBalanceMinor: true,
            reservedBalanceMinor: true,
            sentTodayMinor: true,
            financialDay: true,
            device: { select: { group: { select: { dailyLimitMinor: true, safetyBalanceMinor: true } } } },
          },
        });
        const financialDay = addisFinancialDay(new Date());
        const sentToday = eligible?.financialDay && addisFinancialDay(eligible.financialDay).valueOf() === financialDay.valueOf()
          ? eligible.sentTodayMinor
          : 0n;
        const hasReservedLiquidity = Boolean(eligible && eligible.mainBalanceMinor - eligible.reservedBalanceMinor >= eligible.device.group.safetyBalanceMinor);
        const hasDailyHeadroom = Boolean(eligible && sentToday + eligible.reservedBalanceMinor <= eligible.device.group.dailyLimitMinor);
        if (!eligible || !hasReservedLiquidity || !hasDailyHeadroom) {
          throw new ApiException('device_not_qualified', 'SIM or handset is not eligible to start a money-moving job', HttpStatus.CONFLICT);
        }
      }
      // A generic device failure is only financially final before the PIN commit
      // point. After commit, a late provider SMS can still prove success, so the
      // only safe state is unknown/manual reconciliation and reservations stay held.
      const moneyMoving = !['balance_query', 'unknown_reconciliation'].includes(job.type);
      const effectiveState = precommitNameDisposition.kind === 'uncertain'
        ? 'cancelled'
        : precommitNameDisposition.kind === 'mismatch'
          ? 'failed'
          : financiallySafeReportState(state, job.committedAt, job.state, moneyMoving);
      const possibleCommitAt = moneyMoving && effectiveState === 'unknown' && job.state !== 'leased'
        ? (job.committedAt ?? job.startedAt ?? observedAt)
        : effectiveState === 'committed'
          ? observedAt
          : job.committedAt;
      const committed = Boolean(possibleCommitAt);
      await transaction.deviceJob.update({
        where: { id: job.id },
        data: {
          state: effectiveState,
          startedAt: effectiveState === 'device_started' ? observedAt : job.startedAt,
          committedAt: possibleCommitAt,
          completedAt: ['succeeded', 'failed', 'unknown', 'cancelled'].includes(effectiveState) ? observedAt : undefined,
          lastScreenText: ussdDiagnosticLabel(report.screen_text),
          errorCode: report.error_code,
        },
      });
      if (job.transferAttempt) await this.updateTransferForReport(transaction, job, report, effectiveState, observedAt, committed, possibleCommitAt);
      if (effectiveState === 'unknown' && job.transferAttempt) unknownReference = job.transferAttempt.transfer.reference;
      // A handset-reported "succeeded" is deliberately downgraded to
      // provider_pending until a trusted 127 SMS correlates the transfer. Do
      // not release the handset-wide USSD lock in that case. The SMS ingestion
      // path clears it only after authoritative settlement evidence arrives.
      if (shouldReleaseDeviceLockAfterReport(effectiveState)) {
        await transaction.device.updateMany({ where: { id: deviceId, activeUssdJobId: job.id }, data: { activeUssdJobId: null } });
      }
      if (spoolContext) await this.persistSpoolStatusOutcome(transaction, job, spoolContext, precommitNameDisposition);
    }, { isolationLevel: 'Serializable' });
    if (unknownReference) {
      await this.alerts.notify('unknown_payout', 'A post-commit payout requires manual reconciliation', {
        reference: unknownReference,
        device_id: deviceId,
        job_id: jobId,
      });
    }
    if (invalidClock) {
      await this.alerts.notify('reconciliation_drift', 'A device job reported an implausible timestamp and was quarantined', {
        device_id: deviceId,
        job_id: jobId,
      });
    }
  }

  async reportFromSpool(deviceId: string, event: JobStatusEvent, eventId: string): Promise<void> {
    await this.report(deviceId, event.job_id, {
      fencing_token: event.fencing_token,
      state: event.state,
      observed_at_ms: event.observed_at_ms,
      provider_transaction_id: event.provider_transaction_id ?? undefined,
      error_code: event.error_code.slice(0, 80),
    }, {
      eventId,
      event,
      payloadHash: sha256(stableJson(event)),
    });
  }

  private async persistSpoolStatusOutcome(
    transaction: Prisma.TransactionClient,
    job: Prisma.DeviceJobGetPayload<{ include: { transferAttempt: { include: { transfer: true } } } }>,
    context: SpoolStatusContext,
    nameDisposition: PrecommitNameDisposition,
  ): Promise<void> {
    const attempt = job.transferAttempt;
    if (attempt && nameDisposition.kind !== 'none') {
      const caseType = nameDisposition.kind === 'uncertain' ? 'receiver_name_review' : 'receiver_name_mismatch';
      const existing = await transaction.reconciliationCase.findFirst({
        where: {
          type: caseType,
          referenceType: 'transfer',
          referenceId: attempt.transferId,
          ...(nameDisposition.kind === 'uncertain' ? { status: { in: ['open', 'proposed'] } } : {}),
        },
      });
      if (!existing) {
        await transaction.reconciliationCase.create({
          data: {
            merchantId: attempt.transfer.merchantId,
            type: caseType,
            status: nameDisposition.kind === 'mismatch' ? 'resolved' : 'open',
            referenceType: 'transfer',
            referenceId: attempt.transferId,
            evidence: {
              expected_name: nameDisposition.expectedName,
              observed_name: nameDisposition.providerName,
              deterministic: {
                decision: nameDisposition.deterministic.decision,
                score: nameDisposition.deterministic.score,
                normalized_expected: nameDisposition.deterministic.normalizedExpected,
                normalized_observed: nameDisposition.deterministic.normalizedObserved,
                reason: nameDisposition.deterministic.reason,
              },
              job_id: job.id,
              spool_event_id: context.eventId,
            },
            ...(nameDisposition.kind === 'mismatch'
              ? { resolution: { outcome: 'deterministic_precommit_mismatch', resolved_at: new Date().toISOString() } }
              : {}),
          },
        });
      }
    }
    // Insert last: the inbox marker proves the entire financial transition and
    // any associated reconciliation case committed atomically.
    await transaction.inboxEvent.create({
      data: {
        source: 'device_job_status',
        externalId: context.eventId,
        payloadHash: context.payloadHash,
      },
    });
  }

  async renewActiveForConnection(deviceId: string, expectedJobId?: string, expectedFence?: number) {
    return this.prisma.$transaction(async (transaction) => {
      const device = await transaction.device.findUnique({ where: { id: deviceId } });
      if (!device?.activeUssdJobId) return null;
      const job = await transaction.deviceJob.findUnique({ where: { id: device.activeUssdJobId } });
      if (!job || !['leased', 'device_started', 'committed', 'provider_pending'].includes(job.state)) return null;
      if (expectedJobId && job.id !== expectedJobId) throw new ApiException('invalid_state', 'Lease renewal job is stale', HttpStatus.CONFLICT);
      if (expectedFence !== undefined && job.fencingToken !== BigInt(expectedFence)) {
        throw new ApiException('invalid_state', 'Lease renewal fencing token is stale', HttpStatus.CONFLICT);
      }
      const issuedAt = Date.now();
      const leaseExpiresAt = issuedAt + 45_000;
      await transaction.deviceJob.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(leaseExpiresAt) } });
      return this.signing.signJson({
        job_id: job.id,
        device_id: deviceId,
        fencing_token: Number(job.fencingToken),
        issued_at_ms: issuedAt,
        lease_expires_at_ms: leaseExpiresAt,
      });
    });
  }

  private async updateTransferForReport(
    transaction: Prisma.TransactionClient,
    job: Prisma.DeviceJobGetPayload<{ include: { transferAttempt: { include: { transfer: true } } } }>,
    report: DeviceJobReport,
    reportState: string,
    observedAt: Date,
    wasCommitted: boolean,
    possibleCommitAt: Date | null,
  ): Promise<void> {
    const attempt = job.transferAttempt!;
    const transfer = attempt.transfer;
    const status =
      reportState === 'device_started'
        ? 'device_started'
        : reportState === 'committed'
          ? 'committed'
          : reportState === 'provider_pending'
            ? 'provider_pending'
            : reportState === 'unknown'
              ? 'unknown'
              : reportState === 'cancelled'
                ? 'manual_review'
                : reportState === 'failed'
                ? wasCommitted
                  ? 'failed'
                  : 'failed'
                : transfer.status;
    await transaction.transfer.update({
      where: { id: transfer.id },
      data: {
        status,
        committedAt: (reportState === 'committed' || reportState === 'unknown') && possibleCommitAt
          ? (transfer.committedAt ?? possibleCommitAt)
          : transfer.committedAt,
        completedAt: reportState === 'failed' ? observedAt : undefined,
      },
    });
    if (['device_started', 'committed', 'provider_pending', 'failed', 'unknown', 'cancelled'].includes(reportState)) {
      await transaction.outboxEvent.create({
        data: {
          aggregateType: 'transfer',
          aggregateId: transfer.id,
          eventType: 'transfer.updated',
          payload: {
            reference: transfer.reference,
            status: status === 'failed' ? 'failed' : 'pending',
            p2p_status: status,
          },
        },
      });
    }
    if (['device_started', 'committed', 'provider_pending', 'failed', 'unknown', 'cancelled'].includes(reportState)) {
      const sweepStatus = reportState === 'cancelled' ? 'manual_review' : reportState;
      await transaction.sweepExecution.updateMany({
        where: { transferId: transfer.id },
        data: {
          status: sweepStatus as 'device_started' | 'committed' | 'provider_pending' | 'failed' | 'unknown' | 'manual_review',
          completedAt: ['failed'].includes(reportState) ? observedAt : undefined,
        },
      });
      if (['failed', 'unknown', 'cancelled'].includes(reportState)) {
        await transaction.settlementRequest.updateMany({
          where: { transferId: transfer.id },
          data: { status: reportState === 'cancelled' ? 'manual_review' : reportState as 'failed' | 'unknown' },
        });
      }
    }
    await transaction.transferAttempt.update({
      where: { id: attempt.id },
      data: {
        startedAt: reportState === 'device_started' ? observedAt : undefined,
        committedAt: (reportState === 'committed' || reportState === 'unknown') && possibleCommitAt ? possibleCommitAt : undefined,
        completedAt: ['failed', 'unknown'].includes(reportState) ? observedAt : undefined,
        outcome: ['failed', 'unknown'].includes(reportState) ? reportState : undefined,
        errorCode: report.error_code,
      },
    });
    if (reportState === 'failed') {
      const auth = { merchantId: transfer.merchantId, environment: transfer.environment } as const;
      const total = transfer.amountMinor + transfer.reserveProviderFeeMinor + transfer.gatewayFeeMinor;
      if (transfer.financialMode === 'merchant_debit') {
        await this.ledger.releaseWithdrawalReservation(transaction, auth, transfer.id, total);
      } else {
        await this.ledger.releaseInternalMoveFee(transaction, auth, transfer.id, transfer.reserveProviderFeeMinor);
      }
      await transaction.simWallet.update({
        where: { id: job.simWalletId },
        data: { reservedBalanceMinor: { decrement: transfer.amountMinor + transfer.reserveProviderFeeMinor } },
      });
    }
    if (reportState === 'unknown') {
      await transaction.reconciliationCase.create({
        data: {
          merchantId: transfer.merchantId,
          type: 'unknown_payout',
          referenceType: 'transfer',
          referenceId: transfer.id,
          evidence: { job_id: job.id, screen_state: ussdDiagnosticLabel(report.screen_text), error_code: report.error_code, possible_commit_at: possibleCommitAt?.toISOString() },
        },
      });
    }
    if (reportState === 'cancelled') {
      await transaction.reconciliationCase.create({
        data: {
          merchantId: transfer.merchantId,
          type: 'precommit_cancelled',
          referenceType: 'transfer',
          referenceId: transfer.id,
          evidence: { job_id: job.id, error_code: report.error_code },
        },
      });
    }
  }

  private async markExpiredCommittedUnknown(transaction: Prisma.TransactionClient, job: DeviceJob): Promise<string | null> {
    const attempt = await transaction.transferAttempt.findUnique({ where: { deviceJobId: job.id }, include: { transfer: true } });
    if (attempt) {
      if (['success', 'failed', 'unknown', 'manual_review', 'cancelled'].includes(attempt.transfer.status)) {
        const state = attempt.transfer.status === 'success' ? 'succeeded' : attempt.transfer.status === 'failed' || attempt.transfer.status === 'cancelled' ? 'failed' : 'unknown';
        await transaction.deviceJob.update({ where: { id: job.id }, data: { state, completedAt: new Date(), errorCode: 'LEASE_EXPIRED_AFTER_TRANSFER_TERMINAL' } });
        return null;
      }
      const observedAt = new Date();
      const possibleCommitAt = job.committedAt ?? job.startedAt ?? job.createdAt;
      await transaction.deviceJob.update({ where: { id: job.id }, data: { state: 'unknown', committedAt: possibleCommitAt, completedAt: observedAt, errorCode: 'LEASE_EXPIRED_AFTER_START_POSSIBLE_COMMIT' } });
      await transaction.transfer.update({ where: { id: attempt.transferId }, data: { status: 'unknown', committedAt: attempt.transfer.committedAt ?? possibleCommitAt } });
      await transaction.transferAttempt.update({ where: { id: attempt.id }, data: { committedAt: attempt.committedAt ?? possibleCommitAt, completedAt: observedAt, outcome: 'unknown', errorCode: 'LEASE_EXPIRED_AFTER_START_POSSIBLE_COMMIT' } });
      await transaction.reconciliationCase.create({
        data: {
          merchantId: attempt.transfer.merchantId,
          type: 'unknown_payout',
          referenceType: 'transfer',
          referenceId: attempt.transferId,
          evidence: { job_id: job.id, reason: 'lease_expired_after_start_possible_commit', possible_commit_at: possibleCommitAt.toISOString() },
        },
      });
      await this.updateExpiredLinkedOperation(transaction, attempt.transfer, 'unknown', observedAt);
      await this.emitExpiredTransferEvent(transaction, attempt.transfer, 'pending', 'unknown');
      return attempt.transfer.reference;
    }
    await transaction.deviceJob.update({ where: { id: job.id }, data: { state: 'unknown', completedAt: new Date(), errorCode: 'LEASE_EXPIRED_AFTER_COMMIT' } });
    return null;
  }

  private async updateExpiredLinkedOperation(
    transaction: Prisma.TransactionClient,
    transfer: Prisma.TransferGetPayload<Record<string, never>>,
    status: 'failed' | 'unknown',
    observedAt: Date,
  ): Promise<void> {
    const settlement = await transaction.settlementRequest.findUnique({ where: { transferId: transfer.id } });
    if (settlement) {
      await transaction.settlementRequest.update({ where: { id: settlement.id }, data: { status } });
      await transaction.outboxEvent.create({
        data: {
          aggregateType: 'settlement',
          aggregateId: settlement.id,
          eventType: 'settlement.updated',
          payload: { reference: settlement.reference, status: status === 'failed' ? 'failed' : 'pending', p2p_status: status },
        },
      });
    }
    const sweep = await transaction.sweepExecution.findUnique({ where: { transferId: transfer.id } });
    if (sweep) {
      await transaction.sweepExecution.update({ where: { id: sweep.id }, data: { status, completedAt: status === 'failed' ? observedAt : undefined } });
      await transaction.outboxEvent.create({
        data: {
          aggregateType: 'sweep_execution',
          aggregateId: sweep.id,
          eventType: 'sweep.updated',
          payload: { reference: transfer.reference, rule_id: sweep.ruleId, transfer_reference: transfer.reference, status: status === 'failed' ? 'failed' : 'pending', p2p_status: status },
        },
      });
    }
  }

  private async emitExpiredTransferEvent(
    transaction: Prisma.TransactionClient,
    transfer: Prisma.TransferGetPayload<Record<string, never>>,
    status: 'pending' | 'failed',
    p2pStatus: 'failed' | 'unknown',
  ): Promise<void> {
    await transaction.outboxEvent.create({
      data: {
        aggregateType: 'transfer',
        aggregateId: transfer.id,
        eventType: 'transfer.updated',
        payload: { reference: transfer.reference, status, p2p_status: p2pStatus },
      },
    });
  }

  private envelope(job: DeviceJob) {
    const source = job.payload as Record<string, unknown>;
    const issuedAt = Date.now();
    const profileVersion = Number.parseInt(job.profileVersion, 10);
    if (!Number.isSafeInteger(profileVersion) || profileVersion <= 0) {
      throw new ApiException('invalid_state', 'Device job has an invalid signed profile version', HttpStatus.CONFLICT);
    }
    const unsigned = {
      job_id: job.id,
      device_id: job.deviceId!,
      financial_operation_id: String(source.transfer_id ?? source.financial_operation_id ?? job.id),
      type: job.type,
      sim_iccid: String(source.sim_iccid ?? ''),
      profile_id:
        job.type === 'balance_query'
          ? 'telebirr.balance-query.v1'
          : job.type === 'customer_withdrawal'
            ? 'telebirr.send-money.v1'
            : `telebirr.${job.type.replaceAll('_', '-')}.v1`,
      profile_version: profileVersion,
      attempt: job.attempt,
      fencing_token: Number(job.fencingToken),
      issued_at_ms: issuedAt,
      lease_expires_at_ms: job.leaseExpiresAt?.valueOf() ?? issuedAt + 45_000,
      job_expires_at_ms: job.expiresAt.valueOf(),
      ...(source.destination_phone ? { destination_phone: String(source.destination_phone) } : {}),
      ...(source.amount ? { amount_etb: String(source.amount) } : {}),
      ...(source.expected_name ? { expected_receiver_name: String(source.expected_name) } : {}),
      ...(source.approved_provider_name ? { approved_provider_name: String(source.approved_provider_name) } : {}),
    };
    deviceJobPayloadSchema.parse(unsigned);
    return this.signing.signJson(unsigned);
  }

  private async allocateFence(transaction: Prisma.TransactionClient, simWalletId: string): Promise<bigint> {
    const sim = await transaction.simWallet.update({ where: { id: simWalletId }, data: { nextFencingToken: { increment: 1n } } });
    return sim.nextFencingToken;
  }
}
