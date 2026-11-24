import { Router } from 'express';
import { requireScope } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import {
  reviewIdParamSchema,
  reviewListQuerySchema,
  reviewSubmissionSchema,
} from '../validation/review.js';

export function createReviewsApiRouter(controller, options = {}) {
  const router = Router();
  const requireAdmin = options.requireAdmin ?? requireScope('admin');

  router.post('/', validateBody(reviewSubmissionSchema), controller.create);
  router.get('/', validateQuery(reviewListQuerySchema), requireAdmin, controller.list);
  router.get('/:id', validateParams(reviewIdParamSchema), controller.get);

  return router;
}
