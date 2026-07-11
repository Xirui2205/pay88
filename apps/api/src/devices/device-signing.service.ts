import { Injectable } from '@nestjs/common';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import type { SignedPayloadEnvelope } from '@telebirr/contracts';
import { stringifyJsonSafe } from '../common/json-serialization';

@Injectable()
export class DeviceSigningService {
  readonly keyId = process.env.DEVICE_SIGNING_KEY_ID ?? 'telebirr-device-v1';
  private readonly privateKey;
  readonly publicKeyPem: string;

  constructor() {
    const configured = process.env.DEVICE_JOB_SIGNING_PRIVATE_KEY_PEM?.replace(/\\n/g, '\n');
    if (configured) {
      this.privateKey = createPrivateKey(configured);
      this.publicKeyPem = createPublicKey(this.privateKey).export({ type: 'spki', format: 'pem' }).toString();
    } else {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('DEVICE_JOB_SIGNING_PRIVATE_KEY_PEM is required in production');
      }
      const pair = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      this.privateKey = createPrivateKey(pair.privateKey);
      this.publicKeyPem = pair.publicKey;
    }
  }

  signJson(payload: Record<string, unknown>): SignedPayloadEnvelope {
    const exactPayload = Buffer.from(stringifyJsonSafe(payload), 'utf8');
    return {
      key_id: this.keyId,
      payload_base64: exactPayload.toString('base64'),
      signature_base64: sign('sha256', exactPayload, this.privateKey).toString('base64'),
    };
  }
}
