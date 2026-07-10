import { describe, expect, it } from 'vitest';
import { balanceRefreshStatus } from './sms-ingestion.service';

describe('balance SMS qualification boundary', () => {
  it('recovers only an approved stale wallet and never promotes pending or quarantined SIMs', () => {
    expect(balanceRefreshStatus('payout_stale')).toBe('active');
    expect(balanceRefreshStatus('pending')).toBeUndefined();
    expect(balanceRefreshStatus('quarantined')).toBeUndefined();
    expect(balanceRefreshStatus('disabled')).toBeUndefined();
    expect(balanceRefreshStatus('active')).toBeUndefined();
  });
});
