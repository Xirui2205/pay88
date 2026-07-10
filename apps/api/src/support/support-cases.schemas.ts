import { z } from 'zod';

const safeText = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum).refine(
  (value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value),
  'Control characters are not allowed',
);

export const supportStatusSchema = z.enum(['open', 'investigating', 'awaiting_merchant', 'resolved', 'closed']);
export const supportCategorySchema = z.enum(['transaction_match', 'withdrawal_outcome', 'topup', 'settlement', 'webhook', 'api', 'other']);

export const proposedMatchSchema = z.object({
  kind: z.enum(['deposit_intent', 'incoming_receipt', 'withdrawal', 'provider_transaction']),
  reference: safeText(1, 128),
  explanation: safeText(2, 1000).optional(),
}).strict();

export const supportMessageSchema = z.object({
  message: safeText(2, 5000),
  evidence_reference: safeText(3, 500).optional(),
  proposed_match: proposedMatchSchema.optional(),
}).strict();

export const createSupportCaseSchema = supportMessageSchema.extend({
  environment: z.enum(['test', 'live']).default('live'),
  category: supportCategorySchema,
  subject: safeText(3, 200),
  reference: safeText(1, 128).optional(),
}).strict();

export const changeSupportStatusSchema = z.object({
  status: supportStatusSchema,
  reason: safeText(10, 1000),
}).strict();
