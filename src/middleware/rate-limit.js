import { config } from '../config/index.js';

export class RateLimitError extends Error {
  constructor(message = 'API rate limit exceeded') {
    super(message);
    this.name = 'RateLimitError';
    this.status = 429;
    this.code = 'RATE_LIMITED';
  }
}

export function createRateLimiter({
  limit = config.RATE_LIMIT_MAX,
  windowMs = config.RATE_LIMIT_WINDOW_MS,
  now = () => Date.now(),
} = {}) {
  const windows = new Map();

  function prune(current) {
    for (const [identity, entry] of windows) {
      if (current - entry.startedAt >= windowMs) {
        windows.delete(identity);
      }
    }
  }

  return function rateLimit(req, res, next) {
    const current = now();
    prune(current);

    // Authenticated requests are limited per key; unrecognized identities
    // should never reach this middleware, but fall back to the socket.
    const identity = req.auth?.keyTag ?? req.ip ?? 'unknown';
    let entry = windows.get(identity);

    if (!entry) {
      entry = { startedAt: current, count: 0 };
      windows.set(identity, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, limit - entry.count);
    const resetSeconds = Math.max(
      0,
      Math.ceil((entry.startedAt + windowMs - current) / 1000),
    );

    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (entry.count > limit) {
      return next(new RateLimitError());
    }

    return next();
  };
}
