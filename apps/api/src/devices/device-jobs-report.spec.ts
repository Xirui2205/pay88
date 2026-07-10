import { describe, expect, it, vi } from 'vitest';
import type { JobStatusEvent } from '@telebirr/contracts';
import { sha256, stableJson } from '../common/crypto';
import { DeviceJobsService } from './device-jobs.service';

describe('durable device status reporting', () => {
  it('acks a lost-ACK replay, rejects legacy financial ingress, then records a precommit name review atomically', async () => {
    const now = Date.now();
    const replayEventId = '11111111-1111-4111-8111-111111111111';
    const reviewEventId = '22222222-2222-4222-8222-222222222222';
    const transfer = {
      id: '33333333-3333-4333-8333-333333333333',
      merchantId: '44444444-4444-4444-8444-444444444444',
      environment: 'live',
      reference: 'WD-LOST-ACK-1',
      expectedName: 'Abayine Fucha',
      status: 'device_started',
      committedAt: null,
      amountMinor: 20_00n,
      reserveProviderFeeMinor: 25_00n,
      gatewayFeeMinor: 0n,
      financialMode: 'merchant_debit',
    };
    const attempt = { id: '55555555-5555-4555-8555-555555555555', transferId: transfer.id, transfer };
    const job: Record<string, any> = {
      id: '66666666-6666-4666-8666-666666666666',
      deviceId: '77777777-7777-4777-8777-777777777777',
      simWalletId: '88888888-8888-4888-8888-888888888888',
      type: 'customer_withdrawal',
      state: 'device_started',
      fencingToken: 9n,
      createdAt: new Date(now - 5_000),
      startedAt: new Date(now - 4_000),
      committedAt: null,
      payload: { transfer_id: transfer.id },
      transferAttempt: attempt,
    };
    const replayEvent: JobStatusEvent = {
      job_id: job.id,
      financial_operation_id: transfer.id,
      fencing_token: 9,
      state: 'device_started',
      observed_at_ms: now - 4_000,
      error_code: '',
    };
    const reviewEvent: JobStatusEvent = {
      ...replayEvent,
      state: 'cancelled',
      observed_at_ms: now,
      error_code: 'RequestNameReview',
      expected_receiver_name: 'Abayine Fucha',
      provider_receiver_name: 'Abayine Fita',
    };
    const inbox = new Map<string, string>([[replayEventId, sha256(stableJson(replayEvent))]]);
    const jobUpdates: Array<Record<string, unknown>> = [];
    const transferUpdates: Array<Record<string, unknown>> = [];
    const cases: Array<Record<string, any>> = [];
    const deviceUnlocks: Array<Record<string, unknown>> = [];
    const transaction = {
      deviceJob: {
        findUnique: vi.fn(async () => job),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          jobUpdates.push(data);
          Object.assign(job, data);
          return job;
        }),
      },
      inboxEvent: {
        findUnique: vi.fn(async ({ where }: any) => {
          const id = where.source_externalId.externalId as string;
          return inbox.has(id) ? { payloadHash: inbox.get(id) } : null;
        }),
        create: vi.fn(async ({ data }: any) => {
          inbox.set(data.externalId, data.payloadHash);
          return data;
        }),
      },
      transfer: {
        update: vi.fn(async ({ data }: any) => {
          transferUpdates.push(data);
          Object.assign(transfer, data);
          return transfer;
        }),
      },
      transferAttempt: { update: vi.fn(async ({ data }: any) => data) },
      outboxEvent: { create: vi.fn(async ({ data }: any) => data) },
      sweepExecution: { updateMany: vi.fn(async () => ({ count: 0 })) },
      settlementRequest: { updateMany: vi.fn(async () => ({ count: 0 })) },
      reconciliationCase: {
        findFirst: vi.fn(async ({ where }: any) => cases.find((item) => item.type === where.type) ?? null),
        create: vi.fn(async ({ data }: any) => {
          cases.push(data);
          return data;
        }),
      },
      device: { updateMany: vi.fn(async (input: any) => { deviceUnlocks.push(input); return { count: 1 }; }) },
    };
    const prisma = { $transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction) };
    const ledger = {
      releaseWithdrawalReservation: vi.fn(),
      releaseInternalMoveFee: vi.fn(),
    };
    const service = new DeviceJobsService(prisma as never, ledger as never, {} as never, { notify: vi.fn() } as never);

    await service.reportFromSpool(job.deviceId, replayEvent, replayEventId);
    expect(jobUpdates).toHaveLength(0);
    expect(inbox.size).toBe(1);

    await expect(service.report(job.deviceId, job.id, {
      fencing_token: 9,
      state: 'failed',
      observed_at_ms: now,
      error_code: 'legacy_fallback',
    })).rejects.toMatchObject({ code: 'financial_status_requires_spool' });

    await service.reportFromSpool(job.deviceId, reviewEvent, reviewEventId);
    expect(jobUpdates.at(-1)).toMatchObject({ state: 'cancelled', committedAt: null });
    expect(transferUpdates.at(-1)).toMatchObject({ status: 'manual_review' });
    expect(ledger.releaseWithdrawalReservation).not.toHaveBeenCalled();
    expect(deviceUnlocks).toHaveLength(1);
    expect(inbox.get(reviewEventId)).toBe(sha256(stableJson(reviewEvent)));
    expect(cases.find((item) => item.type === 'receiver_name_review')).toMatchObject({
      status: 'open',
      evidence: { observed_name: 'Abayine Fita', deterministic: { decision: 'uncertain' } },
    });
  });
});
