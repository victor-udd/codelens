import { requireApiKey, resolveAIConfig } from '../config.js';
import { AIConfigurationError } from '../errors.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';

const FACTORIES = new Map([
  ['openai-compatible', createOpenAICompatibleProvider],
  ['openai', createOpenAICompatibleProvider],
]);

export function createProvider(options = {}) {
  const resolved = options.config ?? resolveAIConfig(options.env);
  const name = resolved.provider?.toLowerCase();
  const factory = FACTORIES.get(name);

  if (!factory) {
    throw new AIConfigurationError(`Unsupported AI provider: ${name ?? 'unknown'}`);
  }

  requireApiKey(resolved);

  return factory({
    apiKey: resolved.apiKey,
    model: resolved.model,
    baseUrl: resolved.baseUrl,
    timeoutMs: resolved.timeoutMs,
    maxTokens: resolved.maxTokens,
    maxResponseBytes: resolved.maxResponseBytes,
    fetchImpl: options.fetchImpl,
  });
}

export { createOpenAICompatibleProvider };
