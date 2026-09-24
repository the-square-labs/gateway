import { describe, expect, it, vi } from 'vitest';
import type { User } from '@/types.js';
import { IntegrationsGitRepositoryService } from './integrations.service.git-repositories.js';

describe('Git repository permission diagnostics', () => {
  it.each([
    ['githubUpsertRepositoryFile', 'integrations:github:manage'],
    ['githubUpsertActionsVariable', 'integrations:github:manage'],
    ['githubUpsertActionsSecret', 'integrations:github:manage'],
    ['gitUpsertRepositoryFile', 'integrations:git:manage'],
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
  ] as const)('refuses a %s token without :system when its owner lacks ai:workspace:use', async (provider) => {
    const { resolve, resolveAuth } = createService(provider);
    const scopes = [`integrations:${provider}:view`];

    await expect(resolve({ id: 'user-1', scopes, accountScopes: scopes } as unknown as User)).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERSONAL_GIT_CREDENTIAL_NOT_ALLOWED',
      message: expect.stringMatching(new RegExp(`integrations:${provider}:system.*AI Workspace`)),
    });
    expect(resolveAuth).not.toHaveBeenCalled();
  });

  it.each([
    'github',
    'git',
  ] as const)('lets a %s token use the personal credential of an AI Workspace owner', async (provider) => {
    const { resolve, resolveAuth } = createService(provider);
    const scopes = [`integrations:${provider}:view`];
    const mcpUser = { id: 'user-1', scopes, accountScopes: [...scopes, 'ai:workspace:use'] } as unknown as User;

    await expect(resolve(mcpUser)).resolves.toMatchObject({ token: 'personal-token' });
    // AI Workspace sessions carry no accountScopes and keep the personal fallback.
    await expect(resolve({ id: 'user-1', scopes } as unknown as User)).resolves.toMatchObject({
      token: 'personal-token',
    });
    expect(resolveAuth).toHaveBeenCalledTimes(2);
  });
});
