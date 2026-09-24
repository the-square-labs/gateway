import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { InferenceUsageService } from '@/modules/inference/accounting/inference-usage.service.js';
import { InferenceCoreRuntimeService } from '@/modules/inference/core/inference-core-runtime.service.js';
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
    const user = { ...USER, scopes: ['feat:ai:use', 'inference:providers:manage'] };

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
      executeInferenceTool({ ...USER, scopes: ['feat:ai:use', 'inference:models:manage'] }, 'manage_inference_model', {
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

    await executeInferenceTool(
      { ...USER, scopes: ['feat:ai:use', 'inference:limits:manage'] },
      'manage_inference_limits',
      {
        operation: 'set_default',
        policy,
      }
    );
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
    ).resolves.toEqual([
      { id: 'token-1', status: 'active' },
      { id: 'token-2', status: 'revoked' },
    ]);

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

  it('requires feat:ai:use on the account like the inference management routes', async () => {
    const service = { listConnections: vi.fn().mockResolvedValue([]) };
    container.registerInstance(InferenceProviderService, service as unknown as InferenceProviderService);
    const getUserById = vi.fn().mockResolvedValue({ ...USER, scopes: ['inference:providers:view'] });
    container.registerInstance(AuthService, { getUserById } as unknown as AuthService);
    // Token-bounded MCP scopes never carry the user-only feat:ai:use; the account decides.
    const mcpUser = { ...USER, scopes: ['inference:providers:view'] };

    await expect(
      executeInferenceTool(mcpUser, 'manage_inference_provider', { operation: 'list_connections' })
    ).rejects.toThrow('feat:ai:use is required');
    getUserById.mockResolvedValue({ ...USER, scopes: ['feat:ai:use', 'inference:providers:view'] });
    await expect(
      executeInferenceTool(mcpUser, 'manage_inference_provider', { operation: 'list_connections' })
    ).resolves.toEqual([]);
  });

  it('reads usage with the route scopes and manages the core while inference is disabled', async () => {
    const usage = {
      self: vi.fn().mockResolvedValue({ used: 1 }),
      adminOverview: vi.fn().mockResolvedValue({ total: 2 }),
      activity: vi.fn().mockResolvedValue({ data: [] }),
      resetUserLimits: vi.fn().mockResolvedValue({ reset: true }),
    };
    container.registerInstance(InferenceUsageService, usage as unknown as InferenceUsageService);
    const core = { getStatus: vi.fn().mockResolvedValue({ installed: false }), install: vi.fn() };
    container.registerInstance(InferenceCoreRuntimeService, core as unknown as InferenceCoreRuntimeService);

    await expect(
      executeInferenceTool({ ...USER, scopes: ['feat:ai:use'] }, 'manage_inference_usage', { operation: 'self' })
    ).resolves.toEqual({ used: 1 });
    await expect(
      executeInferenceTool({ ...USER, scopes: ['feat:ai:use'] }, 'manage_inference_usage', { operation: 'system' })
    ).rejects.toThrow('inference:usage:view');
    await executeInferenceTool({ ...USER, scopes: ['feat:ai:use', 'inference:usage:view'] }, 'manage_inference_usage', {
      operation: 'activity',
      status: 'failed',
      limit: 10,
    });
    expect(usage.activity).toHaveBeenCalledWith({ status: 'failed', limit: 10 });
    await expect(
      executeInferenceTool({ ...USER, scopes: ['feat:ai:use', 'inference:limits:manage'] }, 'manage_inference_limits', {
        operation: 'reset_user',
        userId: '66666666-6666-4666-8666-666666666666',
      })
    ).resolves.toEqual({ reset: true });
    expect(usage.resetUserLimits).toHaveBeenCalledWith(USER.id, '66666666-6666-4666-8666-666666666666');

    // The core lifecycle routes are exempt from the inference feature flag.
    container.registerInstance(GeneralSettingsService, {
      isFeatureEnabled: vi.fn().mockResolvedValue(false),
    } as unknown as GeneralSettingsService);
    await expect(
      executeInferenceTool(
        { ...USER, scopes: ['feat:ai:use', 'inference:providers:view'] },
        'manage_inference_provider',
        {
          operation: 'core_status',
        }
      )
    ).resolves.toEqual({ installed: false });
    await expect(
      executeInferenceTool(
        { ...USER, scopes: ['feat:ai:use', 'inference:providers:view'] },
        'manage_inference_provider',
        {
          operation: 'core_install',
        }
      )
    ).rejects.toThrow('inference:providers:manage');
    expect(core.install).not.toHaveBeenCalled();
  });
});
