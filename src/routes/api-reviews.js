import { Router } from 'express';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import {
  reviewIdParamSchema,
  reviewListQuerySchema,
  reviewSubmissionSchema,
} from '../validation/review.js';

export function createReviewsApiRouter(controller) {
  const router = Router();

  router.post('/', validateBody(reviewSubmissionSchema), controller.create);
  router.get('/', validateQuery(reviewListQuerySchema), controller.list);
  router.get('/:id', validateParams(reviewIdParamSchema), controller.get);

  return router;
}
