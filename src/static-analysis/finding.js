import { FindingSource } from '@prisma/client';

// Shape matches the Prisma Finding model fields that can be supplied before a
// reviewId exists. Identifiers and timestamps are assigned at persistence.
export function createFinding(rule, match = {}) {
  return {
    source: FindingSource.STATIC,
    severity: rule.severity,
    category: rule.category,
    title: rule.title,
    explanation: rule.explanation,
    suggestedFix: rule.suggestedFix,
    filePath: null,
    lineStart: match.lineStart ?? 1,
    lineEnd: match.lineEnd ?? match.lineStart ?? 1,
    metadata: {
      ruleId: rule.id,
      ...(match.metadata ?? {}),
    },
  };
}
