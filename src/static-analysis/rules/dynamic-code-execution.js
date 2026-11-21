import { Category, Severity } from '@prisma/client';
import { locationFromOffsets } from '../locations.js';

export const dynamicCodeExecutionRule = {
  id: 'dynamic-code-execution',
  title: 'Dynamic code compilation or execution',
  severity: Severity.ERROR,
  category: Category.SECURITY,
  explanation:
    'Constructing functions from strings, or using Node VM APIs, executes runtime-generated code. Untrusted input reaching these APIs can escape the intended logic.',
  suggestedFix:
    'Replace generated code with ordinary functions and data. If isolation is required, use a dedicated sandbox rather than compiling strings.',

  check({ masked, lineStarts }) {
    const patterns = [
      /\bnew\s+Function\s*\(/g,
      /(?<![\w$.])Function\s*\(/g,
      /(?<![\w$.])(?:vm\s*\.\s*)?(?:runInNewContext|runInThisContext|runInContext|compileFunction)\s*\(/g,
    ];
    const coveredRanges = [];
    const locations = [];

    for (const pattern of patterns) {
      for (const match of masked.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;

        // `new Function(...)` also matches the bare `Function(...)` pattern;
        // keep only one finding per source range.
        if (coveredRanges.some(([from, to]) => start < to && end > from)) {
          continue;
        }

        coveredRanges.push([start, end]);
        locations.push(locationFromOffsets(lineStarts, start, match[0].length));
      }
    }

    return locations;
  },
};
