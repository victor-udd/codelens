import express from 'express';
import { config } from './config/index.js';
import { healthRouter } from './routes/health.js';
import { reviewsRouter } from './routes/reviews.js';
import { requestId } from './middleware/request-id.js';
import { requestLogger } from './middleware/request-logger.js';
import { errorHandler, notFound } from './middleware/error.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use(requestId);
  app.use(requestLogger);
  app.use(express.json({ limit: config.REQUEST_BODY_LIMIT_BYTES }));

  app.use('/health', healthRouter);
  app.use('/reviews', reviewsRouter);
  app.use('/api/reviews', reviewsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
