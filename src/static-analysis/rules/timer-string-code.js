import { Category, Severity } from '@prisma/client';
import { locationFromOffsets } from '../locations.js';

export const timerStringCodeRule = {
  id: 'timer-string-code',
  title: 'String literal scheduled as code',
  severity: Severity.ERROR,
  category: Category.SECURITY,
  explanation:
    'Passing a string to setTimeout() or setInterval() makes the browser or runtime compile and execute it, which is equivalent to eval().',
  suggestedFix: 'Pass a function callback instead of a string.',

  check({ masked, lineStarts }) {
    const pattern =
      /(?<![\w$.])(?:window\s*\.\s*)?(?:setTimeout|setInterval)\s*\(\s*(['"`])/g;
    const locations = [];

    for (const match of masked.matchAll(pattern)) {
      locations.push(
        locationFromOffsets(lineStarts, match.index, match[0].length),
      );
    }

    return locations;
  },
};
