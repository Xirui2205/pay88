import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { DepositIntent, Prisma, SimWallet } from '@prisma/client';
import {
  amountToMinor,
  minorToAmount,
  type DepositStatus,
  type InitializeTransactionInput,
} from '@telebirr/contracts';
import { randomUUID } from 'node:crypto';
import { ApiException } from '../common/api-exception';
import type { MerchantAuthContext } from '../auth/auth.types';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { PrismaService } from '../infra/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { SimSelectionService } from '../fleet/sim-selection.service';
import { CheckoutTokenService } from './checkout-token.service';
import { encryptEvidence } from '../common/evidence-crypto';
import { sha256 } from '../common/crypto';

type DepositWithSim = DepositIntent & { simWallet: SimWallet };

@Injectable()
export class DepositsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(SimSelectionService) private readonly selector: SimSelectionService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(CheckoutTokenService) private readonly checkoutTokens: CheckoutTokenService,
  ) {}

  async initialize(
    auth: MerchantAuthContext,
    input: InitializeTransactionInput,
    idempotencyKey: string,
    intentKind: 'customer_deposit' | 'merchant_topup' = 'customer_deposit',
  ) {
    return (
      await this.idempotency.execute({
        auth,
        operation: intentKind === 'merchant_topup' ? 'topups.initialize' : 'transaction.initialize',
        key: idempotencyKey,
        referenceKey: input.tx_ref,
        referenceOperation: 'deposits.reference',
        payload: { ...input, _p2p_intent_kind: intentKind },
        execute: async (transaction) => {
          const config = await this.merchantConfig(transaction, auth.merchantId);
          const amountMinor = amountToMinor(input.amount);
          if (amountMinor < config.depositMinimumMinor || amountMinor > config.depositMaximumMinor) {
            throw new ApiException('validation_error', 'Amount is outside merchant deposit limits', HttpStatus.UNPROCESSABLE_ENTITY);
          }
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deposit-customer:${auth.merchantId}:${auth.environment}:${input.customer_id}`}))`;
          const active = await transaction.depositIntent.findFirst({
            where: {
              merchantId: auth.merchantId,
              environment: auth.environment,
              customerId: input.customer_id,
              status: { in: ['awaiting_payment', 'late_grace', 'matching'] },
            },
          });
          if (active) {
            throw new ApiException(
              'active_intent_exists',
              `Customer already has active deposit ${active.txRef}`,
              HttpStatus.CONFLICT,
              { tx_ref: active.txRef },
            );
          }

          const sim = await this.selector.selectForDeposit(transaction, auth, {
            customerId: input.customer_id,
            customerPhone: input.phone_number,
            amountMinor,
          });
          const createdAt = new Date();
          const expiresAt = new Date(createdAt.valueOf() + config.depositCountdownSeconds * 1000);
          const lateGraceEndsAt = new Date(expiresAt.valueOf() + config.depositLateGraceSeconds * 1000);
          let deposit = await transaction.depositIntent.create({
            data: {
              merchantId: auth.merchantId,
              environment: auth.environment,
              simWalletId: sim.id,
              txRef: input.tx_ref,
              customerId: input.customer_id,
              customerName: `${input.first_name} ${input.last_name ?? ''}`.trim(),
              customerPhone: input.phone_number,
              amountMinor,
              callbackUrl: input.callback_url,
              returnUrl: input.return_url,
              metadata: {
                ...(input.metadata ?? {}),
                _p2p_intent_kind: intentKind,
                ...(input.customization ? { _p2p_customization: input.customization } : {}),
              } as Prisma.InputJsonValue,
              expiresAt,
              lateGraceEndsAt,
            },
            include: { simWallet: true },
          });

          if (auth.environment === 'test' && input.test_scenario) {
            deposit = await this.applyTestScenario(transaction, auth, deposit, input.test_scenario);
          }
          return this.view(deposit);
        },
      })
    ).result;
  }

  async verify(auth: MerchantAuthContext, txRef: string) {
    let deposit = await this.prisma.depositIntent.findUnique({
      where: { merchantId_environment_txRef: { merchantId: auth.merchantId, environment: auth.environment, txRef } },
      include: { simWallet: true },
    });
    if (!deposit) throw new ApiException('not_found', 'Transaction reference was not found', HttpStatus.NOT_FOUND);
    const now = Date.now();
    if (deposit.status === 'awaiting_payment' && now >= deposit.expiresAt.valueOf()) {
      deposit = { ...deposit, status: now < deposit.lateGraceEndsAt.valueOf() ? 'late_grace' : 'expired' };
    } else if (deposit.status === 'late_grace' && now >= deposit.lateGraceEndsAt.valueOf()) {
      deposit = { ...deposit, status: 'expired' };
    }
    return this.view(deposit);
  }

  async hostedCheckout(txRef: string, token: string) {
    const claims = this.checkoutTokens.verify(token, txRef);
    const deposit = await this.prisma.depositIntent.findUnique({
      where: { id: claims.depositId },
      include: { simWallet: true, merchant: { select: { name: true } } },
    });
    if (!deposit || deposit.txRef !== txRef) throw new ApiException('not_found', 'Checkout was not found', HttpStatus.NOT_FOUND);
    return {
      ...this.view(deposit),
      assigned_phone_number: deposit.simWallet.phoneNumber,
      receiver_name: deposit.simWallet.telebirrAccountName,
      return_url: deposit.returnUrl,
      merchant_name: deposit.merchant.name,
    };
  }

  private async merchantConfig(transaction: Prisma.TransactionClient, merchantId: string) {
    return transaction.merchantConfig.upsert({
      where: { merchantId },
      update: {},
      create: { merchantId },
    });
  }

  private async applyTestScenario(
    transaction: Prisma.TransactionClient,
    auth: MerchantAuthContext,
    deposit: DepositWithSim,
    scenario: NonNullable<InitializeTransactionInput['test_scenario']>,
  ): Promise<DepositWithSim> {
    if (scenario === 'late') {
      return transaction.depositIntent.update({
        where: { id: deposit.id },
        data: { status: 'late_grace', expiresAt: new Date(Date.now() - 1000) },
        include: { simWallet: true },
      });
    }
    if (scenario === 'ambiguous') {
      return transaction.depositIntent.update({ where: { id: deposit.id }, data: { status: 'manual_review' }, include: { simWallet: true } });
    }
    const actualMinor = scenario === 'wrong_amount' ? deposit.amountMinor + 100n : deposit.amountMinor;
    const providerTransactionId = `SIM${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
    let matchedReceiptId: string | undefined;
    if (scenario === 'duplicate') {
      // Model two independently delivered copies of the same trusted provider
      // SMS. The first becomes evidence; the provider transaction-ID unique
      // constraint suppresses the second before any financial posting.
      const receivedAt = new Date();
      const syntheticBody = `TEST TELEBIRR RECEIPT ${providerTransactionId}`;
      const receiptData = {
        simWalletId: deposit.simWalletId,
        sender: '127',
        direction: 'incoming',
        type: 'incoming_transfer',
        rawBody: encryptEvidence(syntheticBody),
        bodyHash: sha256(syntheticBody),
        parsed: {
          type: 'incoming_transfer',
          amount_minor: actualMinor.toString(),
          provider_transaction_id: providerTransactionId,
          simulator: true,
        } as Prisma.InputJsonValue,
        providerTransactionId,
        amountMinor: actualMinor,
        counterpartyName: deposit.customerName,
        counterpartyPhoneSuffix: deposit.customerPhone.slice(-4),
        providerOccurredAt: receivedAt,
        receivedAt,
      };
      const receipt = await transaction.smsReceipt.create({
        data: { ...receiptData, eventId: randomUUID() },
      });
      const duplicate = await transaction.smsReceipt.createMany({
        data: [{ ...receiptData, rawBody: encryptEvidence(syntheticBody), eventId: randomUUID() }],
        skipDuplicates: true,
      });
      if (duplicate.count !== 0) throw new Error('Duplicate provider transaction ID was not suppressed');
      matchedReceiptId = receipt.id;
    }
    await this.ledger.creditDeposit(transaction, auth, deposit.id, actualMinor);
    await transaction.simWallet.update({ where: { id: deposit.simWalletId }, data: { mainBalanceMinor: { increment: actualMinor } } });
    const updated = await transaction.depositIntent.update({
      where: { id: deposit.id },
      data: { status: 'success', creditedAmountMinor: actualMinor, providerTransactionId, ...(matchedReceiptId ? { matchedReceiptId } : {}) },
      include: { simWallet: true },
    });
    await transaction.outboxEvent.create({
      data: {
        aggregateType: 'deposit',
        aggregateId: deposit.id,
        eventType: isMerchantTopup(deposit.metadata) ? 'topup.updated' : 'deposit.updated',
        payload: { tx_ref: deposit.txRef, status: 'success', p2p_status: 'success' },
      },
    });
    return updated;
  }

  private view(deposit: DepositWithSim) {
    const status = coarseDepositStatus(deposit.status);
    const token = this.checkoutTokens.issue({
      depositId: deposit.id,
      txRef: deposit.txRef,
      expires: Math.floor(deposit.lateGraceEndsAt.valueOf() / 1000) + 24 * 60 * 60,
    });
    const baseUrl = (process.env.CHECKOUT_BASE_URL ?? process.env.PUBLIC_API_URL ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:5175').replace(/\/$/, '');
    return {
      tx_ref: deposit.txRef,
      amount: minorToAmount(deposit.amountMinor),
      credited_amount: deposit.creditedAmountMinor === null ? null : minorToAmount(deposit.creditedAmountMinor),
      currency: 'ETB' as const,
      status,
      p2p_status: deposit.status as DepositStatus,
      checkout_url: `${baseUrl}/checkout/${encodeURIComponent(deposit.txRef)}?token=${encodeURIComponent(token)}`,
      assigned_number_masked: maskPhone(deposit.simWallet.phoneNumber),
      receiver_name: deposit.simWallet.telebirrAccountName,
      expires_at: deposit.expiresAt.toISOString(),
      late_grace_ends_at: deposit.lateGraceEndsAt.toISOString(),
      created_at: deposit.createdAt.toISOString(),
      countdown_seconds: Math.max(0, Math.round((deposit.expiresAt.valueOf() - deposit.createdAt.valueOf()) / 1000)),
      late_grace_seconds: Math.max(0, Math.round((deposit.lateGraceEndsAt.valueOf() - deposit.expiresAt.valueOf()) / 1000)),
      provider_transaction_id: deposit.providerTransactionId,
    };
  }
}

function coarseDepositStatus(status: string): 'pending' | 'success' | 'failed' {
  if (status === 'success') return 'success';
  if (status === 'failed' || status === 'expired') return 'failed';
  return 'pending';
}

function maskPhone(phone: string): string {
  return `${phone.slice(0, 7)}****${phone.slice(-2)}`;
}

function isMerchantTopup(metadata: Prisma.JsonValue | null): boolean {
  return Boolean(metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata._p2p_intent_kind === 'merchant_topup');
}
