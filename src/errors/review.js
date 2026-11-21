const SAFE_CODE = /^[A-Z][A-Z0-9_]*$/;

function statusForProcessingCode(code) {
  if (code === 'VALIDATION_ERROR') {
    return 400;
  }

  if (
    code === 'REVIEW_STATE_CONFLICT' ||
    code === 'MAX_ATTEMPTS_EXCEEDED'
  ) {
    return 409;
  }

  if (code.startsWith('AI_')) {
    return 502;
  }

  return 500;
}

export class ReviewNotFoundError extends Error {
  constructor() {
    super('Review not found');
    this.name = 'ReviewNotFoundError';
    this.status = 404;
    this.code = 'REVIEW_NOT_FOUND';
  }
}

// Converts a terminal FAILED review into a safe HTTP error. Only the
// application-owned error code and review ID are carried to the response.
export class ReviewProcessingError extends Error {
  constructor(errorCode, reviewId) {
    super('Review processing failed');
    this.name = 'ReviewProcessingError';
    this.code = SAFE_CODE.test(errorCode ?? '') ? errorCode : 'PROCESSING_FAILED';
    this.status = statusForProcessingCode(this.code);
    this.reviewId = reviewId ?? null;
  }
}
