import { z } from 'zod';
import { etbAmountSchema } from './money';

export const activationRequestSchema = z.object({
  activation_code: z.string().min(6).max(128),
  installation_id: z.string().min(4).max(128),
  hardware_serial: z.string().min(2).max(120),
  certificate_alias: z.string().min(1).max(128),
  protocol_version: z.literal('1'),
  manufacturer: z.string().min(1).max(100),
  model: z.string().min(1).max(100),
  android_release: z.string().min(1).max(32),
  android_sdk: z.number().int().min(26),
  app_version: z.string().min(1).max(32),
  build_fingerprint: z.string().min(1).max(255),
});
export type ActivationRequest = z.infer<typeof activationRequestSchema>;

export const activationResponseSchema = z.object({
  device_id: z.string().uuid(),
  device_token: z.string().regex(/^[A-Za-z0-9_-]{32,512}$/),
  websocket_url: z.string().url().refine((value) => value.startsWith('wss://')),
  heartbeat_interval_seconds: z.number().int().min(15).max(60),
  key_id: z.string().min(1).max(64),
  signing_public_key_pem: z.string().includes('BEGIN PUBLIC KEY'),
  sims: z.array(z.object({
    iccid: z.string().regex(/^\d{10,24}$/),
    telebirr_number: z.string(),
    registered_name: z.string(),
    expected_slot_index: z.number().int().min(0).max(1),
  })).min(1).max(2),
});
export type ActivationResponse = z.infer<typeof activationResponseSchema>;

export const agentJobTypeSchema = z.enum([
  'customer_withdrawal',
  'unknown_reconciliation',
  'merchant_settlement',
  'emergency_liquidity_move',
  'automatic_sweep',
  'balance_query',
]);
export type AgentJobType = z.infer<typeof agentJobTypeSchema>;

export const deviceJobPayloadSchema = z.object({
  job_id: z.string().min(8).max(128),
  device_id: z.string().min(8).max(128),
  financial_operation_id: z.string().min(8).max(128),
  type: agentJobTypeSchema,
  sim_iccid: z.string().regex(/^\d{10,24}$/),
  profile_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
  profile_version: z.number().int().positive(),
  attempt: z.number().int().positive(),
  fencing_token: z.number().int().positive().safe(),
  issued_at_ms: z.number().int().positive(),
  lease_expires_at_ms: z.number().int().positive(),
  job_expires_at_ms: z.number().int().positive(),
  destination_phone: z.string().optional(),
  amount_etb: etbAmountSchema.optional(),
  expected_receiver_name: z.string().min(1).max(200).optional(),
  /**
   * The exact provider-side name that platform staff reviewed for this new,
   * pre-commit attempt.  It is part of the signed payload; a boolean override
   * would be unsafe because a later USSD screen could contain a different name.
   */
  approved_provider_name: z.string().min(1).max(200).optional(),
}).superRefine((value, context) => {
  if (value.lease_expires_at_ms <= value.issued_at_ms || value.lease_expires_at_ms - value.issued_at_ms > 10 * 60_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid job lease interval' });
  }
  if (value.type !== 'balance_query' && (!value.destination_phone || !value.amount_etb || !value.expected_receiver_name)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'money-moving job is missing recipient fields' });
  }
});
export type DeviceJobPayload = z.infer<typeof deviceJobPayloadSchema>;

export const signedPayloadEnvelopeSchema = z.object({
  key_id: z.string().min(1).max(64),
  payload_base64: z.string().min(4).max(96_000),
  signature_base64: z.string().min(4).max(1024),
});
export type SignedPayloadEnvelope = z.infer<typeof signedPayloadEnvelopeSchema>;

export const agentJobStateSchema = z.enum([
  'leased',
  'device_started',
  'committed',
  'provider_pending',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
]);
export type AgentJobState = z.infer<typeof agentJobStateSchema>;

export const jobStatusEventSchema = z.object({
  job_id: z.string().min(8).max(128),
  financial_operation_id: z.string().min(8).max(128),
  fencing_token: z.number().int().positive().safe(),
  state: agentJobStateSchema,
  observed_at_ms: z.number().int().positive(),
  error_code: z.string().max(1000),
  attempt: z.number().int().positive().optional(),
  profile_id: z.string().max(64).optional(),
  profile_version: z.number().int().positive().optional(),
  provider_transaction_id: z.string().max(64).nullable().optional(),
  expected_receiver_name: z.string().max(200).optional(),
  provider_receiver_name: z.string().max(200).optional(),
});
export type JobStatusEvent = z.infer<typeof jobStatusEventSchema>;

/** Legacy HTTPS heartbeat endpoint; WebSocket heartbeat uses the richer Android payload. */
export const simIdentitySchema = z.object({
  slot: z.number().int().min(0).max(1),
  subscription_id: z.number().int(),
  iccid: z.string().min(8).max(32),
  phone_number: z.string(),
  telebirr_account_name: z.string().trim().min(2).max(200),
});

export const deviceHeartbeatSchema = z.object({
  device_id: z.string().uuid(),
  sent_at: z.string().datetime(),
  agent_version: z.string().min(1).max(32),
  ussd_profile_version: z.string().min(1).max(32),
  android_version: z.string().max(32),
  build_fingerprint: z.string().max(255),
  battery_percent: z.number().min(0).max(100),
  charging: z.boolean(),
  temperature_celsius: z.number().min(-20).max(100).nullable(),
  network_type: z.string().max(32),
  permissions_ok: z.boolean(),
  accessibility_ok: z.boolean(),
  openclaw_paired: z.boolean(),
  sims: z.array(simIdentitySchema).min(1).max(2),
});
export type DeviceHeartbeat = z.infer<typeof deviceHeartbeatSchema>;

export const deviceJobReportSchema = z.object({
  fencing_token: z.number().int().positive().safe(),
  state: agentJobStateSchema,
  observed_at_ms: z.number().int().positive(),
  provider_transaction_id: z.string().max(64).optional(),
  screen_text: z.string().max(4000).optional(),
  error_code: z.string().max(80).optional(),
});
export type DeviceJobReport = z.infer<typeof deviceJobReportSchema>;

export const smsIngestSchema = z.object({
  event_id: z.string().uuid(),
  received_at: z.string().datetime(),
  sender: z.string().min(1).max(32),
  subscription_id: z.number().int(),
  sim_iccid: z.string().min(8).max(32),
  body: z.string().min(1).max(8000),
  multipart_reference: z.string().max(100).optional(),
  multipart_part: z.number().int().positive().optional(),
  multipart_total: z.number().int().positive().optional(),
});
export type SmsIngest = z.infer<typeof smsIngestSchema>;
