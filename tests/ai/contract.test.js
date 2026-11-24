import { describe, expect, it } from 'vitest';
import { aiFindingsResponseSchema } from '../../src/ai/contract.js';

function finding(overrides = {}) {
  return {
    severity: 'WARNING',
    category: 'SECURITY',
    title: 'Bounded title',
    explanation: 'A short explanation.',
    suggestedFix: 'A short fix.',
    filePath: 'src/example.js',
    lineStart: 2,
    lineEnd: 3,
    ...overrides,
  };
}

function parse(overrides) {
  return aiFindingsResponseSchema.safeParse({ findings: [finding(overrides)] });
}

describe('AI findings response contract', () => {
  it('accepts a normally sized finding', () => {
    expect(parse().success).toBe(true);
  });

  it.each(['explanation', 'suggestedFix', 'filePath'])(
    'rejects an oversized %s string',
    (field) => {
      const result = parse({ [field]: 'x'.repeat(100_000) });

      expect(result.success).toBe(false);
    },
  );

  it('rejects a large number of findings before persisting them', () => {
    const result = aiFindingsResponseSchema.safeParse({
      findings: Array.from({ length: 101 }, () => finding()),
    });

    expect(result.success).toBe(false);
  });
});
