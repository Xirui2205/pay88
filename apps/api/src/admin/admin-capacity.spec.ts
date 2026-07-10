import { describe, expect, it } from 'vitest';
import { calculateFleetCapacity, recoverySimIdentityMatches } from './admin.service';

describe('fleet capacity calculation', () => {
  it('uses measured p95, one handset-wide session and a bounded safety factor', () => {
    const result = calculateFleetCapacity(10, [10, 11, 12, 13, 30], 0.7, 14);
    expect(result.p95_session_seconds).toBe(30);
    expect(result.theoretical_per_minute).toBe(20);
    expect(result.usable_per_minute).toBe(14);
    expect(result.estimated_queue_wait_seconds).toBe(60);
  });

  it('uses a conservative fallback and never divides by zero', () => {
    expect(calculateFleetCapacity(0, [], 2, 7)).toMatchObject({
      p95_session_seconds: 30,
      safety_factor: 0.95,
      usable_per_minute: 0,
      estimated_queue_wait_seconds: null,
    });
  });
});

describe('device recovery SIM identity boundary', () => {
  const enrolled = { slot: 0, iccid: '8992510112345678901', phoneNumber: '+251992844697', accountName: 'Abayine Fucha' };

  it('requires exact slot, ICCID and canonical phone while tolerating deterministic name formatting', () => {
    expect(recoverySimIdentityMatches(enrolled, { ...enrolled, accountName: 'Fucha Abayine' })).toBe(true);
    expect(recoverySimIdentityMatches(enrolled, { ...enrolled, iccid: '8992510112345678902' })).toBe(false);
    expect(recoverySimIdentityMatches(enrolled, { ...enrolled, phoneNumber: '+251992844698' })).toBe(false);
    expect(recoverySimIdentityMatches(enrolled, { ...enrolled, slot: 1 })).toBe(false);
  });
});
