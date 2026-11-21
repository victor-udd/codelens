import { createHash, randomUUID } from 'node:crypto';
import { FindingSource, ReviewStatus } from '@prisma/client';
import { AIInvalidResponseError, createReviewAIAdapter } from '../ai/index.js';
import { config as appConfig } from '../config/index.js';
import { ReviewNotFoundError } from '../errors/review.js';
import { logger } from '../logger.js';
import {
  createReviewRepository,
  ReviewStateError,
  sameInstant,
} from '../repositories/reviews.js';
import { analyzeSubmission } from '../static-analysis/index.js';
import { parseReviewSubmission } from '../validation/review.js';

// Only codes owned by this application may reach the persisted errorCode.
// Provider messages, stack traces and submitted source are never included.
const SAFE_ERROR_CODES = new Set([
  'VALIDATION_ERROR',
  'REVIEW_STATE_CONFLICT',
  'DATABASE_ERROR',
  'AI_PROVIDER_ERROR',
  'AI_CONFIGURATION_ERROR',
  'AI_AUTHENTICATION_FAILED',
  'AI_RATE_LIMITED',
  'AI_TIMEOUT',
  'AI_UNAVAILABLE',
  'AI_INVALID_RESPONSE',
  'MAX_ATTEMPTS_EXCEEDED',
  'STALE_RECOVERY_SOURCE_UNAVAILABLE',
  'STALE_RECOVERY_FAILED',
  'PROCESSING_FAILED',
]);

function safeErrorCode(error) {
  if (error instanceof ReviewStateError) {
    return 'REVIEW_STATE_CONFLICT';
  }

  if (typeof error?.code === 'string' && SAFE_ERROR_CODES.has(error.code)) {
    return error.code;
  }

  return 'PROCESSING_FAILED';
}

function reviewTag(reviewId) {
  return createHash('sha256').update(reviewId).digest('hex').slice(0, 8);
}

// Stable for the lifetime of a review so a recovered attempt can reuse a
// provider-side idempotency key if the provider supports one.
function idempotencyKeyFor(reviewId) {
  return createHash('sha256').update(`review:${reviewId}`).digest('hex');
}

async function attempt(operation) {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

// Repository implementations may throw driver-specific errors. Convert them
// to an application-owned code before they reach a terminal Review row.
async function databaseAttempt(operation) {
  const result = await attempt(operation);

  if (result.ok || result.error instanceof ReviewStateError) {
    return result;
  }

  const error = new Error('Review persistence operation failed');
  error.code = 'DATABASE_ERROR';
  error.status = 500;
  error.cause = result.error;
  return { ok: false, error };
}

function normalizeAIFindings(findings) {
  if (findings === undefined || findings === null) {
    return [];
  }

  if (!Array.isArray(findings)) {
    throw new AIInvalidResponseError('AI adapter returned invalid findings');
  }

  // The adapter contract already supplies this source; assigning it here also
  // protects the persisted aggregate if an injected adapter omits it.
  return findings.map((finding) => ({
    ...finding,
    source: FindingSource.AI,
  }));
}

function summarize(findings) {
  const staticCount = findings.filter(
    (finding) => finding.source === FindingSource.STATIC,
  ).length;
  const aiCount = findings.length - staticCount;

  return `Review completed with ${findings.length} finding(s): ${staticCount} static, ${aiCount} AI.`;
}

export function createReviewProcessingService(options = {}) {
  const repository = options.repository ?? createReviewRepository();
  const analyze = options.analyze ?? analyzeSubmission;
  const now = options.now ?? (() => new Date());
  const maxAttempts = options.maxAttempts ?? appConfig.MAX_PROCESSING_ATTEMPTS;
  const log = options.logger ?? logger;
  let adapter = options.aiAdapter;

  function getAdapter() {
    if (!adapter) {
      try {
        adapter = createReviewAIAdapter();
      } catch (error) {
        const configurationError = new Error('AI adapter is not configured');
        configurationError.code = 'AI_CONFIGURATION_ERROR';
        configurationError.cause = error;
        throw configurationError;
      }
    }

    return adapter;
  }

  function identityFor(review) {
    return {
      provider:
        review?.provider ??
        options.aiAdapter?.providerName ??
        appConfig.AI_PROVIDER,
      model:
        review?.model ?? options.aiAdapter?.model ?? appConfig.AI_MODEL,
    };
  }

  async function fail(reviewId, error, review = null) {
    const errorCode = safeErrorCode(error);
    const expectedProcessingStartedAt = review?.processingStartedAt ?? null;

    log.warn(
      {
        reviewTag: reviewTag(reviewId),
        errorCode,
        attemptCount: review?.attemptCount ?? null,
      },
      'review failed',
    );

    try {
      await repository.failReview(reviewId, {
        errorCode,
        completedAt: now(),
        expectedProcessingStartedAt,
      });
    } catch (persistenceError) {
      log.error(
        { reviewTag: reviewTag(reviewId), errorCode },
        'failed to persist terminal failure state',
      );
    }

    const stored = await databaseAttempt(() =>
      repository.findReviewById(reviewId),
    );
    const current = stored.ok ? stored.value : null;
    const confirmed =
      !current ||
      (current.status === ReviewStatus.FAILED &&
        current.errorCode === errorCode &&
        (!expectedProcessingStartedAt ||
          sameInstant(current.processingStartedAt, expectedProcessingStartedAt)));

    if (!confirmed) {
      // Another claim owns this review, or the failure write did not commit.
      // Report the persisted state instead of claiming a terminal outcome.
      return {
        ...(current ?? {}),
        reviewId,
        status: current?.status ?? ReviewStatus.FAILED,
        errorCode: current?.errorCode ?? errorCode,
        findings: current?.findings ?? [],
        result: current?.result ?? null,
      };
    }

    return {
      ...(review ?? {}),
      ...(current ?? {}),
      reviewId,
      status: ReviewStatus.FAILED,
      errorCode,
      findings: [],
      result: null,
    };
  }

  async function executeAttempt(parsed, review) {
    if (review.status !== ReviewStatus.PROCESSING) {
      throw new ReviewStateError();
    }

    const { provider, model } = identityFor(review);
    const startedAt = Date.now();
    const findings = [];

    try {
      if (parsed.options?.includeStaticChecks !== false) {
        findings.push(...analyze(parsed));
      }

      const aiAdapter = getAdapter();
      const aiResult = await aiAdapter.reviewSubmission({
        ...parsed,
        options: parsed.options,
        idempotencyKey: idempotencyKeyFor(review.id),
      });

      findings.push(...normalizeAIFindings(aiResult.findings));

      const completed = await databaseAttempt(() =>
        repository.completeReview(review.id, {
          findings,
          summary: summarize(findings),
          latencyMs: Date.now() - startedAt,
          tokenUsage: aiResult.tokenUsage ?? null,
          completedAt: now(),
          expectedProcessingStartedAt: review.processingStartedAt,
        }),
      );

      if (!completed.ok) {
        return fail(review.id, completed.error, review);
      }

      const stored = await databaseAttempt(() =>
        repository.findReviewById(review.id),
      );

      return {
        ...(review ?? {}),
        ...(stored.ok ? stored.value : {}),
        reviewId: review.id,
        status: ReviewStatus.COMPLETED,
        findings,
        result: completed.value.result,
        provider,
        model,
      };
    } catch (error) {
      return fail(review.id, error, review);
    }
  }

  return {
    async processSubmission(submission) {
      const parsed = parseReviewSubmission(submission);
      const reviewId = randomUUID();
      const { provider, model } = identityFor(null);

      const created = await databaseAttempt(() =>
        repository.createReview({
          id: reviewId,
          sourceType: parsed.sourceType,
          language: parsed.language,
          sourceSizeBytes: parsed.sourceSizeBytes,
          options: parsed.options ?? null,
        }),
      );

      if (!created.ok) {
        throw created.error;
      }

      const processing = await databaseAttempt(() =>
        repository.markProcessing(reviewId, {
          processingStartedAt: now(),
          provider,
          model,
          maxAttempts,
        }),
      );

      if (!processing.ok) {
        return fail(reviewId, processing.error, created.value);
      }

      return executeAttempt(parsed, processing.value);
    },

    async resumeProcessing(submission, claimedReview) {
      const parsed = parseReviewSubmission(submission);
      return executeAttempt(parsed, claimedReview);
    },

    async markTerminalFailure(reviewId, errorCode, review = null) {
      const error = new Error('Review reached a terminal failure state');
      error.code = errorCode;
      return fail(reviewId, error, review);
    },

    async getReview(id) {
      const stored = await databaseAttempt(() =>
        repository.findReviewById(id),
      );

      if (!stored.ok) {
        throw stored.error;
      }

      if (!stored.value) {
        throw new ReviewNotFoundError();
      }

      return stored.value;
    },

    async listReviews(pagination) {
      const listed = await databaseAttempt(() =>
        repository.listReviews(pagination),
      );

      if (!listed.ok) {
        throw listed.error;
      }

      return listed.value;
    },
  };
}

export const createReviewProcessor = createReviewProcessingService;
