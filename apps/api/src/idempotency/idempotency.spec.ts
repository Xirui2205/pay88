import { describe, expect, it, vi } from 'vitest';
import { stableJson } from '../common/crypto';
import { financialReferenceRetentionEnd, IdempotencyService } from './idempotency.service';

describe('canonical request hashing', () => {
  it('is independent of object key order', () => {
    expect(stableJson({ amount: '20.00', metadata: { b: 2, a: 1 } })).toBe(
      stableJson({ metadata: { a: 1, b: 2 }, amount: '20.00' }),
    );
  });

  it('does not reorder arrays', () => {
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
  });

  it('canonicalizes BigInts and dates without losing precision or throwing', () => {
    expect(stableJson({ at: new Date('2026-07-11T00:00:00.000Z'), amountMinor: 9_007_199_254_740_993n })).toBe(
      '{"amountMinor":"9007199254740993","at":"2026-07-11T00:00:00.000Z"}',
    );
  });

  it('retains a financial reference fingerprint for the resource lifetime', () => {
    expect(financialReferenceRetentionEnd().getUTCFullYear()).toBe(9999);
  });

  it('stores default idempotent results as Prisma-compatible JSON when they contain BigInts', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      idempotencyRecord: {
        findFirst: vi.fn().mockResolvedValue(null),
        createMany,
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) => callback(transaction)),
    };
    const service = new IdempotencyService(prisma as never);

    await service.execute({
      auth: { merchantId: 'merchant-1', environment: 'test', apiKeyId: 'key-1' },
      operation: 'test.bigint',
      key: 'idem-1',
      payload: { amount: '1.00' },
      execute: async () => ({ amountMinor: 9_007_199_254_740_993n }),
    });

    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ responseBody: { amountMinor: '9007199254740993' } })],
    }));
  });
});
