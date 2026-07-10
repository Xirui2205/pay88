import { describe, expect, it } from 'vitest';
import { canReviewSettlement, settlementTransferReference } from './settlements.service';

describe('settlement approval state', () => {
  it('allows exactly one platform decision', () => {
    expect(canReviewSettlement('requested')).toBe(true);
    for (const terminal of ['approved', 'rejected', 'dispatched', 'success', 'failed', 'unknown']) {
      expect(canReviewSettlement(terminal)).toBe(false);
    }
  });
});

describe('settlement internal transfer reference', () => {
  it('stays within the transfer schema independent of merchant reference length', () => {
    const reference = settlementTransferReference('11111111-1111-4111-8111-111111111111');
    expect(reference).toBe('SET:11111111-1111-4111-8111-111111111111');
    expect(reference.length).toBeLessThanOrEqual(128);
  });
});
