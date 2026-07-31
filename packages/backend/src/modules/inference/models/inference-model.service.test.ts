import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { __testOnly } from './inference-model.service.js';

describe('inference model publication validation', () => {
  it('normalizes stable public IDs and validates compaction limits', () => {
    expect(__testOnly.normalizePublicId(' GPT-5.6/SOL ')).toBe('gpt-5.6/sol');
    expect(() => __testOnly.normalizePublicId('../model')).toThrow(/unsupported characters/);
    expect(() =>
      __testOnly.validateModelInput({
        publicId: 'model',
        displayName: 'Model',
        contextWindow: 100_000,
        maxInputTokens: 80_000,
        maxOutputTokens: 20_000,
        autoCompactTokenLimit: 90_000,
        modalities: ['text'],
        capabilities: {},
        reasoningEfforts: [],
        defaultAccessAllowed: true,
        subscriptionMultiplier: 1,
      })
    ).toThrow(/positive and consistent/);
    expect(() =>
      __testOnly.validateModelInput({
        publicId: 'model-with-unknown-output-limit',
        displayName: 'Model',
        contextWindow: 100_000,
        maxInputTokens: 80_000,
        maxOutputTokens: null,
        autoCompactTokenLimit: 70_000,
        modalities: ['text'],
        capabilities: {},
        reasoningEfforts: [],
        defaultAccessAllowed: true,
        subscriptionMultiplier: 1,
      })
    ).not.toThrow();
  });

  it('requires complete versioned API pricing', () => {
    expect(() =>
      __testOnly.validatePricing({ version: '2026-07', source: 'manual', inputMicrodollarsPerMillion: 1 })
    ).toThrow(/input and output pricing/);
    expect(() =>
      __testOnly.validatePricing({
        version: '2026-07',
        source: 'manual',
        inputMicrodollarsPerMillion: 1,
        outputMicrodollarsPerMillion: -1,
      })
    ).toThrow(/non-negative/);
  });

  it('allows manual source IDs only after discovery is unavailable', () => {
    const metadata = { contextWindow: 100, maxInputTokens: 80, maxOutputTokens: 20 };
    expect(__testOnly.manualSourceAllowed('success', '/models', metadata)).toBe(false);
    expect(__testOnly.manualSourceAllowed('error', '/models', metadata)).toBe(true);
    expect(__testOnly.manualSourceAllowed('success', undefined, metadata)).toBe(true);
  });

  it('preserves manual technical fallback metadata for discovered sources', () => {
    const technical = { contextWindow: 8192, maxInputTokens: 6144 };
    expect(__testOnly.sourceOriginMetadata('openai', true, technical)).toEqual({
      origin: 'discovery',
      providerFamily: 'openai',
      technical,
    });
  });

  it('allows account bindings only for one provider and one upstream model', () => {
    const valid = [
      { providerId: 'kimi', upstreamModelId: 'k3', role: 'primary' as const },
      { providerId: 'kimi', upstreamModelId: 'k3', role: 'primary' as const },
    ];
    expect(() => __testOnly.assertSingleProviderBindings(valid)).not.toThrow();
    expect(() =>
      __testOnly.assertSingleProviderBindings([
        ...valid,
        { providerId: 'openrouter', upstreamModelId: 'k3', role: 'primary' },
      ])
    ).toThrow(/one provider and one upstream model/);
    expect(() =>
      __testOnly.assertSingleProviderBindings([
        ...valid,
        { providerId: 'kimi', upstreamModelId: 'k2', role: 'primary' },
      ])
    ).toThrow(/one provider and one upstream model/);
    expect(() =>
      __testOnly.assertSingleProviderBindings([
        ...valid,
        { providerId: 'kimi', upstreamModelId: 'k3', role: 'vision_sidecar' },
      ])
    ).toThrow(/one provider and one upstream model/);
  });

  it('advertises Fast only when every enabled source is an eligible ChatGPT subscription model', () => {
    const eligible = sourceRow({
      providerId: 'openai',
      sourceType: 'subscription',
      metadata: { service_tiers: [{ id: 'priority', name: 'Fast', description: 'Priority processing' }] },
    });
    expect(__testOnly.supportsFastServiceTier([eligible])).toBe(true);
    expect(
      __testOnly.supportsFastServiceTier([
        eligible,
        sourceRow({ providerId: 'openai', sourceType: 'subscription', metadata: {} }),
      ])
    ).toBe(false);
    expect(
      __testOnly.supportsFastServiceTier([
        sourceRow({
          providerId: 'openai-apikey',
          sourceType: 'api',
          metadata: { additional_speed_tiers: ['fast'] },
        }),
      ])
    ).toBe(false);
  });

  it('hides API-only models when the effective API budget is zero', () => {
    const modelIds = ['subscription-only', 'api-only', 'mixed'];
    expect(__testOnly.filterModelIdsByApiBudget(modelIds, ['subscription-only', 'mixed'], 0)).toEqual([
      'subscription-only',
      'mixed',
    ]);
    expect(__testOnly.filterModelIdsByApiBudget(modelIds, [], 0)).toEqual([]);
    expect(__testOnly.filterModelIdsByApiBudget(modelIds, [], 1)).toEqual(modelIds);
  });

  it('removes API sources from mixed models when API usage is disabled', () => {
    const sources = [
      { id: 'subscription', sourceType: 'subscription' },
      { id: 'api', sourceType: 'api' },
    ];
    expect(__testOnly.filterSourcesByApiUsage(sources, false)).toEqual([sources[0]]);
    expect(__testOnly.filterSourcesByApiUsage(sources, true)).toEqual(sources);
  });
});

function sourceRow(input: {
  providerId: string;
  sourceType: 'subscription' | 'api';
  metadata: Record<string, unknown>;
}) {
  return {
    source: {
      enabled: true,
      sourceType: input.sourceType,
      metadata: { composition: { role: 'primary' } },
    },
    connection: { providerId: input.providerId },
    discovered: { metadata: input.metadata },
  } as never;
}
