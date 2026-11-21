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
  const code = safeCode(err, status);

  if (status >= 500) {
    logger.error({ requestTag: requestTag(req), err }, 'request failed');
  } else {
    logger.warn({ requestTag: requestTag(req), code }, 'request rejected');
  }

  res.status(status).json({
    error: {
      code,
      message: status >= 500 ? 'Internal server error' : err.message,
      requestId: req.requestId,
    },
  });
}
