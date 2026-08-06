import { describe, expect, it } from 'vitest';
import { knownProviderModel, pricingFromDiscoveredMetadata } from './inference-provider-model-catalog.js';

describe('known inference provider model catalog', () => {
  it('provides audited OpenAI API metadata and pricing without leaking into compatible providers', () => {
    expect(knownProviderModel('openai-apikey', 'gpt-5.1-codex-mini')).toMatchObject({
      contextWindow: 400_000,
      maxInputTokens: 272_000,
      maxOutputTokens: 128_000,
      autoCompactTokenLimit: 244_800,
      modalities: ['text', 'image'],
      capabilities: { reasoning: true, tools: true, vision: true },
      reasoningEfforts: ['low', 'medium', 'high'],
      pricing: {
        inputMicrodollarsPerMillion: 250_000,
        cachedInputMicrodollarsPerMillion: 25_000,
        outputMicrodollarsPerMillion: 2_000_000,
        source: 'provider',
      },
    });
    expect(knownProviderModel('openai-compatible', 'gpt-5.1-codex-mini')).toBeUndefined();
  });

  it('provides versioned defaults for current OpenAI, Claude, and Kimi models', () => {
    expect(knownProviderModel('openai-apikey', 'gpt-5.6-sol')).toMatchObject({
      contextWindow: 1_050_000,
      maxInputTokens: 922_000,
      maxOutputTokens: 128_000,
      reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      pricing: {
        inputMicrodollarsPerMillion: 5_000_000,
        cachedInputMicrodollarsPerMillion: 500_000,
        cacheWriteMicrodollarsPerMillion: 6_250_000,
        outputMicrodollarsPerMillion: 30_000_000,
      },
    });
    expect(knownProviderModel('openai-apikey', 'gpt-5.6-terra')).toMatchObject({
      pricing: {
        inputMicrodollarsPerMillion: 2_000_000,
        cachedInputMicrodollarsPerMillion: 200_000,
        cacheWriteMicrodollarsPerMillion: 2_500_000,
        outputMicrodollarsPerMillion: 12_000_000,
      },
    });
    expect(knownProviderModel('openai-apikey', 'gpt-5.6-luna')).toMatchObject({
      pricing: {
        inputMicrodollarsPerMillion: 200_000,
        cachedInputMicrodollarsPerMillion: 20_000,
        cacheWriteMicrodollarsPerMillion: 250_000,
        outputMicrodollarsPerMillion: 1_200_000,
        otherUnitPrices: {
          long_context_threshold_tokens: 272_000,
          long_context_input_microdollars_per_million: 400_000,
          long_context_cached_input_microdollars_per_million: 40_000,
          long_context_cache_write_microdollars_per_million: 500_000,
          long_context_output_microdollars_per_million: 1_800_000,
        },
      },
    });
    expect(knownProviderModel('openai-apikey', 'gpt-4')).toMatchObject({
      contextWindow: 8_192,
      maxInputTokens: 8_192,
      maxOutputTokens: 8_192,
      capabilities: { reasoning: false, tools: true, vision: false },
      pricing: { inputMicrodollarsPerMillion: 30_000_000, outputMicrodollarsPerMillion: 60_000_000 },
    });
    expect(knownProviderModel('anthropic-apikey', 'claude-sonnet-5')).toMatchObject({
      contextWindow: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: {
        inputMicrodollarsPerMillion: 2_000_000,
        cachedInputMicrodollarsPerMillion: 200_000,
        cacheWriteMicrodollarsPerMillion: 2_500_000,
        outputMicrodollarsPerMillion: 10_000_000,
      },
    });
    const kimiK3 = knownProviderModel('moonshot', 'kimi-k3');
    expect(kimiK3).toMatchObject({
      contextWindow: 1_048_576,
      modalities: ['text', 'image', 'video'],
      reasoningEfforts: ['low', 'high', 'max'],
      pricing: {
        inputMicrodollarsPerMillion: 3_000_000,
        cachedInputMicrodollarsPerMillion: 300_000,
        outputMicrodollarsPerMillion: 15_000_000,
      },
    });
    expect(kimiK3?.maxOutputTokens).toBeUndefined();
    expect(knownProviderModel('kimi', 'k3')).toEqual(knownProviderModel('moonshot', 'kimi-k3'));
  });

  it('covers the broader documented OpenAI text and reasoning catalog', () => {
    expect(knownProviderModel('openai-apikey', 'chat-latest')).toMatchObject({
      contextWindow: 400_000,
      maxInputTokens: 272_000,
      maxOutputTokens: 128_000,
      capabilities: { reasoning: false, tools: true, vision: true },
      pricing: {
        inputMicrodollarsPerMillion: 5_000_000,
        cachedInputMicrodollarsPerMillion: 500_000,
        outputMicrodollarsPerMillion: 30_000_000,
      },
    });
    expect(knownProviderModel('openai-apikey', 'gpt-5.5-pro-2026-04-23')).toMatchObject({
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      reasoningEfforts: ['medium', 'high', 'xhigh'],
      pricing: {
        inputMicrodollarsPerMillion: 30_000_000,
        outputMicrodollarsPerMillion: 180_000_000,
      },
    });
    expect(knownProviderModel('openai-apikey', 'gpt-5.2')).toMatchObject({
      contextWindow: 400_000,
      maxInputTokens: 272_000,
      maxOutputTokens: 128_000,
      reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    });
    expect(knownProviderModel('openai-apikey', 'gpt-5-mini')).toMatchObject({
      pricing: {
        inputMicrodollarsPerMillion: 250_000,
        cachedInputMicrodollarsPerMillion: 25_000,
        outputMicrodollarsPerMillion: 2_000_000,
      },
      reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    });
    expect(knownProviderModel('openai-apikey', 'gpt-5.1-chat-latest')).toMatchObject({
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      capabilities: { reasoning: false, vision: true },
      pricing: {
        inputMicrodollarsPerMillion: 1_250_000,
        cachedInputMicrodollarsPerMillion: 125_000,
        outputMicrodollarsPerMillion: 10_000_000,
      },
    });
    expect(knownProviderModel('openai-apikey', 'codex-mini-latest')).toMatchObject({
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      pricing: {
        inputMicrodollarsPerMillion: 1_500_000,
        cachedInputMicrodollarsPerMillion: 375_000,
        outputMicrodollarsPerMillion: 6_000_000,
      },
    });
    expect(knownProviderModel('openai-apikey', 'gpt-4.5-preview-2025-02-27')).toMatchObject({
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      pricing: {
        inputMicrodollarsPerMillion: 75_000_000,
        cachedInputMicrodollarsPerMillion: 37_500_000,
        outputMicrodollarsPerMillion: 150_000_000,
      },
    });
    expect(knownProviderModel('openai-apikey', 'o3-pro')).toMatchObject({
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      pricing: {
        inputMicrodollarsPerMillion: 20_000_000,
        outputMicrodollarsPerMillion: 80_000_000,
      },
    });
  });

  it('preserves model-specific legacy snapshot pricing instead of inheriting a newer alias', () => {
    expect(knownProviderModel('openai-apikey', 'gpt-4o-2024-05-13')).toMatchObject({
      maxOutputTokens: 4_096,
      pricing: {
        inputMicrodollarsPerMillion: 5_000_000,
        outputMicrodollarsPerMillion: 15_000_000,
      },
    });
    expect(knownProviderModel('openai-apikey', 'gpt-3.5-turbo-1106')).toMatchObject({
      capabilities: { reasoning: false, vision: false },
      pricing: {
        inputMicrodollarsPerMillion: 1_000_000,
        outputMicrodollarsPerMillion: 2_000_000,
      },
    });
  });

  it('covers current and still-discoverable Claude aliases and pinned model ids', () => {
    expect(knownProviderModel('anthropic-apikey', 'claude-mythos-5')).toMatchObject({
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: {
        inputMicrodollarsPerMillion: 10_000_000,
        outputMicrodollarsPerMillion: 50_000_000,
      },
    });
    expect(knownProviderModel('anthropic-apikey', 'claude-opus-4-5')).toEqual(
      knownProviderModel('anthropic-apikey', 'claude-opus-4-5-20251101')
    );
    expect(knownProviderModel('anthropic-apikey', 'claude-sonnet-4-5-20250929')).toMatchObject({
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      pricing: {
        inputMicrodollarsPerMillion: 3_000_000,
        cachedInputMicrodollarsPerMillion: 300_000,
        outputMicrodollarsPerMillion: 15_000_000,
      },
    });
    expect(knownProviderModel('anthropic-apikey', 'claude-opus-4-1-20250805')).toMatchObject({
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      pricing: {
        inputMicrodollarsPerMillion: 15_000_000,
        outputMicrodollarsPerMillion: 75_000_000,
      },
    });
  });

  it('maps dated OpenAI snapshots to the audited family defaults', () => {
    expect(knownProviderModel('openai-apikey', 'gpt-4o-2024-11-20')).toEqual(
      knownProviderModel('openai-apikey', 'gpt-4o')
    );
  });

  it('accepts only complete non-negative provider pricing stored by discovery', () => {
    expect(
      pricingFromDiscoveredMetadata({
        gatewayPricing: {
          version: 'provider-v1',
          inputMicrodollarsPerMillion: 250_000,
          outputMicrodollarsPerMillion: 2_000_000,
          source: 'provider',
        },
      })
    ).toMatchObject({ version: 'provider-v1', inputMicrodollarsPerMillion: 250_000 });
    expect(
      pricingFromDiscoveredMetadata({
        gatewayPricing: {
          version: 'provider-v1',
          inputMicrodollarsPerMillion: -1,
          outputMicrodollarsPerMillion: 2_000_000,
          source: 'provider',
        },
      })
    ).toBeUndefined();
  });
});
