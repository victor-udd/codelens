// Typed failures let callers (future pipeline/policy layer) distinguish a bad
// credential from a temporary outage without inspecting provider messages.
export class AIProviderError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'AI_PROVIDER_ERROR';
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class AIConfigurationError extends AIProviderError {
  constructor(message, options = {}) {
    super(message, {
      code: 'AI_CONFIGURATION_ERROR',
      status: 500,
      retryable: false,
      ...options,
    });
  }
}

export class AIAuthenticationError extends AIProviderError {
  constructor(message = 'AI provider rejected the credentials', options = {}) {
    super(message, {
      code: 'AI_AUTHENTICATION_FAILED',
      status: 401,
      retryable: false,
      ...options,
    });
  }
}

export class AIRateLimitError extends AIProviderError {
  constructor(message = 'AI provider rate limit reached', options = {}) {
    super(message, {
      code: 'AI_RATE_LIMITED',
      status: 429,
      retryable: true,
      ...options,
    });
  }
}

export class AITimeoutError extends AIProviderError {
  constructor(message = 'AI provider request timed out', options = {}) {
    super(message, {
      code: 'AI_TIMEOUT',
      status: 504,
      retryable: true,
      ...options,
    });
  }
}

export class AIUnavailableError extends AIProviderError {
  constructor(message = 'AI provider unavailable', options = {}) {
    super(message, {
      code: 'AI_UNAVAILABLE',
      status: 503,
      retryable: true,
      ...options,
    });
  }
}

export class AIInvalidResponseError extends AIProviderError {
  constructor(message = 'AI provider returned invalid output', options = {}) {
    super(message, {
      code: 'AI_INVALID_RESPONSE',
      status: 502,
      retryable: false,
      ...options,
    });
  }
}

export function providerHttpError(status, cause) {
  if (status === 401 || status === 403) {
    return new AIAuthenticationError(undefined, { cause });
  }

  if (status === 429) {
    return new AIRateLimitError(undefined, { cause });
  }

  if (status === 408 || status === 504) {
    return new AITimeoutError(undefined, { cause });
  }

  if (status >= 500) {
    return new AIUnavailableError(undefined, { cause });
  }

  return new AIUnavailableError(`AI provider rejected the request (${status})`, {
    cause,
    retryable: false,
  });
}
