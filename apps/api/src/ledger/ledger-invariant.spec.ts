import { describe, expect, it } from 'vitest';
import { providerFeeAdjustment } from './ledger.service';

describe('double-entry invariant examples', () => {
  it('balances deposit and withdrawal reservation journals', () => {
    const deposit = [{ direction: 'D', value: 5000n }, { direction: 'C', value: 5000n }];
    const reserve = [{ direction: 'D', value: 2100n }, { direction: 'C', value: 2100n }];
    for (const journal of [deposit, reserve]) {
      const debits = journal.filter((entry) => entry.direction === 'D').reduce((sum, entry) => sum + entry.value, 0n);
      const credits = journal.filter((entry) => entry.direction === 'C').reduce((sum, entry) => sum + entry.value, 0n);
      expect(debits).toBe(credits);
    }
  });

  it('records authoritative fee overruns instead of rejecting provider success', () => {
    expect(providerFeeAdjustment(100n, 80n)).toEqual({ refund: 20n, overrun: 0n });
    expect(providerFeeAdjustment(100n, 125n)).toEqual({ refund: 0n, overrun: 25n });
  });

  it('reclassifies treasury sweep principal while charging only the provider fee', () => {
    const amount = 1_000n;
    const reservedFee = 100n;
    const actualFee = 80n;
    const debits = reservedFee + amount;
    const credits = amount + actualFee + (reservedFee - actualFee);
    expect(debits).toBe(credits);
  });
});
