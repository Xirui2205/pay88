import { describe, expect, it } from 'vitest';
import { redactMetadata } from './alerts.service';

describe('alert metadata safety', () => {
  it('redacts credentials and masks phone-like values before persistence or delivery', () => {
    expect(redactMetadata({ pin: '123456', api_token: 'secret', phone_number: '+251911223344', reference: 'WD-1' })).toEqual({
      pin: '[REDACTED]',
      api_token: '[REDACTED]',
      phone_number: '+25***44',
      reference: 'WD-1',
    });
  });
});
