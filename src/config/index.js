import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('postgresql://'), {
      message: 'DATABASE_URL must be a PostgreSQL URL',
    }),

  // Approved MVP limits. Validated here so later phases share one contract.
  REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(131072),
  MAX_CONTENT_BYTES: z.coerce.number().int().positive().default(65536),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  MAX_PROVIDER_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  STALE_PROCESSING_MS: z.coerce.number().int().positive().default(90000),
  STALE_PENDING_MS: z.coerce.number().int().positive().default(300000),
});

export const config = envSchema.parse(process.env);
