import { describe, expect, it, vi } from 'vitest';
import { boundScopes } from '@/lib/permissions.js';
import type { User } from '@/types.js';
import { IntegrationsGitRepositoryService } from './integrations.service.git-repositories.js';
import { clearGitHubRepositoryIdentityCache } from './integrations.service.git-support.js';

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

describe('Repository-qualified GitHub and generic Git scopes', () => {
  const CONNECTOR = '33333333-3333-4333-8333-333333333333';
  const OTHER_CONNECTOR = '44444444-4444-4444-8444-444444444444';
  const identities: Record<string, { id: number; owner: { id: number } }> = {
    '/repos/acme/app': { id: 123, owner: { id: 7 } },
    '/repos/globex/other': { id: 124, owner: { id: 8 } },
  };

  function createService(provider: 'github' | 'git') {
    const service = Object.create(IntegrationsGitRepositoryService.prototype) as IntegrationsGitRepositoryService;
    const resolveAuth = vi.fn().mockResolvedValue(null);
    const request = vi.fn(async (_connector: unknown, token: string, path: string) => {
      const identity = identities[path];
      if (identity) return new Response(JSON.stringify(identity), { status: 200 });
      if (path.includes('/contents/')) {
        return new Response(JSON.stringify({ path: 'README.md', sha: 'abc', encoding: 'base64', content: 'aGk=' }), {
          status: 200,
          headers: { 'x-token': token },
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    Object.assign(service, {
      getConnectorRow: vi.fn(async (id: string) => ({
        id,
        name: 'Main connector',
        enabled: true,
        baseUrl: provider === 'github' ? 'https://github.com' : 'https://git.example.com',
        allowlistMode: 'all_visible',
        encryptedToken: 'system-token',
      })),
      listAllowlistRows: vi.fn().mockResolvedValue([]),
      gitLabUserCredentials: { resolveAuth },
      resolveGitHubConnectorToken: vi.fn().mockResolvedValue('system-token'),
      githubConnectorRequest: request,
    });
    return { service, request, resolveAuth };
  }
  const user = (scopes: string[]) => ({ id: 'user-1', scopes }) as unknown as User;
  const read = (service: IntegrationsGitRepositoryService, scopes: string[], repositoryUrl: string) =>
    service.githubReadRepositoryFile(user(scopes), { connectorId: CONNECTOR, repositoryUrl, path: 'README.md' });

  it('reads a repository through its owner or its own qualifier, and nothing else', async () => {
    clearGitHubRepositoryIdentityCache();
    const { service, request } = createService('github');
    const owner = [`integrations:github:repo:read:${CONNECTOR}/owner/7`, `integrations:github:use:${CONNECTOR}`];
    await expect(read(service, owner, 'https://github.com/acme/app')).resolves.toMatchObject({ path: 'README.md' });
    await expect(read(service, owner, 'https://github.com/globex/other')).rejects.toMatchObject({
      statusCode: 403,
      code: 'CONNECTOR_SCOPE_DENIED',
      message: 'Access to repository globex/other is not granted. Required permission: integrations:github:repo:read',
    });
    const exact = [`integrations:github:repo:read:${CONNECTOR}/repo/123`, 'integrations:github:use'];
    await expect(read(service, exact, 'https://github.com/acme/app')).resolves.toMatchObject({ path: 'README.md' });
    // A path can point at another repository after a rename: lookups by URL always ask GitHub.
    expect(request.mock.calls.filter(([, , path]) => path === '/repos/acme/app')).toHaveLength(2);
  });

  it('refuses writes that a read-only qualifier does not cover', async () => {
    const { service, request } = createService('github');
    const scopes = [`integrations:github:repo:read:${CONNECTOR}/repo/123`, 'integrations:github:use'];
    await expect(
      service.githubUpsertRepositoryFile(user(scopes), {
        connectorId: CONNECTOR,
        repositoryUrl: 'https://github.com/acme/app',
        path: 'README.md',
        branch: 'main',
        message: 'Update',
        content: 'hi',
      })
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      details: { requiredScope: 'integrations:github:repo:write' },
    });
    await expect(
      service.githubUpsertActionsSecret(
        user([`integrations:github:repo:write:${CONNECTOR}/repo/124`, 'integrations:github:use']),
        { connectorId: CONNECTOR, repositoryUrl: 'https://github.com/acme/app', name: 'TOKEN', value: 'x' }
      )
    ).rejects.toMatchObject({
      code: 'CONNECTOR_SCOPE_DENIED',
      details: expect.objectContaining({ repository: 'acme/app' }),
    });
    expect(request.mock.calls.some(([, , path]) => String(path).includes('/actions/secrets'))).toBe(false);
  });

  it('picks the connector credential per repository from the use qualifier', async () => {
    clearGitHubRepositoryIdentityCache();
    const { service, request, resolveAuth } = createService('github');
    const scopes = [`integrations:github:repo:read:${CONNECTOR}`, `integrations:github:use:${CONNECTOR}/repo/123`];
    await read(service, scopes, 'https://github.com/acme/app');
    expect(request).toHaveBeenLastCalledWith(expect.anything(), 'system-token', expect.stringContaining('/contents/'));
    expect(resolveAuth).not.toHaveBeenCalled();
    // Another repository: no use grant covers it and there is no personal credential.
    await expect(read(service, scopes, 'https://github.com/globex/other')).rejects.toMatchObject({
      statusCode: 403,
      code: 'CONNECTOR_SCOPE_DENIED',
      details: expect.objectContaining({ requiredScope: 'integrations:github:use', repository: 'globex/other' }),
    });
    expect(resolveAuth).toHaveBeenCalledOnce();
  });

  it('requires a token and its owner to cover the repository (owner holds the owner, token a repository)', async () => {
    clearGitHubRepositoryIdentityCache();
    const { service } = createService('github');
    const owner = [`integrations:github:repo:read:${CONNECTOR}/owner/7`, 'integrations:github:use'];
    const tokenScopes = boundScopes(
      [
        `integrations:github:repo:read:${CONNECTOR}/repo/123`,
        `integrations:github:repo:read:${CONNECTOR}/repo/124`,
        'integrations:github:use',
      ],
      owner
    );
    const token = { id: 'user-1', scopes: tokenScopes, accountScopes: owner } as unknown as User;
    const readAs = (repositoryUrl: string) =>
      service.githubReadRepositoryFile(token, { connectorId: CONNECTOR, repositoryUrl, path: 'README.md' });

    // Repository 123 belongs to owner 7: both cover it.
    await expect(readAs('https://github.com/acme/app')).resolves.toMatchObject({ path: 'README.md' });
    // Repository 124 belongs to owner 8: the token names it, the owner does not cover it.
    await expect(readAs('https://github.com/globex/other')).rejects.toMatchObject({
      statusCode: 403,
      code: 'CONNECTOR_SCOPE_DENIED',
      details: expect.objectContaining({ repository: 'globex/other' }),
    });
  });

  it('allows only the owner repository when the token names its whole owner', async () => {
    clearGitHubRepositoryIdentityCache();
    const { service } = createService('github');
    identities['/repos/acme/tools'] = { id: 125, owner: { id: 7 } };
    const owner = [`integrations:github:repo:read:${CONNECTOR}/repo/123`, 'integrations:github:use'];
    const tokenScopes = boundScopes(
      [`integrations:github:repo:read:${CONNECTOR}/owner/7`, 'integrations:github:use'],
      owner
    );
    expect(tokenScopes).toContain(`integrations:github:repo:read:${CONNECTOR}/owner/7`);
    const token = { id: 'user-1', scopes: tokenScopes, accountScopes: owner } as unknown as User;
    const readAs = (repositoryUrl: string) =>
      service.githubReadRepositoryFile(token, { connectorId: CONNECTOR, repositoryUrl, path: 'README.md' });

    await expect(readAs('https://github.com/acme/app')).resolves.toMatchObject({ path: 'README.md' });
    // Another repository of owner 7: the token covers it, the owner does not.
    await expect(readAs('https://github.com/acme/tools')).rejects.toMatchObject({ code: 'CONNECTOR_SCOPE_DENIED' });
    await expect(readAs('https://github.com/globex/other')).rejects.toMatchObject({ code: 'CONNECTOR_SCOPE_DENIED' });
    delete identities['/repos/acme/tools'];
  });

  it('never authorizes a repository recreated at a renamed repository path with the old repository grant', async () => {
    const { service } = createService('github');
    const scopes = [`integrations:github:repo:read:${CONNECTOR}/repo/123`, 'integrations:github:use'];
    await expect(read(service, scopes, 'https://github.com/acme/app')).resolves.toMatchObject({ path: 'README.md' });
    // acme/app was renamed and a new repository now answers at the old path.
    const original = identities['/repos/acme/app'];
    identities['/repos/acme/app'] = { id: 999, owner: { id: 7 } };
    try {
      await expect(read(service, scopes, 'https://github.com/acme/app')).rejects.toMatchObject({
        code: 'CONNECTOR_SCOPE_DENIED',
      });
    } finally {
      identities['/repos/acme/app'] = original;
    }
  });

  it('caches owners by repository ID, re-reads them for credential decisions and forgets them on sync', async () => {
    clearGitHubRepositoryIdentityCache();
    const { service, request } = createService('github');
    request.mockImplementation(
      async () => new Response(JSON.stringify({ id: 123, owner: { id: 7 } }), { status: 200 })
    );
    const connector = { id: CONNECTOR, baseUrl: 'https://github.com' };
    const internals = service as unknown as {
      githubRepositoryScopeTargetById(
        c: unknown,
        token: string,
        id: string,
        options?: { fresh?: boolean }
      ): Promise<{ containerIds?: string[] }>;
    };
    const byId = (options?: { fresh?: boolean }) =>
      internals.githubRepositoryScopeTargetById(connector, 'system-token', '123', options);
    await expect(byId()).resolves.toMatchObject({ containerIds: ['7'] });
    await byId();
    expect(request).toHaveBeenCalledTimes(1);
    await byId({ fresh: true });
    expect(request).toHaveBeenCalledTimes(2);
    service.invalidateRepositoryScopeCache('github', CONNECTOR);
    await byId();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith(connector, 'system-token', '/repositories/123');
  });

  it('limits generic Git to connector qualifiers', async () => {
    const { service } = createService('git');
    const internals = service as unknown as {
      resolveGitRepository(u: User, p: 'git', c: string, url: string): Promise<{ token: string }>;
    };
    const scopes = [`integrations:git:repo:read:${CONNECTOR}`, `integrations:git:use:${CONNECTOR}`];
    await expect(
      internals.resolveGitRepository(user(scopes), 'git', CONNECTOR, 'https://git.example.com/acme/app.git')
    ).resolves.toMatchObject({ token: 'system-token' });
    await expect(
      internals.resolveGitRepository(user(scopes), 'git', OTHER_CONNECTOR, 'https://git.example.com/acme/app.git')
    ).rejects.toMatchObject({ statusCode: 403, code: 'CONNECTOR_SCOPE_DENIED' });
  });
});
