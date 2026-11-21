import { ReviewProcessingError } from '../errors/review.js';
import {
  serializeReview,
  serializeReviewList,
} from '../serializers/review.js';

export function createReviewsApiController(reviewService) {
  return {
    async create(req, res, next) {
      try {
        const outcome = await reviewService.processSubmission(req.validated);

        if (outcome.status === 'FAILED') {
          return next(
            new ReviewProcessingError(outcome.errorCode, outcome.reviewId),
          );
        }

        res.setHeader('Location', `/api/reviews/${outcome.reviewId}`);
        return res.status(201).json(serializeReview(outcome));
      } catch (error) {
        return next(error);
      }
    },

    async get(req, res, next) {
      try {
        const review = await reviewService.getReview(req.validatedParams.id);
        return res.status(200).json(serializeReview(review));
      } catch (error) {
        return next(error);
      }
    },

    async list(req, res, next) {
      try {
        const page = await reviewService.listReviews(req.validatedQuery);
        return res.status(200).json(serializeReviewList(page));
      } catch (error) {
        return next(error);
      }
    },
  };
}
