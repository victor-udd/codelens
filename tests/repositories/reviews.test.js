import { describe, expect, it, vi } from 'vitest';
import {
  createReviewRepository,
  ReviewStateError,
} from '../../src/repositories/reviews.js';

function fakeClient({ failOnTx = [] } = {}) {
  const calls = [];
  const failedTx = new Set(failOnTx);
  const tx = {
    finding: {
      deleteMany: vi.fn(async (args) => calls.push(['tx.finding.deleteMany', args])),
      createMany: vi.fn(async (args) => calls.push(['tx.finding.createMany', args])),
    },
    reviewResult: {
      deleteMany: vi.fn(async (args) =>
        calls.push(['tx.reviewResult.deleteMany', args]),
      ),
      create: vi.fn(async (args) => {
        calls.push(['tx.reviewResult.create', args]);
        if (failedTx.has('reviewResult.create')) {
          throw new Error('forced transaction failure');
        }
        return { id: 'result-1', ...args.data };
      }),
    },
    review: {
      updateMany: vi.fn(async (args) => {
        calls.push(['tx.review.updateMany', args]);
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => ({ id: 'review-1', status: 'COMPLETED' })),
    },
  };

  return {
    calls,
    tx,
    client: {
      $transaction: vi.fn(async (callback) => {
        calls.push(['$transaction']);
        return callback(tx);
      }),
      review: {
        create: vi.fn(async (args) => {
          calls.push(['review.create', args]);
          return { id: args.data.id, ...args.data };
        }),
        updateMany: vi.fn(async (args) => {
          calls.push(['review.updateMany', args]);
          return { count: 1 };
        }),
        findUnique: vi.fn(async () => ({ id: 'review-1', status: 'PROCESSING' })),
        findMany: vi.fn(async () => [
          { id: 'review-1', status: 'COMPLETED' },
        ]),
        count: vi.fn(async () => 3),
        update: vi.fn(async (args) => {
          calls.push(['review.update', args]);
          return { id: args.where.id, ...args.data };
        }),
      },
    },
  };
}

describe('review repository', () => {
  it('creates a PENDING review without any submitted source', async () => {
    const { client, calls } = fakeClient();
    const repository = createReviewRepository(client);

    const review = await repository.createReview({
      id: 'review-1',
      sourceType: 'SNIPPET',
      language: 'JAVASCRIPT',
      sourceSizeBytes: 42,
      options: { includeStaticChecks: true, apiKey: 'sk-option-leak' },
    });

    expect(review.status).toBe('PENDING');
    expect(calls[0][1].data).toMatchObject({
      id: 'review-1',
      status: 'PENDING',
      attemptCount: 0,
    });
    expect(calls[0][1].data.options).toEqual({ includeStaticChecks: true });
    expect(calls[0][1].data).not.toHaveProperty('content');
    expect(calls[0][1].data).not.toHaveProperty('source');
  });

  it('moves a PENDING review to PROCESSING and increments attempts', async () => {
    const { client, calls } = fakeClient();
    const repository = createReviewRepository(client);

    await repository.markProcessing('review-1', {
      processingStartedAt: new Date('2026-01-01T00:00:00.000Z'),
      provider: 'fake-provider',
      model: 'fake-model',
    });

    expect(calls[0][0]).toBe('review.updateMany');
    expect(calls[0][1]).toMatchObject({
      where: { id: 'review-1', status: 'PENDING' },
      data: {
        status: 'PROCESSING',
        attemptCount: { increment: 1 },
        provider: 'fake-provider',
        model: 'fake-model',
      },
    });
  });

  it('refuses to process a review that is not PENDING', async () => {
    const { client } = fakeClient();
    client.review.updateMany.mockResolvedValue({ count: 0 });
    const repository = createReviewRepository(client);

    await expect(
      repository.markProcessing('review-1', {
        processingStartedAt: new Date(),
        provider: 'p',
        model: 'm',
      }),
    ).rejects.toBeInstanceOf(ReviewStateError);
  });

  it('persists findings, result and COMPLETED status in one transaction', async () => {
    const { client, calls, tx } = fakeClient();
    const repository = createReviewRepository(client);
    const completedAt = new Date('2026-01-02T00:00:00.000Z');
    const processingStartedAt = new Date('2026-01-01T00:00:00.000Z');

    await repository.completeReview('review-1', {
      expectedProcessingStartedAt: processingStartedAt,
      findings: [
        {
          source: 'STATIC',
          severity: 'WARNING',
          category: 'BUG',
          title: 'Static issue',
          explanation: 'static explanation',
          suggestedFix: 'static fix',
          filePath: null,
          lineStart: 2,
          lineEnd: 2,
          metadata: { ruleId: 'eval-use', detector: 'field-name', field: 'token' },
        },
        {
          source: 'AI',
          severity: 'INFO',
          category: 'STYLE',
          title: 'AI issue',
          explanation: 'ai explanation',
          suggestedFix: 'ai fix',
          filePath: 'src/a.js',
          lineStart: null,
          lineEnd: null,
          metadata: {
            provider: 'fake-provider',
            apiKey: 'sk-leak',
            content: 'sensitive-source',
          },
        },
      ],
      summary: '2 finding(s)',
      latencyMs: 12,
      tokenUsage: { totalTokens: 5 },
      completedAt,
    });

    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(calls.map(([name]) => name)).toEqual([
      '$transaction',
      'tx.finding.deleteMany',
      'tx.reviewResult.deleteMany',
      'tx.finding.createMany',
      'tx.reviewResult.create',
      'tx.review.updateMany',
    ]);
    expect(tx.finding.createMany.mock.calls[0][0].data).toMatchObject([
      { reviewId: 'review-1', source: 'STATIC', title: 'Static issue', lineStart: 2 },
      { reviewId: 'review-1', source: 'AI', title: 'AI issue', lineStart: null },
    ]);
    expect(tx.review.updateMany.mock.calls[0][0]).toMatchObject({
      where: {
        id: 'review-1',
        status: 'PROCESSING',
        processingStartedAt,
      },
      data: { status: 'COMPLETED', completedAt },
    });
    const persistedFindings = tx.finding.createMany.mock.calls[0][0].data;
    for (const finding of persistedFindings) {
      expect(finding).not.toHaveProperty('content');
      expect(finding).not.toHaveProperty('sourceCode');
    }
    expect(persistedFindings[0].metadata).toEqual({
      ruleId: 'eval-use',
      detector: 'field-name',
      field: 'token',
    });
    expect(persistedFindings[1].metadata).toEqual({ provider: 'fake-provider' });
  });

  it('does not commit COMPLETED status when a transaction write fails', async () => {
    const { client, calls, tx } = fakeClient({
      failOnTx: ['reviewResult.create'],
    });
    const repository = createReviewRepository(client);

    await expect(
      repository.completeReview('review-1', {
        findings: [],
        summary: '0 finding(s)',
        latencyMs: 5,
        tokenUsage: null,
        completedAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
    ).rejects.toThrow('forced transaction failure');

    expect(tx.finding.createMany).not.toHaveBeenCalled();
    expect(tx.review.updateMany).not.toHaveBeenCalled();
    expect(calls.map(([name]) => name)).not.toContain('tx.review.updateMany');
  });

  it('stores a safe failure code when completing is not possible', async () => {
    const { client, calls } = fakeClient();
    const repository = createReviewRepository(client);

    await repository.failReview('review-1', {
      errorCode: 'AI_INVALID_RESPONSE',
      completedAt: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(calls[0][0]).toBe('review.updateMany');
    expect(calls[0][1]).toMatchObject({
      where: {
        id: 'review-1',
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      data: {
        status: 'FAILED',
        errorCode: 'AI_INVALID_RESPONSE',
      },
    });
  });

  it('loads one review with its result and findings', async () => {
    const { client } = fakeClient();
    const repository = createReviewRepository(client);

    await expect(repository.findReviewById('review-1')).resolves.toMatchObject({
      id: 'review-1',
      status: 'PROCESSING',
    });
    expect(client.review.findUnique).toHaveBeenCalledWith({
      where: { id: 'review-1' },
      include: expect.objectContaining({
        result: true,
        findings: expect.any(Object),
      }),
    });
  });

  it('lists reviews with pagination offsets and a total count', async () => {
    const { client } = fakeClient();
    const repository = createReviewRepository(client);

    const page = await repository.listReviews({ page: 2, limit: 2 });

    expect(client.review.findMany).toHaveBeenCalledWith({
      skip: 2,
      take: 2,
      orderBy: { createdAt: 'desc' },
      include: expect.objectContaining({
        result: true,
        findings: expect.any(Object),
      }),
    });
    expect(client.review.count).toHaveBeenCalledTimes(1);
    expect(page).toMatchObject({
      page: 2,
      limit: 2,
      total: 3,
      totalPages: 2,
    });
  });

  it('guards a fresh processing claim with the maximum attempt count', async () => {
    const { client, calls } = fakeClient();
    const repository = createReviewRepository(client);

    await repository.markProcessing('review-1', {
      processingStartedAt: new Date('2026-01-01T00:00:00.000Z'),
      provider: 'fake-provider',
      model: 'fake-model',
      maxAttempts: 3,
    });

    expect(calls[0][1].where).toMatchObject({
      id: 'review-1',
      status: 'PENDING',
      attemptCount: { lt: 3 },
    });
  });

  it('finds stale PENDING and PROCESSING reviews', async () => {
    const { client } = fakeClient();
    const repository = createReviewRepository(client);
    const pendingBefore = new Date('2026-01-01T00:00:00.000Z');
    const processingBefore = new Date('2026-01-01T00:01:00.000Z');

    await repository.findStaleReviews({
      pendingBefore,
      processingBefore,
      limit: 10,
    });

    expect(client.review.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { status: 'PENDING', createdAt: { lt: pendingBefore } },
          {
            status: 'PROCESSING',
            processingStartedAt: { lt: processingBefore },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 10,
      include: expect.objectContaining({
        result: true,
        findings: expect.any(Object),
      }),
    });
  });

  it('atomically claims only eligible stale reviews', async () => {
    const { client } = fakeClient();
    const repository = createReviewRepository(client);
    const bounds = {
      pendingBefore: new Date('2026-01-01T00:00:00.000Z'),
      processingBefore: new Date('2026-01-01T00:01:00.000Z'),
      processingStartedAt: new Date('2026-01-01T00:02:00.000Z'),
      provider: 'fake-provider',
      model: 'fake-model',
      maxAttempts: 3,
    };

    await expect(
      repository.claimStaleReview('review-1', bounds),
    ).resolves.toMatchObject({ id: 'review-1', status: 'PROCESSING' });
    expect(client.review.updateMany).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            id: 'review-1',
            status: 'PENDING',
            createdAt: { lt: bounds.pendingBefore },
          },
          {
            id: 'review-1',
            status: 'PROCESSING',
            processingStartedAt: { lt: bounds.processingBefore },
          },
        ],
        AND: [{ attemptCount: { lt: 3 } }],
      },
      data: {
        status: 'PROCESSING',
        attemptCount: { increment: 1 },
        processingStartedAt: bounds.processingStartedAt,
        errorCode: null,
        completedAt: null,
        provider: 'fake-provider',
        model: 'fake-model',
      },
    });

    client.review.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      repository.claimStaleReview('review-1', bounds),
    ).resolves.toBeNull();
  });
});
