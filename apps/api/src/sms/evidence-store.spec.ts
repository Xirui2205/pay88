import { describe, expect, it } from 'vitest';
import { evidenceObjectKey, unattributedSmsEvidenceObjectKey, ussdEvidenceObjectKey } from './evidence-store.service';

describe('evidence object keys', () => {
  it('uses a deterministic UTC partition and opaque event ID', () => {
    expect(evidenceObjectKey('4b43ec1e-ea60-4f10-8336-6ee222c2ee80', new Date('2026-07-10T23:59:00+03:00')))
      .toBe('sms/2026/07/10/4b43ec1e-ea60-4f10-8336-6ee222c2ee80.json.enc');
  });

  it('partitions encrypted USSD evidence independently', () => {
    expect(ussdEvidenceObjectKey('4b43ec1e-ea60-4f10-8336-6ee222c2ee80', new Date('2026-07-10T23:59:00+03:00')))
      .toBe('ussd/2026/07/10/4b43ec1e-ea60-4f10-8336-6ee222c2ee80.json.enc');
  });

  it('partitions encrypted unattributed dual-SIM evidence independently', () => {
    expect(unattributedSmsEvidenceObjectKey('4b43ec1e-ea60-4f10-8336-6ee222c2ee80', new Date('2026-07-10T23:59:00+03:00')))
      .toBe('sms-unattributed/2026/07/10/4b43ec1e-ea60-4f10-8336-6ee222c2ee80.json.enc');
  });
});
