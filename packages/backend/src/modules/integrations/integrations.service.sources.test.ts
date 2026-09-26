import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/types.js';
import { clearGitHubRepositoryIdentityCache } from './integrations.service.git-support.js';
import { IntegrationsService } from './integrations.service.js';

const CONNECTOR_ID = '33333333-3333-4333-8333-333333333333';

function githubRepository(id: number, name: string, ownerId: number, owner: string) {
  return {
    id,
    name,
    full_name: `${owner}/${name}`,
    html_url: `https://github.com/${owner}/${name}`,
    default_branch: 'main',
    owner: { id: ownerId, login: owner, type: 'Organization' },
  };
}

function fixture(enabled = true) {
  const connector = {
    id: CONNECTOR_ID,
    provider: 'github',
    name: 'GitHub',
    enabled,
    baseUrl: 'https://github.com',
    encryptedToken: 'encrypted',
  };
  const personal = vi.fn().mockResolvedValue(null);
  const connectorToken = vi.fn().mockResolvedValue('connector-token');
  const request = vi.fn(
    async (_connector: unknown, _token: string, path: string) =>
      new Response(
        JSON.stringify(
          path.startsWith('/repos/acme/app') || path === '/repositories/123'
            ? githubRepository(123, 'app', 7, 'acme')
            : [githubRepository(123, 'app', 7, 'acme'), githubRepository(124, 'other', 8, 'globex')]
        ),
        { status: 200 }
      )
  );
  const service = Object.assign(Object.create(IntegrationsService.prototype), {
    getConnectorRow: vi.fn().mockResolvedValue(connector),
    resolveGitHubConnectorToken: connectorToken,
    githubConnectorRequest: request,
    gitLabUserCredentials: { resolveAuth: personal },
    upsertProjectRows: vi.fn(),
    db: {
      select: () => ({
        from: () => ({
          where: async () => [
            { id: 'project-1', remoteId: '123' },
            { id: 'project-2', remoteId: '124' },
          ],
        }),
      }),
    },
  }) as IntegrationsService;
  return { service, personal, connectorToken, request, connector };
}

beforeEach(() => clearGitHubRepositoryIdentityCache());

describe('PaaS repository discovery', () => {
  it('lists only the repositories the caller may see, through the connector credential', async () => {
    const { service, personal, connectorToken, request } = fixture();
    const list = (scopes: string[]) =>
      service.listDockerBuildSourceRepositories({ id: 'user-1', scopes } as User, CONNECTOR_ID);

    // Workload scopes alone open the picker but cover no repository.
    await expect(list(['docker:containers:create'])).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();

    // A repository-qualified use grant implies view of exactly that repository.
    await expect(
      list(['docker:containers:create', `integrations:github:use:${CONNECTOR_ID}/repo/123`])
    ).resolves.toEqual([
      expect.objectContaining({ connectorId: CONNECTOR_ID, projectId: 'project-1', fullPath: 'acme/app' }),
    ]);
    // An owner grant covers every repository of that owner.
    await expect(list([`integrations:github:view:${CONNECTOR_ID}/owner/8`])).resolves.toEqual([
      expect.objectContaining({ projectId: 'project-2', fullPath: 'globex/other' }),
    ]);
    // The connector qualifier covers everything.
    await expect(list([`integrations:github:repo:read:${CONNECTOR_ID}`])).resolves.toHaveLength(2);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ id: CONNECTOR_ID }),
      'connector-token',
      expect.any(String)
    );
    expect(connectorToken).toHaveBeenCalled();
    expect(personal).not.toHaveBeenCalled();
  });

  it('keeps ordinary browsing on the caller scopes and names the missing credential scope', async () => {
    const { service, personal } = fixture();
    const user = { id: 'user-1', scopes: ['docker:containers:view'] } as User;
    await expect(service.githubListRepositories(user, { connectorId: CONNECTOR_ID })).rejects.toMatchObject({
      code: 'CONNECTOR_SCOPE_DENIED',
    });
    // repo:read without use or a personal credential: a 403 for tokens and plain users...
    await expect(
      service.githubListRepositories(
        { ...user, scopes: ['integrations:github:repo:read'] },
        { connectorId: CONNECTOR_ID }
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'CONNECTOR_SCOPE_DENIED',
      message: expect.stringMatching(/personal GitHub authorization.*integrations:github:use/),
    });
    // ...and the authorization prompt for AI Workspace users.
    await expect(
      service.githubListRepositories(
        { ...user, scopes: ['integrations:github:repo:read', 'ai:workspace:use'] },
        { connectorId: CONNECTOR_ID }
      )
    ).rejects.toMatchObject({ statusCode: 428, code: 'GITHUB_CREDENTIAL_REQUIRED' });
    expect(personal).toHaveBeenCalledTimes(2);
  });

  it('lists only the repositories an owner-qualified read grant covers', async () => {
    const { service } = fixture();
    const repositories = await service.githubListRepositories(
      {
        id: 'user-1',
        scopes: [`integrations:github:repo:read:${CONNECTOR_ID}/owner/7`, 'integrations:github:use'],
      } as User,
      { connectorId: CONNECTOR_ID }
    );
    expect(repositories.map((repository) => repository.fullName)).toEqual(['acme/app']);
  });

  it('rejects a disabled connector before reading any credential', async () => {
    const { service, personal, connectorToken, request } = fixture(false);
    await expect(
      service.listDockerBuildSourceRepositories(
        { id: 'user-1', scopes: [`integrations:github:use:${CONNECTOR_ID}`] } as User,
        CONNECTOR_ID
      )
    ).rejects.toMatchObject({ code: 'CONNECTOR_DISABLED' });
    expect(connectorToken).not.toHaveBeenCalled();
    expect(personal).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('Configuring a build source', () => {
  function sourceFixture(project: { id: string; remoteId: string; fullPath: string }) {
    const { service, connector, request, personal } = fixture();
    const limit = vi.fn().mockResolvedValue([
      {
        connector,
        project: {
          ...project,
          name: project.fullPath.split('/')[1],
          webUrl: `https://github.com/${project.fullPath}`,
        },
      },
    ]);
    Object.assign(service, {
      db: { select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit }) }) }) }) },
    });
    return { service, request, personal };
  }
  const app = { id: 'project-1', remoteId: '123', fullPath: 'acme/app' };
  const other = { id: 'project-2', remoteId: '124', fullPath: 'globex/other' };

  it('needs only integrations:github:use on the repository', async () => {
    const scopes = [`integrations:github:use:${CONNECTOR_ID}/repo/123`, 'docker:containers:create'];
    const allowed = sourceFixture(app);
    await expect(
      allowed.service.assertBuildSourceRepositoryAccess({ id: 'user-1', scopes } as User, {
        connectorId: CONNECTOR_ID,
        projectId: app.id,
      })
    ).resolves.toBeUndefined();
    // No repo:read, no personal credential, and no provider call for an exact repository grant.
    expect(allowed.personal).not.toHaveBeenCalled();
    expect(allowed.request).not.toHaveBeenCalled();

    const refused = sourceFixture(other);
    await expect(
      refused.service.assertBuildSourceRepositoryAccess({ id: 'user-1', scopes } as User, {
        connectorId: CONNECTOR_ID,
        projectId: other.id,
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'CONNECTOR_SCOPE_DENIED',
      message: 'Access to repository globex/other is not granted. Required permission: integrations:github:use',
      details: expect.objectContaining({ repository: 'globex/other', requiredScopes: ['integrations:github:use'] }),
    });
  });

  it('resolves owner grants through the repository owner ID', async () => {
    const { service, request } = sourceFixture(app);
    await expect(
      service.assertBuildSourceRepositoryAccess(
        { id: 'user-1', scopes: [`integrations:github:use:${CONNECTOR_ID}/owner/7`] } as User,
        { connectorId: CONNECTOR_ID, projectId: app.id }
      )
    ).resolves.toBeUndefined();
    // Looked up by the stored repository ID (never by path), fresh: the source decides the build credential.
    expect(request).toHaveBeenCalledWith(expect.anything(), 'connector-token', '/repositories/123');
    await expect(
      service.assertBuildSourceRepositoryAccess(
        { id: 'user-1', scopes: [`integrations:github:repo:read:${CONNECTOR_ID}`] } as User,
        { connectorId: CONNECTOR_ID, projectId: app.id }
      )
    ).rejects.toMatchObject({ code: 'CONNECTOR_SCOPE_DENIED' });
  });
});

describe('Automatic builds of a configured source', () => {
  function ownerFixture(owner: { scopes: string[]; isBlocked?: boolean } | null) {
    const { service, connector } = fixture();
    const limit = vi.fn().mockResolvedValue([
      {
        connector,
        project: {
          id: 'project-1',
          remoteId: '123',
          fullPath: 'acme/app',
          name: 'app',
          webUrl: 'https://github.com/acme/app',
        },
      },
    ]);
    Object.assign(service, {
      db: {
        select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit }) }) }) }),
        query: {
          users: {
            findFirst: vi.fn().mockResolvedValue(
              owner
                ? {
                    id: 'owner-1',
                    email: 'owner@example.com',
                    groupId: 'owners',
                    additionalScopes: [],
                    additionalGroupIds: [],
                    isBlocked: owner.isBlocked ?? false,
                    deletedAt: null,
                  }
                : undefined
            ),
          },
          permissionGroups: {
            findMany: vi
              .fn()
              .mockResolvedValue([
                { id: 'owners', parentId: null, name: 'owners', scopes: owner?.scopes ?? [], requireGateway2fa: false },
              ]),
          },
        },
      },
    });
    return service;
  }
  const input = { connectorId: CONNECTOR_ID, projectId: 'project-1' };

  it('keeps building while the saver holds use on the repository', async () => {
    const service = ownerFixture({ scopes: [`integrations:github:use:${CONNECTOR_ID}/repo/123`] });
    await expect(service.assertBuildSourceOwnerAccess('owner-1', input)).resolves.toBeUndefined();
  });

  it.each([
    ['revoked use', { scopes: [`integrations:github:use:${CONNECTOR_ID}/repo/999`] }, 'owner@example.com'],
    [
      'a blocked account',
      { scopes: ['integrations:github:use'], isBlocked: true },
      'the account that saved this source',
    ],
    ['a deleted account', null, 'the account that saved this source'],
  ])('pauses automatic builds after %s, naming the account and repository', async (_label, owner, who) => {
    const service = ownerFixture(owner);
    await expect(
      service.assertBuildSourceOwnerAccess('owner-1', { ...input, repositoryFullPath: 'acme/app' })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'SOURCE_OWNER_ACCESS_REVOKED',
      message: `Build paused: ${who} no longer has use on acme/app`,
    });
  });
});
