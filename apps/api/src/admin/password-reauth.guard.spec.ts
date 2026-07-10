import { describe, expect, it, vi } from 'vitest';
import { PasswordReauthGuard } from './password-reauth.guard';

function context(request: Record<string, unknown>) {
  return { switchToHttp: () => ({ getRequest: () => request }) } as never;
}

describe('PasswordReauthGuard', () => {
  it('atomically consumes a single-use staff reauthentication token', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const guard = new PasswordReauthGuard({ platformReauthToken: { updateMany } } as never);
    const request = { platformAuth: { kind: 'session', sessionId: 'session-1' }, header: (name: string) => name === 'x-reauth-token' ? 'par_secret' : undefined };
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ sessionId: 'session-1', usedAt: null }) }));
  });

  it('requires and audits a reason for break-glass sensitive actions', async () => {
    const create = vi.fn(async () => ({}));
    const guard = new PasswordReauthGuard({ auditLog: { create } } as never);
    const denied = { platformAuth: { kind: 'service', staffId: 'break-glass-service' }, header: () => '', originalUrl: '/v1/admin/action', method: 'POST' };
    await expect(guard.canActivate(context(denied))).rejects.toMatchObject({ code: 'break_glass_reason_required' });
    const allowed = { ...denied, header: (name: string) => name === 'x-break-glass-reason' ? 'Carrier incident INC-42' : '' };
    await expect(guard.canActivate(context(allowed))).resolves.toBe(true);
    expect(create).toHaveBeenCalledOnce();
  });
});
