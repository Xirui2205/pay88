import type { ExecutionContext } from '@nestjs/common';
import argon2 from 'argon2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MerchantRequest } from './auth.types';
import { MerchantAuthGuard } from './merchant-auth.guard';

vi.mock('argon2', () => ({ default: { verify: vi.fn() } }));

const rawKey = 'sk_live_a1b2c3d4.valid-or-invalid-secret';
const apiKey = {
  id: '00000000-0000-4000-8000-000000000001',
  merchantId: '00000000-0000-4000-8000-000000000002',
  environment: 'live',
  prefix: 'sk_live_a1b2c3d4',
  secretHash: 'argon2-hash',
  revokedAt: null,
  merchant: { status: 'active' },
};

function executionContext(ip = '203.0.113.10') {
  const request = {
    ip,
    socket: { remoteAddress: ip },
    header: vi.fn((name: string) => name.toLowerCase() === 'authorization' ? `Bearer ${rawKey}` : undefined),
  } as unknown as MerchantRequest;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

function dependencies() {
  const prisma = {
    apiKey: {
      findUnique: vi.fn(async () => apiKey),
      update: vi.fn(async () => apiKey),
    },
  };
  const cache = {
    get: vi.fn(async () => null as string | null),
    set: vi.fn(async () => undefined),
    increment: vi.fn(async () => 1),
  };
  return { prisma, cache };
}

describe('MerchantAuthGuard expensive-verification protection', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.MERCHANT_API_AUTH_ATTEMPTS_PER_MINUTE;
    delete process.env.MERCHANT_API_AUTH_CACHE_SECONDS;
  });

  it('rate-limits by source IP and key prefix before invoking Argon2', async () => {
    process.env.MERCHANT_API_AUTH_ATTEMPTS_PER_MINUTE = '1';
    const { prisma, cache } = dependencies();
    cache.increment.mockResolvedValueOnce(2);
    const verify = vi.mocked(argon2.verify);
    const guard = new MerchantAuthGuard(prisma as never, cache as never);

    await expect(guard.canActivate(executionContext().context)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(cache.increment).toHaveBeenCalledWith(expect.stringMatching(/^merchant-api-auth-attempt:[a-f0-9]{32}:\d+$/), 120);
    expect(verify).not.toHaveBeenCalled();
  });

  it('counts a failed secret for an existing prefix before its Argon2 verification', async () => {
    const { prisma, cache } = dependencies();
    const verify = vi.mocked(argon2.verify).mockResolvedValueOnce(false);
    const guard = new MerchantAuthGuard(prisma as never, cache as never);

    await expect(guard.canActivate(executionContext().context)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(cache.increment).toHaveBeenCalledTimes(1);
    expect(cache.increment.mock.invocationCallOrder[0]).toBeLessThan(verify.mock.invocationCallOrder[0]);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('caches a successful verification while still checking key status on every request', async () => {
    const { prisma, cache } = dependencies();
    let cachedStamp: string | null = null;
    cache.get.mockImplementation(async () => cachedStamp);
    cache.set.mockImplementation(async (_key: string, value: string) => { cachedStamp = value; });
    const verify = vi.mocked(argon2.verify).mockResolvedValue(true);
    const guard = new MerchantAuthGuard(prisma as never, cache as never);
    const first = executionContext();
    const second = executionContext();

    await expect(guard.canActivate(first.context)).resolves.toBe(true);
    await expect(guard.canActivate(second.context)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(prisma.apiKey.findUnique).toHaveBeenCalledTimes(2);
    expect(cache.set).toHaveBeenCalledWith(expect.stringContaining(`merchant-api-auth-ok:${apiKey.id}:`), expect.any(String), 300);
    expect(second.request.auth).toEqual({ merchantId: apiKey.merchantId, environment: 'live', apiKeyId: apiKey.id });
  });
});
