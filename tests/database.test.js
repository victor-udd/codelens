import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDatabase,
  connectDatabase,
  disconnectDatabase,
  prisma,
} from '../src/db/prisma.js';
import { createReviewRepository } from '../src/repositories/reviews.js';

const createdReviewIds = new Set();

function reviewData(id = randomUUID()) {
  createdReviewIds.add(id);
  return {
    id,
    sourceType: 'SNIPPET',
    language: 'JAVASCRIPT',
    sourceSizeBytes: 42,
    options: { includeStaticChecks: true },
  };
}

describe('database foundation', () => {
  beforeAll(async () => {
    await connectDatabase();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  afterEach(async () => {
    const ids = [...createdReviewIds];
    createdReviewIds.clear();

    if (ids.length === 0) {
      return;
    }

    await prisma.finding.deleteMany({ where: { reviewId: { in: ids } } });
    await prisma.reviewResult.deleteMany({ where: { reviewId: { in: ids } } });
    await prisma.review.deleteMany({ where: { id: { in: ids } } });
  });

  it('connects and executes a raw query', async () => {
    await expect(checkDatabase()).resolves.toBeDefined();
  });

  it('creates a review without persisting submitted source', async () => {
    const id = randomUUID();
    const review = await prisma.review.create({ data: reviewData(id) });

    expect(review.id).toBe(id);
    expect(review.status).toBe('PENDING');
    expect(review.attemptCount).toBe(0);
    expect(Object.keys(review)).not.toContain('content');
    expect(Object.keys(review)).not.toContain('source');
  });

  it('relates findings and result to a review and cascades deletes', async () => {
    const review = await prisma.review.create({ data: reviewData() });

    await prisma.finding.create({
      data: {
        reviewId: review.id,
        source: 'STATIC',
        severity: 'WARNING',
        category: 'STYLE',
        title: 'Debug statement',
        explanation: 'Remove debugger statement.',
      },
    });

    await prisma.reviewResult.create({
      data: {
        reviewId: review.id,
        summary: 'No critical issues',
      },
    });

    const loaded = await prisma.review.findUnique({
      where: { id: review.id },
      include: { findings: true, result: true },
    });

    expect(loaded.findings).toHaveLength(1);
    expect(loaded.result.summary).toBe('No critical issues');

    await prisma.review.delete({ where: { id: review.id } });

    expect(
      await prisma.finding.count({ where: { reviewId: review.id } }),
    ).toBe(0);
    expect(
      await prisma.reviewResult.count({ where: { reviewId: review.id } }),
    ).toBe(0);
  });

  it('keeps a newer PROCESSING claim when a stale claim-less failure arrives', async () => {
    const repository = createReviewRepository();
    const created = await repository.createReview(reviewData());
    const processingStartedAt = new Date('2026-02-01T00:00:00.000Z');

    await repository.markProcessing(created.id, {
      processingStartedAt,
      provider: 'newer-worker',
      model: 'newer-model',
    });

    const staleFailure = await repository.failReview(created.id, {
      errorCode: 'AI_TIMEOUT',
      completedAt: new Date('2026-02-01T00:01:00.000Z'),
    });

    expect(staleFailure.count).toBe(0);
    await expect(repository.findReviewById(created.id)).resolves.toMatchObject({
      status: 'PROCESSING',
      provider: 'newer-worker',
      model: 'newer-model',
      errorCode: null,
      completedAt: null,
    });
    expect(
      (await repository.findReviewById(created.id)).processingStartedAt.getTime(),
    ).toBe(processingStartedAt.getTime());

    const ownedFailure = await repository.failReview(created.id, {
      errorCode: 'AI_TIMEOUT',
      completedAt: new Date('2026-02-01T00:01:00.000Z'),
      expectedProcessingStartedAt: processingStartedAt,
    });

    expect(ownedFailure.count).toBe(1);
    await expect(repository.findReviewById(created.id)).resolves.toMatchObject({
      status: 'FAILED',
      errorCode: 'AI_TIMEOUT',
    });
  });

  it('clears stale findings and result when a terminal failure commits', async () => {
    const repository = createReviewRepository();
    const created = await repository.createReview(reviewData());
    const processingStartedAt = new Date('2026-05-01T00:00:00.000Z');

    await repository.markProcessing(created.id, {
      processingStartedAt,
      provider: 'first-worker',
      model: 'first-model',
    });
    await repository.completeReview(created.id, {
      findings: [
        {
          source: 'STATIC',
          severity: 'INFO',
          category: 'STYLE',
          title: 'Old finding',
          explanation: 'From the previous attempt.',
          suggestedFix: null,
          filePath: null,
          lineStart: null,
          lineEnd: null,
          metadata: null,
        },
      ],
      summary: 'Old summary',
      latencyMs: 1,
      tokenUsage: null,
      completedAt: new Date('2026-05-01T00:01:00.000Z'),
      expectedProcessingStartedAt: processingStartedAt,
    });

    const beforeFailure = await repository.findReviewById(created.id);
    expect(beforeFailure.findings).toHaveLength(1);
    expect(beforeFailure.result.summary).toBe('Old summary');

    // Simulate a recovery claim that owns the review while the previous
    // attempt's artifacts are still attached.
    await prisma.review.update({
      where: { id: created.id },
      data: { status: 'PROCESSING' },
    });

    await repository.failReview(created.id, {
      errorCode: 'STALE_RECOVERY_FAILED',
      completedAt: new Date('2026-05-01T00:02:00.000Z'),
      expectedProcessingStartedAt: processingStartedAt,
    });

    const afterFailure = await repository.findReviewById(created.id);
    expect(afterFailure.status).toBe('FAILED');
    expect(afterFailure.findings).toEqual([]);
    expect(afterFailure.result).toBeNull();
  });

  it('rolls back artifact changes when completion fails inside the transaction', async () => {
    const repository = createReviewRepository();
    const created = await repository.createReview(reviewData());
    const processingStartedAt = new Date('2026-03-01T00:00:00.000Z');

    await repository.markProcessing(created.id, {
      processingStartedAt,
      provider: 'previous-worker',
      model: 'previous-model',
    });
    await prisma.reviewResult.create({
      data: { reviewId: created.id, summary: 'previous attempt' },
    });
    await prisma.finding.create({
      data: {
        reviewId: created.id,
        source: 'STATIC',
        severity: 'INFO',
        category: 'STYLE',
        title: 'Previous finding',
        explanation: 'Kept by rollback.',
      },
    });

    await expect(
      repository.completeReview(created.id, {
        findings: [
          {
            source: 'AI',
            severity: 'NOT_A_SEVERITY',
            category: 'STYLE',
            title: 'Invalid finding',
            explanation: 'Rejected by Prisma.',
            suggestedFix: null,
            filePath: null,
            lineStart: null,
            lineEnd: null,
            metadata: null,
          },
        ],
        summary: 'new attempt',
        latencyMs: 1,
        tokenUsage: null,
        completedAt: new Date('2026-03-01T00:01:00.000Z'),
        expectedProcessingStartedAt: processingStartedAt,
      }),
    ).rejects.toThrow();

    const stored = await repository.findReviewById(created.id);

    expect(stored.status).toBe('PROCESSING');
    expect(stored.result?.summary).toBe('previous attempt');
    expect(stored.findings).toHaveLength(1);
    expect(stored.findings[0].title).toBe('Previous finding');
  });

  it('allows only one concurrent stale claim against live PostgreSQL', async () => {
    const id = randomUUID();
    const createdAt = new Date('2026-04-01T00:00:00.000Z');
    await prisma.review.create({
      data: { ...reviewData(id), createdAt },
    });

    const repository = createReviewRepository();
    const bounds = {
      pendingBefore: new Date('2026-04-02T00:00:00.000Z'),
      processingBefore: new Date('2026-04-02T00:00:00.000Z'),
      processingStartedAt: new Date('2026-04-03T00:00:00.000Z'),
      provider: 'recovery-worker',
      model: 'recovery-model',
      maxAttempts: 3,
    };

    const claims = await Promise.all([
      repository.claimStaleReview(id, bounds),
      repository.claimStaleReview(id, bounds),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);

    const stored = await repository.findReviewById(id);
    expect(stored.status).toBe('PROCESSING');
    expect(stored.attemptCount).toBe(1);
    expect(stored.processingStartedAt.getTime()).toBe(
      bounds.processingStartedAt.getTime(),
    );
  });

  it('enforces migration CHECK constraints that are not derivable from the schema', async () => {
    await expect(
      prisma.review.create({
        data: { ...reviewData(), sourceSizeBytes: 0 },
      }),
    ).rejects.toThrow();

    const review = await prisma.review.create({ data: reviewData() });

    await expect(
      prisma.finding.create({
        data: {
          reviewId: review.id,
          source: 'STATIC',
          severity: 'INFO',
          category: 'STYLE',
          title: 'Reversed lines',
          explanation: 'lineEnd precedes lineStart.',
          lineStart: 5,
          lineEnd: 4,
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.review.update({
        where: { id: review.id },
        data: { attemptCount: -1 },
      }),
    ).rejects.toThrow();
  });
});
