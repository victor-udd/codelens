import { z } from 'zod';
import { formatZodIssues } from '../../errors/validation-error.js';
import {
  AIConfigurationError,
  AIInvalidResponseError,
  AIProviderError,
  AITimeoutError,
  AIUnavailableError,
  providerHttpError,
} from '../errors.js';

const envelopeSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().min(1) }) }))
    .min(1),
});

function isAbortError(error) {
  return (
    error?.name === 'AbortError' ||
    error?.name === 'TimeoutError' ||
    error?.code === 'ABORT_ERR'
  );
}

function abortedError() {
  const error = new Error('request aborted');
  error.name = 'AbortError';
  return error;
}

async function readJsonWithLimit(response, maxBytes, signal) {
  const reader = response.body?.getReader?.();

  if (!reader) {
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new AIInvalidResponseError('AI provider response exceeded size limit');
    }

    return response.json();
  }

  const decoder = new TextDecoder();
  const chunks = [];
  let totalBytes = 0;

  try {
    for (;;) {
      if (signal?.aborted) {
        throw abortedError();
      }

      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new AIInvalidResponseError('AI provider response exceeded size limit');
      }

      chunks.push(value);
    }

    if (signal?.aborted) {
      throw abortedError();
    }

    return JSON.parse(decoder.decode(Buffer.concat(chunks)));
  } finally {
    reader.releaseLock();
  }
}

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
  maxTokens = 4096,
  maxResponseBytes = 1048576,
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
      const timedOut = () => controller.signal.aborted;

      try {
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
              max_tokens: maxTokens,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPayload },
              ],
            }),
            signal: controller.signal,
          });
        } catch (error) {
          if (timedOut() || isAbortError(error)) {
            throw new AITimeoutError(undefined, { cause: error });
          }

          throw new AIUnavailableError(undefined, { cause: error });
        }

        // A fetch implementation may ignore the signal; still enforce the
        // deadline before doing anything with a late response.
        if (timedOut()) {
          throw new AITimeoutError();
        }

        if (!response.ok) {
          throw providerHttpError(response.status, response);
        }

        let payload;

        try {
          payload = await readJsonWithLimit(response, maxResponseBytes, controller.signal);
        } catch (error) {
          if (timedOut() || isAbortError(error)) {
            throw new AITimeoutError(undefined, { cause: error });
          }

          throw new AIInvalidResponseError('AI provider returned non-JSON output', {
            cause: error,
          });
        }

        if (timedOut()) {
          throw new AITimeoutError();
        }

        const parsed = envelopeSchema.safeParse(payload);

        if (!parsed.success) {
          throw new AIInvalidResponseError(
            'AI provider response envelope was malformed',
            { details: formatZodIssues(parsed.error.issues) },
          );
        }

        return parsed.data.choices[0].message.content;
      } catch (error) {
        if (error instanceof AIProviderError) {
          throw error;
        }

        if (timedOut() || isAbortError(error)) {
          throw new AITimeoutError(undefined, { cause: error });
        }

        throw new AIUnavailableError(undefined, { cause: error });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
