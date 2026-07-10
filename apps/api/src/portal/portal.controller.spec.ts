import { describe, expect, it, vi } from 'vitest';
import type { PortalRequest } from '../auth/auth.types';
import { PortalController } from './portal.controller';

const supportRequest = {
  portalAuth: {
    sessionId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    merchantId: '00000000-0000-4000-8000-000000000003',
    merchantSlug: 'merchant',
    merchantName: 'Merchant',
    email: 'support@example.com',
    displayName: 'Support',
    role: 'support',
  },
  query: {},
  header: vi.fn(),
} as unknown as PortalRequest;

function controller() {
  const portal = {
    apiKeys: vi.fn(),
    createApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
  };
  const webhooks = {
    register: vi.fn(),
    setEnabled: vi.fn(),
    rotateSecret: vi.fn(),
  };
  return {
    portal,
    webhooks,
    instance: new PortalController(portal as never, {} as never, {} as never, webhooks as never, {} as never, {} as never),
  };
}

describe('PortalController support-role secret boundaries', () => {
  it('blocks API-key inventory, creation and revocation at the endpoint boundary', async () => {
    const { instance, portal } = controller();

    await expect(instance.apiKeys(supportRequest, 'live')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(instance.createApiKey(supportRequest, { environment: 'live', label: 'Production server' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(instance.revokeApiKey(supportRequest, '00000000-0000-4000-8000-000000000004')).rejects.toMatchObject({ code: 'forbidden' });
    expect(portal.apiKeys).not.toHaveBeenCalled();
    expect(portal.createApiKey).not.toHaveBeenCalled();
    expect(portal.revokeApiKey).not.toHaveBeenCalled();
  });

  it('blocks webhook creation, lifecycle management and secret rotation', async () => {
    const { instance, webhooks } = controller();
    const endpointId = '00000000-0000-4000-8000-000000000005';

    await expect(instance.createWebhook(supportRequest, { environment: 'live', url: 'https://merchant.example/webhook' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(instance.setWebhookEnabled(supportRequest, endpointId, { environment: 'live', enabled: false })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(instance.rotateWebhookSecret(supportRequest, endpointId, { environment: 'live' }, 'rotation-attempt-1')).rejects.toMatchObject({ code: 'forbidden' });
    expect(webhooks.register).not.toHaveBeenCalled();
    expect(webhooks.setEnabled).not.toHaveBeenCalled();
    expect(webhooks.rotateSecret).not.toHaveBeenCalled();
  });
});
