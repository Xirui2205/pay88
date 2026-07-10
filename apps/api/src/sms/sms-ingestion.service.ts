import { HttpStatus, Injectable } from '@nestjs/common';
import type { DepositIntent, Prisma, SimStatus } from '@prisma/client';
import { ApiException } from '../common/api-exception';
import type { SmsIngest } from '@telebirr/contracts';
import { PrismaService } from '../infra/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { comparePersonNames } from '../parsers/name-normalizer';
import { isTrustedTelebirrSmsSender, matchesMaskedEthiopianPhone, parseTelebirrSms, type ParsedSms } from '../parsers/sms-parser';
import { sha256 } from '../common/crypto';
import { AlertsService } from '../alerts/alerts.service';
import { EvidenceStoreService } from './evidence-store.service';
import { addisFinancialDay } from '../fleet/sim-selection.service';
import { encryptEvidence } from '../common/evidence-crypto';

export function balanceRefreshStatus(current: SimStatus): SimStatus | undefined {
  return current === 'payout_stale' ? 'active' : undefined;
}

const BALANCE_QUERY_MAX_AGE_MS = 15 * 60_000;
const DEVICE_RECEIPT_CLOCK_SKEW_MS = 60_000;
const PROVIDER_TIME_MAX_DELAY_MS = 7 * 24 * 60 * 60_000;
const PROVIDER_TIME_MAX_FUTURE_SKEW_MS = 5 * 60_000;
const CORRELATABLE_BALANCE_JOB_STATES = ['device_started', 'committed', 'provider_pending'] as const;

type BalanceQueryLeaseCandidate = {
  id: string;
  state: string;
  deviceId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  expiresAt: Date;
  startedAt: Date | null;
  createdAt: Date;
};

/**
 * Keep this check independent from the database filter so a malformed/stale
 * lease can never become financial evidence merely because it was returned by
 * a broad query. A balance job must have actually started; a leased-only job
 * does not prove that *127# was run.
 */
export function correlatableBalanceQueryLeases<T extends BalanceQueryLeaseCandidate>(jobs: T[], observedAt: Date): T[] {
  const earliestStart = observedAt.valueOf() - BALANCE_QUERY_MAX_AGE_MS;
  const latestStart = observedAt.valueOf() + DEVICE_RECEIPT_CLOCK_SKEW_MS;
  return jobs.filter(
    (job) =>
      CORRELATABLE_BALANCE_JOB_STATES.includes(job.state as (typeof CORRELATABLE_BALANCE_JOB_STATES)[number]) &&
      Boolean(job.deviceId) &&
      job.leaseOwner === job.deviceId &&
      Boolean(job.startedAt) &&
      job.startedAt!.valueOf() >= earliestStart &&
      job.startedAt!.valueOf() <= latestStart &&
      job.createdAt.valueOf() >= earliestStart &&
      job.createdAt.valueOf() <= latestStart &&
      Boolean(job.leaseExpiresAt) &&
      job.leaseExpiresAt!.valueOf() >= observedAt.valueOf() &&
      job.expiresAt.valueOf() >= observedAt.valueOf(),
  );
}

export function resultingOutgoingBalance(currentBalanceMinor: bigint, providerBalanceMinor: bigint | null, totalOutflowMinor: bigint): bigint {
  return providerBalanceMinor ?? currentBalanceMinor - totalOutflowMinor;
}

export function effectiveProviderOccurredAt(providerOccurredAt: Date | null, receivedAt: Date): Date {
  if (!providerOccurredAt) return receivedAt;
  const value = providerOccurredAt.valueOf();
  if (value < receivedAt.valueOf() - PROVIDER_TIME_MAX_DELAY_MS || value > receivedAt.valueOf() + PROVIDER_TIME_MAX_FUTURE_SKEW_MS) return receivedAt;
  return providerOccurredAt;
}

type SmsIngestResult = {
  duplicate: boolean;
  type: string;
  matched_reference?: string;
  reconciliation_case_id?: string;
  correlation_status?: 'matched' | 'unmatched' | 'ambiguous';
};

@Injectable()
export class SmsIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly alerts: AlertsService,
    private readonly evidence: EvidenceStoreService,
  ) {}

  async ingest(deviceId: string, event: SmsIngest): Promise<SmsIngestResult> {
    const serverReceivedAt = new Date();
    const reportedReceivedAt = new Date(event.received_at);
    const futureDeviceClock = reportedReceivedAt.valueOf() > serverReceivedAt.valueOf() + DEVICE_RECEIPT_CLOCK_SKEW_MS;
    let oldBalanceDeviceClock = false;
    const result: SmsIngestResult = await this.prisma.$transaction(
      async (transaction) => {
        const existing = await transaction.inboxEvent.findUnique({ where: { source_externalId: { source: 'device_sms', externalId: event.event_id } } });
        if (existing) return { duplicate: true, type: 'already_processed' };
        const sim = await transaction.simWallet.findUnique({ where: { iccid: event.sim_iccid }, include: { device: true } });
        if (!sim || sim.deviceId !== deviceId) {
          throw new ApiException('forbidden', 'SMS SIM identity is not enrolled on this device', HttpStatus.FORBIDDEN);
        }
        if (futureDeviceClock) {
          await transaction.simWallet.update({ where: { id: sim.id }, data: { status: 'quarantined' } });
          await transaction.device.update({ where: { id: deviceId }, data: { status: 'quarantined' } });
        }
        const candidate = parseTelebirrSms(event.body);
        const parsed: ParsedSms = isTrustedTelebirrSmsSender(event.sender)
          ? candidate
          : { type: 'unknown', raw: event.body, reason: 'untrusted_sender' };
        if (parsed.type === 'balance' && !futureDeviceClock) {
          const activeBalanceJob = await transaction.deviceJob.findFirst({
            where: { simWalletId: sim.id, type: 'balance_query', state: { in: [...CORRELATABLE_BALANCE_JOB_STATES] } },
            select: { createdAt: true },
            orderBy: { createdAt: 'desc' },
          });
          oldBalanceDeviceClock = Boolean(activeBalanceJob && reportedReceivedAt.valueOf() < activeBalanceJob.createdAt.valueOf() - DEVICE_RECEIPT_CLOCK_SKEW_MS);
          if (oldBalanceDeviceClock) {
            await transaction.simWallet.update({ where: { id: sim.id }, data: { status: 'quarantined' } });
            await transaction.device.update({ where: { id: deviceId }, data: { status: 'quarantined' } });
          }
        }
        const receivedAt = futureDeviceClock || oldBalanceDeviceClock ? serverReceivedAt : reportedReceivedAt;
        await transaction.inboxEvent.create({
          data: { source: 'device_sms', externalId: event.event_id, payloadHash: sha256(event.body) },
        });
        if ('providerTransactionId' in parsed) {
          const duplicateTransaction = await transaction.smsReceipt.findUnique({ where: { providerTransactionId: parsed.providerTransactionId } });
          if (duplicateTransaction) return { duplicate: true, type: parsed.type };
        }
        const receipt = await transaction.smsReceipt.create({
          data: {
            eventId: event.event_id,
            simWalletId: sim.id,
            sender: event.sender,
            direction: parsed.type === 'outgoing_transfer' ? 'outgoing' : 'incoming',
            type: parsed.type,
            rawBody: encryptEvidence(event.body),
            bodyHash: sha256(event.body),
            parsed: serializeParsed(parsed),
            providerTransactionId: 'providerTransactionId' in parsed ? parsed.providerTransactionId : undefined,
            amountMinor: 'amountMinor' in parsed ? parsed.amountMinor : undefined,
            counterpartyName: parsed.type === 'incoming_transfer' ? parsed.senderName : parsed.type === 'outgoing_transfer' ? parsed.receiverName : undefined,
            counterpartyPhoneSuffix:
              parsed.type === 'incoming_transfer' ? parsed.senderPhoneSuffix : parsed.type === 'outgoing_transfer' ? parsed.receiverPhoneSuffix : undefined,
            counterpartyPhonePrefix:
              parsed.type === 'incoming_transfer' ? parsed.senderPhonePrefix : parsed.type === 'outgoing_transfer' ? parsed.receiverPhonePrefix : undefined,
            providerOccurredAt: 'providerOccurredAt' in parsed ? parsed.providerOccurredAt : undefined,
            receivedAt,
            multipartReference: event.multipart_reference,
          },
        });
        await transaction.simWallet.update({ where: { id: sim.id }, data: { lastSmsAt: receivedAt } });

        if (parsed.type === 'balance') {
          if (oldBalanceDeviceClock) {
            const clockCase = await transaction.reconciliationCase.create({
              data: {
                type: 'device_clock_invalid_balance_sms',
                referenceType: 'sms_receipt',
                referenceId: receipt.id,
                evidence: { device_id: deviceId, reported_received_at: event.received_at, server_received_at: serverReceivedAt.toISOString(), sim_quarantined: true },
              },
            });
            return { duplicate: false, type: parsed.type, correlation_status: 'unmatched', reconciliation_case_id: clockCase.id };
          }
          const correlation = await this.applyBalance(transaction, sim.id, receipt.id, event.sender, parsed, receivedAt);
          return {
            duplicate: false,
            type: parsed.type,
            correlation_status: correlation.status,
            ...(correlation.caseId ? { reconciliation_case_id: correlation.caseId } : {}),
          };
        }
        if (parsed.type === 'incoming_transfer') {
          const matched = await this.matchIncoming(transaction, sim.id, receipt.id, parsed, receivedAt, effectiveProviderOccurredAt(parsed.providerOccurredAt, receivedAt));
          return { duplicate: false, type: parsed.type, ...(matched ? { matched_reference: matched } : {}) };
        }
        if (parsed.type === 'outgoing_transfer') {
          const matched = await this.matchOutgoing(transaction, sim.id, receipt.id, parsed, receivedAt);
          return {
            duplicate: false,
            type: parsed.type,
            ...(matched.matchedReference ? { matched_reference: matched.matchedReference } : {}),
            ...(matched.caseId ? { reconciliation_case_id: matched.caseId } : {}),
            ...(matched.status ? { correlation_status: matched.status } : {}),
          };
        }
        await transaction.reconciliationCase.create({
          data: { type: 'unknown_sms', referenceType: 'sms_receipt', referenceId: receipt.id, evidence: { sender: event.sender, body_hash: receipt.bodyHash } },
        });
        return { duplicate: false, type: 'unknown' };
      },
      { isolationLevel: 'Serializable', timeout: 15_000 },
    );
    const matchedReference = 'matched_reference' in result ? result.matched_reference : undefined;
    if (!result.duplicate && result.type === 'incoming_transfer' && !matchedReference) {
      await this.alerts.notify('unmatched_receipt', 'An incoming Telebirr receipt could not be matched uniquely', {
        event_id: event.event_id,
        sim_iccid_suffix: event.sim_iccid.slice(-4),
      });
    }
    if (!result.duplicate && (futureDeviceClock || oldBalanceDeviceClock)) {
      await this.alerts.notify('reconciliation_drift', 'An implausible device SMS timestamp was clamped and the SIM was quarantined', {
        event_id: event.event_id,
        device_id: deviceId,
        sim_iccid_suffix: event.sim_iccid.slice(-4),
        clock_direction: futureDeviceClock ? 'future' : 'old_before_query',
      });
    }
    if (!result.duplicate && result.type === 'balance' && result.correlation_status !== 'matched') {
      await this.alerts.notify('reconciliation_drift', 'A balance SMS was retained but not applied because query correlation was not unique', {
        event_id: event.event_id,
        reconciliation_case_id: result.reconciliation_case_id ?? null,
        correlation_status: result.correlation_status ?? null,
        sim_iccid_suffix: event.sim_iccid.slice(-4),
      });
    }
    if (!result.duplicate && result.type === 'outgoing_transfer' && !matchedReference) {
      await this.alerts.notify('reconciliation_drift', 'An authenticated outgoing Telebirr receipt could not be matched uniquely; the SIM was quarantined', {
        event_id: event.event_id,
        reconciliation_case_id: result.reconciliation_case_id ?? null,
        correlation_status: result.correlation_status ?? null,
        sim_iccid_suffix: event.sim_iccid.slice(-4),
      });
    }
    if (!result.duplicate && result.type === 'outgoing_transfer' && matchedReference) {
      const contradictory = await this.prisma.reconciliationCase.findFirst({
        where: {
          type: 'late_success_after_manual_failure',
          referenceType: 'transfer',
          referenceId: {
            in: (await this.prisma.transfer.findMany({ where: { reference: matchedReference }, select: { id: true } })).map((item) => item.id),
          },
        },
        select: { id: true },
      });
      if (contradictory) {
        await this.alerts.notify('reconciliation_drift', 'Late provider success contradicted a staff failure resolution', {
          reference: matchedReference,
          case_id: contradictory.id,
        });
      }
    }
    if (!result.duplicate) void this.evidence.persistByEvent(event.event_id);
    return result;
  }

  private async applyBalance(
    transaction: Prisma.TransactionClient,
    simWalletId: string,
    receiptId: string,
    sender: string,
    parsed: Extract<ParsedSms, { type: 'balance' }>,
    observedAt: Date,
  ): Promise<{ status: 'matched' | 'unmatched' | 'ambiguous'; caseId?: string }> {
    const earliestStart = new Date(observedAt.valueOf() - BALANCE_QUERY_MAX_AGE_MS);
    const latestStart = new Date(observedAt.valueOf() + DEVICE_RECEIPT_CLOCK_SKEW_MS);
    const jobs = await transaction.deviceJob.findMany({
      where: {
        simWalletId,
        type: 'balance_query',
        state: { in: [...CORRELATABLE_BALANCE_JOB_STATES] },
        deviceId: { not: null },
        leaseOwner: { not: null },
        leaseExpiresAt: { gte: observedAt },
        expiresAt: { gte: observedAt },
        startedAt: { not: null, gte: earliestStart, lte: latestStart },
        createdAt: { gte: earliestStart, lte: latestStart },
      },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });
    const candidates = isTrustedTelebirrSmsSender(sender) ? correlatableBalanceQueryLeases(jobs, observedAt) : [];
    if (candidates.length !== 1) {
      const status = candidates.length > 1 ? 'ambiguous' : 'unmatched';
      const reconciliation = await transaction.reconciliationCase.create({
        data: {
          type: status === 'ambiguous' ? 'ambiguous_balance_sms' : 'unmatched_balance_sms',
          referenceType: 'sms_receipt',
          referenceId: receiptId,
          evidence: {
            sender,
            observed_at: observedAt.toISOString(),
            candidate_job_ids: candidates.map((item) => item.id),
            balances_minor: {
              main: parsed.mainBalanceMinor.toString(),
              incentive: parsed.incentiveBalanceMinor.toString(),
              fuel: parsed.fuelBalanceMinor.toString(),
              pocket_money: parsed.pocketMoneyBalanceMinor.toString(),
            },
            wallet_mutated: false,
            reason: status === 'ambiguous' ? 'multiple_active_recent_balance_query_leases' : 'no_active_recent_balance_query_lease',
          },
        },
      });
      return { status, caseId: reconciliation.id };
    }

    const currentSim = await transaction.simWallet.findUniqueOrThrow({ where: { id: simWalletId }, select: { status: true, lastBalanceAt: true } });
    if (currentSim.lastBalanceAt && currentSim.lastBalanceAt > observedAt) {
      const reconciliation = await transaction.reconciliationCase.create({
        data: {
          type: 'stale_balance_sms',
          referenceType: 'sms_receipt',
          referenceId: receiptId,
          evidence: {
            sender,
            observed_at: observedAt.toISOString(),
            current_snapshot_at: currentSim.lastBalanceAt.toISOString(),
            candidate_job_ids: candidates.map((item) => item.id),
            wallet_mutated: false,
            reason: 'balance_sms_older_than_current_snapshot',
          },
        },
      });
      return { status: 'unmatched', caseId: reconciliation.id };
    }
    await transaction.balanceSnapshot.create({
      data: {
        simWalletId,
        mainBalanceMinor: parsed.mainBalanceMinor,
        incentiveBalanceMinor: parsed.incentiveBalanceMinor,
        fuelBalanceMinor: parsed.fuelBalanceMinor,
        pocketMoneyBalanceMinor: parsed.pocketMoneyBalanceMinor,
        source: 'balance_sms',
        observedAt,
      },
    });
    await transaction.simWallet.update({
      where: { id: simWalletId },
      data: {
        mainBalanceMinor: parsed.mainBalanceMinor,
        incentiveBalanceMinor: parsed.incentiveBalanceMinor,
        fuelBalanceMinor: parsed.fuelBalanceMinor,
        pocketMoneyBalanceMinor: parsed.pocketMoneyBalanceMinor,
        lastBalanceAt: observedAt,
        lastBalanceSource: 'balance_sms',
        // A balance response may recover a stale, already-approved wallet, but
        // it must never promote a pending/quarantined SIM around qualification.
        status: balanceRefreshStatus(currentSim.status),
      },
    });
    const job = candidates[0];
    await transaction.deviceJob.update({ where: { id: job.id }, data: { state: 'succeeded', completedAt: observedAt } });
    if (job.deviceId) await transaction.device.updateMany({ where: { id: job.deviceId, activeUssdJobId: job.id }, data: { activeUssdJobId: null } });
    return { status: 'matched' };
  }

  private async matchIncoming(
    transaction: Prisma.TransactionClient,
    simWalletId: string,
    receiptId: string,
    parsed: Extract<ParsedSms, { type: 'incoming_transfer' }>,
    receivedAt: Date,
    occurredAt: Date,
  ): Promise<string | null> {
    const deposits = await transaction.depositIntent.findMany({
      where: {
        simWalletId,
        status: { in: ['awaiting_payment', 'late_grace', 'matching', 'manual_review', 'expired'] },
        createdAt: { lte: occurredAt },
      },
      include: { merchant: { include: { config: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const strong = deposits.filter((deposit) => this.strongDepositMatch(deposit, parsed, occurredAt));
    if (strong.length !== 1) {
      const potential = deposits.filter((deposit) => matchesMaskedEthiopianPhone(deposit.customerPhone, parsed.senderPhonePrefix, parsed.senderPhoneSuffix));
      let suspenseMerchantId: string;
      let suspenseEnvironment: 'test' | 'live';
      const uniqueOwners = new Map(potential.map((item) => [`${item.merchantId}:${item.environment}`, item]));
      if (uniqueOwners.size === 1) {
        const owner = [...uniqueOwners.values()][0];
        suspenseMerchantId = owner.merchantId;
        suspenseEnvironment = owner.environment;
      } else {
        const system = await transaction.merchant.upsert({
          where: { slug: 'system-suspense' },
          update: {},
          create: { slug: 'system-suspense', name: 'System Suspense', status: 'active', config: { create: {} } },
        });
        suspenseMerchantId = system.id;
        suspenseEnvironment = 'live';
      }
      await this.ledger.moveReceiptToSuspense(
        transaction,
        { merchantId: suspenseMerchantId, environment: suspenseEnvironment },
        receiptId,
        parsed.amountMinor,
      );
      const balanceMutation = await this.transactionBalanceMutation(transaction, simWalletId, occurredAt, parsed.currentMainBalanceMinor, parsed.amountMinor, 'increment');
      await this.updateWalletCounters(transaction, simWalletId, {
        receivedDelta: parsed.amountMinor,
        data: balanceMutation.data,
      });
      await transaction.reconciliationCase.create({
        data: {
          merchantId: strong.length ? strong[0].merchantId : undefined,
          type: strong.length > 1 ? 'ambiguous_deposit' : 'unmatched_deposit',
          referenceType: 'sms_receipt',
          referenceId: receiptId,
          evidence: {
            candidates: potential.map((item) => item.id),
            provider_transaction_id: parsed.providerTransactionId,
            suspense_merchant_id: suspenseMerchantId,
            suspense_environment: suspenseEnvironment,
          },
        },
      });
      if (strong.length > 1) await transaction.depositIntent.updateMany({ where: { id: { in: strong.map((item) => item.id) } }, data: { status: 'manual_review' } });
      return null;
    }
    const deposit = strong[0];
    const auth = { merchantId: deposit.merchantId, environment: deposit.environment } as const;
    await this.ledger.creditDeposit(transaction, auth, deposit.id, parsed.amountMinor);
    await transaction.depositIntent.update({
      where: { id: deposit.id },
      data: {
        status: 'success',
        creditedAmountMinor: parsed.amountMinor,
        matchedReceiptId: receiptId,
        providerTransactionId: parsed.providerTransactionId,
      },
    });
    const balanceMutation = await this.transactionBalanceMutation(transaction, simWalletId, occurredAt, parsed.currentMainBalanceMinor, parsed.amountMinor, 'increment');
    await this.updateWalletCounters(transaction, simWalletId, {
      receivedDelta: parsed.amountMinor,
      data: balanceMutation.data,
    });
    await transaction.outboxEvent.create({
      data: {
        aggregateType: 'deposit',
        aggregateId: deposit.id,
        eventType: isMerchantTopup(deposit.metadata) ? 'topup.updated' : 'deposit.updated',
        payload: { tx_ref: deposit.txRef, status: 'success', p2p_status: 'success', credited_amount_minor: parsed.amountMinor.toString() },
      },
    });
    return deposit.txRef;
  }

  private strongDepositMatch(
    deposit: DepositIntent & { merchant: { config: { wrongAmountToleranceMinor: bigint } | null } },
    parsed: Extract<ParsedSms, { type: 'incoming_transfer' }>,
    occurredAt: Date,
  ): boolean {
    if (!matchesMaskedEthiopianPhone(deposit.customerPhone, parsed.senderPhonePrefix, parsed.senderPhoneSuffix)) return false;
    if (!depositStatusAllowsProviderTimeMatch(deposit.status, deposit.createdAt, deposit.lateGraceEndsAt, occurredAt)) return false;
    const tolerance = deposit.merchant.config?.wrongAmountToleranceMinor ?? 0n;
    const difference = deposit.amountMinor > parsed.amountMinor ? deposit.amountMinor - parsed.amountMinor : parsed.amountMinor - deposit.amountMinor;
    if (difference > tolerance) return false;
    return comparePersonNames(deposit.customerName, parsed.senderName).decision === 'match';
  }

  private async matchOutgoing(
    transaction: Prisma.TransactionClient,
    simWalletId: string,
    receiptId: string,
    parsed: Extract<ParsedSms, { type: 'outgoing_transfer' }>,
    receivedAt: Date,
  ): Promise<{ matchedReference: string | null; status?: 'unmatched' | 'ambiguous'; caseId?: string }> {
    const occurredAt = effectiveProviderOccurredAt(parsed.providerOccurredAt, receivedAt);
    const committedAfter = new Date(occurredAt.valueOf() - 30 * 60_000);
    const committedBefore = new Date(occurredAt.valueOf() + 5 * 60_000);
    const transfers = await transaction.transfer.findMany({
      where: {
        simWalletId,
        amountMinor: parsed.amountMinor,
        // A staff-proven failure can still be contradicted by a delayed,
        // provider-authenticated success SMS. Keep post-commit failed transfers
        // matchable so the real outflow is never lost from the ledger.
        status: { in: ['committed', 'provider_pending', 'unknown', 'failed', 'success'] },
        destinationPhone: { endsWith: parsed.receiverPhoneSuffix },
        committedAt: { gte: committedAfter, lte: committedBefore },
      },
      orderBy: { committedAt: 'desc' },
      take: 100,
    });
    const maskedPhoneCandidates = transfers.filter((transfer) => matchesMaskedEthiopianPhone(transfer.destinationPhone, parsed.receiverPhonePrefix, parsed.receiverPhoneSuffix));
    const matches = maskedPhoneCandidates.filter((transfer) =>
      comparePersonNames(transfer.resolvedName ?? transfer.expectedName, parsed.receiverName).decision === 'match'
      && (transfer.status !== 'success' || transfer.providerTransactionId === parsed.providerTransactionId),
    );
    if (matches.length !== 1) {
      const totalOutflowMinor = parsed.amountMinor + parsed.serviceFeeMinor + parsed.vatMinor;
      const wallet = await transaction.simWallet.findUniqueOrThrow({
        where: { id: simWalletId },
        select: { mainBalanceMinor: true, lastBalanceAt: true },
      });
      const balanceMutation = transactionBalanceMutationForWallet(wallet, occurredAt, parsed.currentMainBalanceMinor, totalOutflowMinor, 'decrement');
      const resultingBalanceMinor = balanceMutation.resultingBalanceMinor;
      await this.updateWalletCounters(transaction, simWalletId, {
        sentDelta: totalOutflowMinor,
        data: {
          status: 'quarantined',
          ...balanceMutation.data,
        },
      });
      const owners = new Set(transfers.map((item) => item.merchantId));
      const status = matches.length > 1 ? 'ambiguous' : 'unmatched';
      const reconciliation = await transaction.reconciliationCase.create({
        data: {
          merchantId: owners.size === 1 ? [...owners][0] : undefined,
          type: status === 'ambiguous' ? 'ambiguous_payout_sms' : 'unmatched_payout_sms',
          referenceType: 'sms_receipt',
          referenceId: receiptId,
          evidence: {
            candidates: transfers.map((item) => item.id),
            deterministic_name_matches: matches.map((item) => item.id),
            provider_transaction_id: parsed.providerTransactionId,
            receiver_name: parsed.receiverName,
            receiver_phone_suffix: parsed.receiverPhoneSuffix,
            total_outflow_minor: totalOutflowMinor.toString(),
            provider_reported_balance_minor: parsed.currentMainBalanceMinor?.toString() ?? null,
            previous_predicted_balance_minor: wallet.mainBalanceMinor.toString(),
            resulting_balance_minor: resultingBalanceMinor.toString(),
            sent_today_delta_minor: totalOutflowMinor.toString(),
            sim_quarantined: true,
          },
        },
      });
      return { matchedReference: null, status, caseId: reconciliation.id };
    }
    const transfer = matches[0];
    if (transfer.status === 'success' && transfer.providerTransactionId === parsed.providerTransactionId) {
      // Staff already settled the journal and applied the physical delta from
      // conclusive evidence. The delayed provider SMS corroborates that result;
      // applying its amount or balance again would double-count the outflow.
      return { matchedReference: transfer.reference };
    }
    const auth = { merchantId: transfer.merchantId, environment: transfer.environment } as const;
    const actualProviderFee = parsed.serviceFeeMinor + parsed.vatMinor;
    const releasedAfterCommit = transfer.status === 'failed';
    if (releasedAfterCommit) {
      if (transfer.financialMode === 'merchant_debit') {
        await this.ledger.restoreReleasedWithdrawalForLateSuccess(
          transaction,
          auth,
          transfer.id,
          transfer.amountMinor + transfer.reserveProviderFeeMinor + transfer.gatewayFeeMinor,
        );
      } else {
        await this.ledger.restoreReleasedInternalMoveFeeForLateSuccess(
          transaction,
          auth,
          transfer.id,
          transfer.reserveProviderFeeMinor,
        );
      }
      await transaction.reconciliationCase.create({
        data: {
          merchantId: transfer.merchantId,
          type: 'late_success_after_manual_failure',
          referenceType: 'transfer',
          referenceId: transfer.id,
          evidence: {
            receipt_id: receiptId,
            provider_transaction_id: parsed.providerTransactionId,
            warning: 'Provider success contradicted a post-commit staff failure resolution',
          },
        },
      });
    }
    if (transfer.financialMode === 'merchant_debit') {
      await this.ledger.settleWithdrawal(transaction, auth, transfer.id, {
        amountMinor: transfer.amountMinor,
        reservedProviderFeeMinor: transfer.reserveProviderFeeMinor,
        actualProviderFeeMinor: actualProviderFee,
        gatewayFeeMinor: transfer.gatewayFeeMinor,
      });
    } else {
      await this.ledger.settleInternalMoveFee(transaction, auth, transfer.id, transfer.amountMinor, transfer.reserveProviderFeeMinor, actualProviderFee);
    }
    await transaction.transfer.update({
      where: { id: transfer.id },
      data: {
        status: 'success',
        resolvedName: parsed.receiverName,
        providerFeeMinor: parsed.serviceFeeMinor,
        providerVatMinor: parsed.vatMinor,
        providerTransactionId: parsed.providerTransactionId,
        completedAt: new Date(),
      },
    });
    if (transfer.financialMode === 'internal_move') {
      await transaction.treasuryWallet.updateMany({
        where: { environment: transfer.environment, phoneNumber: transfer.destinationPhone },
        data: { predictedBalanceMinor: { increment: transfer.amountMinor } },
      });
    }
    const balanceMutation = await this.transactionBalanceMutation(transaction, simWalletId, occurredAt, parsed.currentMainBalanceMinor, transfer.amountMinor + actualProviderFee, 'decrement');
    await this.updateWalletCounters(transaction, simWalletId, {
      sentDelta: transfer.amountMinor + actualProviderFee,
      data: {
        ...(releasedAfterCommit ? {} : { reservedBalanceMinor: { decrement: transfer.amountMinor + transfer.reserveProviderFeeMinor } }),
        ...balanceMutation.data,
      },
    });
    const attempt = await transaction.transferAttempt.findFirst({ where: { transferId: transfer.id }, orderBy: { attemptNumber: 'desc' } });
    if (attempt?.deviceJobId) {
      const job = await transaction.deviceJob.update({ where: { id: attempt.deviceJobId }, data: { state: 'succeeded', completedAt: new Date() } });
      if (job.deviceId) await transaction.device.updateMany({ where: { id: job.deviceId, activeUssdJobId: job.id }, data: { activeUssdJobId: null } });
      await transaction.transferAttempt.update({ where: { id: attempt.id }, data: { completedAt: new Date(), outcome: 'success' } });
    }
    await transaction.outboxEvent.create({
      data: {
        aggregateType: 'transfer',
        aggregateId: transfer.id,
        eventType: 'transfer.updated',
        payload: { reference: transfer.reference, status: 'success', p2p_status: 'success' },
      },
    });
    const settlement = await transaction.settlementRequest.findUnique({ where: { transferId: transfer.id } });
    if (settlement) {
      await transaction.settlementRequest.update({ where: { id: settlement.id }, data: { status: 'success' } });
      await transaction.outboxEvent.create({
        data: { aggregateType: 'settlement', aggregateId: settlement.id, eventType: 'settlement.updated', payload: { reference: settlement.reference, status: 'success', p2p_status: 'success' } },
      });
    }
    const sweep = await transaction.sweepExecution.findUnique({ where: { transferId: transfer.id } });
    if (sweep) {
      await transaction.sweepExecution.update({ where: { id: sweep.id }, data: { status: 'success', completedAt: new Date() } });
      await transaction.outboxEvent.create({
        data: { aggregateType: 'sweep_execution', aggregateId: sweep.id, eventType: 'sweep.updated', payload: { reference: transfer.reference, execution_id: sweep.id, status: 'success', p2p_status: 'success' } },
      });
    }
    return { matchedReference: transfer.reference };
  }

  private async updateWalletCounters(
    transaction: Prisma.TransactionClient,
    simWalletId: string,
    input: { sentDelta?: bigint; receivedDelta?: bigint; data: Prisma.SimWalletUpdateInput },
  ): Promise<void> {
    const wallet = await transaction.simWallet.findUniqueOrThrow({
      where: { id: simWalletId },
      select: { financialDay: true, sentTodayMinor: true, receivedTodayMinor: true },
    });
    const financialDay = addisFinancialDay(new Date());
    const sameDay = wallet.financialDay && addisFinancialDay(wallet.financialDay).valueOf() === financialDay.valueOf();
    await transaction.simWallet.update({
      where: { id: simWalletId },
      data: {
        ...input.data,
        financialDay,
        sentTodayMinor: (sameDay ? wallet.sentTodayMinor : 0n) + (input.sentDelta ?? 0n),
        receivedTodayMinor: (sameDay ? wallet.receivedTodayMinor : 0n) + (input.receivedDelta ?? 0n),
      },
    });
  }

  private async transactionBalanceMutation(
    transaction: Prisma.TransactionClient,
    simWalletId: string,
    occurredAt: Date,
    providerBalanceMinor: bigint | null,
    amountMinor: bigint,
    direction: 'increment' | 'decrement',
  ): Promise<{ data: Prisma.SimWalletUpdateInput; resultingBalanceMinor: bigint }> {
    const wallet = await transaction.simWallet.findUniqueOrThrow({ where: { id: simWalletId }, select: { mainBalanceMinor: true, lastBalanceAt: true } });
    return transactionBalanceMutationForWallet(wallet, occurredAt, providerBalanceMinor, amountMinor, direction);
  }
}

export function transactionBalanceMutationForWallet(
  wallet: { mainBalanceMinor: bigint; lastBalanceAt: Date | null },
  occurredAt: Date,
  providerBalanceMinor: bigint | null,
  amountMinor: bigint,
  direction: 'increment' | 'decrement',
): { data: Prisma.SimWalletUpdateInput; resultingBalanceMinor: bigint } {
  if (wallet.lastBalanceAt && occurredAt < wallet.lastBalanceAt) return { data: {}, resultingBalanceMinor: wallet.mainBalanceMinor };
  const resultingBalanceMinor = providerBalanceMinor ?? (direction === 'increment' ? wallet.mainBalanceMinor + amountMinor : wallet.mainBalanceMinor - amountMinor);
  return {
    resultingBalanceMinor,
    data: {
      mainBalanceMinor: resultingBalanceMinor,
      lastBalanceAt: occurredAt,
      lastBalanceSource: providerBalanceMinor !== null ? 'transaction_sms' : 'transaction_sms_predicted',
    },
  };
}

export function serializeParsed(parsed: ParsedSms): Prisma.InputJsonValue {
  const { raw: _encryptedEvidenceOnly, ...structured } = parsed;
  return JSON.parse(
    JSON.stringify(structured, (_key, value) => (typeof value === 'bigint' ? value.toString() : value instanceof Date ? value.toISOString() : value)),
  ) as Prisma.InputJsonValue;
}

export function depositStatusAllowsProviderTimeMatch(status: string, createdAt: Date, lateGraceEndsAt: Date, providerOccurredAt: Date): boolean {
  // The expiry cron uses server time while an offline phone may upload later.
  // An intent already marked expired can still be settled automatically when
  // the authenticated provider timestamp proves payment occurred in grace.
  return ['awaiting_payment', 'late_grace', 'matching', 'expired'].includes(status)
    && providerOccurredAt >= createdAt
    && providerOccurredAt <= lateGraceEndsAt;
}

function isMerchantTopup(metadata: Prisma.JsonValue | null): boolean {
  return Boolean(metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata._p2p_intent_kind === 'merchant_topup');
}
