import { parseReviewSubmission } from '../validation/review.js';

// Validation and normalization belong here; HTTP concerns stay in the
// controller and persistence will be added in a repository in a later phase.
export function normalizeReviewSubmission(input) {
  const { content: _content, ...submission } = parseReviewSubmission(input);

  return {
    ...submission,
    status: 'PENDING',
  };
}
