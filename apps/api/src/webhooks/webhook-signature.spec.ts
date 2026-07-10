import { describe, expect, it } from 'vitest';
import { hmacHex } from '../common/crypto';
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from '@telebirr/contracts';

describe('webhook signature', () => {
  it('signs timestamp and exact raw body', () => {
    const body = '{"status":"success"}';
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('x-p2p-signature');
    expect(WEBHOOK_TIMESTAMP_HEADER).toBe('x-p2p-timestamp');
    expect(`v1=${hmacHex('secret', `123.${body}`)}`).toBe(
      'v1=4657cb9a520d50f9cb99bbe100fb8f56e679b3991bf68f3e5e3aade43ca09c3a',
    );
  });
});
