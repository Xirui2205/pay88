import { describe, expect, it } from 'vitest';
import { boundedJobObservedAt, classifyPrecommitNameDisposition, financiallySafeReportState, jobExpiryDisposition, jobStatusInboxDisposition, operatorControlledDeviceStatus, shouldReleaseDeviceLockAfterReport, simRetainsQualification } from './device-jobs.service';

describe('device job commit boundary', () => {
  it('turns a generic post-PIN failure into unknown for manual reconciliation', () => {
    expect(financiallySafeReportState('failed', new Date('2026-07-10T10:00:00Z'))).toBe('unknown');
  });

  it('keeps an explicit pre-commit failure releasable', () => {
    expect(financiallySafeReportState('failed', null)).toBe('failed');
  });

  it('holds reservations for every failure or cancellation reported after device_started', () => {
    expect(financiallySafeReportState('failed', null, 'device_started')).toBe('unknown');
    expect(financiallySafeReportState('cancelled', null, 'device_started')).toBe('unknown');
    expect(financiallySafeReportState('failed', null, 'leased')).toBe('failed');
  });

  it('accepts only the exact, deterministic pre-PIN name-review tuple as a safe cancellation', () => {
    const uncertain = classifyPrecommitNameDisposition({
      priorState: 'device_started',
      committedAt: null,
      reportedState: 'cancelled',
      errorCode: 'RequestNameReview',
      storedExpectedName: 'Abayine Fucha',
      reportedExpectedName: 'Abayine Fucha',
      providerReceiverName: 'Abayine Fita',
    });
    expect(uncertain.kind).toBe('uncertain');

    const mismatch = classifyPrecommitNameDisposition({
      priorState: 'device_started',
      committedAt: null,
      reportedState: 'failed',
      errorCode: 'ReceiverMismatch',
      storedExpectedName: 'Abayine Fucha',
      reportedExpectedName: 'Abayine Fucha',
      providerReceiverName: 'Completely Different',
    });
    expect(mismatch.kind).toBe('mismatch');
  });

  it('keeps malformed, mismatched, or post-commit name claims financially unknown', () => {
    const base = {
      priorState: 'device_started' as const,
      committedAt: null,
      reportedState: 'cancelled' as const,
      errorCode: 'RequestNameReview',
      storedExpectedName: 'Abayine Fucha',
      reportedExpectedName: 'Abayine Fucha',
      providerReceiverName: 'Abayine Fita',
    };
    expect(classifyPrecommitNameDisposition({ ...base, reportedExpectedName: 'Forged Name' }).kind).toBe('none');
    expect(classifyPrecommitNameDisposition({ ...base, committedAt: new Date() }).kind).toBe('none');
    expect(classifyPrecommitNameDisposition({ ...base, errorCode: 'accessibility_interrupted' }).kind).toBe('none');
    expect(classifyPrecommitNameDisposition({ ...base, providerReceiverName: 'Abayine Fucha' }).kind).toBe('none');
  });

  it('keeps a USSD success screen provider-pending until trusted SMS evidence arrives', () => {
    expect(financiallySafeReportState('succeeded', new Date('2026-07-10T10:00:00Z'))).toBe('provider_pending');
  });

  it('keeps the handset mutex held while authoritative provider evidence is pending', () => {
    expect(shouldReleaseDeviceLockAfterReport(financiallySafeReportState('succeeded', new Date()))).toBe(false);
    expect(shouldReleaseDeviceLockAfterReport('provider_pending')).toBe(false);
    expect(shouldReleaseDeviceLockAfterReport('unknown')).toBe(true);
  });
});

describe('device status spool inbox', () => {
  it('processes new events, acknowledges exact replays, and rejects event-ID payload substitution', () => {
    expect(jobStatusInboxDisposition(null, 'hash-a')).toBe('process');
    expect(jobStatusInboxDisposition('hash-a', 'hash-a')).toBe('duplicate');
    expect(jobStatusInboxDisposition('hash-a', 'hash-b')).toBe('conflict');
  });
});

describe('device job clock boundary', () => {
  const received = new Date('2026-07-10T08:00:00Z');
  const created = new Date('2026-07-10T07:55:00Z');

  it('keeps plausible offline-spooled occurrence times but clamps impossible clocks', () => {
    expect(boundedJobObservedAt(new Date('2026-07-10T07:56:00Z').valueOf(), received, created)).toEqual({ observedAt: new Date('2026-07-10T07:56:00Z'), clockInvalid: false });
    expect(boundedJobObservedAt(new Date('2020-01-01T00:00:00Z').valueOf(), received, created)).toEqual({ observedAt: received, clockInvalid: true });
    expect(boundedJobObservedAt(new Date('2026-07-10T08:02:00Z').valueOf(), received, created)).toEqual({ observedAt: received, clockInvalid: true });
  });
});

describe('expired job financial disposition', () => {
  it('releases only jobs that were never delivered to a handset', () => {
    expect(jobExpiryDisposition('queued', null)).toBe('release_precommit');
  });

  it('holds reservations once a handset receives the job because acceptance/start reports may be delayed', () => {
    expect(jobExpiryDisposition('leased', null)).toBe('hold_unknown');
    expect(jobExpiryDisposition('device_started', null)).toBe('hold_unknown');
    expect(jobExpiryDisposition('committed', null)).toBe('hold_unknown');
    expect(jobExpiryDisposition('provider_pending', new Date())).toBe('hold_unknown');
  });
});

describe('operator-controlled device status', () => {
  it('preserves the admin online/offline switch while quarantine always wins', () => {
    expect(operatorControlledDeviceStatus({ quarantine: false, operatorOnline: false })).toBe('offline');
    expect(operatorControlledDeviceStatus({ quarantine: false, operatorOnline: true })).toBe('online');
    expect(operatorControlledDeviceStatus({ quarantine: true, operatorOnline: true })).toBe('quarantined');
  });

  it('keeps a stale but previously approved SIM qualified for its recovery balance query', () => {
    expect(simRetainsQualification('payout_stale')).toBe(true);
    expect(simRetainsQualification('pending')).toBe(false);
    expect(simRetainsQualification('quarantined')).toBe(false);
  });
});
