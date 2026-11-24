import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';

export class AuthError extends Error {
  constructor(message = 'A valid API key is required') {
    super(message);
    this.name = 'AuthError';
    this.status = 401;
    this.code = 'UNAUTHORIZED';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'This API key lacks the required scope') {
    super(message);
    this.name = 'ForbiddenError';
    this.status = 403;
    this.code = 'FORBIDDEN';
  }
}

function keyHash(key) {
  return createHash('sha256').update(String(key)).digest();
}

function credentialFrom(req) {
  const header = req.get('authorization');

  if (header) {
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return match?.[1] ?? null;
  }

  return req.get('x-api-key') ?? null;
}

export function createAuth({
  apiKeys = config.API_KEYS,
  adminApiKeys = config.ADMIN_API_KEYS,
} = {}) {
  const grants = new Map();

  for (const key of adminApiKeys ?? []) {
    grants.set(keyHash(key).toString('hex'), 'admin');
  }

  for (const key of apiKeys ?? []) {
    const hash = keyHash(key).toString('hex');
    if (!grants.has(hash)) {
      grants.set(hash, 'user');
    }
  }

  return function requireAuth(req, _res, next) {
    const credential = credentialFrom(req);

    if (!credential) {
      return next(new AuthError());
    }

    const presented = keyHash(credential);
    let scope = null;

    for (const [hash, grantedScope] of grants) {
      const expected = Buffer.from(hash, 'hex');
      if (
        expected.length === presented.length &&
        timingSafeEqual(expected, presented)
      ) {
        scope = grantedScope;
        break;
      }
    }

    if (!scope) {
      return next(new AuthError());
    }

    // Only a non-reversible identifier is attached to the request; the
    // credential itself never reaches logs or serializers.
    req.auth = { scope, keyTag: presented.toString('hex').slice(0, 8) };
    return next();
  };
}

export function requireScope(scope) {
  return function checkScope(req, _res, next) {
    if (req.auth?.scope !== scope) {
      return next(new ForbiddenError());
    }

    return next();
  };
}
