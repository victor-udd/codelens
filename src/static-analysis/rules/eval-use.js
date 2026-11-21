import { Category, Severity } from '@prisma/client';
import { locationFromOffsets } from '../locations.js';

export const evalUseRule = {
  id: 'eval-use',
  title: 'Use of eval()',
  severity: Severity.CRITICAL,
  category: Category.SECURITY,
  explanation:
    'eval() executes its argument as JavaScript with the privileges of the calling code. Data that reaches it from a request, file, or message can become arbitrary code execution.',
  suggestedFix:
    'Remove eval() and parse data with a safe format such as JSON.parse(), or replace dynamic evaluation with explicit branching.',

  check({ masked, lineStarts }) {
    const locations = [];
    const patterns = [
      /(?<![\w$.])(?:eval|(?:window|globalThis)\s*\.\s*eval)\s*\(/g,
      /\(\s*0\s*,\s*eval\s*\)\s*\(/g, // indirect eval
    ];

    for (const pattern of patterns) {
      for (const match of masked.matchAll(pattern)) {
        locations.push(
          locationFromOffsets(lineStarts, match.index, match[0].length),
        );
      }
    }

    return locations;
  },
};
