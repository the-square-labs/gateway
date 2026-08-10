import { AppError } from '@/middleware/error-handler.js';
import type { AIContextLimits } from './ai.types.js';

const DEFAULT_OUTPUT_RESERVE_MIN = 4_000;
const DEFAULT_OUTPUT_RESERVE_MAX = 32_000;

interface ContextLimitInput {
  contextWindow: number;
  maxInputTokens: number;
  autoCompactTokenLimit: number;
  maxOutputTokens?: number | null;
}

export function normalizeAIContextLimits(input: ContextLimitInput): AIContextLimits {
  const contextWindow = positiveInteger(input.contextWindow);
  const maxInputTokens = positiveInteger(input.maxInputTokens);
  const autoCompactTokenLimit = positiveInteger(input.autoCompactTokenLimit);
  const maxOutputTokens = optionalPositiveInteger(input.maxOutputTokens);

  if (
    contextWindow === null ||
    maxInputTokens === null ||
    autoCompactTokenLimit === null ||
    maxInputTokens > contextWindow ||
    autoCompactTokenLimit > maxInputTokens
  ) {
    throw new AppError(
      503,
      'AI_MODEL_CONTEXT_LIMIT_UNKNOWN',
      'The selected model does not expose a valid context-window configuration'
    );
  }

  const reservedByInputLimit = contextWindow - maxInputTokens;
  const fallbackReserve = clamp(
    Math.floor(contextWindow * 0.1),
    DEFAULT_OUTPUT_RESERVE_MIN,
    DEFAULT_OUTPUT_RESERVE_MAX
  );

  return {
    contextWindow,
    maxInputTokens,
    autoCompactTokenLimit,
    outputReserveTokens: reservedByInputLimit > 0 ? reservedByInputLimit : (maxOutputTokens ?? fallbackReserve),
  };
}

export function directProviderContextLimits(
  maxContextTokens: number,
  maxOutputTokens?: number | null
): AIContextLimits {
  const hardInputLimit = positiveInteger(maxContextTokens);
  if (hardInputLimit === null) {
    throw new AppError(
      503,
      'AI_MODEL_CONTEXT_LIMIT_UNKNOWN',
      'The AI provider context-window setting must be a positive integer'
    );
  }
  return normalizeAIContextLimits({
    contextWindow: hardInputLimit,
    maxInputTokens: hardInputLimit,
    autoCompactTokenLimit: Math.max(1, Math.floor(hardInputLimit * 0.9)),
    maxOutputTokens,
  });
}

export function availableConversationTokenBudget(
  limits: AIContextLimits,
  systemTokens: number,
  toolSchemaTokens: number
): number {
  return Math.max(
    0,
    limits.autoCompactTokenLimit -
      Math.max(0, Math.trunc(systemTokens)) -
      Math.max(0, Math.trunc(toolSchemaTokens)) -
      limits.outputReserveTokens
  );
}

export function toolOutputInlineLimits(
  limits: AIContextLimits,
  systemTokens: number,
  toolSchemaTokens: number
): { availableBudget: number; perToolInlineLimit: number; roundInlineLimit: number } {
  const availableBudget = availableConversationTokenBudget(limits, systemTokens, toolSchemaTokens);
  return {
    availableBudget,
    perToolInlineLimit: Math.min(availableBudget, clamp(Math.floor(availableBudget * 0.08), 8_000, 30_000)),
    roundInlineLimit: Math.min(availableBudget, clamp(Math.floor(availableBudget * 0.2), 16_000, 60_000)),
  };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

function optionalPositiveInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return positiveInteger(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
