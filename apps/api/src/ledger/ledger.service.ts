import { HttpStatus, Injectable } from '@nestjs/common';
import type { LedgerAccount, LedgerAccountType, Prisma } from '@prisma/client';
import { ApiException } from '../common/api-exception';
import type { MerchantAuthContext } from '../auth/auth.types';
import { PrismaService } from '../infra/prisma.service';

export const LEDGER_CODES = {
  available: 'merchant_available',
  reserved: 'merchant_reserved',
  custody: 'telebirr_custody',
  treasuryCustody: 'treasury_custody',
  providerFees: 'provider_fees',
  platformFees: 'platform_fees',
  suspense: 'unmatched_receipts',
} as const;

interface Posting {
  account: LedgerAccount;
  direction: 'D' | 'C';
  amountMinor: bigint;
}

type FinancialContext = Pick<MerchantAuthContext, 'merchantId' | 'environment'>;

const definitions: Record<string, { name: string; type: LedgerAccountType }> = {
  [LEDGER_CODES.available]: { name: 'Merchant available', type: 'liability' },
  [LEDGER_CODES.reserved]: { name: 'Merchant reserved', type: 'liability' },
  [LEDGER_CODES.custody]: { name: 'Telebirr custody', type: 'asset' },
  [LEDGER_CODES.treasuryCustody]: { name: 'Treasury Telebirr custody', type: 'asset' },
  [LEDGER_CODES.providerFees]: { name: 'Telebirr provider fees', type: 'expense' },
  [LEDGER_CODES.platformFees]: { name: 'Platform gateway fees', type: 'revenue' },
  [LEDGER_CODES.suspense]: { name: 'Unmatched receipt suspense', type: 'liability' },
};

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async ensureAccounts(transaction: Prisma.TransactionClient, auth: FinancialContext): Promise<Record<string, LedgerAccount>> {
    const entries = await Promise.all(
      Object.entries(definitions).map(async ([code, definition]) => {
        const account = await transaction.ledgerAccount.upsert({
          where: {
            merchantId_environment_code: {
              merchantId: auth.merchantId,
              environment: auth.environment,
              code,
            },
          },
          update: {},
          create: {
            merchantId: auth.merchantId,
            environment: auth.environment,
            code,
            name: definition.name,
            type: definition.type,
          },
        });
        return [code, account] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  async availableMinor(auth: FinancialContext): Promise<bigint> {
    const account = await this.prisma.ledgerAccount.findUnique({
      where: {
        merchantId_environment_code: {
          merchantId: auth.merchantId,
          environment: auth.environment,
          code: LEDGER_CODES.available,
        },
      },
    });
    return account?.balanceMinor ?? 0n;
  }

  async creditDeposit(
    transaction: Prisma.TransactionClient,
    auth: FinancialContext,
    depositId: string,
    amountMinor: bigint,
  ): Promise<void> {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ledger:${auth.merchantId}:${auth.environment}`}))`;
    const accounts = await this.ensureAccounts(transaction, auth);
    await this.post(transaction, auth, 'deposit', depositId, 'Telebirr customer deposit', [
      { account: accounts[LEDGER_CODES.custody], direction: 'D', amountMinor },
      { account: accounts[LEDGER_CODES.available], direction: 'C', amountMinor },
    ]);
  }

  async moveReceiptToSuspense(
    transaction: Prisma.TransactionClient,
    auth: FinancialContext,
    receiptId: string,
    amountMinor: bigint,
  ): Promise<void> {
    const accounts = await this.ensureAccounts(transaction, auth);
    await this.post(transaction, auth, 'receipt_suspense', receiptId, 'Unmatched Telebirr receipt', [
      { account: accounts[LEDGER_CODES.custody], direction: 'D', amountMinor },
      { account: accounts[LEDGER_CODES.suspense], direction: 'C', amountMinor },
    ]);
  }

  async releaseSuspenseToMerchant(
    transaction: Prisma.TransactionClient,
    source: FinancialContext,
    target: FinancialContext,
    resolutionId: string,
    amountMinor: bigint,
  ): Promise<void> {
    if (source.environment !== target.environment) throw new Error('Suspense cannot cross runtime environments');
    const sourceAccounts = await this.ensureAccounts(transaction, source);
    const targetAccounts = await this.ensureAccounts(transaction, target);
    await this.post(transaction, target, 'suspense_resolution', resolutionId, 'Resolve unmatched Telebirr receipt', [
      { account: sourceAccounts[LEDGER_CODES.suspense], direction: 'D', amountMinor },
      { account: targetAccounts[LEDGER_CODES.available], direction: 'C', amountMinor },
      // Reclassify custody ownership as well as the liability. Without these
      // entries, cross-merchant resolution leaves the physical asset on the
      // suspense owner's ledger while crediting another merchant.
      { account: sourceAccounts[LEDGER_CODES.custody], direction: 'C', amountMinor },
      { account: targetAccounts[LEDGER_CODES.custody], direction: 'D', amountMinor },
    ]);
  }

  async reserveWithdrawal(
    transaction: Prisma.TransactionClient,
    auth: FinancialContext,
    transferId: string,
    totalMinor: bigint,
  ): Promise<void> {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ledger:${auth.merchantId}:${auth.environment}`}))`;
    const accounts = await this.ensureAccounts(transaction, auth);
    const available = await transaction.ledgerAccount.findUniqueOrThrow({
      where: { id: accounts[LEDGER_CODES.available].id },
    });
    if (available.balanceMinor < totalMinor) {
      throw new ApiException(
        'insufficient_merchant_balance',
        'The merchant available balance is insufficient',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    await this.post(transaction, auth, 'withdrawal_reservation', transferId, 'Reserve withdrawal funds', [
      { account: available, direction: 'D', amountMinor: totalMinor },
      { account: accounts[LEDGER_CODES.reserved], direction: 'C', amountMinor: totalMinor },
    ]);
  }

  async reserveInternalMoveFee(
    transaction: Prisma.TransactionClient,
    auth: FinancialContext,
    transferId: string,
    reservedProviderFeeMinor: bigint,
  ): Promise<void> {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ledger:${auth.merchantId}:${auth.environment}`}))`;
    const accounts = await this.ensureAccounts(transaction, auth);
    const available = await transaction.ledgerAccount.findUniqueOrThrow({ where: { id: accounts[LEDGER_CODES.available].id } });
    if (available.balanceMinor < reservedProviderFeeMinor) {
      throw new ApiException('insufficient_merchant_balance', 'The merchant available balance cannot cover the provider fee reserve', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    await this.post(transaction, auth, 'internal_move_fee_reservation', transferId, 'Reserve internal liquidity-move provider fee', [
      { account: available, direction: 'D', amountMinor: reservedProviderFeeMinor },
      { account: accounts[LEDGER_CODES.reserved], direction: 'C', amountMinor: reservedProviderFeeMinor },
    ]);
  }

  async settleWithdrawal(
    transaction: Prisma.TransactionClient,
    auth: FinancialContext,
    transferId: string,
    values: {
      amountMinor: bigint;
      reservedProviderFeeMinor: bigint;
      actualProviderFeeMinor: bigint;
      gatewayFeeMinor: bigint;
    },
  ): Promise<void> {
    const accounts = await this.ensureAccounts(transaction, auth);
    const reservedTotal = values.amountMinor + values.reservedProviderFeeMinor + values.gatewayFeeMinor;
    const actualTotal = values.amountMinor + values.actualProviderFeeMinor + values.gatewayFeeMinor;
    const { refund, overrun } = providerFeeAdjustment(reservedTotal, actualTotal);
    const postings: Posting[] = [
      { account: accounts[LEDGER_CODES.reserved], direction: 'D', amountMinor: reservedTotal },
      { account: accounts[LEDGER_CODES.custody], direction: 'C', amountMinor: values.amountMinor },
      { account: accounts[LEDGER_CODES.custody], direction: 'C', amountMinor: values.actualProviderFeeMinor },
      { account: accounts[LEDGER_CODES.platformFees], direction: 'C', amountMinor: values.gatewayFeeMinor },
    ];
    if (refund > 0n) postings.push({ account: accounts[LEDGER_CODES.available], direction: 'C', amountMinor: refund });
    if (overrun > 0n) postings.push({ account: accounts[LEDGER_CODES.available], direction: 'D', amountMinor: overrun });
    await this.post(transaction, auth, 'withdrawal_settlement', transferId, 'Settle successful withdrawal', postings);
    if (overrun > 0n) await this.recordFeeOverrun(transaction, auth, transferId, values.reservedProviderFeeMinor, values.actualProviderFeeMinor);
  }

  async settleInternalMoveFee(
    transaction: Prisma.TransactionClient,
    auth: FinancialContext,
    transferId: string,
    amountMinor: bigint,
    reservedProviderFeeMinor: bigint,
    actualProviderFeeMinor: bigint,
  ): Promise<void> {
    const accounts = await this.ensureAccounts(transaction, auth);
    const { refund, overrun } = providerFeeAdjustment(reservedProviderFeeMinor, actualProviderFeeMinor);
    const postings: Posting[] = [
      { account: accounts[LEDGER_CODES.reserved], direction: 'D', amountMinor: reservedProviderFeeMinor },
      { account: accounts[LEDGER_CODES.custody], direction: 'C', amountMinor: amountMinor + actualProviderFeeMinor },
      // Principal remains in platform custody, but moves out of the physical
      // fleet into the preapproved jumbo/treasury wallet.
      { account: accounts[LEDGER_CODES.treasuryCustody], direction: 'D', amountMinor },
    ];
    if (refund > 0n) postings.push({ account: accounts[LEDGER_CODES.available], direction: 'C', amountMinor: refund });
    if (overrun > 0n) postings.push({ account: accounts[LEDGER_CODES.available], direction: 'D', amountMinor: overrun });
    await this.post(transaction, auth, 'internal_move_fee_settlement', transferId, 'Settle internal liquidity-move provider fee', postings);
    if (overrun > 0n) await this.recordFeeOverrun(transaction, auth, transferId, reservedProviderFeeMinor, actualProviderFeeMinor);
  }

  async releaseWithdrawalReservation(
    transaction: Prisma.TransactionClient,
    auth: FinancialContext,
    transferId: string,
    totalMinor: bigint,
  ): Promise<void> {
    const accounts = await this.ensureAccounts(transaction, auth);
    await this.post(transaction, auth, 'withdrawal_release', transferId, 'Release failed withdrawal reservation', [
      { account: accounts[LEDGER_CODES.reserved], direction: 'D', amountMinor: totalMinor },
      { account: accounts[LEDGER_CODES.available], direction: 'C', amountMinor: totalMinor },
    ]);
  }

  /**
   * Re-establishes a reservation when a trusted, late provider SMS contradicts
   * a staff failure resolution made after PIN submission. This journal is
   * intentionally allowed to drive merchant available negative: hiding a real
   * provider outflow would be worse than exposing the resulting merchant debt.
   */
  async restoreReleasedWithdrawalForLateSuccess(
    transaction: Prisma.TransactionClient,
    auth: FinancialContext,
    transferId: string,
    totalMinor: bigint,
  ): Promise<void> {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ledger:${auth.merchantId}:${auth.environment}`}))`;
    const accounts = await this.ensureAccounts(transaction, auth);
    await this.post(transaction, auth, 'withdrawal_late_rereservation', transferId, 'Re-reserve after contradictory late provider success', [
      { account: accounts[LEDGER_CODES.available], direction: 'D', amountMinor: totalMinor },
      { account: accounts[LEDGER_CODES.reserved], direction: 'C', amountMinor: totalMinor },
    ]);
  }

  async releaseInternalMoveFee(
    transaction: Prisma.TransactionClient,
    auth: FinancialContext,
    transferId: string,
    reservedProviderFeeMinor: bigint,
  ): Promise<void> {
    const accounts = await this.ensureAccounts(transaction, auth);
    await this.post(transaction, auth, 'internal_move_fee_release', transferId, 'Release internal liquidity-move provider fee reserve', [
      { account: accounts[LEDGER_CODES.reserved], direction: 'D', amountMinor: reservedProviderFeeMinor },
      { account: accounts[LEDGER_CODES.available], direction: 'C', amountMinor: reservedProviderFeeMinor },
    ]);
  }

  async restoreReleasedInternalMoveFeeForLateSuccess(
    transaction: Prisma.TransactionClient,
    auth: FinancialContext,
    transferId: string,
    reservedProviderFeeMinor: bigint,
  ): Promise<void> {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ledger:${auth.merchantId}:${auth.environment}`}))`;
    const accounts = await this.ensureAccounts(transaction, auth);
    await this.post(transaction, auth, 'internal_move_fee_late_rereservation', transferId, 'Re-reserve internal-move fee after contradictory late provider success', [
      { account: accounts[LEDGER_CODES.available], direction: 'D', amountMinor: reservedProviderFeeMinor },
      { account: accounts[LEDGER_CODES.reserved], direction: 'C', amountMinor: reservedProviderFeeMinor },
    ]);
  }

  private async recordFeeOverrun(
    transaction: Prisma.TransactionClient,
    auth: FinancialContext,
    transferId: string,
    reservedProviderFeeMinor: bigint,
    actualProviderFeeMinor: bigint,
  ): Promise<void> {
    await transaction.reconciliationCase.create({
      data: {
        merchantId: auth.merchantId,
        type: 'provider_fee_overrun',
        referenceType: 'transfer',
        referenceId: transferId,
        evidence: {
          reserved_provider_fee_minor: reservedProviderFeeMinor.toString(),
          actual_provider_fee_minor: actualProviderFeeMinor.toString(),
          overrun_minor: (actualProviderFeeMinor - reservedProviderFeeMinor).toString(),
        },
      },
    });
  }

  private async post(
    transaction: Prisma.TransactionClient,
    auth: FinancialContext,
    sourceType: string,
    sourceId: string,
    description: string,
    postings: Posting[],
  ): Promise<void> {
    if (postings.some((posting) => posting.amountMinor < 0n)) throw new Error('Ledger postings cannot be negative');
    const debits = postings.filter((posting) => posting.direction === 'D').reduce((sum, item) => sum + item.amountMinor, 0n);
    const credits = postings.filter((posting) => posting.direction === 'C').reduce((sum, item) => sum + item.amountMinor, 0n);
    if (debits !== credits) throw new Error(`Unbalanced journal: debit=${debits} credit=${credits}`);

    const existing = await transaction.ledgerJournal.findUnique({ where: { sourceType_sourceId: { sourceType, sourceId } } });
    if (existing) return;
    const journal = await transaction.ledgerJournal.create({
      data: { environment: auth.environment, sourceType, sourceId, description },
    });
    for (const posting of postings) {
      await transaction.ledgerEntry.create({
        data: {
          journalId: journal.id,
          accountId: posting.account.id,
          amountMinor: posting.amountMinor,
          direction: posting.direction,
        },
      });
      const naturalDebit = posting.account.type === 'asset' || posting.account.type === 'expense';
      const increase = (naturalDebit && posting.direction === 'D') || (!naturalDebit && posting.direction === 'C');
      await transaction.ledgerAccount.update({
        where: { id: posting.account.id },
        data: { balanceMinor: { increment: increase ? posting.amountMinor : -posting.amountMinor } },
      });
    }
  }
}

export function providerFeeAdjustment(reservedTotal: bigint, actualTotal: bigint): { refund: bigint; overrun: bigint } {
  return actualTotal <= reservedTotal
    ? { refund: reservedTotal - actualTotal, overrun: 0n }
    : { refund: 0n, overrun: actualTotal - reservedTotal };
}
