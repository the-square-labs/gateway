import { describe, expect, it, vi } from 'vitest';
import type { User } from '@/types.js';
import { IntegrationsGitRepositoryService } from './integrations.service.git-repositories.js';

describe('Git repository permission diagnostics', () => {
  it.each([
    // Repository writes need repo:write (like GitLab), not connector admin (:manage).
    ['githubUpsertRepositoryFile', 'integrations:github:repo:write'],
    ['githubUpsertActionsVariable', 'integrations:github:repo:write'],
    ['githubUpsertActionsSecret', 'integrations:github:repo:write'],
    ['gitUpsertRepositoryFile', 'integrations:git:repo:write'],
  ] as const)('%s names the checked permission before resolving credentials', async (method, requiredScope) => {
    // No dependencies: a denial must occur before repository/credential resolution.
    const service = Object.create(IntegrationsGitRepositoryService.prototype) as IntegrationsGitRepositoryService;
    await expect(
      service[method]({ id: 'user-1', scopes: [] } as unknown as User, {
        connectorId: 'connector-1',
        repositoryUrl: 'https://example.invalid/repo.git',
        path: 'file.txt',
        branch: 'main',
        message: 'test',
        content: 'test',
        name: 'TEST',
        value: 'test-secret',
      })
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      message: expect.stringContaining(`Required permission: ${requiredScope}`),
      details: { requiredScope },
    });
  });
});

describe('Personal Git credential fallback for remote MCP', () => {
  function createService(provider: 'github' | 'git') {
    const service = Object.create(IntegrationsGitRepositoryService.prototype) as IntegrationsGitRepositoryService;
    const resolveAuth = vi.fn().mockResolvedValue({ auth: { token: 'personal-token' }, gitlabUsername: 'alice' });
    Object.assign(service, {
      getConnectorRow: vi.fn().mockResolvedValue({
        id: 'connector-1',
        name: 'Main connector',
        enabled: true,
        baseUrl: provider === 'github' ? 'https://github.com' : 'https://git.example.com',
        allowlistMode: 'all_visible',
        encryptedToken: 'system-token',
      }),
      listAllowlistRows: vi.fn().mockResolvedValue([]),
      gitLabUserCredentials: { resolveAuth },
      decryptToken: vi.fn().mockReturnValue('system-token'),
    });
    const internals = service as unknown as {
      resolveGitHubAccount(user: User, connectorId: string): Promise<{ token: string }>;
      resolveGitRepository(
        user: User,
        provider: 'github' | 'git',
        connectorId: string,
        repositoryUrl: string
      ): Promise<{ token: string }>;
    };
    const resolve = (user: User) =>
      provider === 'github'
        ? internals.resolveGitHubAccount(user, 'connector-1')
        : internals.resolveGitRepository(user, 'git', 'connector-1', 'https://git.example.com/acme/app.git');
    return { resolve, resolveAuth };
  }

  it.each([
    'github',
    'git',
  ] as const)('lets a %s token use its owner personal credential without AI Workspace access', async (provider) => {
    const { resolve, resolveAuth } = createService(provider);
    const scopes = [`integrations:${provider}:repo:read`];

    await expect(resolve({ id: 'user-1', scopes, accountScopes: scopes } as unknown as User)).resolves.toMatchObject({
      token: 'personal-token',
    });
    // AI Workspace sessions carry no accountScopes and keep the personal fallback too.
    await expect(resolve({ id: 'user-1', scopes } as unknown as User)).resolves.toMatchObject({
      token: 'personal-token',
    });
    expect(resolveAuth).toHaveBeenCalledTimes(2);
  });

  it.each(['github', 'git'] as const)('uses the connector credential with integrations:%s:use', async (provider) => {
    const { resolve, resolveAuth } = createService(provider);
    const scopes = [`integrations:${provider}:repo:read`, `integrations:${provider}:use`];

    await expect(resolve({ id: 'user-1', scopes } as unknown as User)).resolves.toMatchObject({
      token: 'system-token',
    });
    expect(resolveAuth).not.toHaveBeenCalled();
  });

  it.each([
    'github',
    'git',
  ] as const)('refuses repository reads without integrations:%s:repo:read', async (provider) => {
    const { resolve, resolveAuth } = createService(provider);

    await expect(
      resolve({ id: 'user-1', scopes: [`integrations:${provider}:manage`] } as unknown as User)
    ).rejects.toMatchObject({ statusCode: 403, code: 'CONNECTOR_SCOPE_DENIED' });
    expect(resolveAuth).not.toHaveBeenCalled();
  });
});

describe('GitHub Actions variable reads', () => {
  function createService() {
    const service = Object.create(IntegrationsGitRepositoryService.prototype) as IntegrationsGitRepositoryService;
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ variables: [{ name: 'API_URL', value: 'https://api.example.com' }] }), {
        status: 200,
      })
    );
    Object.assign(service, {
      getConnectorRow: vi.fn().mockResolvedValue({
        id: 'connector-1',
        name: 'Main connector',
        enabled: true,
        baseUrl: 'https://github.com',
        allowlistMode: 'all_visible',
        encryptedToken: 'system-token',
      }),
      listAllowlistRows: vi.fn().mockResolvedValue([]),
      resolveGitHubConnectorToken: vi.fn().mockResolvedValue('system-token'),
      githubConnectorRequest: request,
    });
    return { service, request };
  }
  const input = { connectorId: 'connector-1', repositoryUrl: 'https://github.com/acme/app' };

  it('treats variable values as secrets: repo:read is not enough', async () => {
    const { service, request } = createService();
    const scopes = ['integrations:github:repo:read', 'integrations:github:use'];

    await expect(
      service.githubListActionsVariables({ id: 'user-1', scopes } as unknown as User, input)
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'CONNECTOR_SCOPE_DENIED',
      details: { requiredScopes: ['integrations:github:repo:write'] },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('returns variable values with repo:write', async () => {
    const { service } = createService();
    const scopes = ['integrations:github:repo:write', 'integrations:github:use'];

    await expect(
      service.githubListActionsVariables({ id: 'user-1', scopes } as unknown as User, input)
    ).resolves.toEqual([expect.objectContaining({ name: 'API_URL', value: 'https://api.example.com' })]);
  });
});
