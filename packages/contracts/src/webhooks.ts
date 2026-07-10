import { z } from 'zod';
import { coarseStatusSchema, depositStatusSchema, transferStatusSchema } from './public-api';
import { settlementStatusSchema, sweepExecutionStatusSchema } from './operations';

export const webhookEventSchema = z.object({
  event_id: z.string().uuid(),
  schema_version: z.literal('1.0'),
  event_type: z.enum([
    'deposit.updated',
    'transfer.updated',
    'settlement.updated',
    'topup.updated',
    'sweep.updated',
  ]),
  attempt: z.number().int().positive(),
  created_at: z.string().datetime(),
  merchant_id: z.string().uuid(),
  environment: z.enum(['test', 'live']),
  reference: z.string(),
  status: coarseStatusSchema,
  p2p_status: z.union([depositStatusSchema, transferStatusSchema, settlementStatusSchema, sweepExecutionStatusSchema]),
  data: z.record(z.string(), z.unknown()),
});
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

export const WEBHOOK_SIGNATURE_HEADER = 'x-p2p-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-p2p-timestamp';
