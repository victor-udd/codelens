import { z } from 'zod';
import { config } from '../config/index.js';
import {
  formatZodIssues,
  ValidationError,
} from '../errors/validation-error.js';

export const SOURCE_TYPES = ['SNIPPET', 'DIFF'];
export const SUPPORTED_LANGUAGES = ['JAVASCRIPT', 'TYPESCRIPT', 'PYTHON', 'GO'];

// Options are stored as JSON on the Review row, so unknown option keys are
// preserved while the known MVP flag is type-checked.
export const reviewOptionsSchema = z
  .object({
    includeStaticChecks: z.boolean().optional(),
  })
  .passthrough();

export const reviewSubmissionSchema = z
  .object({
    content: z
      .string({ error: 'content must be a string' })
      .min(1, 'content must not be empty')
      .refine((value) => value.trim().length > 0, {
        message: 'content must not be blank',
      })
      .refine(
        (value) => Buffer.byteLength(value, 'utf8') <= config.MAX_CONTENT_BYTES,
        {
          message: `content must not exceed ${config.MAX_CONTENT_BYTES} bytes`,
        },
      ),
    sourceType: z.enum(SOURCE_TYPES, {
      error: `sourceType must be one of: ${SOURCE_TYPES.join(', ')}`,
    }),
    language: z.enum(SUPPORTED_LANGUAGES, {
      error: `language must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`,
    }),
    options: reviewOptionsSchema.optional(),
    provider: z.string().min(1).max(100).optional(),
    model: z.string().min(1).max(100).optional(),
  })
  .strict();

// Alias for callers that name the operation after the resource being created.
export const createReviewSchema = reviewSubmissionSchema;

export function parseReviewSubmission(input) {
  const result = reviewSubmissionSchema.safeParse(input);

  if (!result.success) {
    throw new ValidationError(formatZodIssues(result.error.issues));
  }

  // The database stores only the byte size, never the submitted source.
  return {
    ...result.data,
    sourceSizeBytes: Buffer.byteLength(result.data.content, 'utf8'),
  };
}
