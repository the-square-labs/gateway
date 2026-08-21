import { describe, expect, it } from 'vitest';
import type { InferenceProviderDefinition } from '../providers/inference-provider.types.js';
import {
  buildCoreProviderConfig,
  coreAdapterForWireProtocol,
  coreKeyProviderName,
  coreModelCapabilities,
  coreModelPricing,
  coreOAuthTarget,
  coreProviderRef,
  coreQuotaToWindows,
  parseCoreModelRows,
  parseCoreQuotaReports,
} from './inference-core-provider-map.js';

const DEFINITION: InferenceProviderDefinition = {
  id: 'xai-apikey',
  label: 'xAI API',
  family: 'custom',
  wireProtocol: 'openai-chat',
  baseUrl: 'https://api.x.ai/v1',
  authTypes: ['api_key'],
  subscription: false,
  featured: true,
  modelsPath: '/models',
  staticHeaders: { 'x-grok-client-identifier': 'gateway' },
  supportedOperations: ['inference'],
} as InferenceProviderDefinition;

describe('inference core provider mapping', () => {
  it('maps gateway OAuth providers to canonical core targets', () => {
    expect(coreOAuthTarget('openai')).toEqual({ kind: 'codex-pool', coreProviderName: 'openai' });
    expect(coreOAuthTarget('anthropic')).toEqual({
      kind: 'core-oauth',
      oauthProvider: 'anthropic',
      coreProviderName: 'anthropic',
    });
    expect(coreOAuthTarget('kimi')).toEqual({
      kind: 'core-oauth',
      oauthProvider: 'kimi',
      coreProviderName: 'kimi',
    });
    expect(coreOAuthTarget('xai')).toEqual({ kind: 'core-oauth', oauthProvider: 'xai', coreProviderName: 'xai' });
    expect(coreOAuthTarget('openai-apikey')).toBeNull();
    expect(coreOAuthTarget('openai-compatible')).toBeNull();
  });

  it('routes OAuth connections through canonical entries and key connections through owned entries', () => {
    expect(coreProviderRef({ id: 'conn-1', providerId: 'anthropic', authType: 'oauth' })).toBe('anthropic');
    expect(coreProviderRef({ id: 'conn-1', providerId: 'openai', authType: 'oauth' })).toBe('openai');
    expect(coreProviderRef({ id: 'conn-1', providerId: 'openai-apikey', authType: 'api_key' })).toBe('core-conn-1');
    expect(coreKeyProviderName('abc')).toBe('core-abc');
  });

  it('maps gateway wire protocols onto core adapter names', () => {
    expect(coreAdapterForWireProtocol('openai-responses')).toBe('openai-responses');
    expect(coreAdapterForWireProtocol('anthropic-messages')).toBe('anthropic');
    expect(coreAdapterForWireProtocol('openai-chat')).toBe('openai-chat');
  });

  it('builds core provider configs with secrets only in the payload', () => {
    expect(
      buildCoreProviderConfig({
        definition: DEFINITION,
        baseUrl: 'https://api.x.ai/v1',
        authType: 'api_key',
        apiKey: 'sk-test',
      })
    ).toEqual({
      templateId: 'xai-apikey',
      adapter: 'openai-chat',
      baseUrl: 'https://api.x.ai/v1',
      authMode: 'key',
      apiKey: 'sk-test',
      headers: { 'x-grok-client-identifier': 'gateway' },
    });
    expect(
      buildCoreProviderConfig({
        definition: { ...DEFINITION, staticHeaders: undefined } as InferenceProviderDefinition,
        baseUrl: 'http://localhost:11434/v1',
        authType: 'local',
        allowPrivateNetwork: true,
        disabled: true,
      })
    ).toEqual({
      templateId: 'xai-apikey',
      adapter: 'openai-chat',
      baseUrl: 'http://localhost:11434/v1',
      authMode: 'local',
      allowPrivateNetwork: true,
      disabled: true,
    });
  });

  it('uses the native Google adapter and leaves generic compatible connections untemplated', () => {
    expect(coreAdapterForWireProtocol('google-gemini')).toBe('google');
    expect(
      buildCoreProviderConfig({
        definition: { ...DEFINITION, id: 'openai-compatible' } as InferenceProviderDefinition,
        baseUrl: 'https://example.test/v1',
        authType: 'api_key',
        apiKey: 'test-key',
      })
    ).not.toHaveProperty('templateId');
  });

  it('passes an explicit live discovery policy to the managed core', () => {
    expect(
      buildCoreProviderConfig({
        definition: { ...DEFINITION, liveModels: true },
        baseUrl: DEFINITION.baseUrl,
        authType: 'api_key',
      })
    ).toMatchObject({ liveModels: true });
  });

  it('parses core model rows defensively and keeps the namespaced id', () => {
    const rows = parseCoreModelRows([
      { provider: 'anthropic', id: 'claude-sonnet-5', namespaced: 'anthropic/claude-sonnet-5', contextWindow: 200_000 },
      { provider: 'openai', id: 'gpt-5.5' },
      { broken: true },
      null,
      { provider: 42, id: 'x' },
    ]);
    expect(rows).toEqual([
      { provider: 'anthropic', id: 'claude-sonnet-5', namespaced: 'anthropic/claude-sonnet-5', contextWindow: 200_000 },
      { provider: 'openai', id: 'gpt-5.5', namespaced: 'gpt-5.5' },
    ]);
    expect(parseCoreModelRows({ not: 'an array' })).toEqual([]);
  });

  it('preserves native OpenCodex model capabilities for Gateway discovery', () => {
    const [row] = parseCoreModelRows([
      {
        provider: 'core-1',
        id: 'glm-5.3',
        namespaced: 'core-1/glm-5.3',
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'high', 'max'],
        capabilities: ['structured_outputs', 'tools'],
        parallelToolCalls: true,
        supportsReasoningSummaries: true,
        supportsServiceTier: false,
      },
    ]);
    expect(row).toMatchObject({
      capabilities: ['structured_outputs', 'tools'],
      parallelToolCalls: true,
      supportsReasoningSummaries: true,
      supportsServiceTier: false,
    });
    expect(coreModelCapabilities(row!)).toEqual({
      structured_outputs: true,
      tools: true,
      reasoning: true,
      vision: true,
      parallelToolCalls: true,
      reasoningSummaries: true,
      serviceTier: false,
    });
  });

  it('parses and converts OpenCodex catalog pricing into exact accounting units', () => {
    const [row] = parseCoreModelRows([
      {
        provider: 'core-1',
        id: 'openai/gpt-5.6-sol',
        pricing: {
          inputUsdPerMillion: 5,
          outputUsdPerMillion: 30,
          cachedInputUsdPerMillion: 0.5,
          cacheWriteUsdPerMillion: 6.25,
          source: 'opencodex-catalog',
        },
      },
    ]);
    expect(row?.pricing).toEqual({
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 30,
      cachedInputUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
      source: 'opencodex-catalog',
    });
    expect(coreModelPricing(row!)).toMatchObject({
      version: expect.stringMatching(/^opencodex-catalog-v1-[a-f0-9]{24}$/),
      inputMicrodollarsPerMillion: 5_000_000,
      outputMicrodollarsPerMillion: 30_000_000,
      cachedInputMicrodollarsPerMillion: 500_000,
      cacheWriteMicrodollarsPerMillion: 6_250_000,
      source: 'provider',
    });
    expect(
      parseCoreModelRows([
        {
          provider: 'core-1',
          id: 'invalid',
          pricing: {
            inputUsdPerMillion: -1,
            outputUsdPerMillion: 1,
            cachedInputUsdPerMillion: 0,
            cacheWriteUsdPerMillion: 0,
            source: 'opencodex-catalog',
          },
        },
      ])[0]
    ).not.toHaveProperty('pricing');
  });

  it('does not advertise tools when the core catalog does not support them', () => {
    expect(
      coreModelCapabilities({
        provider: 'core-1',
        id: 'text-only',
        namespaced: 'core-1/text-only',
        capabilities: ['structured_outputs'],
      })
    ).toMatchObject({ tools: false, structured_outputs: true });
  });

  it('parses core quota reports and projects usage percents into remaining fractions', () => {
    const reports = parseCoreQuotaReports({
      reports: [
        {
          provider: 'anthropic',
          quota: {
            fiveHourPercent: 25,
            fiveHourResetAt: 1_800_000_000_000,
            weeklyPercent: 150,
            weeklyResetAt: 1_800_000_000,
            creditsUsd: { remaining: 12.5, limit: 50 },
          },
        },
        { noProvider: true },
      ],
    });
    expect(reports).toHaveLength(1);
    const windows = coreQuotaToWindows(reports[0]!);
    expect(windows).toEqual([
      { dimension: '5h', remainingFraction: 0.75, resetAt: new Date(1_800_000_000_000) },
      { dimension: '7d', remainingFraction: 0, resetAt: new Date(1_800_000_000_000) },
      { dimension: 'subscription', remainingFraction: 0.25, remainingValue: '12.5', limitValue: '50' },
    ]);
    expect(coreQuotaToWindows({ provider: 'x', quota: { weeklyPercent: 50, weeklyResetAt: 0 } })).toEqual([
      { dimension: '7d', remainingFraction: 0.5 },
    ]);
    expect(coreQuotaToWindows({ provider: 'x', quota: {} })).toEqual([]);
    expect(parseCoreQuotaReports(null)).toEqual([]);
  });
});
