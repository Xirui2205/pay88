import { describe, expect, it } from 'vitest';
import { transactionBalanceMutationForWallet } from '../sms/sms-ingestion.service';
import { manualSuccessBalanceSource, outgoingReceiptAlreadyAppliedToWallet } from './withdrawals.service';

describe('manual payout resolution balance watermark', () => {
  it('marks a predicted decrement and blocks an older delayed SMS from rewinding it', () => {
    const resolvedAt = new Date('2026-07-10T08:10:00Z');
    expect(manualSuccessBalanceSource(false)).toBe('manual_evidence_predicted');
    const delayed = transactionBalanceMutationForWallet(
      { mainBalanceMinor: 79_000n, lastBalanceAt: resolvedAt },
      new Date('2026-07-10T08:05:00Z'),
      100_000n,
      21_000n,
      'decrement',
    );
    expect(delayed.data).toEqual({});
    expect(delayed.resultingBalanceMinor).toBe(79_000n);
  });

  it('distinguishes a provider-confirmed balance from a prediction', () => {
    expect(manualSuccessBalanceSource(true)).toBe('manual_evidence');
  });
});

describe('manual payout resolution after unmatched provider SMS', () => {
  it('recognizes a strongly bound outgoing receipt whose wallet delta was already applied', () => {
    expect(outgoingReceiptAlreadyAppliedToWallet(
      { simWalletId: 'sim-1', destinationPhone: '+251992844697', amountMinor: 20_00n },
      {
        simWalletId: 'sim-1',
        direction: 'outgoing',
        type: 'outgoing_transfer',
        providerTransactionId: 'DG87NDFU4H',
        amountMinor: 20_00n,
        counterpartyPhonePrefix: '9928',
        counterpartyPhoneSuffix: '7',
      },
      'DG87NDFU4H',
    )).toBe(true);
  });

  it('rejects a receipt from another SIM, amount, phone mask, or provider transaction', () => {
    const transfer = { simWalletId: 'sim-1', destinationPhone: '+251992844697', amountMinor: 20_00n };
    const receipt = {
      simWalletId: 'sim-2',
      direction: 'outgoing',
      type: 'outgoing_transfer',
      providerTransactionId: 'DG87NDFU4H',
      amountMinor: 20_00n,
      counterpartyPhonePrefix: '9928',
      counterpartyPhoneSuffix: '7',
    };
    expect(outgoingReceiptAlreadyAppliedToWallet(transfer, receipt, 'DG87NDFU4H')).toBe(false);
    expect(outgoingReceiptAlreadyAppliedToWallet(transfer, { ...receipt, simWalletId: 'sim-1', amountMinor: 21_00n }, 'DG87NDFU4H')).toBe(false);
    expect(outgoingReceiptAlreadyAppliedToWallet(transfer, { ...receipt, simWalletId: 'sim-1', counterpartyPhoneSuffix: '8' }, 'DG87NDFU4H')).toBe(false);
    expect(outgoingReceiptAlreadyAppliedToWallet(transfer, { ...receipt, simWalletId: 'sim-1' }, 'OTHER-ID')).toBe(false);
  });
});
