import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { __testOnly } from './inference-model-configuration.service.js';

describe('atomic inference model configuration', () => {
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
