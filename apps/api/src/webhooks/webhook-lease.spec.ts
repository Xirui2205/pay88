import { describe, expect, it, vi } from 'vitest';
import { WebhooksService } from './webhooks.service';

const serviceWithPrisma = (prisma: unknown) => new WebhooksService(
  prisma as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
);

describe('webhook delivery leases', () => {
  it('claims a due delivery with a conditional, fenced update', async () => {
    const delivery = { id: 'delivery-1' };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue(delivery);
    const service = serviceWithPrisma({ webhookDelivery: { updateMany, findUnique } });
    const now = new Date('2026-07-10T00:00:00.000Z');

    const claim = await (service as unknown as { claimDelivery(id: string, now: Date): Promise<{ delivery: unknown; leaseToken: string } | null> }).claimDelivery('delivery-1', now);

    expect(claim?.delivery).toBe(delivery);
    expect(claim?.leaseToken).toMatch(/^[0-9a-f]{48}$/);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'delivery-1', OR: expect.any(Array) }),
      data: expect.objectContaining({ status: 'processing', leaseToken: claim?.leaseToken, leaseExpiresAt: new Date('2026-07-10T00:00:30.000Z') }),
    }));
  });

  it('does not deliver when another replica won the conditional claim', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUnique = vi.fn();
    const service = serviceWithPrisma({ webhookDelivery: { updateMany, findUnique } });
    const claim = await (service as unknown as { claimDelivery(id: string, now: Date): Promise<unknown> }).claimDelivery('delivery-1', new Date());
    expect(claim).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('allows only the current lease token to finalize a delivery', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const service = serviceWithPrisma({ webhookDelivery: { updateMany } });
    const finalized = await (service as unknown as { finishClaim(id: string, token: string, data: unknown): Promise<boolean> })
      .finishClaim('delivery-1', 'stale-token', { status: 'delivered' });
    expect(finalized).toBe(false);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: 'processing', leaseToken: 'stale-token' },
      data: { status: 'delivered', leaseToken: null, leaseExpiresAt: null },
    });
  });
});
