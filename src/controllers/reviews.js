import { normalizeReviewSubmission } from '../services/reviews.js';

export function createReview(req, res) {
  const review = normalizeReviewSubmission(req.validated);

  // No submitted source is echoed back or persisted by the validation layer.
  res.status(201).json(review);
}
