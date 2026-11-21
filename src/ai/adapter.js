import { FindingSource, SourceType, SupportedLanguage } from '@prisma/client';
import { z } from 'zod';
import { config as appConfig } from '../config/index.js';
import {
  formatZodIssues,
  ValidationError,
} from '../errors/validation-error.js';
import { resolveAIConfig } from './config.js';
import {
  aiFindingsResponseSchema,
  AI_SYSTEM_PROMPT,
  buildUserPayload,
} from './contract.js';
import { AIInvalidResponseError } from './errors.js';
import { createProvider } from './providers/index.js';
import { redactSecrets } from './redaction.js';

const aiReviewRequestSchema = z
  .object({
    content: z.string().min(1),
    language: z.enum(Object.values(SupportedLanguage)),
    sourceType: z.enum(Object.values(SourceType)).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .passthrough();

const defaultSleep = (delayMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

function parseProviderJson(text) {
  if (typeof text === 'object' && text !== null) {
    return text;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AIInvalidResponseError('AI provider returned malformed JSON', {
      cause: error,
    });
  }
}

// The adapter exposes one business-facing operation. Provider details stay
// behind the injected provider interface; callers never see HTTP or credentials.
export function createReviewAIAdapter(options = {}) {
  const provider =
    options.provider ??
    createProvider({
      config: options.config,
      env: options.env ?? process.env,
      fetchImpl: options.fetchImpl,
    });
  const model = provider.model ?? options.model ?? appConfig.AI_MODEL;
  const maxAttempts = options.maxAttempts ?? appConfig.MAX_PROVIDER_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 50;

  return {
    providerName: provider.name,
    model,

    async reviewSubmission(submission) {
      const request = aiReviewRequestSchema.safeParse(submission);

      if (!request.success) {
        throw new ValidationError(
          formatZodIssues(request.error.issues),
          'Invalid AI review request',
        );
      }

      const {
        content,
        language,
        sourceType = SourceType.SNIPPET,
        idempotencyKey,
      } = request.data;
      const { content: safeContent, redactions } = redactSecrets(content);
      const userPayload = buildUserPayload({
        language,
        sourceType,
        source: safeContent,
      });

      let rawResponse;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          rawResponse = await provider.generate({
            systemPrompt: AI_SYSTEM_PROMPT,
            userPayload,
            idempotencyKey,
          });
          break;
        } catch (error) {
          const canRetry = error?.retryable === true;

          if (!canRetry || attempt === maxAttempts) {
            throw error;
          }

          await sleep(retryBaseDelayMs * 2 ** (attempt - 1));
        }
      }

      const parsed = aiFindingsResponseSchema.safeParse(
        parseProviderJson(rawResponse),
      );

      if (!parsed.success) {
        throw new AIInvalidResponseError(
          'AI provider findings failed strict validation',
          { details: formatZodIssues(parsed.error.issues) },
        );
      }

      const findings = parsed.data.findings.map((finding) => ({
        source: FindingSource.AI,
        severity: finding.severity,
        category: finding.category,
        title: finding.title,
        explanation: finding.explanation,
        suggestedFix: finding.suggestedFix,
        filePath: finding.filePath,
        lineStart: finding.lineStart,
        lineEnd: finding.lineEnd,
        metadata: { provider: provider.name, model },
      }));

      return {
        findings,
        provider: provider.name,
        model,
        redactions,
      };
    },
  };
}

export const createAIAdapter = createReviewAIAdapter;

// Re-exported for callers that want to build an adapter from env explicitly.
export { resolveAIConfig };
