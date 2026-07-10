import { describe, expect, it } from 'vitest';
import { ussdDiagnosticLabel } from './evidence-crypto';

describe('USSD diagnostic metadata', () => {
  it('never persists recipient, amount or PIN-screen text in ordinary job rows', () => {
    expect(ussdDiagnosticLabel('You are sending: ETB 20 for 992844697 Abayine')).toBe('ussd_screen_evidence_encrypted');
    expect(ussdDiagnosticLabel('Enter PIN\n121212')).toBe('pin_screen_redacted');
    expect(ussdDiagnosticLabel('Enter PIN\n121212')).not.toContain('121212');
  });
});
