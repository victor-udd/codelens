import { scanSource } from '../static-analysis/lexer.js';
import {
  findCredentialLiterals,
  isSuspiciousValue,
  KNOWN_SECRET_TOKEN,
} from '../static-analysis/rules/hardcoded-secret.js';

const REDACTION = '[REDACTED]';
const KNOWN_TOKEN_GLOBAL = new RegExp(KNOWN_SECRET_TOKEN.source, 'g');
const BEARER_TOKEN = /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const GENERIC_CREDENTIAL_ASSIGNMENT =
  /(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credentials?|client[_-]?secret)(\s*)([:=]=?)(\s*)(['"`])([^'"`\n]*)\5/gi;

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
    const from = literal.start + 1;
    const to = Math.max(from, literal.end - 1);

    if (to <= from) {
      continue;
    }

    for (let index = from; index < to; index += 1) {
      if (characters[index] !== '\n' && characters[index] !== '\r') {
        characters[index] = '';
      }
    }

    characters[from] = REDACTION;
    redactions += 1;
  }

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
