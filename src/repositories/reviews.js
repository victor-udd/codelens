import { ReviewStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';

export class ReviewStateError extends Error {
  constructor(message = 'Review is not in the expected state') {
    super(message);
    this.name = 'ReviewStateError';
    this.code = 'REVIEW_STATE_CONFLICT';
  }
}

const REVIEW_INCLUDE = {
  result: true,
  findings: { orderBy: { createdAt: 'asc' } },
};

const SAFE_METADATA_KEYS = ['ruleId', 'detector', 'field', 'provider', 'model'];

function toSafeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return null;
  }

  if (typeof options.includeStaticChecks !== 'boolean') {
    return null;
  }

  return { includeStaticChecks: options.includeStaticChecks };
}

function toSafeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const safe = {};

  for (const key of SAFE_METADATA_KEYS) {
    if (typeof metadata[key] === 'string') {
      safe[key] = metadata[key];
    }
  }

  return Object.keys(safe).length > 0 ? safe : null;
}

function toFindingData(reviewId, finding) {
  return {
    reviewId,
    source: finding.source,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    explanation: finding.explanation,
    suggestedFix: finding.suggestedFix ?? null,
    filePath: finding.filePath ?? null,
    lineStart: finding.lineStart ?? null,
    lineEnd: finding.lineEnd ?? null,
    metadata: toSafeMetadata(finding.metadata),
  };
}

function sameInstant(left, right) {
  if (!left || !right) {
    return false;
  }

  return new Date(left).getTime() === new Date(right).getTime();
}

// All Prisma access for reviews lives here. Submitted source never appears in
// any write payload. Terminal writes are scoped to the processing claim so a
// stale worker cannot overwrite a newer attempt.
export function createReviewRepository(client = prisma) {
  return {
    async createReview({ id, sourceType, language, sourceSizeBytes, options }) {
      return client.review.create({
        data: {
          id,
          status: ReviewStatus.PENDING,
          sourceType,
          language,
          sourceSizeBytes,
          options: toSafeOptions(options),
          attemptCount: 0,
        },
      });
    },

    async markProcessing(id, { processingStartedAt, provider, model, maxAttempts }) {
      const where = { id, status: ReviewStatus.PENDING };

      if (Number.isInteger(maxAttempts)) {
        where.attemptCount = { lt: maxAttempts };
      }

      const updated = await client.review.updateMany({
        where,
        data: {
          status: ReviewStatus.PROCESSING,
          attemptCount: { increment: 1 },
          processingStartedAt,
          provider,
          model,
        },
      });

      if (updated.count !== 1) {
        throw new ReviewStateError();
      }

      return client.review.findUnique({ where: { id } });
    },

    async completeReview(
      id,
      {
        findings,
        summary,
        latencyMs,
        tokenUsage,
        completedAt,
        expectedProcessingStartedAt,
      },
    ) {
      // One transaction: either all artifacts and the terminal state commit,
      // or none of them do.
      return client.$transaction(async (tx) => {
        await tx.finding.deleteMany({ where: { reviewId: id } });
        await tx.reviewResult.deleteMany({ where: { reviewId: id } });

        if (findings.length > 0) {
          await tx.finding.createMany({
            data: findings.map((finding) => toFindingData(id, finding)),
          });
        }

        const result = await tx.reviewResult.create({
          data: {
            reviewId: id,
            summary,
            latencyMs: latencyMs ?? null,
            tokenUsage: tokenUsage ?? null,
          },
        });

        const where = { id, status: ReviewStatus.PROCESSING };

        if (expectedProcessingStartedAt) {
          where.processingStartedAt = expectedProcessingStartedAt;
        }

        const updated = await tx.review.updateMany({ where, data: { status: ReviewStatus.COMPLETED, completedAt } });

        if (updated.count !== 1) {
          throw new ReviewStateError();
        }

        const review = await tx.review.findUnique({ where: { id } });

        return { review, result };
      });
    },

    async failReview(
      id,
      { errorCode, completedAt, expectedProcessingStartedAt },
    ) {
      const where = {
        id,
        status: { in: [ReviewStatus.PENDING, ReviewStatus.PROCESSING] },
      };

      if (expectedProcessingStartedAt) {
        where.processingStartedAt = expectedProcessingStartedAt;
      }

      const updated = await client.review.updateMany({
        where,
        data: { status: ReviewStatus.FAILED, errorCode, completedAt },
      });

      return {
        count: updated.count,
        review: await client.review.findUnique({ where: { id } }),
      };
    },

    async findReviewById(id) {
      return client.review.findUnique({
        where: { id },
        include: REVIEW_INCLUDE,
      });
    },

    async findStaleReviews({
      pendingBefore,
      processingBefore,
      limit,
    }) {
      return client.review.findMany({
        where: {
          OR: [
            {
              status: ReviewStatus.PENDING,
              createdAt: { lt: pendingBefore },
            },
            {
              status: ReviewStatus.PROCESSING,
              processingStartedAt: { lt: processingBefore },
            },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
        include: REVIEW_INCLUDE,
      });
    },

    async claimStaleReview(
      id,
      {
        pendingBefore,
        processingBefore,
        processingStartedAt,
        provider,
        model,
        maxAttempts,
      },
    ) {
      const where = {
        OR: [
          {
            id,
            status: ReviewStatus.PENDING,
            createdAt: { lt: pendingBefore },
          },
          {
            id,
            status: ReviewStatus.PROCESSING,
            processingStartedAt: { lt: processingBefore },
          },
        ],
      };

      if (Number.isInteger(maxAttempts)) {
        where.AND = [{ attemptCount: { lt: maxAttempts } }];
      }

      const updated = await client.review.updateMany({
        where,
        data: {
          status: ReviewStatus.PROCESSING,
          attemptCount: { increment: 1 },
          processingStartedAt,
          errorCode: null,
          completedAt: null,
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
        },
      });

      if (updated.count !== 1) {
        return null;
      }

      return client.review.findUnique({
        where: { id },
        include: REVIEW_INCLUDE,
      });
    },

    async listReviews({ page, limit }) {
      const skip = (page - 1) * limit;

      const [items, total] = await Promise.all([
        client.review.findMany({
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: REVIEW_INCLUDE,
        }),
        client.review.count(),
      ]);

      return {
        items,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      };
    },
  };
}

export { sameInstant };
