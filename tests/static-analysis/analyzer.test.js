import { describe, expect, it } from 'vitest';
import { Category, FindingSource, Severity } from '@prisma/client';
import { analyzeSource, analyzeSubmission } from '../../src/services/static-analysis.js';
import { parseReviewSubmission } from '../../src/validation/review.js';

const dangerousCode = [
  'const apiKey = "sk_live_abcdef123456";',
  'const run = new Function("return process.env");',
  'eval(userInput);',
  'setTimeout("alert(1)", 10);',
  'try { run(); } catch (error) {}',
  'debugger;',
].join('\n');

describe('static analysis engine', () => {
  it('returns findings in the CodeLens finding shape using Prisma enums', () => {
    const findings = analyzeSource(dangerousCode, 'JAVASCRIPT');

    expect(findings.length).toBeGreaterThan(0);

    for (const finding of findings) {
      expect(finding).toMatchObject({
        source: FindingSource.STATIC,
        severity: expect.any(String),
        category: expect.any(String),
        title: expect.any(String),
        explanation: expect.any(String),
        suggestedFix: expect.any(String),
        filePath: null,
        lineStart: expect.any(Number),
        lineEnd: expect.any(Number),
        metadata: { ruleId: expect.any(String) },
      });
      expect(Object.values(Severity)).toContain(finding.severity);
      expect(Object.values(Category)).toContain(finding.category);
    }
  });

  it('analyzes both JavaScript and TypeScript with the same rules', () => {
    const javascript = analyzeSource(dangerousCode, 'JAVASCRIPT');
    const typescript = analyzeSource(dangerousCode, 'TYPESCRIPT');

    expect(typescript).toEqual(javascript);
  });

  it('returns no findings for Python and Go instead of pretending to analyse them', () => {
    expect(analyzeSource(dangerousCode, 'PYTHON')).toEqual([]);
    expect(analyzeSource(dangerousCode, 'GO')).toEqual([]);
  });

  it('handles empty and non-string input safely', () => {
    expect(analyzeSource('', 'JAVASCRIPT')).toEqual([]);
    expect(analyzeSource('   \n ', 'JAVASCRIPT')).toEqual([]);
    expect(analyzeSource(undefined, 'JAVASCRIPT')).toEqual([]);
    expect(analyzeSource(null, 'JAVASCRIPT')).toEqual([]);
  });

  it('reports accurate multiline line numbers and sorts by line', () => {
    const findings = analyzeSource(dangerousCode, 'JAVASCRIPT');
    const lines = findings.map((finding) => finding.lineStart);

    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(lines).toEqual([1, 2, 3, 4, 5, 6]);
    for (const finding of findings) {
      expect(finding.lineEnd).toBe(finding.lineStart);
    }
  });

  it('never includes submitted source in findings', () => {
    const serialized = JSON.stringify(analyzeSource(dangerousCode, 'JAVASCRIPT'));

    expect(serialized).not.toContain('sk_live_abcdef123456');
    expect(serialized).not.toContain('userInput');
    expect(serialized).not.toContain('return process.env');
  });

  it('does not emit duplicate findings for one rule', () => {
    const findings = analyzeSource('const a = new Function("x");', 'JAVASCRIPT');

    expect(findings).toHaveLength(1);
    expect(findings[0].metadata.ruleId).toBe('dynamic-code-execution');
  });

  it('accepts output from the review validation layer', () => {
    const submission = parseReviewSubmission({
      content: 'eval(request.input);',
      sourceType: 'SNIPPET',
      language: 'JAVASCRIPT',
    });

    const findings = analyzeSubmission(submission);

    expect(findings).toHaveLength(1);
    expect(findings[0].metadata.ruleId).toBe('eval-use');
    expect(findings[0].lineStart).toBe(1);
  });

  it('returns no findings for safe code', () => {
    const safe = [
      'const config = JSON.parse(payload);',
      'setTimeout(() => refresh(), 100);',
      'try { refresh(); } catch (error) { logger.warn(error); }',
    ].join('\n');

    expect(analyzeSource(safe, 'TYPESCRIPT')).toEqual([]);
  });
});
