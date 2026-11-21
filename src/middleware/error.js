import { logger } from '../logger.js';
import { requestTag } from './request-logger.js';

function safeCode(err, status) {
  if (typeof err.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(err.code)) {
    return err.code;
  }
  return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR';
}

export function notFound(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found',
      requestId: req.requestId,
    },
  });
}

export function errorHandler(err, req, res, _next) {
  const status = Number.isInteger(err.status) ? err.status : 500;
  const malformedJson = err.type === 'entity.parse.failed';
  const code = malformedJson ? 'VALIDATION_ERROR' : safeCode(err, status);
  const details = Array.isArray(err.details) ? err.details : undefined;
  const expectedFailure = err.name === 'ReviewProcessingError';
  const message =
    status >= 500 && !expectedFailure ? 'Internal server error' : err.message;

  if (status >= 500) {
    logger.error(
      {
        requestTag: requestTag(req),
        ...(expectedFailure
          ? {
              code,
              ...(err.reviewId ? { reviewId: err.reviewId } : {}),
            }
          : { err }),
      },
      'request failed',
    );
  } else {
    logger.warn({ requestTag: requestTag(req), code }, 'request rejected');
  }

  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      ...(err.reviewId ? { reviewId: err.reviewId } : {}),
      requestId: req.requestId,
    },
  });
}
