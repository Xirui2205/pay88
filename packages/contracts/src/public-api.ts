import { z } from 'zod';
import { etbAmountSchema, etbCurrencySchema, ethiopianPhoneSchema } from './money';

export const runtimeEnvironmentSchema = z.enum(['test', 'live']);
export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;

export const coarseStatusSchema = z.enum(['pending', 'success', 'failed']);
export type CoarseStatus = z.infer<typeof coarseStatusSchema>;

export const depositStatusSchema = z.enum([
  'awaiting_payment',
  'late_grace',
  'matching',
  'manual_review',
  'success',
  'expired',
  'failed',
]);
export type DepositStatus = z.infer<typeof depositStatusSchema>;

export const transferStatusSchema = z.enum([
  'accepted',
  'queued',
  'device_assigned',
  'device_started',
  'committed',
  'provider_pending',
  'success',
  'failed',
  'unknown',
  'manual_review',
  'cancelled',
]);
export type TransferStatus = z.infer<typeof transferStatusSchema>;

const absoluteHttpUrl = z.string().url().refine((value) => /^https?:\/\//i.test(value), 'must use http or https');

export const initializeTransactionSchema = z.object({
  amount: etbAmountSchema,
  currency: etbCurrencySchema.default('ETB'),
  tx_ref: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  customer_id: z.string().trim().min(1).max(128),
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().max(100).optional(),
  email: z.string().email().max(254).optional(),
  phone_number: ethiopianPhoneSchema,
  callback_url: absoluteHttpUrl.optional(),
  return_url: absoluteHttpUrl.optional(),
  customization: z
    .object({
      title: z.string().trim().max(120).optional(),
      description: z.string().trim().max(500).optional(),
      logo: absoluteHttpUrl.optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  test_scenario: z.enum(['success', 'wrong_amount', 'late', 'duplicate', 'ambiguous']).optional(),
});
export type InitializeTransactionInput = z.infer<typeof initializeTransactionSchema>;

export const createTransferSchema = z.object({
  account_number: ethiopianPhoneSchema,
  expected_name: z.string().trim().min(2).max(200),
  customer_id: z.string().trim().min(1).max(128),
  /** Authenticated merchants assert `registered`; `alternate` requires an approved merchant setting. */
  destination_type: z.enum(['registered', 'alternate']).default('registered'),
  amount: etbAmountSchema,
  currency: etbCurrencySchema.default('ETB'),
  reference: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  bank_code: z.union([z.literal('855'), z.literal(855)]).transform(() => '855' as const),
  callback_url: absoluteHttpUrl.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  test_scenario: z.enum(['success', 'explicit_failure', 'delay', 'unknown']).optional(),
});
export type CreateTransferInput = z.infer<typeof createTransferSchema>;

export const apiErrorCodeSchema = z.enum([
  'ok',
  'validation_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'duplicate_reference_conflict',
  'active_intent_exists',
  'insufficient_merchant_balance',
  'no_physical_liquidity',
  'rate_limited',
  'invalid_state',
  'internal_error',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export interface ApiEnvelope<T> {
  status: 'success' | 'error';
  message: string;
  code: ApiErrorCode | string;
  data: T | null;
  request_id: string;
}

export interface DepositView {
  tx_ref: string;
  amount: string;
  credited_amount: string | null;
  currency: 'ETB';
  status: CoarseStatus;
  p2p_status: DepositStatus;
  checkout_url: string;
  assigned_number_masked: string;
  receiver_name: string;
  expires_at: string;
  late_grace_ends_at: string;
  created_at: string;
  countdown_seconds: number;
  late_grace_seconds: number;
  provider_transaction_id: string | null;
}

export interface TransferView {
  reference: string;
  amount: string;
  provider_fee: string | null;
  provider_vat: string | null;
  gateway_fee: string;
  currency: 'ETB';
  status: CoarseStatus;
  p2p_status: TransferStatus;
  account_number_masked: string;
  expected_name: string;
  provider_transaction_id: string | null;
  created_at: string;
  eta_seconds: number;
  estimated_completion_at: string | null;
  status_url: string;
  status_api_url: string;
}

export const idempotencyKeySchema = z.string().trim().min(8).max(255);
