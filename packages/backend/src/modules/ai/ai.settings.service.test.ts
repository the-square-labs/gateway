import { describe, expect, it, vi } from 'vitest';
import { AISettingsService } from './ai.settings.service.js';

function createHarness(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [...values].map(([key, value]) => ({ key, value, updatedAt: new Date() }))),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: { key: string; value: unknown }) => ({
        onConflictDoUpdate: vi.fn(async () => {
          values.set(row.key, row.value);
        }),
      })),
    })),
  };
  const crypto = {
    encryptString: vi.fn((value: string) => ({ encryptedKey: value, encryptedDek: 'dek' })),
    decryptString: vi.fn((value: { encryptedKey: string }) => value.encryptedKey),
  };
  const service = new AISettingsService(db as never, crypto as never);
  Object.assign(service as object, {
    getSetting: async (key: string) => values.get(key),
    setSetting: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    deleteSetting: async (key: string) => {
      values.delete(key);
    },
  });
  return { service, values };
}

describe('AISettingsService provider selection', () => {
  it('deletes stored API keys when an explicit empty value is submitted', async () => {
    const { service, values } = createHarness({
      'ai:api_key_encrypted': { encryptedKey: 'provider-secret', encryptedDek: 'dek' },
      'ai:web_search_api_key_encrypted': { encryptedKey: 'search-secret', encryptedDek: 'dek' },
    });

    await service.updateConfig({ apiKey: '', webSearchApiKey: '' });

    expect(values.has('ai:api_key_encrypted')).toBe(false);
    expect(values.has('ai:web_search_api_key_encrypted')).toBe(false);
    await expect(service.getConfigForAdmin()).resolves.toMatchObject({ hasApiKey: false, hasWebSearchKey: false });
  });

  it('keeps OpenAI-compatible as the default provider', async () => {
    const { service } = createHarness();
    await expect(service.getConfig()).resolves.toMatchObject({
      providerType: 'openai_compatible',
      gatewayInferenceModel: '',
      gatewayInferenceAllowUserModelSelection: true,
      allowUserReasoningEffortSelection: false,
    });
  });

  it('preserves an explicit model-selection opt-out', async () => {
    const { service } = createHarness({
      'ai:gateway_inference_allow_user_model_selection': false,
    });

    await expect(service.getConfig()).resolves.toMatchObject({
      gatewayInferenceAllowUserModelSelection: false,
    });
  });

  it('requires the inference feature before selecting Gateway Inference', async () => {
    const { service } = createHarness();
    await expect(service.updateConfig({ providerType: 'gateway_inference' })).rejects.toMatchObject({
      code: 'AI_GATEWAY_INFERENCE_DISABLED',
    });

    service.setInferenceFeatureResolver(async () => true);
    service.setGatewayInferenceModelValidator(async (model) => model === 'gateway-model');
    await service.updateConfig({
      providerType: 'gateway_inference',
      gatewayInferenceModel: 'gateway-model',
    });
    await expect(service.getConfig()).resolves.toMatchObject({
      providerType: 'gateway_inference',
      gatewayInferenceModel: 'gateway-model',
    });
  });

  it('requires a published default model for Gateway Inference', async () => {
    const { service } = createHarness();
    service.setInferenceFeatureResolver(async () => true);
    service.setGatewayInferenceModelValidator(async (model) => model === 'published-model');

    await expect(
      service.updateConfig({
        providerType: 'gateway_inference',
        gatewayInferenceModel: '',
      })
    ).rejects.toMatchObject({ code: 'AI_GATEWAY_INFERENCE_MODEL_REQUIRED' });

    await expect(
      service.updateConfig({
        providerType: 'gateway_inference',
        gatewayInferenceModel: 'unpublished-model',
      })
    ).rejects.toMatchObject({ code: 'AI_GATEWAY_INFERENCE_MODEL_UNAVAILABLE' });
  });

  it('restores the preserved OpenAI-compatible provider when inference is disabled', async () => {
    const { service, values } = createHarness({
      'ai:enabled': true,
      'ai:provider_type': 'gateway_inference',
      'ai:gateway_inference_model': 'gateway-model',
      'ai:provider_url': 'https://api.example.com/v1',
      'ai:model': 'preserved-model',
      'ai:api_key_encrypted': { encryptedKey: 'secret', encryptedDek: 'dek' },
    });

    await service.handleInferenceDisabled();

    expect(values.get('ai:provider_type')).toBe('openai_compatible');
    expect(values.get('ai:enabled')).toBe(true);
    expect(values.get('ai:provider_url')).toBe('https://api.example.com/v1');
    expect(values.get('ai:model')).toBe('preserved-model');
  });

  it('replaces a deleted Gateway Inference default with the first available model', async () => {
    const { service, values } = createHarness({
      'ai:gateway_inference_model': 'deleted-model',
    });

    await service.handleGatewayInferenceModelRemoved('deleted-model', 'first-model');
    expect(values.get('ai:gateway_inference_model')).toBe('first-model');

    await service.handleGatewayInferenceModelRemoved('unrelated-model', 'other-model');
    expect(values.get('ai:gateway_inference_model')).toBe('first-model');
  });

  it('clears the Gateway Inference default when the last model is deleted', async () => {
    const { service, values } = createHarness({
      'ai:gateway_inference_model': 'deleted-model',
    });

    await service.handleGatewayInferenceModelRemoved('deleted-model', null);
    expect(values.get('ai:gateway_inference_model')).toBe('');
  });

  it('disables the assistant when inference is disabled without a preserved provider key', async () => {
    const { service, values } = createHarness({
      'ai:enabled': true,
      'ai:provider_type': 'gateway_inference',
      'ai:gateway_inference_model': 'gateway-model',
    });

    await service.handleInferenceDisabled();

    expect(values.get('ai:provider_type')).toBe('openai_compatible');
    expect(values.get('ai:enabled')).toBe(false);
  });
});
