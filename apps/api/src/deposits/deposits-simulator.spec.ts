import { describe, expect, it, vi } from 'vitest';
import { DepositsService } from './deposits.service';

describe('deposit simulator duplicate scenario', () => {
  it('persists one receipt, suppresses the duplicate provider ID, and credits exactly once', async () => {
    const ledger = { creditDeposit: vi.fn(async () => undefined) };
    const receiptCreate = vi.fn(async () => ({ id: 'receipt-1' }));
    const receiptCreateMany = vi.fn(async () => ({ count: 0 }));
    const simUpdate = vi.fn(async () => ({}));
    const depositUpdate = vi.fn(async ({ data }: any) => ({ ...deposit, ...data }));
    const transaction = {
      smsReceipt: { create: receiptCreate, createMany: receiptCreateMany },
      simWallet: { update: simUpdate },
      depositIntent: { update: depositUpdate },
      outboxEvent: { create: vi.fn(async () => ({})) },
    };
    const deposit = {
      id: 'deposit-1',
      simWalletId: 'sim-1',
      txRef: 'DUPLICATE-1',
      customerName: 'Abebe Kebede',
      customerPhone: '+251912345678',
      amountMinor: 50_00n,
      metadata: {},
      simWallet: {},
    };
    const service = new DepositsService({} as never, {} as never, {} as never, ledger as never, {} as never);

    const result = await (service as any).applyTestScenario(
      transaction,
      { merchantId: 'merchant-1', environment: 'test', apiKeyId: 'key-1' },
      deposit,
      'duplicate',
    );

    expect(receiptCreate).toHaveBeenCalledTimes(1);
    expect(receiptCreateMany).toHaveBeenCalledTimes(1);
    expect(receiptCreateMany.mock.calls[0]?.[0]).toMatchObject({ skipDuplicates: true });
    expect(ledger.creditDeposit).toHaveBeenCalledTimes(1);
    expect(simUpdate).toHaveBeenCalledTimes(1);
    expect(depositUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'success', creditedAmountMinor: 50_00n, matchedReceiptId: 'receipt-1' }),
    }));
    expect(result.status).toBe('success');
  });
});
