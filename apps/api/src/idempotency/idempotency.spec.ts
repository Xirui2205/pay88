import { describe, expect, it } from 'vitest';
import { stableJson } from '../common/crypto';
import { financialReferenceRetentionEnd } from './idempotency.service';

describe('canonical request hashing', () => {
  it('is independent of object key order', () => {
    expect(stableJson({ amount: '20.00', metadata: { b: 2, a: 1 } })).toBe(
      stableJson({ metadata: { a: 1, b: 2 }, amount: '20.00' }),
    );
  });

  it('does not reorder arrays', () => {
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
  });

  it('retains a financial reference fingerprint for the resource lifetime', () => {
    expect(financialReferenceRetentionEnd().getUTCFullYear()).toBe(9999);
  });
});
