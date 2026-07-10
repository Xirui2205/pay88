import type { Prisma } from '@prisma/client';

export interface PlatformPolicy {
  balanceStaleSeconds: number;
  capacitySafetyFactor: number;
  dailyLimitMinor: bigint;
  walletCeilingMinor: bigint;
  safetyBalanceMinor: bigint;
  safetyHeadroomMinor: bigint;
  defaultDepositCountdownSeconds: number;
  defaultDepositLateGraceSeconds: number;
}

interface SettingReader {
  platformSetting: { findUnique(args: { where: { key: string } }): Promise<{ value: Prisma.JsonValue } | null> };
}

export async function loadPlatformPolicy(reader: SettingReader): Promise<PlatformPolicy> {
  const setting = await reader.platformSetting.findUnique({ where: { key: 'fleet.defaults' } });
  const value = setting?.value && typeof setting.value === 'object' && !Array.isArray(setting.value)
    ? setting.value as Record<string, unknown>
    : {};
  return {
    balanceStaleSeconds: boundedInteger(value.balance_stale_seconds, 1_800, 300, 10_800),
    capacitySafetyFactor: boundedNumber(value.capacity_safety_factor, 0.7, 0.1, 0.95),
    dailyLimitMinor: moneyMinor(value.daily_transfer_cap, 15_000_000n),
    walletCeilingMinor: moneyMinor(value.wallet_ceiling, 7_500_000n),
    safetyBalanceMinor: moneyMinor(value.safety_balance, 100_000n),
    safetyHeadroomMinor: moneyMinor(value.safety_headroom, 100_000n),
    defaultDepositCountdownSeconds: boundedInteger(value.default_deposit_countdown_seconds, 600, 60, 3_600),
    defaultDepositLateGraceSeconds: boundedInteger(value.default_deposit_late_grace_seconds, 1_800, 0, 7_200),
  };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function moneyMinor(value: unknown, fallback: bigint): bigint {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.\d{2}$/.test(value) ? BigInt(value.replace('.', '')) : fallback;
}
