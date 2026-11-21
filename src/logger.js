import pino from 'pino';
import { config } from './config/index.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'codelens' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'content',
      'source',
      '*.content',
      '*.source',
    ],
    censor: '[REDACTED]',
  },
});
