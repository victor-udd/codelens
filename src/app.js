import express from 'express';
import { config } from './config/index.js';
import { createReviewsApiController } from './controllers/reviews-api.js';
import { errorHandler, notFound } from './middleware/error.js';
import { requestId } from './middleware/request-id.js';
import { requestLogger } from './middleware/request-logger.js';
import { createReviewsApiRouter } from './routes/api-reviews.js';
import { healthRouter } from './routes/health.js';
import { reviewsRouter } from './routes/reviews.js';
import { createReviewProcessingService } from './services/review-processing.js';

export function createApp(dependencies = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false);

  const reviewService =
    dependencies.reviewService ??
    createReviewProcessingService({
      repository: dependencies.repository,
      aiAdapter: dependencies.aiAdapter,
    });
  const reviewsApiController =
    dependencies.reviewsApiController ??
    createReviewsApiController(reviewService);

  app.use(requestId);
  app.use(requestLogger);
  app.use(express.json({ limit: config.REQUEST_BODY_LIMIT_BYTES }));

  app.use('/health', healthRouter);
  app.use('/reviews', reviewsRouter);
  app.use('/api/reviews', createReviewsApiRouter(reviewsApiController));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
