import { Category, Severity } from '@prisma/client';

const SENSITIVE_KEY =
  /(?:password|passwd|pwd|secret|token|api[-_]?key|private[-_]?key|access[-_]?key|credentials?|client[-_]?secret|session[-_]?key|encryption[-_]?key|auth(?:orization)?)/i;

export const KNOWN_SECRET_PREFIX =
  /(?:sk_live_|rk_live_|gh[pousr]_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/;

// Full token shapes used when redacting text sent to a third party.
export const KNOWN_SECRET_TOKEN =
  /(?:sk_live_[A-Za-z0-9]{10,}|rk_live_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/;

const PLACEHOLDER =
  /^(?:test|testing|example|sample|demo|placeholder|dummy|fake|redacted|change[-_]?me|your[-_]?[\w-]+|xxx+|\*+|<[^>]+>|\$\{[^}]+\}|null|undefined|true|false)$/i;

function looksLikePlaceholder(value) {
  if (PLACEHOLDER.test(value)) {
    return true;
  }

  if (/(?:example\.com|placeholder|changeme|your[-_ ](?:key|token|secret))/i.test(value)) {
    return true;
  }

  return /^(.)\1+$/.test(value);
}

export function assignedKey(masked, start) {
  const before = masked.slice(Math.max(0, start - 200), start).replace(/\s+$/, '');
  const assignment =
    /([\w$.]+)\s*(?::\s*[\w<>[\]|]+\s*)?=\s*$/.exec(before);
  const property = /([\w$.]+)\s*:\s*$/.exec(before);

  return assignment?.[1] ?? property?.[1] ?? '';
}

export function isSuspiciousValue(value, key) {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return false;
  }

  if (KNOWN_SECRET_PREFIX.test(trimmed)) {
    return true;
  }

  if (looksLikePlaceholder(trimmed) || trimmed.length < 6) {
    return false;
  }

  if (key && trimmed.toLowerCase() === key.split('.').pop().toLowerCase()) {
    return false;
  }

  return SENSITIVE_KEY.test(key);
}

// Shared by the static rule and the AI redactor so both agree on what counts
// as a credential.
export function findCredentialLiterals({ masked, strings }) {
  const seen = new Set();
  const credentials = [];

  for (const literal of strings) {
    if (seen.has(literal.start)) {
      continue;
    }

    const key = assignedKey(masked, literal.start);

    if (!isSuspiciousValue(literal.value, key)) {
      continue;
    }

    seen.add(literal.start);
    credentials.push({
      literal,
      key,
      detector: KNOWN_SECRET_PREFIX.test(literal.value.trim())
        ? 'known-prefix'
        : 'field-name',
    });
  }

  return credentials;
}

export const hardcodedSecretRule = {
  id: 'hardcoded-secret',
  title: 'Potential hardcoded credential',
  severity: Severity.CRITICAL,
  category: Category.SECURITY,
  explanation:
    'A literal is assigned to a credential-like field, or matches a known secret token prefix. Committed credentials remain valid in source control history and must be treated as exposed.',
  suggestedFix:
    'Load the value from an environment variable or secret manager, and rotate the exposed credential.',

  check(context) {
    return findCredentialLiterals(context).map(
      ({ literal, key, detector }) => ({
        lineStart: literal.lineStart,
        lineEnd: literal.lineEnd,
        metadata: {
          detector,
          ...(key ? { field: key } : {}),
        },
      }),
    );
  },
};
