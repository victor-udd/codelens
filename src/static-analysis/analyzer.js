import { SupportedLanguage } from '@prisma/client';
import { createFinding } from './finding.js';
import { scanSource } from './lexer.js';
import { RULES } from './rules/index.js';

const ANALYZED_LANGUAGES = new Set([
  SupportedLanguage.JAVASCRIPT,
  SupportedLanguage.TYPESCRIPT,
]);

// Python and Go submissions are accepted by the API but intentionally return
// no findings: no rules are implemented for them yet.
export function analyzeSource(source, language) {
  if (typeof source !== 'string' || source.length === 0) {
    return [];
  }

  if (!ANALYZED_LANGUAGES.has(language)) {
    return [];
  }

  const context = scanSource(source);
  const findings = [];

  for (const rule of RULES) {
    for (const match of rule.check(context) ?? []) {
      findings.push(createFinding(rule, match));
    }
  }

  return findings.sort((left, right) => {
    return (
      left.lineStart - right.lineStart ||
      left.metadata.ruleId.localeCompare(right.metadata.ruleId) ||
      left.title.localeCompare(right.title)
    );
  });
}

// Accepts the normalized output of the review validation layer.
export function analyzeSubmission(submission) {
  return analyzeSource(submission?.content, submission?.language);
}

export const analyze = analyzeSource;
