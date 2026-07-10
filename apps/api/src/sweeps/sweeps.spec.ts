import { describe, expect, it } from 'vitest';
import { calculateSweepAmount, financialModeForDestination } from './sweeps.service';

describe('calculateSweepAmount', () => {
  it('does not sweep at or below the approved high-water threshold', () => {
    expect(calculateSweepAmount({
      balanceMinor: 80_000n,
      reservedMinor: 4_000n,
      safetyMinor: 1_000n,
      highWaterMinor: 75_000n,
      targetMinor: 50_000n,
      maxPerRunMinor: 100_000n,
    })).toBe(0n);
  });

  it('leaves target, safety and reservations while respecting the per-run maximum', () => {
    expect(calculateSweepAmount({
      balanceMinor: 200_000n,
      reservedMinor: 10_000n,
      safetyMinor: 5_000n,
      highWaterMinor: 100_000n,
      targetMinor: 75_000n,
      maxPerRunMinor: 80_000n,
    })).toBe(80_000n);
    expect(calculateSweepAmount({
      balanceMinor: 160_000n,
      reservedMinor: 10_000n,
      safetyMinor: 5_000n,
      highWaterMinor: 100_000n,
      targetMinor: 75_000n,
      maxPerRunMinor: 100_000n,
    })).toBe(70_000n);
  });
});

describe('financialModeForDestination', () => {
  it('debits merchant-owned exits but treats platform treasury moves as internal custody moves', () => {
    expect(financialModeForDestination('merchant_owned')).toBe('merchant_debit');
    expect(financialModeForDestination('platform_treasury')).toBe('internal_move');
  });
});
