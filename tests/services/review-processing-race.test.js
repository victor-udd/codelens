import { describe, expect, it } from 'vitest';
import { createReviewProcessingService } from '../../src/services/review-processing.js';
import { createFakeAIAdapter } from '../helpers/fake-ai-adapter.js';
import { FakeReviewRepository } from '../helpers/fake-review-repository.js';

const START = '2026-01-01T00:00:00.000Z';

function submission() {
  return {
    content: 'const recoveredValue = 1;',
    language: 'JAVASCRIPT',
    sourceType: 'SNIPPET',
    options: { includeStaticChecks: false },
  };
}

// Interleaves a second worker's successful claim between worker A's failed
// markProcessing call and its terminal failure write.
class InterleavingRepository extends FakeReviewRepository {
  async failReview(id, data) {
    if (!this.claimedByOtherWorker) {
      this.claimedByOtherWorker = true;

      const at = this.now();
      const claim = await this.claimStaleReview(id, {
        pendingBefore: new Date(at.getTime() + 1),
        processingBefore: new Date(at.getTime() + 1),
        processingStartedAt: new Date(at.getTime() + 1000),
        provider: 'other-provider',
        model: 'other-model',
        maxAttempts: 3,
      });

      expect(claim).toMatchObject({ id, status: 'PROCESSING' });
      this.otherClaimAt = claim.processingStartedAt;
    }

    return super.failReview(id, data);
  }
}

describe('review processing ownership', () => {
  it('does not let a stale PENDING worker overwrite a newer PROCESSING claim', async () => {
    let current = new Date(START);
    const now = () => current;
    const repository = new InterleavingRepository({
      now,
      failOn: ['markProcessing'],
    });
    const service = createReviewProcessingService({
      repository,
      aiAdapter: createFakeAIAdapter(),
      now,
      maxAttempts: 3,
    });

    const outcome = await service.processSubmission(submission());
    const review = repository.get(outcome.reviewId);

    expect(outcome.status).toBe('PROCESSING');
    expect(review).toMatchObject({
      status: 'PROCESSING',
      provider: 'other-provider',
      model: 'other-model',
      attemptCount: 1,
      errorCode: null,
      completedAt: null,
    });
    expect(new Date(review.processingStartedAt).getTime()).toBe(
      new Date(repository.otherClaimAt).getTime(),
    );
    expect(repository.calls.filter((call) => call.method === 'failReview')).toHaveLength(1);
  });
});
