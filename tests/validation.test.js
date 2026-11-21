import { describe, expect, it } from 'vitest';
import { config } from '../src/config/index.js';
import {
  parseReviewSubmission,
  reviewSubmissionSchema,
} from '../src/validation/review.js';

function validSubmission(overrides = {}) {
  return {
    content: 'const answer = 42;',
    sourceType: 'SNIPPET',
    language: 'JAVASCRIPT',
    ...overrides,
  };
}

describe('review submission schema', () => {
  it('accepts a minimal valid submission and derives its byte size', () => {
    const parsed = parseReviewSubmission(validSubmission());

    expect(parsed.sourceSizeBytes).toBe(
      Buffer.byteLength('const answer = 42;', 'utf8'),
    );
    expect(parsed.sourceType).toBe('SNIPPET');
    expect(parsed.language).toBe('JAVASCRIPT');
  });

  it('accepts a DIFF submission with options and provider metadata', () => {
    const parsed = parseReviewSubmission(
      validSubmission({
        sourceType: 'DIFF',
        language: 'TYPESCRIPT',
        options: { includeStaticChecks: false, customFlag: 'kept' },
        provider: 'openai',
        model: 'gpt-4o-mini',
      }),
    );

    expect(parsed.options).toMatchObject({
      includeStaticChecks: false,
      customFlag: 'kept',
    });
    expect(parsed.provider).toBe('openai');
    expect(parsed.model).toBe('gpt-4o-mini');
  });

  it('rejects empty and whitespace-only content', () => {
    for (const content of ['', '   \n\t']) {
      const result = reviewSubmissionSchema.safeParse(
        validSubmission({ content }),
      );

      expect(result.success).toBe(false);
    }
  });

  it('measures the content limit in UTF-8 bytes, not characters', () => {
    const tooLarge = 'é'.repeat(Math.floor(config.MAX_CONTENT_BYTES / 2) + 1);

    const result = reviewSubmissionSchema.safeParse(
      validSubmission({ content: tooLarge }),
    );

    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/bytes/);
  });

  it('rejects unknown source types and languages', () => {
    const badType = reviewSubmissionSchema.safeParse(
      validSubmission({ sourceType: 'FILE' }),
    );
    const badLanguage = reviewSubmissionSchema.safeParse(
      validSubmission({ language: 'RUST' }),
    );

    expect(badType.success).toBe(false);
    expect(badLanguage.success).toBe(false);
  });

  it('rejects missing fields and unknown top-level fields', () => {
    const missing = reviewSubmissionSchema.safeParse({
      content: 'x',
      language: 'GO',
    });
    const unknown = reviewSubmissionSchema.safeParse({
      ...validSubmission(),
      sourceSizeBytes: 1,
    });

    expect(missing.success).toBe(false);
    expect(unknown.success).toBe(false);
  });

  it('exposes field paths for invalid input', () => {
    expect(() => parseReviewSubmission({})).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        status: 400,
        details: expect.arrayContaining([
          expect.objectContaining({ path: 'content' }),
          expect.objectContaining({ path: 'sourceType' }),
          expect.objectContaining({ path: 'language' }),
        ]),
      }),
    );
  });
});
