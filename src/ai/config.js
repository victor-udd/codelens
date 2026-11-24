import { config as appConfig } from '../config/index.js';
import { AIConfigurationError } from './errors.js';

function firstNonEmpty(...values) {
  return values.find(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
}

// Canonical variables are AI_*; OPENAI_* names are accepted as aliases for
// deployments that already provision provider-specific secrets.
export function resolveAIConfig(env = process.env) {
  return {
    provider: firstNonEmpty(env.AI_PROVIDER, appConfig.AI_PROVIDER),
    apiKey: firstNonEmpty(env.AI_API_KEY, env.OPENAI_API_KEY, appConfig.AI_API_KEY),
    model: firstNonEmpty(env.AI_MODEL, env.OPENAI_MODEL, appConfig.AI_MODEL),
    baseUrl: firstNonEmpty(env.AI_BASE_URL, env.OPENAI_BASE_URL, appConfig.AI_BASE_URL),
    timeoutMs: appConfig.PROVIDER_TIMEOUT_MS,
    maxAttempts: appConfig.MAX_PROVIDER_ATTEMPTS,
    maxTokens: appConfig.AI_MAX_OUTPUT_TOKENS,
    maxResponseBytes: appConfig.AI_RESPONSE_MAX_BYTES,
  };
}

export function requireApiKey(resolved) {
  if (!resolved.apiKey) {
    throw new AIConfigurationError(
      'AI provider credential is missing; set AI_API_KEY',
    );
  }

  return resolved.apiKey;
}
