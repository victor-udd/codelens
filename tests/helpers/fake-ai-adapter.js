// Test double implementing the provider-independent AI adapter interface.
// No network calls and no credentials are used.
export class FakeAIAdapter {
  constructor({
    findings = [],
    error = null,
    provider = 'fake-provider',
    model = 'fake-model',
    tokenUsage = null,
    redactions = 0,
  } = {}) {
    this.findings = findings;
    this.error = error;
    this.providerName = provider;
    this.model = model;
    this.tokenUsage = tokenUsage;
    this.redactions = redactions;
    this.calls = [];
  }

  async reviewSubmission(submission) {
    this.calls.push(submission);

    if (this.error) {
      throw this.error;
    }

    return {
      findings: this.findings,
      provider: this.providerName,
      model: this.model,
      tokenUsage: this.tokenUsage,
      redactions: this.redactions,
    };
  }
}

export function createFakeAIAdapter(options) {
  return new FakeAIAdapter(options);
}
