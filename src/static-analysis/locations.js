import { lineAt } from './lexer.js';

export function locationFromOffsets(lineStarts, start, length = 1) {
  const end = Math.max(start, start + length - 1);

  return {
    lineStart: lineAt(lineStarts, start),
    lineEnd: lineAt(lineStarts, end),
  };
}
