import { HttpStatus, Injectable } from '@nestjs/common';
import type { DeviceJobType, FinancialMode, Prisma, SimWallet, SmsReceipt, Transfer } from '@prisma/client';
import {
  amountToMinor,
  minorToAmount,
  type CreateTransferInput,
  type TransferStatus,
} from '@telebirr/contracts';
import { randomUUID } from 'node:crypto';
import type { MerchantAuthContext } from '../auth/auth.types';
import { ApiException } from '../common/api-exception';
import { SimSelectionService } from '../fleet/sim-selection.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { PrismaService } from '../infra/prisma.service';
import { LedgerService, LEDGER_CODES } from '../ledger/ledger.service';
import { TransferTokenService } from './transfer-token.service';
import { addisFinancialDay } from '../fleet/sim-selection.service';
import { CURRENT_DEVICE_PROFILE_VERSION_TEXT } from '../devices/device-profile-version';
import { loadPlatformPolicy } from '../configuration/platform-policy';
import { matchesMaskedEthiopianPhone } from '../parsers/sms-parser';

type TransferWithSim = Transfer & { simWallet: SimWallet | null };

export function outgoingReceiptAlreadyAppliedToWallet(
  transfer: Pick<Transfer, 'simWalletId' | 'destinationPhone' | 'amountMinor'>,
  receipt: Pick<SmsReceipt, 'simWalletId' | 'direction' | 'type' | 'providerTransactionId' | 'amountMinor' | 'counterpartyPhonePrefix' | 'counterpartyPhoneSuffix'> | null,
  providerTransactionId: string,
): boolean {
  return Boolean(
    receipt &&
    receipt.providerTransactionId === providerTransactionId &&
    receipt.simWalletId === transfer.simWalletId &&
    receipt.direction === 'outgoing' &&
    receipt.type === 'outgoing_transfer' &&
    receipt.amountMinor === transfer.amountMinor &&
    receipt.counterpartyPhonePrefix &&
    receipt.counterpartyPhoneSuffix &&
    matchesMaskedEthiopianPhone(transfer.destinationPhone, receipt.counterpartyPhonePrefix, receipt.counterpartyPhoneSuffix),
  );
}

export interface QueueTransferOptions {
  operationKind: DeviceJobType;
  financialMode: FinancialMode;
  priority: number;
  simOverride?: SimWallet;
}

@Injectable()
export class WithdrawalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly selector: SimSelectionService,
    private readonly ledger: LedgerService,
    private readonly transferTokens: TransferTokenService,
  ) {}

  async create(auth: MerchantAuthContext, input: CreateTransferInput, idempotencyKey: string) {
    return (
      await this.idempotency.execute({
        auth,
        operation: 'transfers.create',
        key: idempotencyKey,
        referenceKey: input.reference,
        payload: input,
        execute: async (transaction) => {
          const config = await transaction.merchantConfig.upsert({
            where: { merchantId: auth.merchantId },
            update: {},
            create: { merchantId: auth.merchantId },
          });
          if (input.destination_type === 'alternate' && !config.allowAlternateWithdrawalPhone) {
            throw new ApiException('alternate_destination_disabled', 'This merchant is not approved to use alternate withdrawal numbers', HttpStatus.FORBIDDEN);
          }
          const transfer = await this.queueTransfer(transaction, auth, input, {
            // Client-controlled metadata can never opt into an internal
            // settlement or liquidity operation.
            operationKind: 'customer_withdrawal',
            financialMode: 'merchant_debit',
            priority: 500,
          });
          return this.view(transfer);
        },
      })
    ).result;
  }

  async queueTransfer(
    transaction: Prisma.TransactionClient,
    auth: Pick<MerchantAuthContext, 'merchantId' | 'environment'>,
    input: CreateTransferInput,
    options: QueueTransferOptions,
  ): Promise<TransferWithSim> {
    const config = await transaction.merchantConfig.upsert({ where: { merchantId: auth.merchantId }, update: {}, create: { merchantId: auth.merchantId } });
    const amountMinor = amountToMinor(input.amount);
    const gatewayFeeMinor = options.financialMode === 'internal_move' ? 0n : config.gatewayFeeFlatMinor;
    const ledgerReservation = options.financialMode === 'internal_move'
      ? config.reserveProviderFeeMinor
      : amountMinor + config.reserveProviderFeeMinor + gatewayFeeMinor;
    const physicalReservation = amountMinor + config.reserveProviderFeeMinor;
    const sim = options.simOverride ?? await this.selector.selectForWithdrawal(transaction, auth as MerchantAuthContext, physicalReservation);
    let transfer = await transaction.transfer.create({
      data: {
        merchantId: auth.merchantId,
        environment: auth.environment,
        simWalletId: sim.id,
        reference: input.reference,
        customerId: input.customer_id,
        destinationPhone: input.account_number,
        expectedName: input.expected_name,
        amountMinor,
        reserveProviderFeeMinor: config.reserveProviderFeeMinor,
        gatewayFeeMinor,
        financialMode: options.financialMode,
        operationKind: options.operationKind,
        callbackUrl: input.callback_url,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
        status: 'accepted',
        estimatedCompletionAt: new Date(Date.now() + 60_000),
      },
      include: { simWallet: true },
    });
    if (options.financialMode === 'merchant_debit') {
      await this.ledger.reserveWithdrawal(transaction, auth, transfer.id, ledgerReservation);
    } else {
      await this.ledger.reserveInternalMoveFee(transaction, auth, transfer.id, ledgerReservation);
    }
    await transaction.simWallet.update({ where: { id: sim.id }, data: { reservedBalanceMinor: { increment: physicalReservation } } });

    if (auth.environment === 'test') {
      transfer = await this.applyTestScenario(transaction, auth, transfer, input.test_scenario ?? 'success');
    } else {
      const fencedSim = await transaction.simWallet.update({ where: { id: sim.id }, data: { nextFencingToken: { increment: 1n } } });
      const job = await transaction.deviceJob.create({
        data: {
          type: options.operationKind,
          state: 'queued',
          priority: options.priority,
          deviceId: sim.deviceId,
          simWalletId: sim.id,
          profileVersion: CURRENT_DEVICE_PROFILE_VERSION_TEXT,
          payload: {
            transfer_id: transfer.id,
            reference: transfer.reference,
            destination_phone: transfer.destinationPhone,
            expected_name: transfer.expectedName,
            amount: minorToAmount(transfer.amountMinor),
            sim_iccid: sim.iccid,
            comment: '',
          },
          fencingToken: fencedSim.nextFencingToken,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        },
      });
      await transaction.transferAttempt.create({
        data: { transferId: transfer.id, attemptNumber: 1, fencingToken: fencedSim.nextFencingToken, deviceJobId: job.id },
      });
      transfer = await transaction.transfer.update({ where: { id: transfer.id }, data: { status: 'queued' }, include: { simWallet: true } });
    }
    return transfer;
  }

  async verify(auth: MerchantAuthContext, reference: string) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { merchantId_environment_reference: { merchantId: auth.merchantId, environment: auth.environment, reference } },
      include: { simWallet: true },
    });
    if (!transfer) throw new ApiException('not_found', 'Transfer reference was not found', HttpStatus.NOT_FOUND);
    return this.view(transfer);
  }

  async completeTest(auth: MerchantAuthContext, reference: string, outcome: 'success' | 'failed' | 'unknown') {
    if (auth.environment !== 'test') throw new ApiException('forbidden', 'Simulator endpoints require a test key', HttpStatus.FORBIDDEN);
    return this.prisma.$transaction(async (transaction) => {
      const transfer = await transaction.transfer.findUnique({
        where: { merchantId_environment_reference: { merchantId: auth.merchantId, environment: 'test', reference } },
        include: { simWallet: true },
      });
      if (!transfer) throw new ApiException('not_found', 'Transfer reference was not found', HttpStatus.NOT_FOUND);
      // The simulator reference is the natural idempotency key: an exact replay
      // returns the established terminal result, while a changed outcome cannot
      // rewrite test history.
      if (!['accepted', 'queued'].includes(transfer.status)) {
        if (transfer.status === outcome) return this.view(transfer);
        throw new ApiException(
          'duplicate_reference_conflict',
          'The test transfer was already completed with a different outcome',
          HttpStatus.CONFLICT,
        );
      }
      return this.view(await this.finalizeTest(transaction, auth, transfer, outcome));
    });
  }

  async balances(auth: MerchantAuthContext) {
    const policy = await loadPlatformPolicy(this.prisma);
    const balanceCutoff = new Date(Date.now() - policy.balanceStaleSeconds * 1000);
    const heartbeatCutoff = new Date(Date.now() - 90_000);
    const [accounts, pendingTransfers] = await Promise.all([
      this.prisma.ledgerAccount.findMany({ where: { merchantId: auth.merchantId, environment: auth.environment } }),
      this.prisma.transfer.aggregate({
        where: {
          merchantId: auth.merchantId,
          environment: auth.environment,
          status: { in: ['committed', 'provider_pending', 'unknown', 'manual_review'] },
        },
        _sum: { amountMinor: true, reserveProviderFeeMinor: true, gatewayFeeMinor: true },
      }),
    ]);
    const byCode = Object.fromEntries(accounts.map((account) => [account.code, account.balanceMinor]));
    const physical = await this.prisma.simWallet.aggregate({
      where: {
        status: 'active',
        lastBalanceAt: { gte: balanceCutoff },
        device: {
          status: 'online',
          lastHeartbeatAt: { gte: heartbeatCutoff },
          lastPermissionsOk: true,
          lastAccessibilityOk: true,
          hardwareSerial: auth.environment === 'live' ? { not: 'VIRTUAL-TEST-DEVICE' } : 'VIRTUAL-TEST-DEVICE',
          group: {
            ...(auth.environment === 'live' ? { code: { not: 'TEST-SIMULATOR' } } : { code: 'TEST-SIMULATOR' }),
            OR: [{ merchants: { some: { merchantId: auth.merchantId } } }, { merchants: { none: {} } }],
          },
        },
      },
      _sum: { mainBalanceMinor: true, reservedBalanceMinor: true },
    });
    const aggregatePhysicalAvailable = (physical._sum.mainBalanceMinor ?? 0n) - (physical._sum.reservedBalanceMinor ?? 0n);
    return {
      currency: 'ETB',
      available: minorToAmount(byCode[LEDGER_CODES.available] ?? 0n),
      reserved: minorToAmount(byCode[LEDGER_CODES.reserved] ?? 0n),
      pending: minorToAmount(
        (pendingTransfers._sum.amountMinor ?? 0n) +
        (pendingTransfers._sum.reserveProviderFeeMinor ?? 0n) +
        (pendingTransfers._sum.gatewayFeeMinor ?? 0n),
      ),
      physical_liquidity: {
        // A reconciliation drift can temporarily make reservations exceed the
        // latest aggregate snapshot. Public capacity is never negative: zero
        // means no new payout may be admitted while operators resolve drift.
        available: minorToAmount(aggregatePhysicalAvailable > 0n ? aggregatePhysicalAvailable : 0n),
        status: 'aggregate_only',
      },
    };
  }

  async hostedStatus(reference: string, token: string) {
    const claims = this.transferTokens.verify(token, reference);
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: claims.transferId },
      include: { simWallet: true, merchant: { select: { name: true } } },
    });
    if (!transfer || transfer.reference !== reference) throw new ApiException('not_found', 'Transfer was not found', HttpStatus.NOT_FOUND);
    return { ...this.view(transfer), merchant_name: transfer.merchant.name };
  }

  async cancelBeforeStart(transferId: string, reason: string, actorId: string) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`transfer-admin:${transferId}`}))`;
      const transfer = await transaction.transfer.findUnique({
        where: { id: transferId },
        include: { simWallet: true, attempts: { include: { deviceJob: true }, orderBy: { attemptNumber: 'desc' }, take: 1 } },
      });
      if (!transfer) throw new ApiException('not_found', 'Transfer was not found', HttpStatus.NOT_FOUND);
      if (!['accepted', 'queued', 'device_assigned'].includes(transfer.status)) {
        throw new ApiException('invalid_state', 'A transfer can only be cancelled before device execution starts', HttpStatus.CONFLICT);
      }
      const attempt = transfer.attempts[0];
      if (attempt?.deviceJob && attempt.deviceJob.state !== 'queued') {
        throw new ApiException('invalid_state', 'The device has already leased or started this transfer', HttpStatus.CONFLICT);
      }
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
      if (transfer.simWalletId) {
        await transaction.simWallet.update({
          where: { id: transfer.simWalletId },
          data: { reservedBalanceMinor: { decrement: transfer.amountMinor + transfer.reserveProviderFeeMinor } },
        });
      }
      if (attempt?.deviceJobId) {
        await transaction.deviceJob.update({
          where: { id: attempt.deviceJobId },
          data: { state: 'cancelled', completedAt: new Date(), errorCode: 'PLATFORM_CANCELLED_PRECOMMIT' },
        });
        await transaction.transferAttempt.update({
          where: { id: attempt.id },
          data: { completedAt: new Date(), outcome: 'cancelled', errorCode: 'PLATFORM_CANCELLED_PRECOMMIT' },
        });
      }
      const cancelled = await transaction.transfer.update({
        where: { id: transfer.id },
        data: { status: 'cancelled', completedAt: new Date() },
        include: { simWallet: true },
      });
      await transaction.auditLog.create({
        data: { merchantId: transfer.merchantId, actorType: 'platform_staff', actorId, action: 'transfer.cancel_precommit', targetType: 'transfer', targetId: transfer.id, reason },
      });
      await transaction.outboxEvent.create({
        data: { aggregateType: 'transfer', aggregateId: transfer.id, eventType: 'transfer.updated', payload: { reference: transfer.reference, status: 'failed', p2p_status: 'cancelled' } },
      });
      await this.updateLinkedOperation(transaction, transfer.id, 'failed');
      return this.view(cancelled);
    }, { isolationLevel: 'Serializable' });
  }

  async resolveUnknown(
    transferId: string,
    input: {
      outcome: 'success' | 'failed';
      providerTransactionId?: string;
      resolvedName?: string;
      serviceFeeMinor: bigint;
      vatMinor: bigint;
      currentMainBalanceMinor?: bigint;
      failureEvidenceReference?: string;
      reason: string;
    },
    actorId: string,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`transfer-admin:${transferId}`}))`;
      const transfer = await transaction.transfer.findUnique({
        where: { id: transferId },
        include: { simWallet: true, attempts: { include: { deviceJob: true }, orderBy: { attemptNumber: 'desc' }, take: 1 } },
      });
      if (!transfer) throw new ApiException('not_found', 'Transfer was not found', HttpStatus.NOT_FOUND);
      if (!['unknown', 'manual_review'].includes(transfer.status)) {
        throw new ApiException('invalid_state', 'Only an unknown or manual-review transfer can be resolved', HttpStatus.CONFLICT);
      }
      if (input.outcome === 'failed' && transfer.committedAt && !input.failureEvidenceReference) {
        throw new ApiException('validation_error', 'Conclusive provider failure evidence is required after PIN submission', HttpStatus.UNPROCESSABLE_ENTITY);
      }
      if (!transfer.simWalletId || !transfer.simWallet) throw new ApiException('invalid_state', 'Transfer has no assigned SIM wallet', HttpStatus.CONFLICT);
      const auth = { merchantId: transfer.merchantId, environment: transfer.environment } as const;
      const physicalReservation = transfer.amountMinor + transfer.reserveProviderFeeMinor;
      const attempt = transfer.attempts[0];

      if (input.outcome === 'success') {
        const resolutionAt = new Date();
        if (!input.providerTransactionId) {
          throw new ApiException('validation_error', 'A provider transaction ID is required to prove success', HttpStatus.UNPROCESSABLE_ENTITY);
        }
        const existingProviderReceipt = await transaction.smsReceipt.findUnique({
          where: { providerTransactionId: input.providerTransactionId },
        });
        const physicalAlreadyApplied = outgoingReceiptAlreadyAppliedToWallet(transfer, existingProviderReceipt, input.providerTransactionId);
        if (existingProviderReceipt && !physicalAlreadyApplied) {
          throw new ApiException('validation_error', 'Provider transaction evidence does not match the assigned payout', HttpStatus.UNPROCESSABLE_ENTITY);
        }
        const actualProviderFee = input.serviceFeeMinor + input.vatMinor;
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
        const financialDay = addisFinancialDay(resolutionAt);
        const sameDay = transfer.simWallet.financialDay && addisFinancialDay(transfer.simWallet.financialDay).valueOf() === financialDay.valueOf();
        const sentDelta = transfer.amountMinor + actualProviderFee;
        await transaction.simWallet.update({
          where: { id: transfer.simWalletId },
          data: {
            reservedBalanceMinor: { decrement: physicalReservation },
            ...(physicalAlreadyApplied
              ? input.currentMainBalanceMinor !== undefined
                ? {
                    // The SMS path already applied principal, provider fees and
                    // daily counters. A newer operator-supplied balance may
                    // replace the snapshot, but the outflow is never counted a
                    // second time.
                    mainBalanceMinor: input.currentMainBalanceMinor,
                    lastBalanceAt: resolutionAt,
                    lastBalanceSource: manualSuccessBalanceSource(true),
                  }
                : {}
              : {
                  mainBalanceMinor: input.currentMainBalanceMinor ?? { decrement: sentDelta },
                  sentTodayMinor: (sameDay ? transfer.simWallet.sentTodayMinor : 0n) + sentDelta,
                  financialDay,
                  // Advance the balance watermark for both an explicit balance
                  // and a predicted decrement. Otherwise an older delayed SMS
                  // can rewind this manual resolution.
                  lastBalanceAt: resolutionAt,
                  lastBalanceSource: manualSuccessBalanceSource(input.currentMainBalanceMinor !== undefined),
                }),
          },
        });
        if (transfer.financialMode === 'internal_move') {
          await transaction.treasuryWallet.updateMany({
            where: { environment: transfer.environment, phoneNumber: transfer.destinationPhone },
            data: { predictedBalanceMinor: { increment: transfer.amountMinor } },
          });
        }
        const resolved = await transaction.transfer.update({
          where: { id: transfer.id },
          data: {
            status: 'success',
            providerTransactionId: input.providerTransactionId,
            resolvedName: input.resolvedName,
            providerFeeMinor: input.serviceFeeMinor,
            providerVatMinor: input.vatMinor,
            completedAt: resolutionAt,
          },
          include: { simWallet: true },
        });
        if (attempt?.deviceJobId) await transaction.deviceJob.update({ where: { id: attempt.deviceJobId }, data: { state: 'succeeded', completedAt: new Date() } });
        if (attempt) await transaction.transferAttempt.update({ where: { id: attempt.id }, data: { outcome: 'success', completedAt: new Date() } });
        await this.finishManualResolution(transaction, transfer.id, actorId, input.reason, 'success', input.providerTransactionId);
        await this.updateLinkedOperation(transaction, transfer.id, 'success');
        await transaction.outboxEvent.create({ data: { aggregateType: 'transfer', aggregateId: transfer.id, eventType: 'transfer.updated', payload: { reference: transfer.reference, status: 'success', p2p_status: 'success' } } });
        return this.view(resolved);
      }

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
      await transaction.simWallet.update({ where: { id: transfer.simWalletId }, data: { reservedBalanceMinor: { decrement: physicalReservation } } });
      const resolved = await transaction.transfer.update({ where: { id: transfer.id }, data: { status: 'failed', completedAt: new Date() }, include: { simWallet: true } });
      if (attempt?.deviceJobId) await transaction.deviceJob.update({ where: { id: attempt.deviceJobId }, data: { state: 'failed', completedAt: new Date(), errorCode: 'MANUALLY_PROVEN_FAILED' } });
      if (attempt) await transaction.transferAttempt.update({ where: { id: attempt.id }, data: { outcome: 'failed', completedAt: new Date(), errorCode: 'MANUALLY_PROVEN_FAILED' } });
      await this.finishManualResolution(transaction, transfer.id, actorId, input.reason, 'failed', undefined, input.failureEvidenceReference);
      await this.updateLinkedOperation(transaction, transfer.id, 'failed');
      await transaction.outboxEvent.create({ data: { aggregateType: 'transfer', aggregateId: transfer.id, eventType: 'transfer.updated', payload: { reference: transfer.reference, status: 'failed', p2p_status: 'failed' } } });
      return this.view(resolved);
    }, { isolationLevel: 'Serializable', timeout: 20_000 });
  }

  async approveNameAndRetry(transferId: string, reason: string, actorId: string) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`transfer-admin:${transferId}`}))`;
      const transfer = await transaction.transfer.findUnique({
        where: { id: transferId },
        include: { simWallet: true, attempts: { include: { deviceJob: true }, orderBy: { attemptNumber: 'desc' }, take: 1 } },
      });
      if (!transfer) throw new ApiException('not_found', 'Transfer was not found', HttpStatus.NOT_FOUND);
      if (transfer.status !== 'manual_review' || transfer.committedAt || !transfer.simWallet) {
        throw new ApiException('invalid_state', 'Only a cancelled pre-commit name-review transfer can be retried', HttpStatus.CONFLICT);
      }
      const previous = transfer.attempts[0];
      if (previous?.deviceJob && !['cancelled', 'failed'].includes(previous.deviceJob.state)) {
        throw new ApiException('invalid_state', 'The previous device attempt is still active', HttpStatus.CONFLICT);
      }
      const nameCase = await transaction.reconciliationCase.findFirst({
        where: {
          referenceType: 'transfer',
          referenceId: transfer.id,
          type: 'receiver_name_review',
          status: { in: ['open', 'proposed'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      const nameEvidence = nameCase?.evidence as Record<string, unknown> | null;
      const deterministic = nameEvidence?.deterministic as Record<string, unknown> | undefined;
      if (deterministic?.decision !== 'uncertain') {
        throw new ApiException('invalid_state', 'Only a deterministically uncertain receiver name can be staff-approved', HttpStatus.CONFLICT);
      }
      const approvedProviderName = typeof nameEvidence?.observed_name === 'string'
        ? nameEvidence.observed_name.trim()
        : '';
      if (!approvedProviderName) {
        throw new ApiException('invalid_state', 'The receiver-name case has no provider name to approve', HttpStatus.CONFLICT);
      }
      const fenced = await transaction.simWallet.update({
        where: { id: transfer.simWallet.id },
        data: { nextFencingToken: { increment: 1n } },
      });
      const attemptNumber = (previous?.attemptNumber ?? 0) + 1;
      const job = await transaction.deviceJob.create({
        data: {
          type: transfer.operationKind,
          state: 'queued',
          priority: priorityForOperation(transfer.operationKind),
          deviceId: transfer.simWallet.deviceId,
          simWalletId: transfer.simWallet.id,
          // A staff-approved retry must use the current safe profile even when
          // the earlier pre-commit attempt was created against legacy v1.
          profileVersion: CURRENT_DEVICE_PROFILE_VERSION_TEXT,
          payload: {
            transfer_id: transfer.id,
            reference: transfer.reference,
            destination_phone: transfer.destinationPhone,
            expected_name: transfer.expectedName,
            amount: minorToAmount(transfer.amountMinor),
            sim_iccid: transfer.simWallet.iccid,
            comment: '',
            approved_provider_name: approvedProviderName,
          },
          attempt: attemptNumber,
          fencingToken: fenced.nextFencingToken,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        },
      });
      await transaction.transferAttempt.create({
        data: { transferId: transfer.id, attemptNumber, fencingToken: fenced.nextFencingToken, deviceJobId: job.id },
      });
      const queued = await transaction.transfer.update({
        where: { id: transfer.id },
        data: { status: 'queued', resolvedName: approvedProviderName, estimatedCompletionAt: new Date(Date.now() + 60_000) },
        include: { simWallet: true },
      });
      await transaction.reconciliationCase.updateMany({
        where: { referenceType: 'transfer', referenceId: transfer.id, type: 'receiver_name_review', status: { in: ['open', 'proposed'] } },
        data: { status: 'resolved', resolution: { outcome: 'staff_approved_precommit_retry', reason, resolved_by: actorId, resolved_at: new Date().toISOString() } },
      });
      await transaction.settlementRequest.updateMany({ where: { transferId: transfer.id }, data: { status: 'dispatched' } });
      await transaction.sweepExecution.updateMany({ where: { transferId: transfer.id }, data: { status: 'queued', completedAt: null } });
      await transaction.auditLog.create({
        data: {
          merchantId: transfer.merchantId,
          actorType: 'platform_staff',
          actorId,
          action: 'transfer.name_approved_retry',
          targetType: 'transfer',
          targetId: transfer.id,
          reason,
          metadata: { attempt_number: attemptNumber, approved_provider_name: approvedProviderName },
        },
      });
      await transaction.outboxEvent.create({
        data: { aggregateType: 'transfer', aggregateId: transfer.id, eventType: 'transfer.updated', payload: { reference: transfer.reference, status: 'pending', p2p_status: 'queued' } },
      });
      return this.view(queued);
    }, { isolationLevel: 'Serializable' });
  }

  private async applyTestScenario(
    transaction: Prisma.TransactionClient,
    auth: Pick<MerchantAuthContext, 'merchantId' | 'environment'>,
    transfer: TransferWithSim,
    scenario: NonNullable<CreateTransferInput['test_scenario']>,
  ): Promise<TransferWithSim> {
    if (scenario === 'delay') return transaction.transfer.update({ where: { id: transfer.id }, data: { status: 'queued' }, include: { simWallet: true } });
    return this.finalizeTest(transaction, auth, transfer, scenario === 'explicit_failure' ? 'failed' : scenario);
  }

  private async finalizeTest(
    transaction: Prisma.TransactionClient,
    auth: Pick<MerchantAuthContext, 'merchantId' | 'environment'>,
    transfer: TransferWithSim,
    outcome: 'success' | 'failed' | 'unknown',
  ): Promise<TransferWithSim> {
    if (outcome === 'unknown') {
      const updated = await transaction.transfer.update({ where: { id: transfer.id }, data: { status: 'unknown' }, include: { simWallet: true } });
      await transaction.reconciliationCase.create({
        data: { merchantId: auth.merchantId, type: 'unknown_payout', referenceType: 'transfer', referenceId: transfer.id, evidence: { simulator: true } },
      });
      await this.updateLinkedOperation(transaction, transfer.id, 'unknown');
      await transaction.outboxEvent.create({
        data: {
          aggregateType: 'transfer',
          aggregateId: transfer.id,
          eventType: 'transfer.updated',
          payload: { reference: transfer.reference, status: 'pending', p2p_status: 'unknown' },
        },
      });
      return updated;
    }
    const totalReservation = transfer.amountMinor + transfer.reserveProviderFeeMinor + transfer.gatewayFeeMinor;
    const physicalReservation = transfer.amountMinor + transfer.reserveProviderFeeMinor;
    if (outcome === 'failed') {
      if (transfer.financialMode === 'merchant_debit') {
        await this.ledger.releaseWithdrawalReservation(transaction, auth, transfer.id, totalReservation);
      } else {
        await this.ledger.releaseInternalMoveFee(transaction, auth, transfer.id, transfer.reserveProviderFeeMinor);
      }
      await transaction.simWallet.update({ where: { id: transfer.simWalletId! }, data: { reservedBalanceMinor: { decrement: physicalReservation } } });
      const failed = await transaction.transfer.update({ where: { id: transfer.id }, data: { status: 'failed', completedAt: new Date() }, include: { simWallet: true } });
      await this.updateLinkedOperation(transaction, transfer.id, 'failed');
      await transaction.outboxEvent.create({
        data: {
          aggregateType: 'transfer',
          aggregateId: transfer.id,
          eventType: 'transfer.updated',
          payload: { reference: transfer.reference, status: 'failed', p2p_status: 'failed' },
        },
      });
      return failed;
    }
    const providerFeeMinor = 100n;
    if (transfer.financialMode === 'merchant_debit') {
      await this.ledger.settleWithdrawal(transaction, auth, transfer.id, {
        amountMinor: transfer.amountMinor,
        reservedProviderFeeMinor: transfer.reserveProviderFeeMinor,
        actualProviderFeeMinor: providerFeeMinor,
        gatewayFeeMinor: transfer.gatewayFeeMinor,
      });
    } else {
      await this.ledger.settleInternalMoveFee(transaction, auth, transfer.id, transfer.amountMinor, transfer.reserveProviderFeeMinor, providerFeeMinor);
    }
    const financialDay = addisFinancialDay(new Date());
    const sameDay = transfer.simWallet?.financialDay && addisFinancialDay(transfer.simWallet.financialDay).valueOf() === financialDay.valueOf();
    const sentDelta = transfer.amountMinor + providerFeeMinor;
    await transaction.simWallet.update({
      where: { id: transfer.simWalletId! },
      data: {
        reservedBalanceMinor: { decrement: physicalReservation },
        mainBalanceMinor: { decrement: transfer.amountMinor + providerFeeMinor },
        sentTodayMinor: sameDay ? (transfer.simWallet?.sentTodayMinor ?? 0n) + sentDelta : sentDelta,
        financialDay,
      },
    });
    if (transfer.financialMode === 'internal_move') {
      await transaction.treasuryWallet.updateMany({
        where: { environment: transfer.environment, phoneNumber: transfer.destinationPhone },
        data: { predictedBalanceMinor: { increment: transfer.amountMinor } },
      });
    }
    const updated = await transaction.transfer.update({
      where: { id: transfer.id },
      data: {
        status: 'success',
        providerFeeMinor: 87n,
        providerVatMinor: 13n,
        providerTransactionId: `SIM${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`,
        completedAt: new Date(),
      },
      include: { simWallet: true },
    });
    await transaction.outboxEvent.create({
      data: { aggregateType: 'transfer', aggregateId: transfer.id, eventType: 'transfer.updated', payload: { reference: transfer.reference, status: 'success', p2p_status: 'success' } },
    });
    await this.updateLinkedOperation(transaction, transfer.id, 'success');
    return updated;
  }

  private async updateLinkedOperation(
    transaction: Prisma.TransactionClient,
    transferId: string,
    status: 'success' | 'failed' | 'unknown',
  ): Promise<void> {
    const [settlement, sweep, transfer] = await Promise.all([
      transaction.settlementRequest.findUnique({ where: { transferId } }),
      transaction.sweepExecution.findUnique({ where: { transferId } }),
      transaction.transfer.findUniqueOrThrow({ where: { id: transferId }, select: { reference: true } }),
    ]);
    if (settlement) {
      await transaction.settlementRequest.update({ where: { id: settlement.id }, data: { status } });
      await transaction.outboxEvent.create({
        data: {
          aggregateType: 'settlement',
          aggregateId: settlement.id,
          eventType: 'settlement.updated',
          payload: { reference: settlement.reference, status: status === 'success' ? 'success' : status === 'failed' ? 'failed' : 'pending', p2p_status: status },
        },
      });
    }
    if (sweep) {
      await transaction.sweepExecution.update({ where: { id: sweep.id }, data: { status, completedAt: status === 'success' || status === 'failed' ? new Date() : undefined } });
      await transaction.outboxEvent.create({
        data: {
          aggregateType: 'sweep_execution',
          aggregateId: sweep.id,
          eventType: 'sweep.updated',
          payload: { reference: transfer.reference, execution_id: sweep.id, status: status === 'success' ? 'success' : status === 'failed' ? 'failed' : 'pending', p2p_status: status },
        },
      });
    }
  }

  private async finishManualResolution(
    transaction: Prisma.TransactionClient,
    transferId: string,
    actorId: string,
    reason: string,
    outcome: 'success' | 'failed',
    providerTransactionId?: string,
    failureEvidenceReference?: string,
  ): Promise<void> {
    const transfer = await transaction.transfer.findUniqueOrThrow({ where: { id: transferId }, select: { merchantId: true } });
    await transaction.reconciliationCase.updateMany({
      where: { referenceType: 'transfer', referenceId: transferId, status: { in: ['open', 'proposed'] } },
      data: {
        status: 'resolved',
        resolution: { outcome, reason, provider_transaction_id: providerTransactionId ?? null, failure_evidence_reference: failureEvidenceReference ?? null, resolved_by: actorId, resolved_at: new Date().toISOString() },
      },
    });
    await transaction.auditLog.create({
      data: {
        merchantId: transfer.merchantId,
        actorType: 'platform_staff',
        actorId,
        action: 'transfer.manual_resolution',
        targetType: 'transfer',
        targetId: transferId,
        reason,
        metadata: { outcome, provider_transaction_id: providerTransactionId ?? null, failure_evidence_reference: failureEvidenceReference ?? null },
      },
    });
  }

  private view(transfer: TransferWithSim) {
    const token = this.transferTokens.issue({ transferId: transfer.id, reference: transfer.reference, expires: Math.floor(Date.now() / 1000) + 24 * 60 * 60 });
    const checkoutBaseUrl = (process.env.CHECKOUT_BASE_URL ?? 'http://localhost:5175').replace(/\/$/, '');
    const apiBaseUrl = (process.env.PUBLIC_API_URL ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    return {
      reference: transfer.reference,
      amount: minorToAmount(transfer.amountMinor),
      provider_fee: transfer.providerFeeMinor === null ? null : minorToAmount(transfer.providerFeeMinor),
      provider_vat: transfer.providerVatMinor === null ? null : minorToAmount(transfer.providerVatMinor),
      gateway_fee: minorToAmount(transfer.gatewayFeeMinor),
      currency: 'ETB' as const,
      status: coarseTransferStatus(transfer.status),
      p2p_status: transfer.status as TransferStatus,
      account_number_masked: `${transfer.destinationPhone.slice(0, 7)}****${transfer.destinationPhone.slice(-2)}`,
      expected_name: transfer.expectedName,
      provider_transaction_id: transfer.providerTransactionId,
      created_at: transfer.createdAt.toISOString(),
      eta_seconds: transfer.estimatedCompletionAt
        ? Math.max(0, Math.ceil((transfer.estimatedCompletionAt.valueOf() - Date.now()) / 1000))
        : 0,
      estimated_completion_at: transfer.estimatedCompletionAt?.toISOString() ?? null,
      status_url: `${checkoutBaseUrl}/withdrawal/${encodeURIComponent(transfer.reference)}?token=${encodeURIComponent(token)}`,
      status_api_url: `${apiBaseUrl}/v1/hosted/transfers/${encodeURIComponent(transfer.reference)}?token=${encodeURIComponent(token)}`,
    };
  }
}

export function manualSuccessBalanceSource(explicitProviderBalance: boolean): 'manual_evidence' | 'manual_evidence_predicted' {
  return explicitProviderBalance ? 'manual_evidence' : 'manual_evidence_predicted';
}

function coarseTransferStatus(status: string): 'pending' | 'success' | 'failed' {
  if (status === 'success') return 'success';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  return 'pending';
}

function priorityForOperation(operation: DeviceJobType): number {
  if (operation === 'customer_withdrawal') return 500;
  if (operation === 'unknown_reconciliation') return 400;
  if (operation === 'merchant_settlement' || operation === 'emergency_liquidity_move') return 300;
  if (operation === 'automatic_sweep') return 200;
  return 100;
}
