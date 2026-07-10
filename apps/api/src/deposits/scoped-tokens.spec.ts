import { beforeEach, describe, expect, it } from 'vitest';
import { CheckoutTokenService } from './checkout-token.service';
import { TransferTokenService } from '../withdrawals/transfer-token.service';

describe('hosted-page scoped tokens', () => {
  beforeEach(() => {
    process.env.CHECKOUT_TOKEN_SECRET = 'test-secret-that-is-more-than-thirty-two-characters';
  });

  it('binds a checkout token to its deposit reference', () => {
    const service = new CheckoutTokenService();
    const token = service.issue({ depositId: 'deposit-id', txRef: 'DEP-1', expires: Math.floor(Date.now() / 1000) + 60 });
    expect(service.verify(token, 'DEP-1').depositId).toBe('deposit-id');
    expect(() => service.verify(token, 'DEP-2')).toThrow();
  });

  it('domain-separates withdrawal status tokens', () => {
    const service = new TransferTokenService();
    const token = service.issue({ transferId: 'transfer-id', reference: 'WD-1', expires: Math.floor(Date.now() / 1000) + 60 });
    expect(service.verify(token, 'WD-1').transferId).toBe('transfer-id');
    expect(() => service.verify(`${token}x`, 'WD-1')).toThrow();
  });
});
