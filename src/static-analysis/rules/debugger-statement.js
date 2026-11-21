import { Category, Severity } from '@prisma/client';
import { locationFromOffsets } from '../locations.js';

export const debuggerStatementRule = {
  id: 'debugger-statement',
  title: 'Debugger statement',
  severity: Severity.WARNING,
  category: Category.STYLE,
  explanation:
    'A debugger statement pauses execution when developer tools are open. Left in production code it can stall request handling.',
  suggestedFix: 'Remove the debugger statement before shipping.',

  check({ masked, lineStarts }) {
    const pattern = /\bdebugger\s*;/g;
    const locations = [];

    for (const match of masked.matchAll(pattern)) {
      locations.push(
        locationFromOffsets(lineStarts, match.index, match[0].length),
      );
    }

    return locations;
  },
};
