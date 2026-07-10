import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './configuration';

describe('environment validation', () => {
  it('provides isolated local defaults outside production', () => {
    const config = validateEnvironment({ NODE_ENV: 'test' });
    expect(config.DATABASE_URL).toContain('localhost');
    expect(config.DEVICE_GATEWAY_URL).toMatch(/^wss:/);
  });

  it('fails closed on placeholder production secrets and ephemeral signing keys', () => {
    expect(() => validateEnvironment({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@example.com:5432/app',
      PUBLIC_API_URL: 'https://api.example.com',
      CHECKOUT_BASE_URL: 'https://checkout.example.com',
      DEVICE_GATEWAY_URL: 'wss://device.example.com/v1/device/connect',
      CHECKOUT_TOKEN_SECRET: 'replace-with-at-least-32-random-characters',
      WEBHOOK_MASTER_KEY: 'replace-with-at-least-32-random-characters',
      ADMIN_API_TOKEN: 'replace-with-at-least-32-random-characters',
      OPENCLAW_GATEWAY_TOKEN: 'replace-with-at-least-32-random-characters',
    })).toThrow();
  });
});
