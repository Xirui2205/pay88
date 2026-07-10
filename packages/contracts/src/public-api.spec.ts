import { describe, expect, it } from 'vitest';
import { createTransferSchema } from './public-api';

const transfer = {
  account_number: '0912345678',
  expected_name: 'Test Receiver',
  customer_id: 'customer-1',
  amount: '25.00',
  currency: 'ETB' as const,
  reference: 'withdrawal-1',
};

describe('public transfer contract', () => {
  it.each([855, '855'] as const)('normalizes Telebirr bank code %s', (bankCode) => {
    expect(createTransferSchema.parse({ ...transfer, bank_code: bankCode }).bank_code).toBe('855');
  });

  it('rejects a different provider code', () => {
    expect(createTransferSchema.safeParse({ ...transfer, bank_code: 999 }).success).toBe(false);
  });

  it('defaults to the authenticated merchant assertion and makes alternate destinations explicit', () => {
    expect(createTransferSchema.parse({ ...transfer, bank_code: 855 }).destination_type).toBe('registered');
    expect(createTransferSchema.parse({ ...transfer, bank_code: 855, destination_type: 'alternate' }).destination_type).toBe('alternate');
  });
});
