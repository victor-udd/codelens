import { z } from 'zod';

const envSchema = z
  .object({
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

    REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(131072),
    MAX_CONTENT_BYTES: z.coerce.number().int().positive().default(65536),
    PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
    MAX_PROVIDER_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4096),
    AI_RESPONSE_MAX_BYTES: z.coerce.number().int().positive().default(1048576),
    MAX_PROCESSING_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    STALE_PROCESSING_MS: z.coerce.number().int().positive().default(90000),
    STALE_PENDING_MS: z.coerce.number().int().positive().default(300000),
    RECOVERY_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(50),

    // AI adapter settings are optional so the rest of the app can boot without
    // an AI credential. Missing credentials produce a typed adapter error only
    // when an AI review is actually requested.
    AI_PROVIDER: z.string().min(1).default('openai-compatible'),
    AI_API_KEY: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().min(1).optional(),
    ),
    AI_MODEL: z.string().min(1).default('gpt-4o-mini'),
    AI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),

    // Comma-separated API keys. Values are converted to hashes at the
    // middleware boundary; raw keys are never logged or persisted.
    API_KEYS: z
      .string()
      .min(1)
      .transform((value) =>
        value
          .split(',')
          .map((key) => key.trim())
          .filter(Boolean),
      )
      .refine((keys) => keys.length > 0, {
        message: 'API_KEYS must contain at least one key',
      }),
    ADMIN_API_KEYS: z
      .string()
      .optional()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((key) => key.trim())
          .filter(Boolean),
      ),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  })
  // A stale lease must outlast the longest synchronous provider retry window,
  // otherwise recovery could reclaim a request that is still in flight.
  .refine(
    (env) =>
      env.STALE_PROCESSING_MS >
      env.PROVIDER_TIMEOUT_MS * env.MAX_PROVIDER_ATTEMPTS,
    {
      path: ['STALE_PROCESSING_MS'],
      message:
        'STALE_PROCESSING_MS must exceed PROVIDER_TIMEOUT_MS * MAX_PROVIDER_ATTEMPTS',
    },
  );

export const config = envSchema.parse(process.env);
