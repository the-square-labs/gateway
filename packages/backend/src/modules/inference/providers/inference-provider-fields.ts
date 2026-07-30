import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import type { InferenceUsage } from '../protocol/inference-protocol.types.js';

type JsonObject = Record<string, unknown>;
const RESPONSES_CLIENT_HINTS = [
  'client_metadata',
  'include',
  'max_tool_calls',
  'prompt_cache_retention',
  'safety_identifier',
  'text',
  'truncation',
] as const;

export function wireExtensions(raw: Record<string, unknown>, allowed: readonly string[]): JsonObject {
  // These select client-facing Responses behavior. Native Responses providers
  // receive the fields through `allowed`; translations safely consume them
  // locally instead of forwarding invalid controls to another wire protocol.
  const local = new Set(['idempotency_key', ...RESPONSES_CLIENT_HINTS]);
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(raw).find((key) => !local.has(key) && !allowedSet.has(key));
  if (unsupported) {
    throw new InferenceProtocolError(
      400,
      'invalid_request_error',
      `Request field ${unsupported} is unsupported by this provider`
    );
  }
  return Object.fromEntries(Object.entries(raw).filter(([key]) => allowedSet.has(key)));
}

export function normalizeOpenAiUsage(usage: JsonObject | null): Partial<InferenceUsage> {
  const inputDetails = object(usage?.input_tokens_details ?? usage?.prompt_tokens_details);
  const outputDetails = object(usage?.output_tokens_details ?? usage?.completion_tokens_details);
  const inputTokens = number(usage?.input_tokens ?? usage?.prompt_tokens) ?? 0;
  const providerOutputTokens = number(usage?.output_tokens ?? usage?.completion_tokens) ?? 0;
  const reasoningTokens = number(outputDetails?.reasoning_tokens) ?? 0;
  const outputTokens = Math.max(0, providerOutputTokens - reasoningTokens);
  return {
    inputTokens,
    cachedInputTokens: number(inputDetails?.cached_tokens) ?? 0,
    cacheWriteTokens: number(inputDetails?.cache_write_tokens) ?? 0,
    outputTokens,
    reasoningTokens,
    totalTokens: number(usage?.total_tokens) ?? inputTokens + outputTokens + reasoningTokens,
    estimated: false,
  };
}

export function normalizeAnthropicUsage(usage: JsonObject | null): Partial<InferenceUsage> {
  if (!usage) return {};
  const uncachedInput = number(usage.input_tokens);
  const cached = number(usage.cache_read_input_tokens);
  const cacheWrite = number(usage.cache_creation_input_tokens);
  const outputTokens = number(usage.output_tokens);
  const hasInput = uncachedInput !== undefined || cached !== undefined || cacheWrite !== undefined;
  const inputTokens = (uncachedInput ?? 0) + (cached ?? 0) + (cacheWrite ?? 0);
  return {
    ...(hasInput
      ? {
          inputTokens,
          cachedInputTokens: cached ?? 0,
          cacheWriteTokens: cacheWrite ?? 0,
        }
      : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(hasInput && outputTokens !== undefined ? { totalTokens: inputTokens + outputTokens } : {}),
    estimated: false,
  };
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
