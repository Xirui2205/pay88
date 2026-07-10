import { Injectable } from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { ResolvedWebhookTarget } from './webhook-url-policy.service';

export interface WebhookHttpResponse {
  status: number;
  ok: boolean;
  body: string;
}

@Injectable()
export class WebhookHttpClientService {
  post(target: ResolvedWebhookTarget, headers: Record<string, string>, body: string): Promise<WebhookHttpResponse> {
    return new Promise((resolve, reject) => {
      const secure = target.url.protocol === 'https:';
      const tlsHostname = target.url.hostname.startsWith('[') && target.url.hostname.endsWith(']')
        ? target.url.hostname.slice(1, -1)
        : target.url.hostname;
      const request = (secure ? httpsRequest : httpRequest)(
        {
          protocol: target.url.protocol,
          hostname: target.address,
          family: target.family,
          port: target.url.port ? Number(target.url.port) : secure ? 443 : 80,
          path: `${target.url.pathname}${target.url.search}`,
          method: 'POST',
          servername: secure && isIP(tlsHostname) === 0 ? tlsHostname : undefined,
          rejectUnauthorized: true,
          headers: { ...headers, host: target.url.host, 'content-length': Buffer.byteLength(body).toString() },
        },
        (response) => {
          let responseBody = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            if (responseBody.length < 2000) responseBody += chunk.slice(0, 2000 - responseBody.length);
          });
          response.on('end', () => {
            clearTimeout(totalTimeout);
            const status = response.statusCode ?? 0;
            resolve({ status, ok: status >= 200 && status < 300, body: responseBody });
          });
          response.once('error', (error) => {
            clearTimeout(totalTimeout);
            reject(error);
          });
        },
      );

      const totalTimeout = setTimeout(() => request.destroy(new Error('Webhook request timed out')), 10_000);
      request.once('error', (error) => {
        clearTimeout(totalTimeout);
        reject(error);
      });
      request.end(body);
    });
  }
}
