import { z } from 'zod';
import { formatZodIssues } from '../../errors/validation-error.js';
import {
  AIConfigurationError,
  AIInvalidResponseError,
  AITimeoutError,
  AIUnavailableError,
  providerHttpError,
} from '../errors.js';

const envelopeSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().min(1) }) }))
    .min(1),
});

function endpointFor(baseUrl) {
  let parsed;

  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AIConfigurationError('AI_BASE_URL must be a valid URL');
  }

  return new URL('chat/completions', `${parsed.toString().replace(/\/$/, '')}/`)
    .toString();
}

// Provider-specific HTTP protocol only. Business rules, redaction and finding
// validation live outside this module.
export function createOpenAICompatibleProvider({
  apiKey,
  model,
  baseUrl = 'https://api.openai.com/v1',
  timeoutMs = 15000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new AIConfigurationError(
      'AI provider credential is missing; set AI_API_KEY',
    );
  }

  if (!model || typeof model !== 'string') {
    throw new AIConfigurationError('AI model is missing; set AI_MODEL');
  }

  if (typeof fetchImpl !== 'function') {
    throw new AIConfigurationError('A fetch implementation is required');
  }

  const endpoint = endpointFor(baseUrl);

  return {
    name: 'openai-compatible',
    model,

    async generate({ systemPrompt, userPayload, idempotencyKey }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;

      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(idempotencyKey
              ? { 'Idempotency-Key': idempotencyKey }
              : {}),
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPayload },
            ],
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (
          controller.signal.aborted ||
          error?.name === 'AbortError' ||
          error?.name === 'TimeoutError'
        ) {
          throw new AITimeoutError(undefined, { cause: error });
        }

        throw new AIUnavailableError(undefined, { cause: error });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw providerHttpError(response.status, response);
      }

      let payload;

      try {
        payload = await response.json();
      } catch (error) {
        throw new AIInvalidResponseError('AI provider returned non-JSON output', {
          cause: error,
        });
      }

      const parsed = envelopeSchema.safeParse(payload);

      if (!parsed.success) {
        throw new AIInvalidResponseError(
          'AI provider response envelope was malformed',
          { details: formatZodIssues(parsed.error.issues) },
        );
      }

      return parsed.data.choices[0].message.content;
    },
  };
}
