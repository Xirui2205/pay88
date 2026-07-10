import { afterEach, describe, expect, it } from 'vitest';
import { assertTrustedDeviceIngress } from './device-ingress.guard';

const originalEnvironment = process.env.NODE_ENV;
const originalSecret = process.env.DEVICE_MTLS_PROXY_SECRET;
const originalMtlsRequired = process.env.DEVICE_MTLS_REQUIRED;

afterEach(() => {
  if (originalEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment;
  if (originalSecret === undefined) delete process.env.DEVICE_MTLS_PROXY_SECRET;
  else process.env.DEVICE_MTLS_PROXY_SECRET = originalSecret;
  if (originalMtlsRequired === undefined) delete process.env.DEVICE_MTLS_REQUIRED;
  else process.env.DEVICE_MTLS_REQUIRED = originalMtlsRequired;
});

describe('trusted device ingress', () => {
  it('rejects spoofable certificate headers without the independent proxy secret', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEVICE_MTLS_PROXY_SECRET = 'a'.repeat(32);
    const values: Record<string, string> = {
      'x-client-cert-verified': 'SUCCESS',
      'x-client-cert-sha256': 'b'.repeat(64),
    };
    expect(() => assertTrustedDeviceIngress((name) => values[name])).toThrow('trusted device ingress');
  });

  it('accepts only the mTLS terminator-authenticated production path', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEVICE_MTLS_PROXY_SECRET = 'a'.repeat(32);
    const values: Record<string, string> = {
      'x-device-ingress-secret': 'a'.repeat(32),
      'x-client-cert-verified': 'SUCCESS',
      'x-client-cert-sha256': 'b'.repeat(64),
    };
    expect(() => assertTrustedDeviceIngress((name) => values[name])).not.toThrow();
  });

  it('allows explicit pilot token authentication without mTLS', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEVICE_MTLS_REQUIRED = 'false';
    expect(() => assertTrustedDeviceIngress(() => undefined)).not.toThrow();
  });
});
