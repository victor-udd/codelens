import { randomUUID } from 'node:crypto';

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.requestId =
    incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
