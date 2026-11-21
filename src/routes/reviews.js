import { Router } from 'express';
import { createReview } from '../controllers/reviews.js';
import { validateBody } from '../middleware/validate.js';
import { reviewSubmissionSchema } from '../validation/review.js';

export const reviewsRouter = Router();

reviewsRouter.post('/', validateBody(reviewSubmissionSchema), createReview);
