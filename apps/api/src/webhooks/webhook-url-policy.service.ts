import { HttpStatus, Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ApiException } from '../common/api-exception';

export interface ResolvedWebhookTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export type WebhookDnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const ipv4Bytes = (address: string): number[] | null => {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const values = parts.map((part) => Number(part));
  if (values.some((value, index) => !Number.isInteger(value) || value < 0 || value > 255 || String(value) !== parts[index])) return null;
  return values;
};

const isPublicIpv4 = (address: string): boolean => {
  const bytes = ipv4Bytes(address);
  if (!bytes) return false;
  const [a, b] = bytes;

  // Only globally routable unicast addresses are accepted. This intentionally
  // rejects the complete RFC 6890 special-purpose ranges, including carrier
  // NAT, documentation, benchmarking, multicast and future-use space.
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (bytes[2] === 0 || bytes[2] === 2)) return false;
  if (a === 192 && b === 88 && bytes[2] === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && bytes[2] === 100) return false;
  if (a === 203 && b === 0 && bytes[2] === 113) return false;
  return true;
};

const parseIpv6 = (input: string): number[] | null => {
  const address = input.toLowerCase();
  if (address.includes('%') || address.split('::').length > 2) return null;

  let normalized = address;
  const lastColon = normalized.lastIndexOf(':');
  const tail = normalized.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4Bytes(tail);
    if (!v4) return null;
    normalized = `${normalized.slice(0, lastColon)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }

  const [leftRaw, rightRaw] = normalized.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  const hasCompression = normalized.includes('::');
  if ((!hasCompression && left.length !== 8) || (hasCompression && left.length + right.length >= 8)) return null;
  const zeros = hasCompression ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array<string>(zeros).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
};

const hasPrefix = (bytes: number[], prefix: number[], bits: number): boolean => {
  const wholeBytes = Math.floor(bits / 8);
  const remainingBits = bits % 8;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (bytes[wholeBytes] & mask) === (prefix[wholeBytes] & mask);
};

const isPublicIpv6 = (address: string): boolean => {
  const bytes = parseIpv6(address);
  if (!bytes) return false;

  // IPv4-mapped IPv6 must be judged by the embedded IPv4 address.
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIpv4(bytes.slice(12).join('.'));
  }

  // Global IPv6 unicast is currently allocated from 2000::/3. Rejecting all
  // other space prevents loopback, link-local, ULA, multicast and translation
  // prefixes from becoming alternate paths to internal services.
  if (!hasPrefix(bytes, [0x20], 3)) return false;

  // Special-use ranges that sit inside 2000::/3.
  if (hasPrefix(bytes, [0x20, 0x01, 0x00], 23)) return false; // IETF protocol assignments, Teredo, ORCHID, benchmarking
  if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return false; // documentation
  if (hasPrefix(bytes, [0x20, 0x02], 16)) return false; // 6to4 can encode non-public IPv4
  if (hasPrefix(bytes, [0x3f, 0xfe], 16) || hasPrefix(bytes, [0x3f, 0xff, 0x00], 20)) return false; // retired 6bone / documentation
  return true;
};

export const isPublicWebhookAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
};

const systemLookup: WebhookDnsLookup = async (hostname) => {
  const records = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DNS resolution timed out')), 5_000);
    lookup(hostname, { all: true, verbatim: true }).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
  return records.map(({ address, family }) => ({ address, family }));
};

export async function resolveWebhookTarget(
  rawUrl: string,
  options: { production?: boolean; lookup?: WebhookDnsLookup } = {},
): Promise<ResolvedWebhookTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiException('invalid_webhook_url', 'Webhook URL is invalid', HttpStatus.UNPROCESSABLE_ENTITY);
  }

  const production = options.production ?? process.env.NODE_ENV === 'production';
  const permittedProtocols = production ? new Set(['https:']) : new Set(['https:', 'http:']);
  if (!permittedProtocols.has(url.protocol)) {
    throw new ApiException('invalid_webhook_url', production ? 'Production webhooks require HTTPS' : 'Webhook URL must use HTTP or HTTPS', HttpStatus.UNPROCESSABLE_ENTITY);
  }
  if (url.username || url.password) {
    throw new ApiException('invalid_webhook_url', 'Webhook URL must not contain credentials', HttpStatus.UNPROCESSABLE_ENTITY);
  }
  if (!url.hostname || url.hash) {
    throw new ApiException('invalid_webhook_url', 'Webhook URL must have a hostname and no fragment', HttpStatus.UNPROCESSABLE_ENTITY);
  }

  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  let records: Array<{ address: string; family: number }>;
  if (isIP(hostname)) {
    records = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      records = await (options.lookup ?? systemLookup)(hostname);
    } catch {
      throw new ApiException('invalid_webhook_url', 'Webhook hostname could not be resolved', HttpStatus.UNPROCESSABLE_ENTITY);
    }
  }

  if (records.length === 0 || records.some(({ address }) => !isPublicWebhookAddress(address))) {
    throw new ApiException('invalid_webhook_url', 'Webhook hostname must resolve only to public addresses', HttpStatus.UNPROCESSABLE_ENTITY);
  }

  const selected = records[0];
  const selectedFamily = isIP(selected.address);
  if (selectedFamily !== 4 && selectedFamily !== 6) {
    throw new ApiException('invalid_webhook_url', 'Webhook hostname resolved to an unsupported address', HttpStatus.UNPROCESSABLE_ENTITY);
  }
  return { url, address: selected.address, family: selectedFamily };
}

@Injectable()
export class WebhookUrlPolicyService {
  resolve(rawUrl: string): Promise<ResolvedWebhookTarget> {
    return resolveWebhookTarget(rawUrl);
  }
}
