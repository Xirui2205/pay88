import { describe, expect, it, vi } from 'vitest';
import { SmsIngestionService, correlatableBalanceQueryLeases, depositStatusAllowsProviderTimeMatch, effectiveProviderOccurredAt, resultingOutgoingBalance, serializeParsed, transactionBalanceMutationForWallet } from './sms-ingestion.service';
import { parseTelebirrSms } from '../parsers/sms-parser';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const SIM_ID = '22222222-2222-4222-8222-222222222222';
const RECEIPT_ID = '33333333-3333-4333-8333-333333333333';
const CASE_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';
const OBSERVED_AT = new Date('2026-07-10T08:00:00.000Z');

describe('provider transaction time', () => {
  it('uses a plausible Telebirr timestamp instead of delayed device upload time', () => {
    const providerTime = new Date('2026-07-10T07:40:00.000Z');
    expect(effectiveProviderOccurredAt(providerTime, OBSERVED_AT)).toEqual(providerTime);
  });

  it('falls back to receipt time for implausibly old or future timestamps', () => {
    expect(effectiveProviderOccurredAt(new Date('2026-06-01T00:00:00.000Z'), OBSERVED_AT)).toEqual(OBSERVED_AT);
    expect(effectiveProviderOccurredAt(new Date('2026-07-10T09:00:00.000Z'), OBSERVED_AT)).toEqual(OBSERVED_AT);
  });
});

describe('late deposit provider-time policy', () => {
  const created = new Date('2026-07-10T08:00:00Z');
  const graceEnd = new Date('2026-07-10T08:40:00Z');

  it('auto-matches an expired row when the provider proves payment occurred inside grace', () => {
    expect(depositStatusAllowsProviderTimeMatch('expired', created, graceEnd, new Date('2026-07-10T08:39:59Z'))).toBe(true);
    expect(depositStatusAllowsProviderTimeMatch('expired', created, graceEnd, new Date('2026-07-10T08:40:01Z'))).toBe(false);
    expect(depositStatusAllowsProviderTimeMatch('manual_review', created, graceEnd, new Date('2026-07-10T08:20:00Z'))).toBe(false);
  });
});

describe('transaction balance watermark', () => {
  it('does not rewind a newer wallet snapshot when an older SMS uploads late', () => {
    const result = transactionBalanceMutationForWallet(
      { mainBalanceMinor: 80_000n, lastBalanceAt: new Date('2026-07-10T08:00:00Z') },
      new Date('2026-07-10T07:30:00Z'),
      90_000n,
      10_000n,
      'decrement',
    );
    expect(result.data).toEqual({});
    expect(result.resultingBalanceMinor).toBe(80_000n);
  });

  it('advances a predicted balance and its provider-time watermark once', () => {
    const occurredAt = new Date('2026-07-10T08:01:00Z');
    const result = transactionBalanceMutationForWallet({ mainBalanceMinor: 80_000n, lastBalanceAt: null }, occurredAt, null, 5_000n, 'increment');
    expect(result.resultingBalanceMinor).toBe(85_000n);
    expect(result.data).toMatchObject({ mainBalanceMinor: 85_000n, lastBalanceAt: occurredAt });
  });
});

const BALANCE_BODY = [
  'Dear',
  'Your telebirr Customer Incentive Account Balance is : ETB 10.00',
  'Customer E-Money Account Balance is : ETB 844.35',
  'Customer E-Money Account for fuel payment Balance is : ETB 0.00',
  'PocketMoney Account Balance is : ETB 0.00',
  'Thank you for using telebirr Ethio telecom',
].join(' ');

const OUTGOING_BODY = [
  'Dear Bekalu You have transferred ETB 20.00 to Abayine Fucha (9928****7)',
  'on 10/07/2026 10:59:30. Your transaction number is DG87NDFU4H.',
  'The service fee is ETB 0.87 and 15% VAT on the service fee is ETB 0.13.',
].join(' ');

describe('structured SMS evidence', () => {
  it('never duplicates the full raw provider message in plaintext parsed JSON', () => {
    const parsed = parseTelebirrSms(OUTGOING_BODY);
    const serialized = JSON.stringify(serializeParsed(parsed));
    expect(serialized).not.toContain(OUTGOING_BODY);
    expect(serialized).not.toContain('"raw"');
  });
});

type HarnessOptions = {
  jobs?: Array<Record<string, unknown>>;
  transfers?: Array<Record<string, unknown>>;
  mainBalanceMinor?: bigint;
  lastBalanceAt?: Date | null;
};

function createHarness(options: HarnessOptions = {}) {
  let inboxProcessed = false;
  const simWalletUpdate = vi.fn().mockResolvedValue({});
  const reconciliationCreate = vi.fn().mockResolvedValue({ id: CASE_ID });
  const tx = {
    inboxEvent: {
      findUnique: vi.fn().mockImplementation(async () => (inboxProcessed ? { id: 'processed' } : null)),
      create: vi.fn().mockImplementation(async () => {
        inboxProcessed = true;
        return {};
      }),
    },
    simWallet: {
      findUnique: vi.fn().mockResolvedValue({ id: SIM_ID, deviceId: DEVICE_ID }),
      findUniqueOrThrow: vi.fn().mockImplementation(async (args: { select?: Record<string, boolean> }) => {
        if (args.select?.status) return { status: 'payout_stale', lastBalanceAt: options.lastBalanceAt ?? null };
        if (args.select?.mainBalanceMinor) return { mainBalanceMinor: options.mainBalanceMinor ?? 100_000n };
        return {
          financialDay: new Date('2026-07-10T00:00:00.000Z'),
          sentTodayMinor: 500n,
          receivedTodayMinor: 300n,
        };
      }),
      update: simWalletUpdate,
    },
    smsReceipt: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: RECEIPT_ID, bodyHash: 'body-hash' }),
    },
    deviceJob: {
      findFirst: vi.fn().mockResolvedValue((options.jobs ?? [])[0] ?? null),
      findMany: vi.fn().mockResolvedValue(options.jobs ?? []),
      update: vi.fn().mockResolvedValue({}),
    },
    device: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    balanceSnapshot: { create: vi.fn().mockResolvedValue({}) },
    transfer: { findMany: vi.fn().mockResolvedValue(options.transfers ?? []) },
    reconciliationCase: { create: reconciliationCreate },
  };
  const prisma = {
    $transaction: vi.fn().mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const alerts = { notify: vi.fn().mockResolvedValue({}) };
  const evidence = { persistByEvent: vi.fn().mockResolvedValue(undefined) };
  const service = new SmsIngestionService(prisma as never, {} as never, alerts as never, evidence as never);
  return { service, tx, alerts, evidence, simWalletUpdate, reconciliationCreate };
}

function event(body: string, receivedAt = OBSERVED_AT) {
  return {
    event_id: EVENT_ID,
    received_at: receivedAt.toISOString(),
    sender: '127',
    subscription_id: 1,
    sim_iccid: '8999912345678901234',
    body,
  };
}

function validBalanceJob(id: string) {
  return {
    id,
    state: 'provider_pending',
    deviceId: DEVICE_ID,
    leaseOwner: DEVICE_ID,
    leaseExpiresAt: new Date(OBSERVED_AT.valueOf() + 20_000),
    expiresAt: new Date(OBSERVED_AT.valueOf() + 5 * 60_000),
    startedAt: new Date(OBSERVED_AT.valueOf() - 20_000),
    createdAt: new Date(OBSERVED_AT.valueOf() - 30_000),
  };
}

describe('balance SMS correlation safety', () => {
  it('accepts only a started job with the same device lease and a recent correlation window', () => {
    const valid = validBalanceJob('valid');
    const leasedOnly = { ...validBalanceJob('leased-only'), state: 'leased', startedAt: null };
    const wrongOwner = { ...validBalanceJob('wrong-owner'), leaseOwner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const stale = { ...validBalanceJob('stale'), leaseExpiresAt: new Date(OBSERVED_AT.valueOf() - 6 * 60_000) };
    const tooOld = {
      ...validBalanceJob('too-old'),
      createdAt: new Date(OBSERVED_AT.valueOf() - 16 * 60_000),
      startedAt: new Date(OBSERVED_AT.valueOf() - 16 * 60_000),
    };

    expect(correlatableBalanceQueryLeases([valid, leasedOnly, wrongOwner, stale, tooOld], OBSERVED_AT).map((item) => item.id)).toEqual(['valid']);
  });

  it('retains an unsolicited balance receipt as manual evidence without mutating balance or snapshot', async () => {
    const harness = createHarness({ jobs: [] });

    const result = await harness.service.ingest(DEVICE_ID, event(BALANCE_BODY));

    expect(result).toMatchObject({ duplicate: false, type: 'balance', correlation_status: 'unmatched', reconciliation_case_id: CASE_ID });
    expect(harness.tx.balanceSnapshot.create).not.toHaveBeenCalled();
    expect(harness.simWalletUpdate).toHaveBeenCalledTimes(1);
    expect(harness.simWalletUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { lastSmsAt: OBSERVED_AT } }));
    expect(harness.reconciliationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'unmatched_balance_sms',
          referenceId: RECEIPT_ID,
          evidence: expect.objectContaining({ wallet_mutated: false, candidate_job_ids: [] }),
        }),
      }),
    );
    expect(harness.alerts.notify).toHaveBeenCalledWith('reconciliation_drift', expect.any(String), expect.objectContaining({ reconciliation_case_id: CASE_ID }));
  });

  it('quarantines and retains a balance SMS when the device timestamp predates its active query', async () => {
    const harness = createHarness({ jobs: [validBalanceJob('clock-job')] });
    const result = await harness.service.ingest(DEVICE_ID, event(BALANCE_BODY, new Date('2026-07-10T07:00:00Z')));

    expect(result).toMatchObject({ correlation_status: 'unmatched', reconciliation_case_id: CASE_ID });
    expect(harness.reconciliationCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'device_clock_invalid_balance_sms' }) }));
    expect(harness.tx.balanceSnapshot.create).not.toHaveBeenCalled();
  });

  it('refuses an ambiguous balance response rather than choosing the newest job', async () => {
    const harness = createHarness({ jobs: [validBalanceJob('job-a'), validBalanceJob('job-b')] });

    const result = await harness.service.ingest(DEVICE_ID, event(BALANCE_BODY));

    expect(result.correlation_status).toBe('ambiguous');
    expect(harness.tx.balanceSnapshot.create).not.toHaveBeenCalled();
    expect(harness.tx.deviceJob.update).not.toHaveBeenCalled();
    expect(harness.reconciliationCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'ambiguous_balance_sms' }) }),
    );
  });

  it('applies a balance and completes the job only for one valid correlation', async () => {
    const job = validBalanceJob('job-a');
    const harness = createHarness({ jobs: [job] });

    const result = await harness.service.ingest(DEVICE_ID, event(BALANCE_BODY));

    expect(result.correlation_status).toBe('matched');
    expect(harness.tx.balanceSnapshot.create).toHaveBeenCalledOnce();
    expect(harness.simWalletUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mainBalanceMinor: 84_435n, lastBalanceSource: 'balance_sms' }) }),
    );
    expect(harness.tx.deviceJob.update).toHaveBeenCalledWith({ where: { id: 'job-a' }, data: { state: 'succeeded', completedAt: OBSERVED_AT } });
    expect(harness.reconciliationCreate).not.toHaveBeenCalled();
  });

  it('keeps a uniquely correlated but older balance as evidence instead of overwriting a newer snapshot', async () => {
    const harness = createHarness({
      jobs: [validBalanceJob('job-a')],
      lastBalanceAt: new Date(OBSERVED_AT.valueOf() + 1_000),
    });

    const result = await harness.service.ingest(DEVICE_ID, event(BALANCE_BODY));

    expect(result).toMatchObject({ correlation_status: 'unmatched', reconciliation_case_id: CASE_ID });
    expect(harness.tx.balanceSnapshot.create).not.toHaveBeenCalled();
    expect(harness.tx.deviceJob.update).not.toHaveBeenCalled();
    expect(harness.reconciliationCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'stale_balance_sms', evidence: expect.objectContaining({ wallet_mutated: false }) }) }),
    );
  });
});

describe('unmatched authenticated outgoing SMS safety', () => {
  it('projects the resulting balance when the provider SMS has no explicit balance', () => {
    expect(resultingOutgoingBalance(100_000n, null, 2_100n)).toBe(97_900n);
    expect(resultingOutgoingBalance(100_000n, 23_217n, 2_100n)).toBe(23_217n);
  });

  it('accounts for the outflow once, quarantines the SIM, and opens evidence when no transfer matches', async () => {
    const harness = createHarness({ transfers: [], mainBalanceMinor: 100_000n });

    const first = await harness.service.ingest(DEVICE_ID, event(OUTGOING_BODY));
    const duplicate = await harness.service.ingest(DEVICE_ID, event(OUTGOING_BODY));

    expect(first).toMatchObject({
      duplicate: false,
      type: 'outgoing_transfer',
      correlation_status: 'unmatched',
      reconciliation_case_id: CASE_ID,
    });
    expect(duplicate).toEqual({ duplicate: true, type: 'already_processed' });
    const financialUpdates = harness.simWalletUpdate.mock.calls.filter(([args]) => 'mainBalanceMinor' in args.data);
    expect(financialUpdates).toHaveLength(1);
    expect(financialUpdates[0][0]).toMatchObject({
      where: { id: SIM_ID },
      data: {
        status: 'quarantined',
        mainBalanceMinor: 97_900n,
        sentTodayMinor: 2_600n,
        receivedTodayMinor: 300n,
        // The authoritative transaction watermark is provider occurrence time
        // (10:59:30 Africa/Addis_Ababa), not delayed device upload time.
        lastBalanceAt: new Date('2026-07-10T07:59:30.000Z'),
        lastBalanceSource: 'transaction_sms_predicted',
      },
    });
    expect(harness.reconciliationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'unmatched_payout_sms',
          referenceId: RECEIPT_ID,
          evidence: expect.objectContaining({
            total_outflow_minor: '2100',
            previous_predicted_balance_minor: '100000',
            resulting_balance_minor: '97900',
            sent_today_delta_minor: '2100',
            sim_quarantined: true,
          }),
        }),
      }),
    );
    expect(harness.alerts.notify).toHaveBeenCalledTimes(1);
    expect(harness.alerts.notify).toHaveBeenCalledWith('reconciliation_drift', expect.any(String), expect.objectContaining({ reconciliation_case_id: CASE_ID }));
  });
});
