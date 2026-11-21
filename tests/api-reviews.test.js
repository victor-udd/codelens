import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { AIAuthenticationError } from '../src/ai/index.js';
import { createApp } from '../src/app.js';
import { createReviewProcessingService } from '../src/services/review-processing.js';
import { createFakeAIAdapter } from './helpers/fake-ai-adapter.js';
import { FakeReviewRepository } from './helpers/fake-review-repository.js';

const sourceWithIssues = [
  'const apiKey = "abcdef123456";',
  'eval(userInput);',
].join('\n');

const aiFinding = {
  severity: 'WARNING',
  category: 'SECURITY',
  title: 'AI-detected issue',
  explanation: 'The provider reported a concern.',
  suggestedFix: 'Apply the suggested fix.',
  filePath: 'src/example.js',
  lineStart: 2,
  lineEnd: 2,
  metadata: {
    provider: 'fake-provider',
    model: 'fake-model',
    apiKey: 'sk-leak-123',
    content: 'sensitive-source',
  },
};

function submission(content = sourceWithIssues, overrides = {}) {
  return {
    content,
    language: 'JAVASCRIPT',
    sourceType: 'SNIPPET',
    options: { includeStaticChecks: true, apiKey: 'sk-option-leak' },
    ...overrides,
  };
}

describe('review HTTP API', () => {
  it('creates and completes a review with a safe serialized response', async () => {
    const repository = new FakeReviewRepository();
    const aiAdapter = createFakeAIAdapter({
      findings: [aiFinding],
      tokenUsage: { totalTokens: 7 },
    });
    const app = createApp({ repository, aiAdapter });

    const response = await request(app)
      .post('/api/reviews')
      .send(submission());

    expect(response.status).toBe(201);
    expect(response.headers.location).toBe(`/api/reviews/${response.body.id}`);
    expect(response.body).toMatchObject({
      status: 'COMPLETED',
      sourceType: 'SNIPPET',
      language: 'JAVASCRIPT',
      sourceSizeBytes: Buffer.byteLength(sourceWithIssues, 'utf8'),
      options: { includeStaticChecks: true },
      provider: 'fake-provider',
      model: 'fake-model',
      attemptCount: 1,
      summary: expect.stringContaining('3 finding(s)'),
      findingCount: 3,
      completedAt: expect.any(String),
    });

    const ai = response.body.findings.find(
      (finding) => finding.source === 'AI',
    );
    expect(ai).toMatchObject({
      title: 'AI-detected issue',
      metadata: { provider: 'fake-provider', model: 'fake-model' },
    });
    expect(Object.keys(ai).sort()).toEqual([
      'category',
      'explanation',
      'filePath',
      'lineEnd',
      'lineStart',
      'metadata',
      'severity',
      'source',
      'suggestedFix',
      'title',
    ]);

    const body = JSON.stringify(response.body);
    for (const sensitive of [
      sourceWithIssues,
      'abcdef123456',
      'sk-option-leak',
      'sk-leak-123',
      'sensitive-source',
      'content',
    ]) {
      expect(body).not.toContain(sensitive);
    }
  });

  it('rejects an invalid submission before calling services', async () => {
    const repository = new FakeReviewRepository();
    const aiAdapter = createFakeAIAdapter();
    const app = createApp({ repository, aiAdapter });

    const response = await request(app)
      .post('/api/reviews')
      .send(submission('', { language: 'RUST' }));

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.arrayContaining([
        expect.objectContaining({ path: 'content' }),
        expect.objectContaining({ path: 'language' }),
      ]),
      requestId: expect.any(String),
    });
    expect(repository.calls).toEqual([]);
    expect(aiAdapter.calls).toEqual([]);
  });

  it('retrieves a completed review', async () => {
    const repository = new FakeReviewRepository();
    const aiAdapter = createFakeAIAdapter({ findings: [aiFinding] });
    const service = createReviewProcessingService({ repository, aiAdapter });
    const app = createApp({ reviewService: service });

    const created = await request(app).post('/api/reviews').send(submission());
    const response = await request(app).get(
      `/api/reviews/${created.body.id}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: created.body.id,
      status: 'COMPLETED',
      summary: created.body.summary,
      findingCount: created.body.findingCount,
    });
    expect(JSON.stringify(response.body)).not.toContain('abcdef123456');
  });

  it('returns a structured 404 for an unknown review ID', async () => {
    const app = createApp({
      repository: new FakeReviewRepository(),
      aiAdapter: createFakeAIAdapter(),
    });

    const response = await request(app).get(`/api/reviews/${randomUUID()}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({
      code: 'REVIEW_NOT_FOUND',
      message: 'Review not found',
      requestId: expect.any(String),
    });
  });

  it('rejects a malformed review ID', async () => {
    const app = createApp({
      repository: new FakeReviewRepository(),
      aiAdapter: createFakeAIAdapter(),
    });

    const response = await request(app).get('/api/reviews/not-a-uuid');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.arrayContaining([
        expect.objectContaining({ path: 'id' }),
      ]),
    });
  });

  it('paginates reviews and rejects invalid pagination parameters', async () => {
    let clock = 0;
    const repository = new FakeReviewRepository({
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)),
    });
    const aiAdapter = createFakeAIAdapter();
    const service = createReviewProcessingService({
      repository,
      aiAdapter,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 100 + clock++)),
    });

    for (let index = 0; index < 3; index += 1) {
      await service.processSubmission(
        submission(`const value${index} = ${index};`, {
          options: { includeStaticChecks: false },
        }),
      );
    }

    const app = createApp({ reviewService: service });
    const page = await request(app).get('/api/reviews?page=2&limit=2');

    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.pagination).toEqual({
      page: 2,
      limit: 2,
      total: 3,
      totalPages: 2,
    });
    expect(page.body.data[0]).not.toHaveProperty('content');

    for (const query of ['page=0', 'limit=101', 'offset=1']) {
      const invalid = await request(app).get(`/api/reviews?${query}`);
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('maps a processing failure to a safe HTTP error and FAILED review', async () => {
    const repository = new FakeReviewRepository();
    const aiAdapter = createFakeAIAdapter({
      error: new AIAuthenticationError('AI rejected sk-leak-999 credential'),
    });
    const app = createApp({ repository, aiAdapter });

    const response = await request(app)
      .post('/api/reviews')
      .send(submission('const value = 1;'));

    expect(response.status).toBe(502);
    expect(response.body.error).toMatchObject({
      code: 'AI_AUTHENTICATION_FAILED',
      message: 'Review processing failed',
      reviewId: expect.any(String),
      requestId: expect.any(String),
    });
    expect(JSON.stringify(response.body)).not.toContain('sk-leak-999');
    expect(JSON.stringify(response.body)).not.toContain('rejected');

    const stored = await request(app).get(
      `/api/reviews/${response.body.error.reviewId}`,
    );
    expect(stored.status).toBe(200);
    expect(stored.body).toMatchObject({
      status: 'FAILED',
      errorCode: 'AI_AUTHENTICATION_FAILED',
      summary: null,
      findings: [],
    });
  });
});
