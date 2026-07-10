import { describe, expect, it, vi } from 'vitest';
import { isPublicWebhookAddress, resolveWebhookTarget } from './webhook-url-policy.service';

describe('webhook URL SSRF policy', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ])('accepts globally routable address %s', (address) => {
    expect(isPublicWebhookAddress(address)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.4',
    '203.0.113.5',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2002:7f00:1::1',
    '3fff::1',
  ])('rejects non-public or special-use address %s', (address) => {
    expect(isPublicWebhookAddress(address)).toBe(false);
  });

  it('requires HTTPS in production and disallows URL credentials', async () => {
    const dns = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    await expect(resolveWebhookTarget('http://merchant.example/hook', { production: true, lookup: dns })).rejects.toMatchObject({ code: 'invalid_webhook_url' });
    await expect(resolveWebhookTarget('https://user:secret@merchant.example/hook', { production: true, lookup: dns })).rejects.toMatchObject({ code: 'invalid_webhook_url' });
    expect(dns).not.toHaveBeenCalled();
  });

  it('rejects private IP literals and URL fragments without consulting DNS', async () => {
    const dns = vi.fn();
    await expect(resolveWebhookTarget('https://127.0.0.1/hook', { production: true, lookup: dns })).rejects.toMatchObject({ code: 'invalid_webhook_url' });
    await expect(resolveWebhookTarget('https://merchant.example/hook#fragment', { production: true, lookup: dns })).rejects.toMatchObject({ code: 'invalid_webhook_url' });
    expect(dns).not.toHaveBeenCalled();
  });

  it('rejects a hostname if any DNS answer is non-public', async () => {
    const dns = vi.fn().mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ]);
    await expect(resolveWebhookTarget('https://merchant.example/hook', { production: true, lookup: dns })).rejects.toMatchObject({ code: 'invalid_webhook_url' });
  });

  it('returns a public address that the HTTP client can pin', async () => {
    const dns = vi.fn().mockResolvedValue([
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '1.1.1.1', family: 4 },
    ]);
    const target = await resolveWebhookTarget('https://merchant.example:8443/hook?source=p2p', { production: true, lookup: dns });
    expect(target.address).toBe('2606:4700:4700::1111');
    expect(target.family).toBe(6);
    expect(target.url.pathname).toBe('/hook');
  });
});
