import { describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { AIService } from './ai.service.js';

const CONFIG_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['feat:ai:configure'] as string[],
  isBlocked: false,
};

const TOKEN_USER = {
  ...CONFIG_USER,
  scopes: ['feat:ai:use', 'nodes:details', 'proxy:view'] as string[],
};

function createService({
  settingsService,
  sandboxService,
}: {
  settingsService: Record<string, unknown>;
  sandboxService?: Record<string, unknown>;
}) {
  return new AIService(
    settingsService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { log: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    sandboxService as never
  );
}

describe('AIService AI settings tools', () => {
  it('reads and updates only supported AI settings fields', async () => {
    const adminConfig = {
      enabled: true,
      model: 'gpt-test',
      hasApiKey: true,
      apiKeyLast4: '1234',
    };
    const settingsService = {
      getConfigForAdmin: vi.fn().mockResolvedValue(adminConfig),
      updateConfig: vi.fn().mockResolvedValue(adminConfig),
    };
    const service = createService({ settingsService });

    await expect(service.executeTool(CONFIG_USER, 'get_ai_settings', {})).resolves.toEqual({
      result: { ...adminConfig, gatewayInferenceModels: [] },
      invalidateStores: [],
    });

    await expect(
      service.executeTool(CONFIG_USER, 'update_ai_settings', {
        model: 'gpt-new',
        maxToolRounds: 20,
        unsupported: 'ignored',
      })
    ).resolves.toEqual({
      result: { ...adminConfig, gatewayInferenceModels: [] },
      invalidateStores: ['settings'],
    });

    expect(settingsService.updateConfig).toHaveBeenCalledWith({ model: 'gpt-new', maxToolRounds: 20 });
  });

  it('rejects empty updates and exposes sandbox runtime status without sandbox execution', async () => {
    const settingsService = {
      getConfig: vi.fn().mockResolvedValue({ sandboxEnabled: true, sandboxDefaultTier: 'low' }),
      getConfigForAdmin: vi.fn(),
      updateConfig: vi.fn(),
    };
    const sandboxService = {
      status: vi.fn().mockReturnValue({ status: 'running' }),
      health: vi.fn().mockRejectedValue(new Error('socket missing')),
    };
    const service = createService({ settingsService, sandboxService });

    await expect(service.executeTool(CONFIG_USER, 'update_ai_settings', { unsupported: true })).resolves.toMatchObject({
      error: 'No supported AI settings fields were provided',
    });
    expect(settingsService.updateConfig).not.toHaveBeenCalled();

    await expect(service.executeTool(CONFIG_USER, 'get_sandbox_runtime_status', {})).resolves.toEqual({
      result: {
        enabled: true,
        defaultTier: 'low',
        status: { status: 'running' },
        health: { ok: false, error: 'socket missing' },
      },
      invalidateStores: [],
    });
  });

  it('lists tool metadata for assistant configuration audits', async () => {
    const service = createService({
      settingsService: {
        getConfigForAdmin: vi.fn(),
        updateConfig: vi.fn(),
      },
    });

    await expect(service.executeTool(CONFIG_USER, 'list_ai_tools', {})).resolves.toMatchObject({
      result: expect.arrayContaining([
        expect.objectContaining({
          name: 'get_ai_settings',
          category: 'AI Workspace',
          requiredScope: 'feat:ai:configure',
        }),
      ]),
      invalidateStores: [],
    });
  });

  it('manages current-user API tokens through browser-session-only assistant access', async () => {
    const tokensService = {
      listTokens: vi.fn().mockResolvedValue([{ id: 'token-1', name: 'Deploy', scopes: ['nodes:details'] }]),
      createToken: vi
        .fn()
        .mockResolvedValue({ id: 'token-2', name: 'Proxy', scopes: ['proxy:view'], token: 'gw_secret' }),
      updateToken: vi.fn().mockResolvedValue(undefined),
      revokeToken: vi.fn().mockResolvedValue(undefined),
    };
    const resolveSpy = vi.spyOn(container, 'resolve').mockImplementation((token) => {
      if (token === TokensService) return tokensService as never;
      throw new Error('Unexpected container resolve');
    });
    const service = createService({
      settingsService: {
        getConfigForAdmin: vi.fn(),
        updateConfig: vi.fn(),
      },
    });

    try {
      await expect(service.executeTool(TOKEN_USER, 'manage_api_token', { operation: 'list' })).resolves.toEqual({
        result: [{ id: 'token-1', name: 'Deploy', scopes: ['nodes:details'] }],
        invalidateStores: ['settings'],
      });
      expect(tokensService.listTokens).toHaveBeenCalledWith('user-1');

      await expect(
        service.executeTool(TOKEN_USER, 'manage_api_token', {
          operation: 'create',
          name: 'Proxy',
          scopes: ['proxy:view'],
        })
      ).resolves.toEqual({
        result: { id: 'token-2', name: 'Proxy', scopes: ['proxy:view'], token: 'gw_secret' },
        invalidateStores: ['settings'],
      });
      expect(tokensService.createToken).toHaveBeenCalledWith('user-1', { name: 'Proxy', scopes: ['proxy:view'] });

      await expect(
        service.executeTool(TOKEN_USER, 'manage_api_token', {
          operation: 'update',
          tokenId: 'token-2',
          scopes: ['nodes:details'],
        })
      ).resolves.toEqual({ result: { success: true }, invalidateStores: ['settings'] });
      expect(tokensService.updateToken).toHaveBeenCalledWith('user-1', 'token-2', { scopes: ['nodes:details'] });

      await expect(
        service.executeTool(TOKEN_USER, 'manage_api_token', { operation: 'revoke', tokenId: 'token-2' })
      ).resolves.toEqual({ result: { success: true }, invalidateStores: ['settings'] });
      expect(tokensService.revokeToken).toHaveBeenCalledWith('user-1', 'token-2');
    } finally {
      resolveSpy.mockRestore();
    }
  });
});
