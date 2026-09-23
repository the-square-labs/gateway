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
    expect(names(['integrations:gitlab:sync'])).toContain('sync_integration_connector');
    expect(names(['integrations:cloudflare:sync'])).toContain('sync_integration_connector');
    expect(names(['integrations:github:sync'])).toContain('sync_integration_connector');
    expect(names(['integrations:cloudflare:manage'])).toEqual(
      expect.arrayContaining(['list_integration_connectors', 'sync_integration_connector'])
    );
    expect(names(['docker:volumes:view'])).not.toContain('list_integration_connectors');
    expect(
      listAvailableMcpTools(['integrations:gitlab:sync']).find((tool) => tool.name === 'sync_integration_connector')
    ).toMatchObject({ category: 'Integrations', destructive: false });
  });

  it('syncs a GitLab connector with integrations:gitlab:sync', async () => {
    const integrations = { syncGitLabConnector: vi.fn().mockResolvedValue({ status: 'success', projectCount: 3 }) };
    mockServices(integrations);

    await expect(
      createService().executeTool(
        { ...BASE_USER, scopes: ['integrations:gitlab:sync'] },
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
      { ...BASE_USER, scopes: ['integrations:gitlab:sync'] },
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
      { ...BASE_USER, scopes: ['integrations:cloudflare:manage', 'integrations:gitlab:sync'] },
      'sync_integration_connector',
      { provider: 'cloudflare', connectorId: CONNECTOR_ID },
      { source: 'mcp', scopes: ['integrations:gitlab:sync'] }
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
});
