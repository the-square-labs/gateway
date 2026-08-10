import { describe, expect, it } from 'vitest';
import {
  availableConversationTokenBudget,
  directProviderContextLimits,
  normalizeAIContextLimits,
  toolOutputInlineLimits,
} from './ai-context-limits.js';

describe('AI context limits', () => {
  it('keeps Gateway Inference context, hard input, soft compact, and output reserve distinct', () => {
    expect(
      normalizeAIContextLimits({
        contextWindow: 160_000,
        maxInputTokens: 136_000,
        autoCompactTokenLimit: 120_000,
        maxOutputTokens: 20_000,
      })
    ).toEqual({
      contextWindow: 160_000,
      maxInputTokens: 136_000,
      autoCompactTokenLimit: 120_000,
      outputReserveTokens: 24_000,
    });
  });

  it('derives the direct-provider soft compact limit at ninety percent', () => {
    expect(directProviderContextLimits(100_000, 8_000)).toEqual({
      contextWindow: 100_000,
      maxInputTokens: 100_000,
      autoCompactTokenLimit: 90_000,
      outputReserveTokens: 8_000,
    });
  });

  it('rejects unknown or internally inconsistent model limits', () => {
    expect(() =>
      normalizeAIContextLimits({
        contextWindow: 100_000,
        maxInputTokens: 120_000,
        autoCompactTokenLimit: 90_000,
      })
    ).toThrowError(expect.objectContaining({ code: 'AI_MODEL_CONTEXT_LIMIT_UNKNOWN' }));
  });

  it('subtracts system, schema, and output reserve from the conversation budget', () => {
    const limits = directProviderContextLimits(100_000, 8_000);
    expect(availableConversationTokenBudget(limits, 10_000, 12_000)).toBe(60_000);
  });

  it('clamps tool and round inline limits to 8k-30k and 16k-60k', () => {
    const limits = directProviderContextLimits(500_000, 10_000);
    expect(toolOutputInlineLimits(limits, 10_000, 10_000)).toEqual({
      availableBudget: 420_000,
      perToolInlineLimit: 30_000,
      roundInlineLimit: 60_000,
    });

    const medium = directProviderContextLimits(100_000, 8_000);
    expect(toolOutputInlineLimits(medium, 5_000, 5_000)).toEqual({
      availableBudget: 72_000,
      perToolInlineLimit: 8_000,
      roundInlineLimit: 16_000,
    });
  });

  it('bounds both inline limits by the actual budget for tiny windows', () => {
    const limits = directProviderContextLimits(10_000, 4_000);
    expect(toolOutputInlineLimits(limits, 2_000, 2_500)).toEqual({
      availableBudget: 500,
      perToolInlineLimit: 500,
      roundInlineLimit: 500,
    });
  });
});
