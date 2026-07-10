import { describe, expect, it } from 'vitest';
import { addisFinancialDay, isLiveFleetIdentity, predictedDepositBalance, withinWithdrawalCapacity } from './sim-selection.service';

describe('financial day', () => {
  it('uses Africa/Addis_Ababa boundaries', () => {
    expect(addisFinancialDay(new Date('2026-07-09T22:30:00Z')).toISOString()).toBe('2026-07-09T21:00:00.000Z');
  });
});

describe('test/live fleet isolation', () => {
  it('rejects the simulator by both its reserved group and hardware identity', () => {
    expect(isLiveFleetIdentity('TEST-SIMULATOR', 'some-device')).toBe(false);
    expect(isLiveFleetIdentity('PILOT-CH9N', 'VIRTUAL-TEST-DEVICE')).toBe(false);
    expect(isLiveFleetIdentity('PILOT-CH9N', 'TECNO-001')).toBe(true);
  });
});

describe('reservation-aware capacity', () => {
  it('includes every active deposit intent in predicted wallet headroom', () => {
    expect(predictedDepositBalance(70_000n, [2_000n, 3_000n], 1_000n)).toBe(76_000n);
  });

  it('includes queued and unknown payout reservations in the daily cap', () => {
    expect(withinWithdrawalCapacity(100_000n, 30_000n, 20_000n, 150_000n)).toBe(true);
    expect(withinWithdrawalCapacity(100_000n, 30_000n, 20_001n, 150_000n)).toBe(false);
  });
});
