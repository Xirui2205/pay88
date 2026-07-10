import { describe, expect, it } from 'vitest';
import { redactAdvisoryValue } from './advisory.controller';

describe('OpenClaw advisory evidence boundary', () => {
  it('removes raw screens, names, phones and receipt links recursively', () => {
    expect(redactAdvisoryValue({
      screen_text: 'Send ETB 20 to Abayine',
      expected_name: 'Abayine Fucha',
      destination_phone: '+251992844697',
      nested: { receipt_link: 'https://provider/secret', safe_id: 'job-123', note: 'call 0992844697' },
    })).toEqual({
      screen_text: '[redacted]',
      expected_name: '[redacted]',
      destination_phone: '[redacted]',
      nested: { receipt_link: '[redacted]', safe_id: 'job-123', note: 'call 099***697' },
    });
  });
});
