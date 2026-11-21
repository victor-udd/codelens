import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('review submission endpoint', () => {
  const app = createApp();

  function validSubmission(overrides = {}) {
    return {
      content: 'print("hello")',
      sourceType: 'SNIPPET',
      language: 'PYTHON',
      ...overrides,
    };
  }

  it('accepts a valid submission without echoing the source', async () => {
    const response = await request(app)
      .post('/reviews')
      .send(validSubmission());

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'PENDING',
      sourceType: 'SNIPPET',
      language: 'PYTHON',
      sourceSizeBytes: Buffer.byteLength('print("hello")', 'utf8'),
    });
    expect(response.body.content).toBeUndefined();
  });

  it('returns a structured validation error for an invalid body', async () => {
    const response = await request(app)
      .post('/reviews')
      .send({ content: '', sourceType: 'SNIPPET', language: 'RUST' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.arrayContaining([
        expect.objectContaining({ path: 'content' }),
        expect.objectContaining({ path: 'language' }),
      ]),
    });
    expect(response.body.error.requestId).toBeDefined();
  });

  it('validates submissions on the API-prefixed route too', async () => {
    const response = await request(app)
      .post('/api/reviews')
      .send(validSubmission({ sourceType: 'INVALID' }));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns a validation error for malformed JSON', async () => {
    const response = await request(app)
      .post('/reviews')
      .set('Content-Type', 'application/json')
      .send('{"content":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unexpected fields before any processing', async () => {
    const response = await request(app)
      .post('/reviews')
      .send(validSubmission({ source: 'secret' }));

    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unrecognized_keys',
          path: 'source',
        }),
      ]),
    );
  });
});
