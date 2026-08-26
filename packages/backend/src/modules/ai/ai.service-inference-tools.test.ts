import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { InferenceUsageService } from '@/modules/inference/accounting/inference-usage.service.js';
import { InferenceTokenService } from '@/modules/inference/inference-token.service.js';
import { InferenceModelConfigurationService } from '@/modules/inference/models/inference-model-configuration.service.js';
import { InferenceProviderService } from '@/modules/inference/providers/inference-provider.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { executeInferenceTool } from './ai.inference-tools.js';
import { getOpenAITools } from './ai.tools.js';

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc:user',
  email: 'user@example.com',
  name: 'User',
  avatarUrl: null,
  groupId: '22222222-2222-4222-8222-222222222222',
  groupName: 'Inference admins',
  scopes: [] as string[],
  isBlocked: false,
};

describe('internal AI inference tools', () => {
  beforeEach(() => {
    container.reset();
    container.registerInstance(GeneralSettingsService, {
      isFeatureEnabled: vi.fn().mockResolvedValue(true),
    } as unknown as GeneralSettingsService);
  });

  it('exposes the scoped Inference category to token managers', () => {
    const providerTools = getOpenAITools([], ['inference:providers:manage'], false, {
      discoveredToolsets: ['Inference'],
    });
    const tokenTools = getOpenAITools([], ['feat:ai:use'], false, {
      discoveredToolsets: ['Inference'],
    });

    expect(providerTools.map((tool) => tool.function.name)).toContain('manage_inference_provider');
    expect(tokenTools.map((tool) => tool.function.name)).toContain('manage_inference_token');
  });

  it('lists provider state and converts human USD connection budgets', async () => {
    const service = {
      listConnections: vi.fn().mockResolvedValue([{ id: 'connection-1', name: 'OpenAI API' }]),
      updateConnection: vi.fn().mockResolvedValue({ id: 'connection-1', apiMonthlyLimitMicrodollars: 12_500_000 }),
    };
    container.registerInstance(InferenceProviderService, service as unknown as InferenceProviderService);
    const user = { ...USER, scopes: ['inference:providers:manage'] };

    await expect(
      executeInferenceTool(user, 'manage_inference_provider', { operation: 'list_connections' })
    ).resolves.toEqual([{ id: 'connection-1', name: 'OpenAI API' }]);
    await executeInferenceTool(user, 'manage_inference_provider', {
      operation: 'update',
      connectionId: '33333333-3333-4333-8333-333333333333',
      apiMonthlyLimitUsd: 12.5,
    });

    expect(service.updateConnection).toHaveBeenCalledWith(USER.id, '33333333-3333-4333-8333-333333333333', {
      apiMonthlyLimitMicrodollars: 12_500_000,
    });
  });

  it('saves the complete model configuration through the atomic service', async () => {
    const save = vi.fn().mockResolvedValue({ id: 'model-1', publicId: 'team-model' });
    container.registerInstance(InferenceModelConfigurationService, {
      save,
    } as unknown as InferenceModelConfigurationService);
    const configuration = {
      model: {
        publicId: 'team-model',
        displayName: 'Team model',
        contextWindow: 128_000,
        maxInputTokens: 120_000,
        maxOutputTokens: null,
        autoCompactTokenLimit: 100_000,
        modalities: ['text'],
        capabilities: { tools: true, reasoning: true },
        reasoningEfforts: ['high', 'ultra'],
        defaultReasoningEffort: 'high',
        defaultAccessAllowed: true,
        subscriptionMultiplier: 2,
      },
      sources: [
        {
          connectionId: '33333333-3333-4333-8333-333333333333',
          discoveredModelId: '44444444-4444-4444-8444-444444444444',
          reasoningEffortMap: { high: 'high', ultra: 'max' },
        },
      ],
      access: { mode: 'everyone', subjects: [] },
    };

    await expect(
      executeInferenceTool({ ...USER, scopes: ['inference:models:manage'] }, 'manage_inference_model', {
        operation: 'save',
        modelId: '55555555-5555-4555-8555-555555555555',
        configuration,
      })
    ).resolves.toEqual({ id: 'model-1', publicId: 'team-model' });
    expect(save).toHaveBeenCalledWith(USER.id, '55555555-5555-4555-8555-555555555555', configuration);
  });

  it('manages complete default limits and current-user tokens with exact scopes', async () => {
    const setDefault = vi.fn().mockResolvedValue([{ policyType: 'default' }]);
    const createToken = vi.fn().mockResolvedValue({ id: 'token-1', token: 'gwi_secret' });
    const listTokens = vi.fn().mockResolvedValue([
      { id: 'token-1', status: 'active' },
      { id: 'token-2', status: 'revoked' },
    ]);
    container.registerInstance(InferenceUsageService, { setDefault } as unknown as InferenceUsageService);
    container.registerInstance(InferenceTokenService, { createToken, listTokens } as unknown as InferenceTokenService);
    const policy = {
      enabled: true,
      credits5hEnabled: true,
      credits5h: 100,
      credits7dEnabled: true,
      credits7d: 500,
      credits30dEnabled: false,
      credits30d: 0,
      apiMonthlyMicrodollars: 10_000_000,
      billingTimezone: 'Europe/Chisinau',
    };

    await executeInferenceTool({ ...USER, scopes: ['inference:limits:manage'] }, 'manage_inference_limits', {
      operation: 'set_default',
      policy,
    });
    await expect(
      executeInferenceTool({ ...USER, scopes: ['feat:ai:use'] }, 'manage_inference_token', {
        operation: 'create',
        name: 'Laptop',
      })
    ).resolves.toEqual({ id: 'token-1', token: 'gwi_secret' });
    await expect(
      executeInferenceTool({ ...USER, scopes: ['feat:ai:use'] }, 'manage_inference_token', {
        operation: 'list',
      })
    ).resolves.toEqual([{ id: 'token-1', status: 'active' }]);

    expect(setDefault).toHaveBeenCalledWith(USER.id, policy);
    expect(createToken).toHaveBeenCalledWith(USER.id, { name: 'Laptop' });
  });

  it('does not bypass the persisted inference feature toggle', async () => {
    container.registerInstance(GeneralSettingsService, {
      isFeatureEnabled: vi.fn().mockResolvedValue(false),
    } as unknown as GeneralSettingsService);

    await expect(
      executeInferenceTool({ ...USER, scopes: ['feat:ai:use'] }, 'manage_inference_token', {
        operation: 'create',
        name: 'Laptop',
      })
    ).rejects.toThrow(/Inference is disabled/);
  });
});
