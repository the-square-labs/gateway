import { describe, expect, it } from 'vitest';
import { inheritFamilyMetadata } from './inference-provider.service.helpers.js';
import type { DiscoveredInferenceModel } from './inference-provider.types.js';

function model(id: string, overrides: Partial<DiscoveredInferenceModel> = {}): DiscoveredInferenceModel {
  return {
    id,
    modalities: ['text'],
    capabilities: { tools: true, reasoning: false, vision: false },
    reasoningEfforts: [],
    metadata: { source: 'opencodex' },
    ...overrides,
  };
}

const grok46 = model('grok-4.6', {
  modalities: ['text', 'image'],
  capabilities: { tools: true, reasoning: true, vision: true },
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  metadata: {
    source: 'opencodex',
    default_reasoning_effort: 'high',
    field_sources: { modalities: 'fallback', reasoningEfforts: 'fallback', contextWindow: 'provider' },
  },
});

describe('inheritFamilyMetadata', () => {
  it('fills a new family version from the newest earlier version on the account', () => {
    const grok45 = model('grok-4.5', {
      reasoningEfforts: ['low', 'medium', 'high'],
      metadata: { field_sources: { reasoningEfforts: 'fallback' } },
    });
    const grok47 = model('grok-4.7', { metadata: { field_sources: { contextWindow: 'provider' } } });

    const [, , inherited] = inheritFamilyMetadata([grok45, grok46, grok47]);

    expect(inherited).toMatchObject({
      id: 'grok-4.7',
      modalities: ['text', 'image'],
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      capabilities: { tools: true, reasoning: true, vision: true },
      metadata: {
        inherited_from: 'grok-4.6',
        default_reasoning_effort: 'high',
        field_sources: { contextWindow: 'provider', modalities: 'fallback', reasoningEfforts: 'fallback' },
      },
    });
  });

  it('keeps values the model has a source for and leaves variants and older versions alone', () => {
    const textOnly = model('grok-4.7', { metadata: { field_sources: { modalities: 'provider' } } });
    const variant = model('grok-4.7-build-fast');
    const older = model('grok-4.3');

    const [own, fast, old] = inheritFamilyMetadata([textOnly, variant, older, grok46]);

    expect(own).toMatchObject({ modalities: ['text'], reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] });
    expect(own?.capabilities.vision).toBe(false);
    expect(fast).toBe(variant);
    expect(old).toBe(older);
  });

  it('does not cross families or majors', () => {
    const models = [grok46, model('grok-5.1'), model('glm-4.7')];
    const [, nextMajor, otherFamily] = inheritFamilyMetadata(models);
    expect(nextMajor).toBe(models[1]);
    expect(otherFamily).toBe(models[2]);
  });
});
