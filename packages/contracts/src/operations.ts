import { z } from 'zod';
import { etbAmountSchema, etbCurrencySchema, ethiopianPhoneSchema, amountToMinor } from './money';

export const createSettlementSchema = z.object({
  reference: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  account_number: ethiopianPhoneSchema,
  expected_name: z.string().trim().min(2).max(200),
  amount: etbAmountSchema,
  currency: etbCurrencySchema.default('ETB'),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateSettlementInput = z.infer<typeof createSettlementSchema>;

export const settlementStatusSchema = z.enum([
  'requested',
  'approved',
  'rejected',
  'dispatched',
  'success',
  'failed',
  'unknown',
  'manual_review',
]);

export const sweepRuleInputSchema = z
  .object({
    group_id: z.string().uuid(),
    name: z.string().trim().min(2).max(120),
    destination_type: z.enum(['platform_treasury', 'merchant_owned']),
    destination_phone: ethiopianPhoneSchema,
    destination_name: z.string().trim().min(2).max(200),
    high_water_balance: etbAmountSchema,
    target_balance: etbAmountSchema,
    max_per_run: etbAmountSchema,
    minimum_interval_seconds: z.number().int().min(60).max(86_400).default(900),
  })
  .superRefine((value, context) => {
    if (amountToMinor(value.target_balance) >= amountToMinor(value.high_water_balance)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['target_balance'], message: 'target balance must be below high-water balance' });
    }
  });
export type SweepRuleInput = z.infer<typeof sweepRuleInputSchema>;

export const sweepRuleStatusSchema = z.enum(['pending', 'approved', 'rejected', 'disabled']);

export const sweepExecutionStatusSchema = z.enum([
  'queued',
  'device_started',
  'committed',
  'provider_pending',
  'success',
  'failed',
  'unknown',
  'manual_review',
]);
