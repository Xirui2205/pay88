import argon2 from 'argon2';
import { describe, expect, it, vi } from 'vitest';
import type { PortalAuthContext } from '../auth/auth.types';
import { PortalService } from './portal.service';

const auth: PortalAuthContext = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  merchantId: '00000000-0000-4000-8000-000000000003',
  merchantSlug: 'merchant',
  merchantName: 'Merchant',
  email: 'owner@example.com',
  displayName: 'Owner',
  role: 'owner',
};
const supportAuth: PortalAuthContext = { ...auth, role: 'support', userId: '00000000-0000-4000-8000-000000000004' };

describe('PortalService', () => {
  it('returns a new API key once while persisting only an Argon2 hash', async () => {
    let persisted: Record<string, unknown> | undefined;
    const transaction = {
      apiKey: { create: vi.fn(async ({ data }) => { persisted = data; return { id: 'key-id', createdAt: new Date('2026-07-10T00:00:00Z'), ...data }; }) },
      auditLog: { create: vi.fn(async () => ({})) },
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(transaction)) };
    const service = new PortalService(prisma as never, {} as never);
    const result = await service.createApiKey(auth, 'live', 'Production server');

    expect(result.secret_key).toMatch(/^sk_live_[a-f0-9]{12}\./);
    expect(persisted).not.toHaveProperty('secret');
    expect(await argon2.verify(String(persisted?.secretHash), result.secret_key)).toBe(true);
  });

  it('does not expose API-key inventory or mutations to support users', async () => {
    const findMany = vi.fn(async () => []);
    const findFirst = vi.fn(async () => null);
    const prisma = { apiKey: { findMany, findFirst } };
    const service = new PortalService(prisma as never, {} as never);

    await expect(service.apiKeys(supportAuth, 'live')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(service.createApiKey(supportAuth, 'live', 'Production server')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(service.revokeApiKey(supportAuth, '00000000-0000-4000-8000-000000000005')).rejects.toMatchObject({ code: 'forbidden' });
    expect(findMany).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('scopes physical-liquidity aggregation to own or non-dedicated groups', async () => {
    const aggregate = vi.fn(async () => ({ _count: 0, _sum: { mainBalanceMinor: 0n, reservedBalanceMinor: 0n } }));
    const prisma = {
      ledgerAccount: { findMany: vi.fn(async () => []) },
      transfer: { aggregate: vi.fn(async () => ({ _count: 0, _sum: { amountMinor: 0n } })) },
      depositIntent: { count: vi.fn(async () => 0) },
      simWallet: { aggregate },
    };
    const service = new PortalService(prisma as never, {} as never);
    await service.summary(auth, 'live');
    expect(aggregate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        device: expect.objectContaining({
          hardwareSerial: { not: 'VIRTUAL-TEST-DEVICE' },
          group: expect.objectContaining({
            code: { not: 'TEST-SIMULATOR' },
            OR: [{ merchants: { some: { merchantId: auth.merchantId } } }, { merchants: { none: { dedicated: true } } }],
          }),
        }),
      }),
    }));
  });
});
