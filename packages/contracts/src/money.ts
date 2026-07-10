import { z } from 'zod';

/** ETB is represented as a canonical decimal string at every public boundary. */
export const etbAmountSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.\d{2}$/, 'amount must be a positive decimal string with two digits')
  .refine((value) => BigInt(value.replace('.', '')) > 0n, 'amount must be greater than zero');

export const etbCurrencySchema = z.literal('ETB');

export function amountToMinor(value: string): bigint {
  return BigInt(etbAmountSchema.parse(value).replace('.', ''));
}

export function minorToAmount(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const raw = absolute.toString().padStart(3, '0');
  return `${negative ? '-' : ''}${raw.slice(0, -2)}.${raw.slice(-2)}`;
}

export function normalizeEthiopianPhone(value: string): string {
  const digits = value.replace(/[^0-9+]/g, '');
  if (/^\+2519\d{8}$/.test(digits)) return digits;
  if (/^2519\d{8}$/.test(digits)) return `+${digits}`;
  if (/^09\d{8}$/.test(digits)) return `+251${digits.slice(1)}`;
  if (/^9\d{8}$/.test(digits)) return `+251${digits}`;
  throw new Error('phone must be a valid Ethiopian mobile number');
}

export const ethiopianPhoneSchema = z.string().transform((value, context) => {
  try {
    return normalizeEthiopianPhone(value);
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
    return z.NEVER;
  }
});

