import { Category, Severity } from '@prisma/client';
import { locationFromOffsets } from '../locations.js';

export const emptyCatchRule = {
  id: 'empty-catch',
  title: 'Empty catch block',
  severity: Severity.WARNING,
  category: Category.BUG,
  explanation:
    'An empty catch block silently discards errors. Failures become invisible and are difficult to diagnose in production.',
  suggestedFix:
    'Handle the error, rethrow it, or log it with context before continuing.',

  check({ masked, lineStarts }) {
    const pattern = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
    const locations = [];

    for (const match of masked.matchAll(pattern)) {
      locations.push(
        locationFromOffsets(lineStarts, match.index, match[0].length),
      );
    }

    return locations;
  },
};
