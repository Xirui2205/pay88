import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebhookHttpClientService } from './webhook-http-client.service';

describe('webhook HTTP client', () => {
  it('pins the socket address, preserves Host, and never follows redirects', async () => {
    let redirectedRequests = 0;
    let receivedHost = '';
    const server = createServer((request, response) => {
      receivedHost = request.headers.host ?? '';
      if (request.url === '/redirected') {
        redirectedRequests += 1;
        response.writeHead(200).end('must not be reached');
        return;
      }
      response.writeHead(302, { location: '/redirected' }).end('redirect refused');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const client = new WebhookHttpClientService();
      const response = await client.post(
        { url: new URL(`http://merchant.example:${port}/initial`), address: '127.0.0.1', family: 4 },
        { 'content-type': 'application/json' },
        '{}',
      );
      expect(response.status).toBe(302);
      expect(response.ok).toBe(false);
      expect(response.body).toBe('redirect refused');
      expect(receivedHost).toBe(`merchant.example:${port}`);
      expect(redirectedRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
