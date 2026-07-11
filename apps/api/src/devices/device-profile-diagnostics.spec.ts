import { describe, expect, it } from 'vitest';
import { profileInstallResultSchema } from './device-websocket.gateway';

describe('profile installation response diagnostics', () => {
  it('accepts a complete rejected-profile response for Admin inspection', () => {
    expect(profileInstallResultSchema.parse({
      profile_id: 'telebirr.balance-query.v1',
      profile_version: 2,
      key_id: 'telebirr-device-v1',
      result: 'rejected',
      code: 'signature_invalid',
      message: 'Invalid profile signature',
      observed_at_ms: 1_783_776_000_000,
      installed_profiles: [],
      server_envelope: { key_id: 'telebirr-device-v1', payload_base64: 'AA==', signature_base64: 'AA==' },
    })).toMatchObject({ result: 'rejected', code: 'signature_invalid' });
  });
});
