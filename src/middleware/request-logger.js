import { createHash } from 'node:crypto';
import { logger } from '../logger.js';

// Never log a raw request or review ID; use a non-reversible short tag.
export function requestTag(req) {
  return createHash('sha256')
    .update(req.requestId ?? 'unknown')
    .digest('hex')
    .slice(0, 8);
}

export function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info(
      {
        requestTag: requestTag(req),
        method: req.method,
        path: req.route?.path ?? req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      },
      'request completed',
    );
  });

  next();
}
