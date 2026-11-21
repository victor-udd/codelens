import { ReviewStateError } from '../../src/repositories/reviews.js';

function sameInstant(left, right) {
  if (!left || !right) {
    return false;
  }

  return new Date(left).getTime() === new Date(right).getTime();
}

function isBefore(value, cutoff) {
  return Boolean(value) && new Date(value) < new Date(cutoff);
}

// In-memory stand-in for the Prisma repository. It mirrors claim/guard
// semantics closely enough to exercise retry and concurrency decisions.
export class FakeReviewRepository {
  constructor({ failOn = [], now = () => new Date() } = {}) {
    this.failOn = new Set(failOn);
    this.now = now;
    this.reviews = new Map();
    this.results = new Map();
    this.resultRows = new Map();
    this.findingRows = new Map();
    this.calls = [];
  }

  maybeFail(method) {
    if (this.failOn.has(method)) {
      throw new Error(`forced ${method} failure`);
    }
  }

  async createReview(data) {
    this.calls.push({ method: 'createReview', data, statusAfter: 'PENDING' });
    this.maybeFail('createReview');

    const timestamp = this.now();
    const review = {
      ...data,
      status: 'PENDING',
      processingStartedAt: null,
      errorCode: null,
      completedAt: null,
      provider: null,
      model: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.reviews.set(data.id, review);
    return { ...review };
  }

  async markProcessing(id, data) {
    this.calls.push({ method: 'markProcessing', id, data, statusAfter: 'PROCESSING' });
    this.maybeFail('markProcessing');

    const review = this.reviews.get(id);

    // No await before this check/update, so concurrent calls observe one winner.
    if (
      !review ||
      review.status !== 'PENDING' ||
      (Number.isInteger(data.maxAttempts) &&
        review.attemptCount >= data.maxAttempts)
    ) {
      throw new ReviewStateError();
    }

    Object.assign(review, {
      status: 'PROCESSING',
      attemptCount: (review.attemptCount ?? 0) + 1,
      updatedAt: this.now(),
      ...data,
    });
    return { ...review };
  }

  async completeReview(id, data) {
    this.calls.push({ method: 'completeReview', id, data, statusAfter: 'COMPLETED' });
    this.maybeFail('completeReview');

    const review = this.reviews.get(id);

    if (
      !review ||
      review.status !== 'PROCESSING' ||
      (data.expectedProcessingStartedAt &&
        !sameInstant(review.processingStartedAt, data.expectedProcessingStartedAt))
    ) {
      throw new ReviewStateError();
    }

    Object.assign(review, {
      status: 'COMPLETED',
      completedAt: data.completedAt,
      errorCode: null,
      updatedAt: this.now(),
    });

    this.findingRows.set(
      id,
      data.findings.map((finding, index) => ({
        id: `finding-${id}-${index}`,
        reviewId: id,
        createdAt: this.now(),
        ...finding,
      })),
    );

    const result = {
      id: `result-${id}`,
      reviewId: id,
      summary: data.summary,
      latencyMs: data.latencyMs,
      tokenUsage: data.tokenUsage,
      createdAt: this.now(),
    };
    this.resultRows.set(id, result);
    this.results.set(id, { ...data, ...result });

    return { review: { ...review }, result };
  }

  async failReview(id, data) {
    this.calls.push({ method: 'failReview', id, data, statusAfter: 'FAILED' });
    this.maybeFail('failReview');

    const review = this.reviews.get(id);
    const eligible =
      review &&
      ['PENDING', 'PROCESSING'].includes(review.status) &&
      (!data.expectedProcessingStartedAt ||
        sameInstant(review.processingStartedAt, data.expectedProcessingStartedAt));

    if (!eligible) {
      return { count: 0, review: review ? { ...review } : null };
    }

    Object.assign(review, {
      status: 'FAILED',
      errorCode: data.errorCode,
      completedAt: data.completedAt,
      updatedAt: this.now(),
    });
    return { count: 1, review: { ...review } };
  }

  withArtifacts(review) {
    return {
      ...review,
      result: this.resultRows.get(review.id) ?? null,
      findings: this.findingRows.get(review.id) ?? [],
    };
  }

  async findReviewById(id) {
    const review = this.reviews.get(id);
    return review ? this.withArtifacts(review) : null;
  }

  isStale(review, { pendingBefore, processingBefore }) {
    if (review.status === 'PENDING') {
      return isBefore(review.createdAt, pendingBefore);
    }

    if (review.status === 'PROCESSING') {
      return isBefore(review.processingStartedAt, processingBefore);
    }

    return false;
  }

  async findStaleReviews(bounds) {
    return [...this.reviews.values()]
      .filter((review) => this.isStale(review, bounds))
      .slice(0, bounds.limit)
      .map((review) => this.withArtifacts(review));
  }

  async claimStaleReview(id, bounds) {
    this.calls.push({ method: 'claimStaleReview', id, data: bounds });
    this.maybeFail('claimStaleReview');

    const review = this.reviews.get(id);

    // No await before this check/update, so only one concurrent claim wins.
    if (
      !review ||
      !this.isStale(review, bounds) ||
      (Number.isInteger(bounds.maxAttempts) &&
        review.attemptCount >= bounds.maxAttempts)
    ) {
      return null;
    }

    Object.assign(review, {
      status: 'PROCESSING',
      attemptCount: (review.attemptCount ?? 0) + 1,
      processingStartedAt: bounds.processingStartedAt,
      errorCode: null,
      completedAt: null,
      provider: bounds.provider ?? review.provider,
      model: bounds.model ?? review.model,
      updatedAt: this.now(),
    });

    return this.withArtifacts(review);
  }

  async listReviews({ page, limit }) {
    const reviews = [...this.reviews.values()]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((review) => this.withArtifacts(review));
    const skip = (page - 1) * limit;

    return {
      items: reviews.slice(skip, skip + limit),
      page,
      limit,
      total: reviews.length,
      totalPages: Math.ceil(reviews.length / limit),
    };
  }

  get(id) {
    const review = this.reviews.get(id);
    return review ? { ...review } : undefined;
  }

  setReviewState(id, patch) {
    const review = this.reviews.get(id);

    if (!review) {
      throw new Error(`unknown review: ${id}`);
    }

    Object.assign(review, patch);
    return { ...review };
  }
}
