import { createCipheriv, createHash, randomBytes } from 'node:crypto';

export function encryptEvidence(value: string): string {
  const key = createHash('sha256').update(process.env.DATA_ENCRYPTION_KEY ?? process.env.WEBHOOK_MASTER_KEY ?? 'development-encryption-key').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function sanitizeUssdEvidence(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n').trim().slice(0, 8_000);
  if (/\b(?:enter|input|provide)\s+(?:your\s+)?pin\b/i.test(normalized)) return '[PIN SCREEN REDACTED]';
  return normalized;
}

/**
 * DeviceJob.lastScreenText is operational metadata, not the encrypted evidence
 * store. Persist only a coarse, non-identifying classification there so names,
 * phone numbers, amounts and PIN UI content never leak into ordinary rows.
 */
export function ussdDiagnosticLabel(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.replace(/\r\n?/g, '\n').toLocaleUpperCase('en-US');
  if (/\b(?:ENTER|INPUT|PROVIDE)\s+(?:YOUR\s+)?PIN\b/.test(normalized)) return 'pin_screen_redacted';
  if (/\b(?:PROCESS|WAIT|REQUEST)\b/.test(normalized)) return 'provider_processing_screen';
  if (/\b(?:SUCCESSFUL|COMPLETED)\b/.test(normalized)) return 'provider_success_screen';
  if (/\b(?:FAILED|DECLINED|INSUFFICIENT|INVALID PIN)\b/.test(normalized)) return 'provider_failure_screen';
  return 'ussd_screen_evidence_encrypted';
}
