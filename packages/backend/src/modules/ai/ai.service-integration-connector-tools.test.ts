import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { ExternalSshService } from '@/modules/integrations/external-ssh.service.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { listAvailableMcpTools } from '@/modules/mcp/mcp-tools.js';
import { AIService } from './ai.service.js';

const CONNECTOR_ID = '11111111-2222-4333-8444-555555555555';

const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [] as string[],
  isBlocked: false,
};

function createService() {
  return new AIService(
    {} as never,
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
    {} as never
  );
}

function connectorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTOR_ID,
    name: 'Main',
    baseUrl: 'https://example.com',
    enabled: true,
    authMode: 'token',
    tokenMasked: '****abcd',
    hasToken: true,
    syncStatus: 'success',
    syncLastError: null,
    syncFinishedAt: null,
    testedAt: null,
    ...overrides,
  };
}

function mockServices(integrations: Record<string, unknown>, ssh: Record<string, unknown> = {}) {
  vi.spyOn(container, 'resolve').mockImplementation((token) => {
    if (token === IntegrationsService) return integrations as never;
    if (token === ExternalSshService) return ssh as never;
    throw new Error('unexpected resolver call');
  });
}

describe('integration connector AI/MCP tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('advertises the connector tools through MCP in the Integrations category only for matching scopes', () => {
    const names = (scopes: string[]) => listAvailableMcpTools(scopes).map((tool) => tool.name);

    expect(names(['integrations:cloudflare:view'])).toContain('list_integration_connectors');
    expect(names(['integrations:cloudflare:view'])).not.toContain('sync_integration_connector');
    expect(names(['integrations:gitlab:manage'])).toContain('sync_integration_connector');
    expect(names(['integrations:cloudflare:sync'])).toContain('sync_integration_connector');
    expect(names(['integrations:github:manage'])).toContain('sync_integration_connector');
    expect(names(['integrations:cloudflare:manage'])).toEqual(
      expect.arrayContaining(['list_integration_connectors', 'sync_integration_connector'])
    );
    expect(names(['docker:volumes:view'])).not.toContain('list_integration_connectors');
    expect(
      listAvailableMcpTools(['integrations:gitlab:manage']).find((tool) => tool.name === 'sync_integration_connector')
    ).toMatchObject({ category: 'Integrations', destructive: false });
  });

  it('syncs a GitLab connector with integrations:gitlab:manage', async () => {
    const integrations = { syncGitLabConnector: vi.fn().mockResolvedValue({ status: 'success', projectCount: 3 }) };
    mockServices(integrations);

    await expect(
      createService().executeTool(
        { ...BASE_USER, scopes: ['integrations:gitlab:manage'] },
        'sync_integration_connector',
        { provider: 'gitlab', connectorId: CONNECTOR_ID }
      )
    ).resolves.toEqual({
      result: { provider: 'gitlab', connectorId: CONNECTOR_ID, result: { status: 'success', projectCount: 3 } },
      invalidateStores: [],
    });
    expect(integrations.syncGitLabConnector).toHaveBeenCalledWith(CONNECTOR_ID, 'user-1');
  });

  it('enforces the per-provider route scope, not just any sync scope', async () => {
    const integrations = { syncCloudflareConnector: vi.fn(), syncGitConnector: vi.fn() };
    mockServices(integrations);
    const service = createService();

    const cloudflare = await service.executeTool(
      { ...BASE_USER, scopes: ['integrations:gitlab:manage'] },
      'sync_integration_connector',
      { provider: 'cloudflare', connectorId: CONNECTOR_ID }
    );
    expect(cloudflare.error).toContain('Missing required connector scope');

    const git = await service.executeTool(
      { ...BASE_USER, scopes: ['integrations:github:manage'] },
      'sync_integration_connector',
      { provider: 'git', connectorId: CONNECTOR_ID }
    );
    expect(git.error).toContain('Missing required connector scope');

    const viewOnly = await service.executeTool(
      { ...BASE_USER, scopes: ['integrations:cloudflare:view'] },
      'sync_integration_connector',
      { provider: 'cloudflare', connectorId: CONNECTOR_ID }
    );
    expect(viewOnly.error).toContain('PERMISSION_DENIED');

    expect(integrations.syncCloudflareConnector).not.toHaveBeenCalled();
    expect(integrations.syncGitConnector).not.toHaveBeenCalled();
  });

  it('syncs Cloudflare over MCP with only integrations:cloudflare:sync', async () => {
    const integrations = { syncCloudflareConnector: vi.fn().mockResolvedValue({ status: 'success', zoneCount: 2 }) };
    mockServices(integrations);

    await expect(
      createService().executeTool(
        { ...BASE_USER, scopes: ['integrations:cloudflare:sync'] },
        'sync_integration_connector',
        { provider: 'cloudflare', connectorId: CONNECTOR_ID },
        { source: 'mcp', scopes: ['integrations:cloudflare:sync'] }
      )
    ).resolves.toMatchObject({ result: { provider: 'cloudflare', result: { status: 'success', zoneCount: 2 } } });
    expect(integrations.syncCloudflareConnector).toHaveBeenCalledWith(CONNECTOR_ID, 'user-1');
  });

  it('checks the MCP token scopes rather than the broader account scopes', async () => {
    const integrations = { syncCloudflareConnector: vi.fn() };
    mockServices(integrations);

    const result = await createService().executeTool(
      { ...BASE_USER, scopes: ['integrations:cloudflare:manage', 'integrations:gitlab:manage'] },
      'sync_integration_connector',
      { provider: 'cloudflare', connectorId: CONNECTOR_ID },
      { source: 'mcp', scopes: ['integrations:gitlab:manage'] }
    );

    expect(result.error).toContain('Missing required connector scope');
    expect(integrations.syncCloudflareConnector).not.toHaveBeenCalled();
  });

  it('syncs Git connectors without returning credential metadata', async () => {
    const integrations = {
      syncGitConnector: vi.fn().mockResolvedValue({
        ...connectorRow(),
        allowlistEntries: [{ id: 'entry-1' }, { id: 'entry-2' }],
      }),
    };
    mockServices(integrations);

    const { result, error } = await createService().executeTool(
      { ...BASE_USER, scopes: ['integrations:github:manage'] },
      'sync_integration_connector',
      { provider: 'github', connectorId: CONNECTOR_ID }
    );

    expect(error).toBeUndefined();
    expect(integrations.syncGitConnector).toHaveBeenCalledWith('github', CONNECTOR_ID, 'user-1');
    expect(result).toMatchObject({
      provider: 'github',
      result: { id: CONNECTOR_ID, provider: 'github', repositoryCount: 2 },
    });
    expect(JSON.stringify(result)).not.toContain('abcd');
  });

  it('re-tests SSH connectors through ExternalSshService with the execution user', async () => {
    const ssh = { test: vi.fn().mockResolvedValue({ success: true }) };
    mockServices({}, ssh);

    await expect(
      createService().executeTool({ ...BASE_USER, scopes: ['integrations:ssh:manage'] }, 'sync_integration_connector', {
        provider: 'ssh',
        connectorId: CONNECTOR_ID,
      })
    ).resolves.toMatchObject({ result: { provider: 'ssh', result: { success: true } } });
    expect(ssh.test).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1', scopes: ['integrations:ssh:manage'] }),
      CONNECTOR_ID
    );
  });

  it('lists only the providers the caller may view and reports providers that fail', async () => {
    const integrations = {
      listGitLabConnectors: vi.fn(),
      listCloudflareConnectors: vi.fn().mockResolvedValue([{ ...connectorRow(), zones: [{ id: 'zone-1' }] }]),
      listGitConnectors: vi.fn().mockRejectedValue(new AppError(503, 'UNAVAILABLE', 'Git unavailable')),
    };
    const ssh = { list: vi.fn() };
    mockServices(integrations, ssh);

    const { result, error } = await createService().executeTool(
      { ...BASE_USER, scopes: ['integrations:cloudflare:view', 'integrations:git:view'] },
      'list_integration_connectors',
      { enabled: true }
    );

    expect(error).toBeUndefined();
    expect(result).toEqual({
      connectors: [expect.objectContaining({ provider: 'cloudflare', id: CONNECTOR_ID, zoneCount: 1 })],
      unavailableProviders: [{ provider: 'git', error: 'Git unavailable' }],
    });
    expect(JSON.stringify(result)).not.toContain('abcd');
    expect(integrations.listCloudflareConnectors).toHaveBeenCalledWith({ enabled: true });
    expect(integrations.listGitConnectors).toHaveBeenCalledWith('git', true);
    expect(integrations.listGitLabConnectors).not.toHaveBeenCalled();
    expect(ssh.list).not.toHaveBeenCalled();
  });

  it('refuses an explicit provider the caller may not view', async () => {
    const integrations = { listGitLabConnectors: vi.fn() };
    mockServices(integrations);

    const result = await createService().executeTool(
      { ...BASE_USER, scopes: ['integrations:cloudflare:view'] },
      'list_integration_connectors',
      { provider: 'gitlab' }
    );

    expect(result.error).toContain('Missing required connector scope');
    expect(integrations.listGitLabConnectors).not.toHaveBeenCalled();
  });

  it('manages connectors through manage_integration_connector with the route scopes and schemas', async () => {
    const integrations = {
      getCloudflareConnector: vi.fn().mockResolvedValue(connectorRow()),
      updateCloudflareConnector: vi.fn().mockResolvedValue(connectorRow({ name: 'Renamed' })),
      rotateGitLabConnectorToken: vi.fn().mockResolvedValue(connectorRow()),
      deleteGitConnector: vi.fn().mockResolvedValue(undefined),
      previewGitConnectorTest: vi.fn().mockResolvedValue({ ok: true }),
    };
    const ssh = { discoverHostKey: vi.fn().mockResolvedValue({ fingerprint: 'SHA256:abc' }) };
    mockServices(integrations, ssh);
    const service = createService();
    const run = (scopes: string[], args: Record<string, unknown>) =>
      service.executeTool({ ...BASE_USER, scopes }, 'manage_integration_connector', args);

    // Reads accept view or manage; writes need manage on the provider.
    await expect(
      run(['integrations:cloudflare:view'], { provider: 'cloudflare', operation: 'get', connectorId: CONNECTOR_ID })
    ).resolves.toMatchObject({ result: { id: CONNECTOR_ID } });
    await expect(
      run(['integrations:cloudflare:view'], {
        provider: 'cloudflare',
        operation: 'update',
        connectorId: CONNECTOR_ID,
        name: 'Renamed',
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('Missing required connector scope') });
    await expect(
      run(['integrations:cloudflare:manage'], {
        provider: 'cloudflare',
        operation: 'update',
        connectorId: CONNECTOR_ID,
        name: 'Renamed',
        settings: { defaultProxied: false },
      })
    ).resolves.toMatchObject({ result: { name: 'Renamed' } });
    expect(integrations.updateCloudflareConnector).toHaveBeenCalledWith(
      CONNECTOR_ID,
      { name: 'Renamed', settings: { defaultProxied: false } },
      'user-1'
    );

    // Provider-specific operations are refused for other providers.
    await expect(
      run(['integrations:github:manage'], { provider: 'github', operation: 'list_zones', connectorId: CONNECTOR_ID })
    ).resolves.toMatchObject({ error: 'Operation list_zones is not available for github connectors' });

    await expect(
      run(['integrations:gitlab:manage'], {
        provider: 'gitlab',
        operation: 'rotate_token',
        connectorId: CONNECTOR_ID,
        token: 'glpat-new',
      })
    ).resolves.toMatchObject({ result: { id: CONNECTOR_ID } });
    expect(integrations.rotateGitLabConnectorToken).toHaveBeenCalledWith(CONNECTOR_ID, 'glpat-new', 'user-1');

    await expect(
      run(['integrations:git:manage'], { provider: 'git', operation: 'delete', connectorId: CONNECTOR_ID })
    ).resolves.toMatchObject({ result: { success: true } });
    expect(integrations.deleteGitConnector).toHaveBeenCalledWith('git', CONNECTOR_ID, 'user-1');

    // Candidate credentials are validated like POST /git/connectors/preview-test.
    await expect(
      run(['integrations:git:manage'], {
        provider: 'git',
        operation: 'preview_test',
        baseUrl: 'https://git.example.com',
        repositoryUrl: 'not-a-url',
        username: 'bot',
        token: 'secret',
      })
    ).resolves.toMatchObject({ error: expect.stringContaining('Invalid') });
    expect(integrations.previewGitConnectorTest).not.toHaveBeenCalled();

    await expect(
      run(['integrations:ssh:manage'], { provider: 'ssh', operation: 'discover_host_key', host: 'example.com' })
    ).resolves.toMatchObject({ result: { fingerprint: 'SHA256:abc' } });
    expect(ssh.discoverHostKey).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1' }), {
      host: 'example.com',
    });
  });

  it('creates connectors with the full route schemas', async () => {
    const integrations = { createCloudflareConnector: vi.fn().mockResolvedValue(connectorRow()) };
    const ssh = { create: vi.fn().mockResolvedValue({ id: CONNECTOR_ID }) };
    mockServices(integrations, ssh);
    const service = createService();

    await service.executeTool(
      { ...BASE_USER, scopes: ['integrations:cloudflare:manage'] },
      'create_cloudflare_connector',
      {
        name: 'CF',
        token: 'cf-token',
        settings: { defaultTtl: 300 },
      }
    );
    expect(integrations.createCloudflareConnector).toHaveBeenCalledWith(
      { name: 'CF', enabled: true, token: 'cf-token', settings: { defaultTtl: 300 } },
      'user-1'
    );

    await service.executeTool({ ...BASE_USER, scopes: ['integrations:ssh:manage'] }, 'create_ssh_connector', {
      name: 'Box',
      host: 'box.example.com',
      username: 'deploy',
      authMethod: 'private_key',
      generatePrivateKey: true,
      hostFingerprint: 'SHA256:abc',
    });
    expect(ssh.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      expect.objectContaining({ authMethod: 'private_key', generatePrivateKey: true })
    );
  });
});
