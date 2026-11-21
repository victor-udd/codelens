import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AIAuthenticationError,
  AIInvalidResponseError,
  AIRateLimitError,
  AITimeoutError,
} from '../../src/ai/index.js';
import { createReviewProcessingService } from '../../src/services/review-processing.js';
import { createReviewRecoveryService } from '../../src/services/review-recovery.js';
import { createFakeAIAdapter } from '../helpers/fake-ai-adapter.js';
import { FakeReviewRepository } from '../helpers/fake-review-repository.js';

const START = '2026-01-01T00:00:00.000Z';
const STALE_PROCESSING_MS = 90_000;
const STALE_PENDING_MS = 300_000;
const MAX_ATTEMPTS = 3;

function clockFrom(start = START) {
  let current = new Date(start);

  return {
    now: () => current,
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
      return current;
    },
  };
}

function reviewData(id) {
  return {
    id,
    sourceType: 'SNIPPET',
    language: 'JAVASCRIPT',
    sourceSizeBytes: 24,
    options: { includeStaticChecks: false },
  };
}

function submission() {
  return {
    content: 'const recoveredValue = 1;',
    language: 'JAVASCRIPT',
    sourceType: 'SNIPPET',
    options: { includeStaticChecks: false },
  };
}

async function createInterruptedReview(repository, clock, { attemptCount = 1 } = {}) {
  const id = randomUUID();
  await repository.createReview(reviewData(id));
  await repository.markProcessing(id, {
    processingStartedAt: clock.now(),
    provider: 'fake-provider',
    model: 'fake-model',
    maxAttempts: MAX_ATTEMPTS,
  });
  repository.setReviewState(id, { attemptCount });
  return id;
}

function memoryLogger() {
  const entries = [];
  const capture = (level) => (data, message) => {
    entries.push({ level, ...data, message });
  };

  return {
    entries,
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
  };
}

describe('review recovery', () => {
  it('detects stale PENDING and PROCESSING reviews', async () => {
    const clock = clockFrom();
    const repository = new FakeReviewRepository({ now: clock.now });
    const pendingId = randomUUID();
    const processingId = await createInterruptedReview(repository, clock);

    await repository.createReview(reviewData(pendingId));
    clock.advance(STALE_PENDING_MS + 1000);

    const recovery = createReviewRecoveryService({
      repository,
      aiAdapter: createFakeAIAdapter(),
      now: clock.now,
      staleProcessingMs: STALE_PROCESSING_MS,
      stalePendingMs: STALE_PENDING_MS,
      maxAttempts: MAX_ATTEMPTS,
    });

    const stale = await recovery.findStaleReviews();

    expect(stale.map((review) => review.id)).toEqual(
      expect.arrayContaining([processingId, pendingId]),
    );
  });

  it('reclaims and completes an interrupted review using the supplied source', async () => {
    const clock = clockFrom();
    const repository = new FakeReviewRepository({ now: clock.now });
    const aiAdapter = createFakeAIAdapter();
    const processingService = createReviewProcessingService({
      repository,
      aiAdapter,
      now: clock.now,
      maxAttempts: MAX_ATTEMPTS,
    });
    const id = await createInterruptedReview(repository, clock);
    clock.advance(STALE_PROCESSING_MS + 1000);

    const recovery = createReviewRecoveryService({
      repository,
      processingService,
      sourceLoader: async () => submission(),
      now: clock.now,
      staleProcessingMs: STALE_PROCESSING_MS,
      stalePendingMs: STALE_PENDING_MS,
      maxAttempts: MAX_ATTEMPTS,
    });

    const outcome = await recovery.recoverReview(id);

    expect(outcome.status).toBe('COMPLETED');
    expect(repository.get(id)).toMatchObject({
      status: 'COMPLETED',
      attemptCount: 2,
    });
    expect(aiAdapter.calls).toHaveLength(1);
    expect(aiAdapter.calls[0].idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(outcome)).not.toContain(submission().content);
  });

  it('stops retrying a review that reached the maximum attempt count', async () => {
    const clock = clockFrom();
    const repository = new FakeReviewRepository({ now: clock.now });
    const aiAdapter = createFakeAIAdapter();
    const id = await createInterruptedReview(repository, clock, {
      attemptCount: MAX_ATTEMPTS,
    });
    clock.advance(STALE_PROCESSING_MS + 1000);

    const recovery = createReviewRecoveryService({
      repository,
      aiAdapter,
      sourceLoader: async () => submission(),
      now: clock.now,
      staleProcessingMs: STALE_PROCESSING_MS,
      stalePendingMs: STALE_PENDING_MS,
      maxAttempts: MAX_ATTEMPTS,
    });

    const outcome = await recovery.recoverReview(id);

    expect(outcome.errorCode).toBe('MAX_ATTEMPTS_EXCEEDED');
    expect(repository.get(id)).toMatchObject({
      status: 'FAILED',
      errorCode: 'MAX_ATTEMPTS_EXCEEDED',
    });
    expect(repository.get(id).completedAt).toBeDefined();
    expect(aiAdapter.calls).toEqual([]);
  });

  it('allows only one concurrent stale claim to win', async () => {
    const clock = clockFrom();
    const repository = new FakeReviewRepository({ now: clock.now });
    const id = await createInterruptedReview(repository, clock);
    clock.advance(STALE_PROCESSING_MS + 1000);

    const bounds = {
      pendingBefore: new Date(clock.now().getTime() - STALE_PENDING_MS),
      processingBefore: new Date(
        clock.now().getTime() - STALE_PROCESSING_MS,
      ),
      processingStartedAt: clock.now(),
      provider: 'fake-provider',
      model: 'fake-model',
      maxAttempts: MAX_ATTEMPTS,
    };

    const claims = await Promise.all([
      repository.claimStaleReview(id, bounds),
      repository.claimStaleReview(id, bounds),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({
      id,
      status: 'PROCESSING',
      attemptCount: 2,
    });
  });

  it.each([
    ['timeout', new AITimeoutError('provider timed out sk-leak-timeout'), 'AI_TIMEOUT'],
    ['rate limit', new AIRateLimitError('rate limited sk-leak-rate'), 'AI_RATE_LIMITED'],
    [
      'authentication failure',
      new AIAuthenticationError('rejected sk-leak-auth'),
      'AI_AUTHENTICATION_FAILED',
    ],
    [
      'malformed response',
      new AIInvalidResponseError('bad JSON sk-leak-json'),
      'AI_INVALID_RESPONSE',
    ],
  ])('persists a terminal state on %s', async (_name, error, expectedCode) => {
    const repository = new FakeReviewRepository();
    const aiAdapter = createFakeAIAdapter({ error });
    const service = createReviewProcessingService({ repository, aiAdapter });

    const outcome = await service.processSubmission(submission());

    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorCode).toBe(expectedCode);
    expect(repository.get(outcome.reviewId)).toMatchObject({
      status: 'FAILED',
      errorCode: expectedCode,
    });
    expect(repository.get(outcome.reviewId).completedAt).toBeDefined();
    expect(JSON.stringify(outcome)).not.toContain('sk-leak');
  });

  it('persists DATABASE_ERROR when completion cannot be committed', async () => {
    const repository = new FakeReviewRepository({ failOn: ['completeReview'] });
    const service = createReviewProcessingService({
      repository,
      aiAdapter: createFakeAIAdapter(),
    });

    const outcome = await service.processSubmission(submission());

    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorCode).toBe('DATABASE_ERROR');
    expect(repository.get(outcome.reviewId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'DATABASE_ERROR',
    });
    expect(JSON.stringify(outcome)).not.toContain('forced completeReview failure');
  });

  it('fails safely when recovered source cannot be supplied', async () => {
    const clock = clockFrom();
    const repository = new FakeReviewRepository({ now: clock.now });
    const aiAdapter = createFakeAIAdapter();
    const log = memoryLogger();
    const id = await createInterruptedReview(repository, clock);
    clock.advance(STALE_PROCESSING_MS + 1000);

    const recovery = createReviewRecoveryService({
      repository,
      aiAdapter,
      sourceLoader: async () => {
        throw new Error('loader saw sk-leak-loader');
      },
      now: clock.now,
      logger: log,
      staleProcessingMs: STALE_PROCESSING_MS,
      stalePendingMs: STALE_PENDING_MS,
      maxAttempts: MAX_ATTEMPTS,
    });

    const outcome = await recovery.recoverReview(id);

    expect(outcome.errorCode).toBe('STALE_RECOVERY_SOURCE_UNAVAILABLE');
    expect(repository.get(id)).toMatchObject({
      status: 'FAILED',
      errorCode: 'STALE_RECOVERY_SOURCE_UNAVAILABLE',
    });
    expect(aiAdapter.calls).toEqual([]);
    expect(JSON.stringify(log.entries)).not.toContain('sk-leak-loader');
    expect(log.entries.some((entry) => entry.reviewTag)).toBe(true);
  });
});
