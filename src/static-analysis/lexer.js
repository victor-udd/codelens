// Produces a "code-only" view of a JS/TS source file. Comments and literal
// contents are replaced with spaces (newlines preserved), so every rule can
// use plain offsets while never matching text inside comments or strings.
// Nothing here evaluates or transforms submitted code.

export function createLineIndex(source) {
  const starts = [0];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      starts.push(index + 1);
    }
  }

  return starts;
}

export function lineAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return low + 1;
}

const REGEX_PREFIX_WORDS = new Set([
  'return',
  'throw',
  'case',
  'delete',
  'typeof',
  'void',
  'new',
  'in',
  'of',
  'yield',
  'await',
  'instanceof',
]);

function looksLikeRegexStart(masked, index) {
  let cursor = index - 1;

  while (cursor >= 0 && /\s/.test(masked[cursor])) {
    cursor -= 1;
  }

  if (cursor < 0) {
    return true;
  }

  if ('([{,;:=!?&|+-*%^~<>'.includes(masked[cursor])) {
    return true;
  }

  const wordMatch = /[\w$]+$/.exec(masked.slice(0, cursor + 1).join(''));
  return Boolean(wordMatch && REGEX_PREFIX_WORDS.has(wordMatch[0]));
}

function scanQuoted(source, start, quote) {
  let cursor = start + 1;

  while (cursor < source.length) {
    const character = source[cursor];

    if (character === '\\') {
      cursor += 2;
      continue;
    }

    if (character === quote) {
      return Math.min(cursor + 1, source.length);
    }

    // Unterminated single-line literals must not swallow following code.
    if (character === '\n' || character === '\r') {
      return cursor;
    }

    cursor += 1;
  }

  return source.length;
}

function scanTemplate(source, start) {
  let cursor = start + 1;
  let braceDepth = 0;

  while (cursor < source.length) {
    const character = source[cursor];

    if (character === '\\') {
      cursor += 2;
      continue;
    }

    if (character === '$' && source[cursor + 1] === '{') {
      braceDepth += 1;
      cursor += 2;
      continue;
    }

    if (character === '}' && braceDepth > 0) {
      braceDepth -= 1;
      cursor += 1;
      continue;
    }

    if (character === '`' && braceDepth === 0) {
      return Math.min(cursor + 1, source.length);
    }

    cursor += 1;
  }

  return source.length;
}

function scanRegex(source, start) {
  let cursor = start + 1;
  let inCharacterClass = false;

  while (cursor < source.length) {
    const character = source[cursor];

    if (character === '\\') {
      cursor += 2;
      continue;
    }

    if (character === '[') {
      inCharacterClass = true;
    } else if (character === ']') {
      inCharacterClass = false;
    } else if (character === '/' && !inCharacterClass) {
      cursor += 1;
      while (/[a-z]/i.test(source[cursor] ?? '')) {
        cursor += 1;
      }
      return cursor;
    } else if (character === '\n' || character === '\r') {
      return cursor;
    }

    cursor += 1;
  }

  return source.length;
}

export function scanSource(source) {
  const characters = source.split('');
  const lineStarts = createLineIndex(source);
  const strings = [];

  function blank(start, end) {
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== '\n' && characters[index] !== '\r') {
        characters[index] = ' ';
      }
    }
  }

  function recordLiteral(start, end, quote, isTemplate) {
    const raw = source.slice(start + 1, Math.max(start + 1, end - 1));

    // Interpolated templates are code-plus-data; skip them for value-based
    // rules to avoid guessing what a placeholder expands to.
    if (isTemplate && raw.includes('${')) {
      return;
    }

    strings.push({
      value: raw,
      start,
      end,
      quote,
      isTemplate,
      lineStart: lineAt(lineStarts, start),
      lineEnd: lineAt(lineStarts, Math.max(start, end - 1)),
    });
  }

  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === '/' && next === '/') {
      let end = index + 2;
      while (end < source.length && source[end] !== '\n' && source[end] !== '\r') {
        end += 1;
      }
      blank(index, end);
      index = end;
      continue;
    }

    if (character === '/' && next === '*') {
      let end = index + 2;
      while (end < source.length && !(source[end] === '*' && source[end + 1] === '/')) {
        end += 1;
      }
      end = Math.min(end + 2, source.length);
      blank(index, end);
      index = end;
      continue;
    }

    if (character === '"' || character === "'") {
      const end = scanQuoted(source, index, character);
      recordLiteral(index, end, character, false);
      blank(index + 1, Math.max(index + 1, end - 1));
      index = end;
      continue;
    }

    if (character === '`') {
      const end = scanTemplate(source, index);
      recordLiteral(index, end, '`', true);
      blank(index + 1, Math.max(index + 1, end - 1));
      index = end;
      continue;
    }

    if (character === '/' && looksLikeRegexStart(characters, index)) {
      const end = scanRegex(source, index);
      blank(index + 1, end);
      index = end;
      continue;
    }

    index += 1;
  }

  return {
    source,
    masked: characters.join(''),
    strings,
    lineStarts,
  };
}
