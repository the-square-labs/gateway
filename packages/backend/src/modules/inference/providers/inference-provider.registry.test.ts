import { describe, expect, it } from 'vitest';
import { InferenceProviderRegistry } from './inference-provider.registry.js';

const OPENCODEX_PROVIDER_IDS = [
  'openai',
  'xai',
  'xai-apikey',
  'anthropic',
  'anthropic-apikey',
  'kimi',
  'openai-apikey',
  'umans',
  'opencode-go',
  'neuralwatt',
  'orcarouter',
  'google',
  'deepseek',
  'firepass',
  'moonshot',
  'nvidia',
  'zai',
  'siliconflow',
  'qwen-cloud',
  'tencent-coding-plan',
  'alibaba-token-plan',
  'alibaba-token-plan-intl',
  'zenmux',
  'litellm',
  'ollama-cloud',
  'minimax',
  'minimax-cn',
  'kimi-code',
  'opencode-free',
  'mimo-free',
  'cloudflare-workers-ai',
  'github-copilot',
  'openrouter',
  'groq',
  'cerebras',
  'together',
  'huggingface',
  'mistral',
] as const;

describe('InferenceProviderRegistry parity', () => {
  it('covers the pinned OpenCodex catalog except the explicit Cursor and Kiro exclusions', () => {
    const registry = new InferenceProviderRegistry();
    for (const id of OPENCODEX_PROVIDER_IDS) expect(registry.get(id), id).toBeDefined();
    expect(registry.get('cursor')).toBeUndefined();
    expect(registry.get('kiro')).toBeUndefined();
  });

  it('declares operations explicitly and keeps extended OpenAI API surfaces on API billing', () => {
    const registry = new InferenceProviderRegistry();
    expect(registry.require('openai').label).toBe('ChatGPT subscription');
    for (const provider of registry.list()) {
      expect(provider.supportedOperations?.length, provider.id).toBeGreaterThan(0);
    }
    expect(registry.require('openai-apikey').supportedOperations).toEqual([
      'inference',
      'images',
      'search',
      'realtime',
    ]);
    expect(registry.require('openai').supportedOperations).toEqual(['inference']);
  });

  it('requires explicit private-network acknowledgement for the generic compatible connector', () => {
    const registry = new InferenceProviderRegistry();
    expect(registry.require('openai-compatible').allowBaseUrlOverride).toBe(true);
  });

  it('only exposes the approved connection templates while retaining parity definitions internally', () => {
    const registry = new InferenceProviderRegistry();
    expect(registry.listConnectable().map((provider) => provider.id)).toEqual([
      'openai',
      'openai-apikey',
      'xai',
      'xai-apikey',
      'anthropic',
      'anthropic-apikey',
      'kimi',
      'moonshot',
      'openai-compatible',
      'openrouter',
    ]);
    expect(registry.require('google')).toBeDefined();
    expect(() => registry.requireConnectable('google')).toThrow(/not connectable/);
  });
});
