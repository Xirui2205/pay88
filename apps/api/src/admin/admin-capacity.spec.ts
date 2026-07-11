import { describe, expect, it } from 'vitest';
import { calculateFleetCapacity, deviceExecutionReadiness, recoverySimIdentityMatches } from './admin.service';

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

describe('device execution diagnostics', () => {
  const now = new Date('2026-07-11T12:00:00Z');
  const allProfiles = [
    'telebirr.send-money.v1@2',
    'telebirr.merchant-settlement.v1@2',
    'telebirr.automatic-sweep.v1@2',
    'telebirr.emergency-liquidity-move.v1@2',
    'telebirr.balance-query.v1@2',
  ].join(',');

  it('reports a fully eligible device as ready', () => {
    expect(deviceExecutionReadiness({
      status: 'online', lastHeartbeatAt: new Date(now.valueOf() - 30_000),
      lastPermissionsOk: true, lastAccessibilityOk: true,
      ussdProfileVersion: allProfiles, activeUssdJobId: null,
    }, now)).toMatchObject({ ready: true, blockers: [], missing_profiles: [] });
  });

  it('returns every concrete blocker instead of silently leaving work queued', () => {
    const result = deviceExecutionReadiness({
      status: 'online', lastHeartbeatAt: null,
      lastPermissionsOk: false, lastAccessibilityOk: false,
      ussdProfileVersion: '', activeUssdJobId: '11111111-1111-4111-8111-111111111111',
    }, now);
    expect(result.ready).toBe(false);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      'heartbeat_missing', 'permissions_missing', 'accessibility_disabled', 'profiles_missing', 'ussd_mutex_busy',
    ]);
    expect(result.missing_profiles).toHaveLength(5);
  });
});
