import { scanSource } from '../static-analysis/lexer.js';
import {
  assignedKey,
  findCredentialLiterals,
  isSuspiciousValue,
  normalizeKey,
  KNOWN_SECRET_TOKEN,
} from '../static-analysis/rules/hardcoded-secret.js';

const REDACTION = '[REDACTED]';
const KNOWN_TOKEN_GLOBAL = new RegExp(KNOWN_SECRET_TOKEN.source, 'g');
const BEARER_TOKEN = /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const GENERIC_CREDENTIAL_ASSIGNMENT =
  /(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credentials?|client[_-]?secret|authorization|auth)(\s*)([:=]=?)(\s*)(['"`])([^'"`\n]*)\5/gi;

// Short, generic variable names are ambiguous before an external provider:
// a long mixed alphanumeric bare value under one of these keys is redacted
// even though the key alone is not credential-shaped.
const AMBIGUOUS_KEY = /^(?:k|v|x|y|key|val|value|data|payload|config)$/;
const TOKEN_LIKE = /^(?=.{12,}$)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_]+$/;
const BARE_ASSIGNMENT =
  /([A-Za-z_$][\w$.-]*)\s*[:=]\s*([A-Za-z0-9_]{12,})(?![\w$.(])/gd;
const QUOTED_KEY_BARE_ASSIGNMENT =
  /(['"`])([\w$.-]+)\1\s*[:=]\s*([A-Za-z0-9_]{12,})(?![\w$.(])/gd;

function literalBounds(literal) {
  const from = literal.start + 1;
  const to = Math.max(from, literal.end - 1);
  return to > from ? { from, to } : null;
}

function replaceSpan(characters, source, from, to) {
  // Already redacted (or otherwise modified) spans are not counted twice.
  if (characters.slice(from, to).join('') !== source.slice(from, to)) {
    return false;
  }

  for (let index = from; index < to; index += 1) {
    if (characters[index] !== '\n' && characters[index] !== '\r') {
      characters[index] = '';
    }
  }

  characters[from] = REDACTION;
  return true;
}

function isAmbiguousCredential(key, value) {
  return AMBIGUOUS_KEY.test(key) && TOKEN_LIKE.test(value);
}

function redactBareAssignments(source, context, characters) {
  let redactions = 0;
  const patterns = [
    [BARE_ASSIGNMENT, 1, 2],
    [QUOTED_KEY_BARE_ASSIGNMENT, 2, 3],
  ];

  for (const [pattern, keyIndex, valueIndex] of patterns) {
    for (const match of source.matchAll(pattern)) {
      const key = normalizeKey(match[keyIndex]);
      const value = match[valueIndex];

      if (!isSuspiciousValue(value, key) && !isAmbiguousCredential(key, value)) {
        continue;
      }

      const [from, to] = match.indices[valueIndex];

      // Bare code is preserved in the lexer's masked view; text inside
      // comments or quoted strings is blanked and must not be rewritten.
      if (context.masked.slice(from, to) !== source.slice(from, to)) {
        continue;
      }

      if (replaceSpan(characters, source, from, to)) {
        redactions += 1;
      }
    }
  }

  return redactions;
}

// Uses the same credential heuristics as the static rule, plus known token
// prefixes anywhere in the file (including comments). Line breaks are kept so
// any line numbers discussed with the model remain meaningful.
export function redactSecrets(source) {
  if (typeof source !== 'string' || source.length === 0) {
    return { content: typeof source === 'string' ? source : '', redactions: 0 };
  }

  const context = scanSource(source);
  const characters = source.split('');
  let redactions = 0;

  for (const { literal } of findCredentialLiterals(context)) {
    const bounds = literalBounds(literal);

    if (bounds && replaceSpan(characters, source, bounds.from, bounds.to)) {
      redactions += 1;
    }
  }

  // Fail closed for short/generic keys holding a token-like literal: the
  // static rule stays narrowly scoped, but source sent to a provider does not.
  for (const literal of context.strings) {
    const bounds = literalBounds(literal);

    if (!bounds) {
      continue;
    }

    const key = normalizeKey(
      assignedKey(context.source, literal.start, context.masked),
    );
    const value = source.slice(bounds.from, bounds.to);

    if (!isAmbiguousCredential(key, value)) {
      continue;
    }

    if (replaceSpan(characters, source, bounds.from, bounds.to)) {
      redactions += 1;
    }
  }

  redactions += redactBareAssignments(source, context, characters);

  let content = characters.join('');

  content = content.replace(KNOWN_TOKEN_GLOBAL, () => {
    redactions += 1;
    return REDACTION;
  });

  content = content.replace(BEARER_TOKEN, () => {
    redactions += 1;
    return `Bearer ${REDACTION}`;
  });

  // Fallback for languages without a JS lexer (e.g. Python/Go) and for
  // credential assignments the lexer did not recognise.
  content = content.replace(
    GENERIC_CREDENTIAL_ASSIGNMENT,
    (match, key, before, separator, spacing, quote, value) => {
      if (value === REDACTION || !isSuspiciousValue(value, key)) {
        return match;
      }

      redactions += 1;
      return `${key}${before}${separator}${spacing}${quote}${REDACTION}${quote}`;
    },
  );

  return { content, redactions };
}
