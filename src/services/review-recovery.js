import { createHash } from 'node:crypto';
import { ReviewStatus } from '@prisma/client';
import { config as appConfig } from '../config/index.js';
import { logger } from '../logger.js';
import {
  createReviewProcessingService,
} from './review-processing.js';
import { createReviewRepository } from '../repositories/reviews.js';

function reviewTag(reviewId) {
  return createHash('sha256').update(reviewId).digest('hex').slice(0, 8);
}

// Recovery deliberately has no queue or timer. An operator (or a future
// scheduler) calls recoverStaleReviews(); claims are database-atomic, so
// multiple callers are safe.
export function createReviewRecoveryService(options = {}) {
  const repository = options.repository ?? createReviewRepository();
  const processingService =
    options.processingService ??
    createReviewProcessingService({
      repository,
      aiAdapter: options.aiAdapter,
      maxAttempts: options.maxAttempts,
    });
  const sourceLoader = options.sourceLoader ?? (async () => null);
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? logger;
  const staleProcessingMs =
    options.staleProcessingMs ?? appConfig.STALE_PROCESSING_MS;
  const stalePendingMs = options.stalePendingMs ?? appConfig.STALE_PENDING_MS;
  const maxAttempts = options.maxAttempts ?? appConfig.MAX_PROCESSING_ATTEMPTS;
  const batchSize = options.batchSize ?? appConfig.RECOVERY_BATCH_SIZE;

  function bounds(at = now()) {
    return {
      pendingBefore: new Date(at.getTime() - stalePendingMs),
      processingBefore: new Date(at.getTime() - staleProcessingMs),
      limit: batchSize,
    };
  }

  function findStaleReviews() {
    return repository.findStaleReviews(bounds());
  }

  async function recoverCandidate(candidate) {
    const reviewId = candidate.id;
    const tag = reviewTag(reviewId);
    const at = now();

    if (candidate.attemptCount >= maxAttempts) {
      log.warn(
        { reviewTag: tag, attemptCount: candidate.attemptCount, maxAttempts },
        'stale review exhausted its retry limit',
      );
      return processingService.markTerminalFailure(
        reviewId,
        'MAX_ATTEMPTS_EXCEEDED',
        candidate,
      );
    }

    const claimed = await repository.claimStaleReview(reviewId, {
      ...bounds(at),
      processingStartedAt: at,
      provider: candidate.provider ?? null,
      model: candidate.model ?? null,
      maxAttempts,
    });

    if (!claimed) {
      log.info({ reviewTag: tag }, 'stale review claim lost');
      return {
        reviewId,
        status: 'SKIPPED',
        errorCode: 'CLAIM_CONFLICT',
      };
    }

    log.info(
      { reviewTag: tag, attemptCount: claimed.attemptCount, maxAttempts },
      'claimed stale review for recovery',
    );

    let submission = null;

    try {
      submission = await sourceLoader(reviewId, claimed);
    } catch {
      submission = null;
    }

    if (!submission) {
      // Submitted source is never persisted, so recovery cannot re-run AI
      // analysis without a caller-supplied source provider.
      return processingService.markTerminalFailure(
        reviewId,
        'STALE_RECOVERY_SOURCE_UNAVAILABLE',
        claimed,
      );
    }

    return processingService.resumeProcessing(submission, claimed);
  }

  return {
    findStaleReviews,

    async recoverStaleReviews() {
      const stale = await findStaleReviews();
      const outcomes = [];

      for (const candidate of stale) {
        outcomes.push(await recoverCandidate(candidate));
      }

      return outcomes;
    },

    async recoverReview(id) {
      const review = await repository.findReviewById(id);

      if (
        !review ||
        ![ReviewStatus.PENDING, ReviewStatus.PROCESSING].includes(review.status)
      ) {
        return { reviewId: id, status: 'SKIPPED', errorCode: 'NOT_RECOVERABLE' };
      }

      return recoverCandidate(review);
    },
  };
}

export const createReviewRecovery = createReviewRecoveryService;
