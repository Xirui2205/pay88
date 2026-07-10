import { z } from 'zod';

const optionalUrl = z.string().url().optional().or(z.literal(''));

const developmentSecret = 'development-only-secret-change-before-shared-use';

export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),
  CHECKOUT_BASE_URL: z.string().url().default('http://localhost:5175'),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  DATABASE_URL: z.string().min(1).default('postgresql://telebirr:telebirr@localhost:5432/telebirr?schema=public'),
  REDIS_URL: optionalUrl,
  RABBITMQ_URL: optionalUrl,
  OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
  OBJECT_STORAGE_BUCKET: z.string().min(3).optional(),
  OBJECT_STORAGE_ACCESS_KEY: z.string().min(1).optional(),
  OBJECT_STORAGE_SECRET_KEY: z.string().min(1).optional(),
  DEVICE_GATEWAY_URL: z.string().url().default('wss://localhost:3000/v1/device/connect'),
  DEVICE_JOB_SIGNING_PRIVATE_KEY_PEM: z.string().optional(),
  DEVICE_MTLS_PROXY_SECRET: z.string().min(32).default(developmentSecret),
  CHECKOUT_TOKEN_SECRET: z.string().min(32).default(developmentSecret),
  WEBHOOK_MASTER_KEY: z.string().min(32).default(developmentSecret),
  DATA_ENCRYPTION_KEY: z.string().min(32).default(developmentSecret),
  ADMIN_API_TOKEN: z.string().min(32).default(developmentSecret),
  OPENCLAW_GATEWAY_TOKEN: z.string().min(32).default(developmentSecret),
  OPENCLAW_TOOL_TOKEN: z.string().min(32).default(developmentSecret),
  MERCHANT_API_AUTH_ATTEMPTS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
  MERCHANT_API_AUTH_CACHE_SECONDS: z.coerce.number().int().min(1).max(3_600).default(300),
  MERCHANT_API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(100).max(100_000).default(2_000),
}).superRefine((value, context) => {
  if (value.NODE_ENV !== 'production') return;
  const requiredSecrets = [
    ['CHECKOUT_TOKEN_SECRET', value.CHECKOUT_TOKEN_SECRET],
    ['WEBHOOK_MASTER_KEY', value.WEBHOOK_MASTER_KEY],
    ['DATA_ENCRYPTION_KEY', value.DATA_ENCRYPTION_KEY],
    ['ADMIN_API_TOKEN', value.ADMIN_API_TOKEN],
    ['OPENCLAW_GATEWAY_TOKEN', value.OPENCLAW_GATEWAY_TOKEN],
    ['OPENCLAW_TOOL_TOKEN', value.OPENCLAW_TOOL_TOKEN],
    ['DEVICE_MTLS_PROXY_SECRET', value.DEVICE_MTLS_PROXY_SECRET],
  ] as const;
  for (const [name, secret] of requiredSecrets) {
    if (secret === developmentSecret || /replace|change-me/i.test(secret)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} must be a generated production secret` });
    }
  }
  const secretValues = [value.CHECKOUT_TOKEN_SECRET, value.WEBHOOK_MASTER_KEY, value.DATA_ENCRYPTION_KEY, value.ADMIN_API_TOKEN, value.OPENCLAW_GATEWAY_TOKEN, value.OPENCLAW_TOOL_TOKEN, value.DEVICE_MTLS_PROXY_SECRET];
  if (new Set(secretValues).size !== secretValues.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['DATA_ENCRYPTION_KEY'], message: 'production trust boundaries must use independent secrets' });
  }
  if (!value.DEVICE_JOB_SIGNING_PRIVATE_KEY_PEM?.includes('BEGIN PRIVATE KEY')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['DEVICE_JOB_SIGNING_PRIVATE_KEY_PEM'], message: 'a persistent P-256 PKCS#8 key is required in production' });
  }
  if (!value.CORS_ALLOWED_ORIGINS?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['CORS_ALLOWED_ORIGINS'], message: 'at least one exact browser origin is required in production' });
  }
  for (const [name, url, protocol] of [
    ['PUBLIC_API_URL', value.PUBLIC_API_URL, 'https:'],
    ['CHECKOUT_BASE_URL', value.CHECKOUT_BASE_URL, 'https:'],
    ['DEVICE_GATEWAY_URL', value.DEVICE_GATEWAY_URL, 'wss:'],
  ] as const) {
    if (new URL(url).protocol !== protocol || /localhost|127\.0\.0\.1/i.test(new URL(url).hostname)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} must use a non-local ${protocol} endpoint in production` });
    }
  }
  for (const name of ['REDIS_URL', 'RABBITMQ_URL'] as const) {
    if (!value[name]) context.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} is required in production` });
  }
  for (const name of ['OBJECT_STORAGE_ENDPOINT', 'OBJECT_STORAGE_BUCKET', 'OBJECT_STORAGE_ACCESS_KEY', 'OBJECT_STORAGE_SECRET_KEY'] as const) {
    const configured = value[name as keyof typeof value];
    if (typeof configured !== 'string' || !configured.trim() || /replace|change-me/i.test(configured)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} is required for production evidence retention` });
    }
  }
});

export type ApiEnvironment = z.infer<typeof environmentSchema>;

export function validateEnvironment(input: Record<string, unknown>): ApiEnvironment {
  return environmentSchema.parse(input);
}
