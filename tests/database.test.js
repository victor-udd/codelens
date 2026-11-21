import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDatabase,
  connectDatabase,
  disconnectDatabase,
  prisma,
} from '../src/db/prisma.js';

function reviewData(id = randomUUID()) {
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
    await prisma.finding.deleteMany();
    await prisma.reviewResult.deleteMany();
    await prisma.review.deleteMany();
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
});
