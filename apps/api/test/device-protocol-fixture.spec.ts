import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  activationRequestSchema,
  activationResponseSchema,
  deviceJobPayloadSchema,
  jobStatusEventSchema,
  signedPayloadEnvelopeSchema,
} from '@telebirr/contracts';
import { deviceSpoolBatchSchema, deviceWsHeartbeatSchema, leaseRenewalRequestSchema } from '../src/devices/device-websocket.gateway';
import { DeviceProfilesService } from '../src/devices/device-profiles.service';
import { DeviceSigningService } from '../src/devices/device-signing.service';

const fixturePath = resolve(process.cwd(), '../device-agent/app/src/test/resources/protocol/device-protocol-v1.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, any>;

function verifyEnvelope(envelope: Record<string, string>, publicKeyPem: string): Buffer {
  signedPayloadEnvelopeSchema.parse(envelope);
  const payload = Buffer.from(envelope.payload_base64, 'base64');
  expect(verify('sha256', payload, createPublicKey(publicKeyPem), Buffer.from(envelope.signature_base64, 'base64'))).toBe(true);
  return payload;
}

describe('Android/backend protocol v1 canonical fixture', () => {
  it('shares the exact activation request and standard response data', () => {
    activationRequestSchema.parse(fixture.activation_request);
    activationResponseSchema.parse(fixture.activation_response.data);
    expect(fixture.activation_response).toMatchObject({ status: 'success', code: 'ok' });
  });

  it('verifies and decodes the P-256 signed numeric-fence job', () => {
    const payload = verifyEnvelope(fixture.signed_job_envelope, fixture.signing_public_key_pem);
    expect(deviceJobPayloadSchema.parse(JSON.parse(payload.toString('utf8')))).toEqual(fixture.decoded_job_payload);
  });

  it('verifies the profile and lease-renewal envelopes byte-for-byte', () => {
    const profile = JSON.parse(verifyEnvelope(fixture.signed_profile_envelope, fixture.signing_public_key_pem).toString('utf8'));
    expect(profile.profile_id).toBe(fixture.expected_profile.profile_id);
    expect(profile.steps.map((step: { id: string }) => step.id)).toEqual(fixture.expected_profile.step_ids);
    expect(profile.steps.find((step: { response: { financial_commit?: boolean } }) => step.response.financial_commit)?.id).toBe('pin');
    const renewal = JSON.parse(verifyEnvelope(fixture.signed_lease_renewal_envelope, fixture.signing_public_key_pem).toString('utf8'));
    expect(renewal).toEqual(fixture.decoded_lease_renewal_payload);
  });

  it('parses the canonical WebSocket heartbeat and spool status event', () => {
    const examples = fixture.websocket_examples;
    deviceWsHeartbeatSchema.parse(examples.client_heartbeat.payload);
    const batch = deviceSpoolBatchSchema.parse(examples.client_spool_batch);
    jobStatusEventSchema.parse(batch.events[0].payload);
    leaseRenewalRequestSchema.parse(examples.client_lease_renewal_request);
    expect(examples.server_spool_ack.event_ids).toEqual([batch.events[0].id]);
  });

  it('generates an executable send profile with the observed commit sequence', () => {
    delete process.env.DEVICE_JOB_SIGNING_PRIVATE_KEY_PEM;
    const signing = new DeviceSigningService();
    const profiles = new DeviceProfilesService(signing).allSignedProfiles();
    const decoded = profiles.map((envelope) => JSON.parse(Buffer.from(envelope.payload_base64, 'base64').toString('utf8')));
    const send = decoded.find((profile) => profile.profile_id === 'telebirr.send-money.v1');
    const balance = decoded.find((profile) => profile.profile_id === 'telebirr.balance-query.v1');
    expect(send.version).toBe(2);
    expect(send.steps.map((step: { id: string }) => step.id)).toEqual(fixture.expected_profile.step_ids);
    expect(send.steps.find((step: { response: { financial_commit?: boolean } }) => step.response.financial_commit)?.id).toBe('pin');
    expect(send.steps.find((step: { id: string }) => step.id === 'final-confirm').response.type).toBe('verify_transfer_and_select');
    expect(send.steps.find((step: { id: string }) => step.id === 'provider-result').response.type).toBe('dismiss_and_wait_for_provider');
    expect(send.recipient_name_patterns.some((pattern: string) => pattern.includes('\\bfor\\s+'))).toBe(true);
    expect(balance.version).toBe(2);
    expect(balance.steps.find((step: { id: string }) => step.id === 'processing').response.type).toBe('dismiss_and_wait_for_provider');
  });
});
