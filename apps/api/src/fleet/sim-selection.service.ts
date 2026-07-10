import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, SimWallet } from '@prisma/client';
import { ApiException } from '../common/api-exception';
import type { MerchantAuthContext } from '../auth/auth.types';
import { loadPlatformPolicy } from '../configuration/platform-policy';

type SimCandidate = Prisma.SimWalletGetPayload<{
  include: {
    device: { include: { group: { include: { merchants: true } } } };
    deposits: true;
  };
}>;

@Injectable()
export class SimSelectionService {
  async selectForDeposit(
    transaction: Prisma.TransactionClient,
    auth: MerchantAuthContext,
    input: { customerId: string; customerPhone: string; amountMinor: bigint },
  ): Promise<SimWallet> {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('deposit-sim-assignment'))`;
    if (auth.environment === 'test') return this.ensureTestSim(transaction);

    const sticky = await transaction.depositIntent.findFirst({
      where: { merchantId: auth.merchantId, environment: auth.environment, customerId: input.customerId, status: 'success' },
      orderBy: { createdAt: 'desc' },
      select: { simWalletId: true },
    });
    const candidates = await this.liveCandidates(transaction, auth, true);
    const senderSuffix = input.customerPhone.slice(-4);
    const viable = candidates
      .filter((candidate) => this.allowedForMerchant(candidate, auth.merchantId))
      .filter((candidate) => {
        const ceiling = candidate.device.group.walletCeilingMinor - candidate.device.group.safetyHeadroomMinor;
        return predictedDepositBalance(candidate.mainBalanceMinor, candidate.deposits.map((deposit) => deposit.amountMinor), input.amountMinor) <= ceiling;
      })
      .filter(
        (candidate) =>
          !candidate.deposits.some(
            (deposit) =>
              ['awaiting_payment', 'late_grace', 'matching'].includes(deposit.status) &&
              deposit.amountMinor === input.amountMinor &&
              deposit.customerPhone.endsWith(senderSuffix),
          ),
      )
      .sort((left, right) => {
        const stickyDifference = Number(right.id === sticky?.simWalletId) - Number(left.id === sticky?.simWalletId);
        if (stickyDifference) return stickyDifference;
        const leftPredicted = predictedDepositBalance(left.mainBalanceMinor, left.deposits.map((deposit) => deposit.amountMinor), 0n);
        const rightPredicted = predictedDepositBalance(right.mainBalanceMinor, right.deposits.map((deposit) => deposit.amountMinor), 0n);
        return Number(leftPredicted - rightPredicted);
      });
    if (!viable[0]) {
      throw new ApiException('no_physical_liquidity', 'No receiving wallet has safe headroom', HttpStatus.SERVICE_UNAVAILABLE);
    }
    return viable[0];
  }

  async selectForWithdrawal(
    transaction: Prisma.TransactionClient,
    auth: MerchantAuthContext,
    requiredMinor: bigint,
  ): Promise<SimWallet> {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('withdrawal-sim-assignment'))`;
    if (auth.environment === 'test') return this.ensureTestSim(transaction);
    const candidates = await this.liveCandidates(transaction, auth, false);
    const today = addisFinancialDay(new Date());
    const viable = candidates
      .filter((candidate) => this.allowedForMerchant(candidate, auth.merchantId))
      .filter((candidate) => {
        const sentToday = candidate.financialDay && addisFinancialDay(candidate.financialDay).valueOf() === today.valueOf()
          ? candidate.sentTodayMinor
          : 0n;
        const available = candidate.mainBalanceMinor - candidate.reservedBalanceMinor - candidate.device.group.safetyBalanceMinor;
        return available >= requiredMinor && withinWithdrawalCapacity(sentToday, candidate.reservedBalanceMinor, requiredMinor, candidate.device.group.dailyLimitMinor);
      })
      .sort((left, right) => Number(right.mainBalanceMinor - left.mainBalanceMinor));
    if (!viable[0]) {
      throw new ApiException('no_physical_liquidity', 'No eligible wallet can fund this transfer', HttpStatus.SERVICE_UNAVAILABLE);
    }
    return viable[0];
  }

  private async liveCandidates(
    transaction: Prisma.TransactionClient,
    auth: MerchantAuthContext,
    deposits: boolean,
  ): Promise<SimCandidate[]> {
    const cutoff = new Date(Date.now() - 90_000);
    const policy = await loadPlatformPolicy(transaction);
    const balanceCutoff = new Date(Date.now() - policy.balanceStaleSeconds * 1000);
    return transaction.simWallet.findMany({
      where: {
        status: deposits ? { in: ['active', 'payout_stale'] } : 'active',
        ...(deposits ? {} : { lastBalanceAt: { gte: balanceCutoff } }),
        device: {
          status: 'online',
          lastHeartbeatAt: { gte: cutoff },
          lastPermissionsOk: true,
          lastAccessibilityOk: true,
          group: {
            // Test-mode wallets share the schema for deterministic API parity,
            // but must never enter a live financial candidate pool.
            code: { not: 'TEST-SIMULATOR' },
            OR: [
              { merchants: { some: { merchantId: auth.merchantId } } },
              { merchants: { none: { dedicated: true } } },
            ],
          },
        },
      },
      include: {
        device: { include: { group: { include: { merchants: true } } } },
        deposits: deposits
          ? { where: { status: { in: ['awaiting_payment', 'late_grace', 'matching'] } } }
          : false,
      },
      // V1 qualification target is 1,000 dual-SIM phones. Do not truncate the
      // eligible pool below the supported fleet size or a healthy wallet can be
      // hidden by an arbitrary database row order.
      take: 2500,
    }) as Promise<SimCandidate[]>;
  }

  private allowedForMerchant(candidate: SimCandidate, merchantId: string): boolean {
    if (!isLiveFleetIdentity(candidate.device.group.code, candidate.device.hardwareSerial)) return false;
    const policies = candidate.device.group.merchants;
    const own = policies.find((policy) => policy.merchantId === merchantId);
    if (own) return true;
    return !policies.some((policy) => policy.dedicated);
  }

  private async ensureTestSim(transaction: Prisma.TransactionClient): Promise<SimWallet> {
    const location = await transaction.fleetLocation.upsert({
      where: { code: 'TEST' },
      update: {},
      create: { code: 'TEST', name: 'Test simulator' },
    });
    const group = await transaction.deviceGroup.upsert({
      where: { code: 'TEST-SIMULATOR' },
      update: {},
      create: { code: 'TEST-SIMULATOR', name: 'Test simulator', locationId: location.id },
    });
    const device = await transaction.device.upsert({
      where: { hardwareSerial: 'VIRTUAL-TEST-DEVICE' },
      update: { status: 'online', lastHeartbeatAt: new Date(), lastPermissionsOk: true, lastAccessibilityOk: true },
      create: {
        groupId: group.id,
        name: 'Virtual test phone',
        hardwareSerial: 'VIRTUAL-TEST-DEVICE',
        model: 'Simulator',
        status: 'online',
        lastHeartbeatAt: new Date(),
        lastPermissionsOk: true,
        lastAccessibilityOk: true,
      },
    });
    return transaction.simWallet.upsert({
      where: { iccid: '8999999999999999999' },
      update: {
        status: 'active',
        mainBalanceMinor: 100000000000n,
        lastBalanceAt: new Date(),
      },
      create: {
        deviceId: device.id,
        slot: 0,
        subscriptionId: 1,
        iccid: '8999999999999999999',
        iccidHash: '608531b6d7e79186f3b8ece708f39b8e18777e5065aae202a16386e3293f6706',
        phoneNumber: '+251900000000',
        telebirrAccountName: 'P2P Test Receiver',
        status: 'active',
        mainBalanceMinor: 100000000000n,
        lastBalanceAt: new Date(),
        lastBalanceSource: 'simulator',
      },
    });
  }
}

export function isLiveFleetIdentity(groupCode: string, hardwareSerial: string | null): boolean {
  return groupCode !== 'TEST-SIMULATOR' && hardwareSerial !== 'VIRTUAL-TEST-DEVICE';
}

export function addisFinancialDay(value: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Addis_Ababa',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
  return new Date(`${parts}T00:00:00.000+03:00`);
}

export function predictedDepositBalance(currentMinor: bigint, activeIntentAmounts: bigint[], incomingMinor: bigint): bigint {
  return currentMinor + activeIntentAmounts.reduce((total, amount) => total + amount, 0n) + incomingMinor;
}

export function withinWithdrawalCapacity(sentTodayMinor: bigint, reservedMinor: bigint, requiredMinor: bigint, dailyLimitMinor: bigint): boolean {
  return sentTodayMinor + reservedMinor + requiredMinor <= dailyLimitMinor;
}
