import { describe, expect, it } from 'vitest';
import {
  AIAuthenticationError,
  AIInvalidResponseError,
} from '../../src/ai/index.js';
import { createReviewProcessingService } from '../../src/services/review-processing.js';
import { createFakeAIAdapter } from '../helpers/fake-ai-adapter.js';
import { FakeReviewRepository } from '../helpers/fake-review-repository.js';

const sourceWithIssues = [
  'const apiKey = "abcdef123456";',
  'eval(userInput);',
  'setTimeout("run()", 10);',
].join('\n');

const safeSource = [
  'const config = JSON.parse(payload);',
  'setTimeout(() => refresh(), 100);',
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
};

function submission(content = sourceWithIssues, overrides = {}) {
  return {
    content,
    language: 'JAVASCRIPT',
    sourceType: 'SNIPPET',
    options: { includeStaticChecks: true },
    ...overrides,
  };
}

describe('review processing service', () => {
  it('completes a review with both static and AI findings', async () => {
    const repository = new FakeReviewRepository();
    const aiAdapter = createFakeAIAdapter({
      findings: [aiFinding],
      tokenUsage: { totalTokens: 7 },
    });
    const service = createReviewProcessingService({ repository, aiAdapter });

    const result = await service.processSubmission(submission());

    expect(result.status).toBe('COMPLETED');
    expect(result.findings.filter((finding) => finding.source === 'STATIC')).toHaveLength(3);
    expect(result.findings.filter((finding) => finding.source === 'AI')).toHaveLength(1);
    expect(result.result.summary).toContain('4 finding(s)');
    expect(result.result.summary).toContain('3 static, 1 AI');
    expect(result.result.tokenUsage).toEqual({ totalTokens: 7 });
    expect(aiAdapter.calls[0]).toMatchObject({
      content: sourceWithIssues,
      options: { includeStaticChecks: true },
    });
    expect(repository.results.get(result.reviewId).findings).toHaveLength(4);
  });

  it('completes a review with no findings', async () => {
    const repository = new FakeReviewRepository();
    const aiAdapter = createFakeAIAdapter({ findings: [] });
    const service = createReviewProcessingService({ repository, aiAdapter });

    const result = await service.processSubmission(submission(safeSource));

    expect(result.status).toBe('COMPLETED');
    expect(result.findings).toEqual([]);
    expect(result.result.summary).toContain('0 finding(s)');
    expect(repository.results.get(result.reviewId).findings).toEqual([]);
  });

  it.each([
    ['AI provider failure', new AIAuthenticationError(), 'AI_AUTHENTICATION_FAILED'],
    ['malformed AI output', new AIInvalidResponseError(), 'AI_INVALID_RESPONSE'],
  ])('marks a review FAILED on %s', async (_name, error, expectedCode) => {
    const repository = new FakeReviewRepository();
    const aiAdapter = createFakeAIAdapter({ error });
    const service = createReviewProcessingService({ repository, aiAdapter });

    const result = await service.processSubmission(submission());

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe(expectedCode);
    expect(repository.calls.map((call) => call.method)).toEqual([
      'createReview',
      'markProcessing',
      'failReview',
    ]);
    expect(repository.get(result.reviewId)).toMatchObject({
      status: 'FAILED',
      errorCode: expectedCode,
    });
    expect(repository.get(result.reviewId).completedAt).toBeDefined();
    expect(repository.get(result.reviewId).status).not.toBe('PROCESSING');
    expect(repository.results.has(result.reviewId)).toBe(false);
  });

  it('marks a review FAILED when the adapter returns malformed findings', async () => {
    const repository = new FakeReviewRepository();
    const aiAdapter = createFakeAIAdapter({ findings: { unexpected: true } });
    const service = createReviewProcessingService({ repository, aiAdapter });

    const result = await service.processSubmission(submission());

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('AI_INVALID_RESPONSE');
    expect(repository.get(result.reviewId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'AI_INVALID_RESPONSE',
    });
    expect(repository.results.has(result.reviewId)).toBe(false);
  });

  it('marks a review FAILED when result persistence fails', async () => {
    const repository = new FakeReviewRepository({ failOn: ['completeReview'] });
    const aiAdapter = createFakeAIAdapter({ findings: [aiFinding] });
    const service = createReviewProcessingService({ repository, aiAdapter });

    const result = await service.processSubmission(submission());

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('DATABASE_ERROR');
    expect(repository.get(result.reviewId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'DATABASE_ERROR',
    });
    expect(repository.get(result.reviewId).status).not.toBe('PROCESSING');
    expect(JSON.stringify(result)).not.toContain('forced');
  });

  it('records PENDING -> PROCESSING -> COMPLETED transitions and metadata', async () => {
    const repository = new FakeReviewRepository();
    const aiAdapter = createFakeAIAdapter({ findings: [] });
    const service = createReviewProcessingService({ repository, aiAdapter });

    const result = await service.processSubmission(submission(safeSource));

    expect(repository.calls.map((call) => call.statusAfter)).toEqual([
      'PENDING',
      'PROCESSING',
      'COMPLETED',
    ]);
    expect(repository.calls[1].data).toMatchObject({
      provider: 'fake-provider',
      model: 'fake-model',
    });
    expect(repository.calls[1].data.processingStartedAt).toBeDefined();
    expect(repository.get(result.reviewId).attemptCount).toBe(1);
    expect(result.provider).toBe('fake-provider');
    expect(result.model).toBe('fake-model');
  });

  it('does not persist submitted source or raw failures', async () => {
    const repository = new FakeReviewRepository({ failOn: ['completeReview'] });
    const aiAdapter = createFakeAIAdapter({ findings: [aiFinding] });
    const service = createReviewProcessingService({ repository, aiAdapter });

    const result = await service.processSubmission(submission());
    const persisted = JSON.stringify(repository.calls);

    expect(persisted).not.toContain(sourceWithIssues);
    expect(persisted).not.toContain('eval(userInput)');
    expect(persisted).not.toContain('abcdef123456');
    expect(persisted).not.toContain('forced completeReview failure');
    expect(JSON.stringify(result)).not.toContain('forced completeReview failure');
  });

  it('skips static checks when review options disable them', async () => {
    const repository = new FakeReviewRepository();
    const aiAdapter = createFakeAIAdapter({ findings: [aiFinding] });
    const service = createReviewProcessingService({ repository, aiAdapter });

    const result = await service.processSubmission(
      submission(sourceWithIssues, { options: { includeStaticChecks: false } }),
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].source).toBe('AI');
  });

  it('does not create a review for invalid submissions', async () => {
    const repository = new FakeReviewRepository();
    const aiAdapter = createFakeAIAdapter();
    const service = createReviewProcessingService({ repository, aiAdapter });

    await expect(
      service.processSubmission({ content: '', language: 'JAVASCRIPT' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repository.calls).toEqual([]);
    expect(aiAdapter.calls).toEqual([]);
  });
});
