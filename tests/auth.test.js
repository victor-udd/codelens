import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createRateLimiter } from '../src/middleware/rate-limit.js';
import { createFakeAIAdapter } from './helpers/fake-ai-adapter.js';
import { FakeReviewRepository } from './helpers/fake-review-repository.js';

const userKey = 'test-user-key';
const adminKey = 'test-admin-key';

function submission() {
  return {
    content: 'print("hello")',
    sourceType: 'SNIPPET',
    language: 'PYTHON',
    options: { includeStaticChecks: false },
  };
}

function testApp(overrides = {}) {
  return createApp({
    apiKeys: [userKey],
    adminApiKeys: [adminKey],
    repository: new FakeReviewRepository(),
    aiAdapter: createFakeAIAdapter(),
    ...overrides,
  });
}

describe('API authentication and rate limiting', () => {
  it('keeps health available without credentials', async () => {
    const response = await request(testApp()).get('/health');

    expect(response.status).toBe(200);
  });

  it('rejects review requests without an API key', async () => {
    const response = await request(testApp())
      .post('/reviews')
      .send(submission());

    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects an unknown API key', async () => {
    const response = await request(testApp())
      .post('/reviews')
      .set('Authorization', 'Bearer wrong-key')
      .send(submission());

    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it.each(['x-api-key', 'authorization'])(
    'accepts a configured key through %s',
    async (header) => {
      const value =
        header === 'authorization' ? `Bearer ${userKey}` : userKey;
      const response = await request(testApp())
        .post('/reviews')
        .set(header, value)
        .send(submission());

      expect(response.status).toBe(201);
    },
  );

  it('requires admin scope to list every review', async () => {
    const app = testApp();

    const denied = await request(app)
      .get('/api/reviews')
      .set('x-api-key', userKey);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: 'FORBIDDEN' });

    const allowed = await request(app)
      .get('/api/reviews')
      .set('x-api-key', adminKey);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data).toEqual([]);
  });

  it('does not require admin scope to read one review by id', async () => {
    const response = await request(testApp())
      .get('/api/reviews/00000000-0000-4000-8000-000000000000')
      .set('x-api-key', userKey);

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'REVIEW_NOT_FOUND' });
  });

  it('returns 429 with rate-limit headers after the configured budget', async () => {
    let now = 1_000_000;
    const app = testApp({
      rateLimit: createRateLimiter({
        limit: 2,
        windowMs: 60_000,
        now: () => now,
      }),
    });

    const first = await request(app)
      .post('/reviews')
      .set('x-api-key', userKey)
      .send(submission());
    const second = await request(app)
      .post('/reviews')
      .set('x-api-key', userKey)
      .send(submission());
    const third = await request(app)
      .post('/reviews')
      .set('x-api-key', userKey)
      .send(submission());

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(third.status).toBe(429);
    expect(third.body.error).toMatchObject({ code: 'RATE_LIMITED' });
    expect(third.headers['ratelimit-limit']).toBe('2');
    expect(third.headers['ratelimit-remaining']).toBe('0');

    now += 60_001;
    const afterWindow = await request(app)
      .post('/reviews')
      .set('x-api-key', userKey)
      .send(submission());
    expect(afterWindow.status).toBe(201);
  });
});
