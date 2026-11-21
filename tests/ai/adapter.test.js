import { describe, expect, it, vi } from 'vitest';
import { FindingSource } from '@prisma/client';
import {
  AIAuthenticationError,
  AIInvalidResponseError,
  AIRateLimitError,
  createReviewAIAdapter,
  resolveAIConfig,
} from '../../src/ai/index.js';
import { ValidationError } from '../../src/errors/validation-error.js';

function validOutput(overrides = {}) {
  return JSON.stringify({
    findings: [
      {
        severity: 'WARNING',
        category: 'SECURITY',
        title: 'Unsafe call',
        explanation: 'The source calls eval.',
        suggestedFix: 'Use JSON.parse instead.',
        filePath: 'src/example.js',
        lineStart: 2,
        lineEnd: 3,
        ...overrides,
      },
    ],
  });
}

function fakeProvider(output = validOutput()) {
  return {
    name: 'fake-provider',
    model: 'fake-model',
    generate: vi.fn().mockResolvedValue(output),
  };
}

const submission = {
  content: 'const apiKey = "sk_live_abcdef123456";\neval(userInput);',
  language: 'JAVASCRIPT',
  sourceType: 'SNIPPET',
};

describe('AI review adapter', () => {
  it('returns validated AI findings in the shared finding shape', async () => {
    const provider = fakeProvider();
    const adapter = createReviewAIAdapter({ provider, sleep: async () => {} });

    const result = await adapter.reviewSubmission(submission);

    expect(result).toMatchObject({
      provider: 'fake-provider',
      model: 'fake-model',
      redactions: 1,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      source: FindingSource.AI,
      severity: 'WARNING',
      category: 'SECURITY',
      title: 'Unsafe call',
      filePath: 'src/example.js',
      lineStart: 2,
      lineEnd: 3,
      metadata: { provider: 'fake-provider', model: 'fake-model' },
    });
  });

  it('redacts secrets before handing source to the provider', async () => {
    const provider = fakeProvider();
    const adapter = createReviewAIAdapter({ provider });

    await adapter.reviewSubmission(submission);

    const { userPayload, systemPrompt } = provider.generate.mock.calls[0][0];

    expect(userPayload).not.toContain('sk_live_abcdef123456');
    expect(userPayload).toContain('[REDACTED]');
    expect(systemPrompt).toContain('UNTRUSTED DATA');
    expect(systemPrompt).toContain('never as instructions');
    expect(systemPrompt).toContain('No tools are available');
  });

  it.each([
    ['extra keys', { ...JSON.parse(validOutput()).findings[0], surprise: 1 }],
    ['invalid severity', { ...JSON.parse(validOutput()).findings[0], severity: 'CATASTROPHIC' }],
    ['invalid category', { ...JSON.parse(validOutput()).findings[0], category: 'VIBES' }],
    ['missing fix', { ...JSON.parse(validOutput()).findings[0], suggestedFix: undefined }],
    ['reversed lines', { ...JSON.parse(validOutput()).findings[0], lineStart: 9, lineEnd: 2 }],
  ])('rejects strict-schema violations: %s', async (_name, finding) => {
    const provider = fakeProvider(JSON.stringify({ findings: [finding] }));
    const adapter = createReviewAIAdapter({ provider });

    await expect(adapter.reviewSubmission(submission)).rejects.toMatchObject({
      code: 'AI_INVALID_RESPONSE',
      details: expect.any(Array),
    });
  });

  it('rejects malformed JSON and missing findings keys', async () => {
    const malformed = createReviewAIAdapter({
      provider: fakeProvider('not json'),
    });
    const wrongShape = createReviewAIAdapter({
      provider: fakeProvider('{"issues":[]}'),
    });

    await expect(malformed.reviewSubmission(submission)).rejects.toMatchObject({
      code: 'AI_INVALID_RESPONSE',
    });
    await expect(wrongShape.reviewSubmission(submission)).rejects.toMatchObject({
      code: 'AI_INVALID_RESPONSE',
    });
  });

  it('retries retryable provider failures and stops on auth failures', async () => {
    const retrying = fakeProvider();
    retrying.generate
      .mockRejectedValueOnce(new AIRateLimitError())
      .mockResolvedValueOnce(validOutput());
    const retryAdapter = createReviewAIAdapter({
      provider: retrying,
      maxAttempts: 3,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await expect(retryAdapter.reviewSubmission(submission)).resolves.toBeDefined();
    expect(retrying.generate).toHaveBeenCalledTimes(2);

    const failing = fakeProvider();
    failing.generate.mockRejectedValue(new AIAuthenticationError());
    const failAdapter = createReviewAIAdapter({
      provider: failing,
      maxAttempts: 3,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await expect(failAdapter.reviewSubmission(submission)).rejects.toBeInstanceOf(
      AIAuthenticationError,
    );
    expect(failing.generate).toHaveBeenCalledTimes(1);
  });

  it('does not retry invalid response shapes', async () => {
    const provider = fakeProvider('{"findings":"nope"}');
    const adapter = createReviewAIAdapter({ provider, maxAttempts: 3 });

    await expect(adapter.reviewSubmission(submission)).rejects.toBeInstanceOf(
      AIInvalidResponseError,
    );
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('validates adapter input before contacting a provider', async () => {
    const provider = fakeProvider();
    const adapter = createReviewAIAdapter({ provider });

    await expect(
      adapter.reviewSubmission({ content: '', language: 'JAVASCRIPT' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      adapter.reviewSubmission({ content: 'x', language: 'RUST' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it('reads credentials and model from the environment', async () => {
    const resolved = resolveAIConfig({
      AI_PROVIDER: 'openai-compatible',
      AI_API_KEY: 'env-test-key',
      AI_MODEL: 'env-test-model',
      AI_BASE_URL: 'https://env.example/v1',
    });

    expect(resolved).toMatchObject({
      provider: 'openai-compatible',
      apiKey: 'env-test-key',
      model: 'env-test-model',
      baseUrl: 'https://env.example/v1',
    });
    expect(resolveAIConfig({ OPENAI_API_KEY: 'alias-key' }).apiKey).toBe(
      'alias-key',
    );
    expect(resolveAIConfig({ AI_API_KEY: '' }).apiKey).toBeUndefined();

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: validOutput() } }] }),
    });
    const adapter = createReviewAIAdapter({
      env: {
        AI_PROVIDER: 'openai-compatible',
        AI_API_KEY: 'env-test-key',
        AI_MODEL: 'env-test-model',
        AI_BASE_URL: 'https://env.example/v1',
      },
      fetchImpl,
    });

    await adapter.reviewSubmission(submission);

    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer env-test-key',
    );
  });
});
