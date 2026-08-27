import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { __testOnly } from './inference-model-configuration.service.js';

describe('atomic inference model configuration', () => {
  it('accepts safe fallback sources from different providers', () => {
    const model = {
      publicId: 'coding-default',
      displayName: 'Coding Default',
      contextWindow: 200_000,
      maxInputTokens: 180_000,
      maxOutputTokens: 20_000,
      autoCompactTokenLimit: 160_000,
      modalities: ['text'],
      capabilities: {},
      reasoningEfforts: ['high'],
      defaultReasoningEffort: 'high',
      defaultAccessAllowed: true,
      subscriptionMultiplier: 1,
    };
    const source = {
      connectionId: 'connection-a',
      discoveredModelId: 'model-a',
      upstreamModelId: 'gpt-5.6-luna',
      coreAccountId: 'openai',
      coreModelId: 'gpt-5.6-luna',
      providerId: 'openai',
      sourceType: 'subscription' as const,
      enabled: true,
      subscriptionMultiplierOverride: null,
      reasoningEffortMap: { high: 'high' },
      capabilitiesOverride: null,
      metadata: {},
      safeContextWindow: 400_000,
      safeMaxInputTokens: 300_000,
      safeAutoCompactTokenLimit: 250_000,
      modalities: ['text'],
      capabilities: {},
    };
    expect(() =>
      __testOnly.validatePublishableConfiguration(
        model,
        [
          source,
          {
            ...source,
            connectionId: 'connection-b',
            discoveredModelId: 'model-b',
            upstreamModelId: 'claude-sonnet-5',
            coreAccountId: 'anthropic',
            coreModelId: 'claude-sonnet-5',
            providerId: 'anthropic',
          },
        ],
        'everyone'
      )
    ).not.toThrow();
  });

  it('rejects a fallback source that cannot satisfy the published model contract', () => {
    const model = {
      publicId: 'vision-default',
      displayName: 'Vision Default',
      contextWindow: 200_000,
      maxInputTokens: 180_000,
      maxOutputTokens: 20_000,
      autoCompactTokenLimit: 160_000,
      modalities: ['text', 'image'],
      capabilities: { tools: true },
      reasoningEfforts: ['high'],
      defaultReasoningEffort: 'high',
      defaultAccessAllowed: true,
      subscriptionMultiplier: 1,
    };
    const source = {
      connectionId: 'connection-a',
      discoveredModelId: 'model-a',
      upstreamModelId: 'text-only',
      coreAccountId: 'provider-a',
      coreModelId: 'text-only',
      providerId: 'provider-a',
      sourceType: 'subscription' as const,
      enabled: true,
      subscriptionMultiplierOverride: null,
      reasoningEffortMap: { high: 'high' },
      capabilitiesOverride: null,
      metadata: {},
      safeContextWindow: 400_000,
      safeMaxInputTokens: 300_000,
      safeAutoCompactTokenLimit: 250_000,
      modalities: ['text'],
      capabilities: { tools: false },
    };
    expect(() => __testOnly.validatePublishableConfiguration(model, [source], 'everyone')).toThrow(
      /modalities and capabilities/
    );
  });

  it('rejects enabled sources that cannot be routed', () => {
    expect(() => __testOnly.assertEnabledSourceAvailable(true, false, true)).toThrow(/enabled provider connection/);
    expect(() => __testOnly.assertEnabledSourceAvailable(true, true, false)).toThrow(/available discovered model/);
    expect(() => __testOnly.assertEnabledSourceAvailable(false, false, false)).not.toThrow();
    expect(() => __testOnly.assertEnabledSourceAvailable(true, true, true)).not.toThrow();
  });

  it('pins managed sources to their core provider and model', () => {
    expect(
      __testOnly.coreSourceReferences(
        {
          id: 'connection-1',
          providerId: 'openai',
          authType: 'oauth',
          metadata: { coreManaged: true, coreAccountId: 'chatgpt-account-1' },
        },
        'gpt-5.6-luna'
      )
    ).toEqual({ coreAccountId: 'openai', coreModelId: 'gpt-5.6-luna' });
  });

  it('keeps the core-only namespaced route separate from the upstream model id', () => {
    expect(
      __testOnly.coreSourceReferences(
        {
          id: 'connection-1',
          providerId: 'alibaba-token-plan-intl',
          authType: 'api_key',
          metadata: { coreManaged: true },
        },
        'glm-5.3',
        { coreModelId: 'core-connection-1/glm-5.3' }
      )
    ).toEqual({
      coreAccountId: 'core-connection-1',
      coreModelId: 'core-connection-1/glm-5.3',
    });
  });

  it('does not invent core references for legacy sources', () => {
    expect(
      __testOnly.coreSourceReferences(
        {
          id: 'connection-1',
          providerId: 'openai',
          authType: 'oauth',
          metadata: {},
        },
        'gpt-5.6-luna'
      )
    ).toEqual({ coreAccountId: null, coreModelId: null });
  });
});
