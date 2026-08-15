import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { IntegrationsService } from './integrations.service.js';

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

function connectorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'gitlab',
    name: 'Main GitLab',
    baseUrl: 'https://gitlab.example.com',
    enabled: true,
    encryptedToken: 'encrypted-token',
    tokenLast4: 'abcd',
    allowlistMode: 'selected',
    settings: {
      autoSyncEnabled: true,
      autoSyncIntervalSeconds: 900,
      cloneShallow: true,
      cloneDepth: 1,
      cloneLfs: false,
      cloneSubmodules: false,
      cloneMaxSizeMb: 1024,
      cloneTimeoutSeconds: 300,
    },
    capabilities: { projectsView: true },
    syncStatus: 'never',
    syncLastError: null,
    syncFailureCount: 0,
    syncStartedAt: null,
    syncFinishedAt: null,
    syncLastOverlapAt: null,
    syncNextRetryAt: null,
    testedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function createListDb(rows: unknown[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue(rows),
        })),
      })),
    })),
  };
}

function createGetDb(row: unknown) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([row]),
        })),
      })),
    })),
  };
}

function createGetUpdateDb(row: unknown) {
  return {
    ...createGetDb(row),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  };
}

function createCloudflareDeleteInUseDb(connector: unknown) {
  const select = vi.fn();
  select
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([connector]),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ id: 'domain-1', domain: 'example.com' }]),
        })),
      })),
    });
  return { select, delete: vi.fn() };
}

function createToolProjectsDb(input: { connector: unknown; projects: unknown[]; allowlistEntries: unknown[] }) {
  const select = vi.fn();
  select
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([input.connector]),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(input.projects),
          })),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue(input.allowlistEntries),
        })),
      })),
    });
  return { select };
}

function createProjectActionDb(input: { connector: unknown; project: unknown; allowlistEntries: unknown[] }) {
  const select = vi.fn();
  select
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([input.connector]),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([input.project]),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue(input.allowlistEntries),
        })),
      })),
    });
  return {
    select,
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  };
}

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-row-1',
    connectorId: '11111111-1111-4111-8111-111111111111',
    remoteId: '28',
    fullPath: 'general/balanceify',
    name: 'balanceify',
    webUrl: 'https://gitlab.example.com/general/balanceify',
    visibility: 'private',
    defaultBranch: 'main',
    archived: false,
    lastSeenAt: new Date('2026-01-01T00:00:00Z'),
    inaccessibleAt: null,
    metadata: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function vcsProvider<T extends Record<string, unknown>>(overrides: T) {
  return {
    provider: 'gitlab',
    readFile: vi.fn(),
    createBranch: vi.fn(),
    commitFiles: vi.fn(),
    updateProjectSettings: vi.fn(),
    downloadRepositoryArchive: vi.fn(),
    ...overrides,
  };
}

describe('IntegrationsService', () => {
  it('previews generic Git credentials against the configured repository', async () => {
    const service = new IntegrationsService({} as never, { log: vi.fn() } as never, {} as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(
        service.previewGitConnectorTest({
          baseUrl: 'https://git.example.com/',
          repositoryUrl: 'https://git.example.com/team/app.git',
          username: 'deploy-user',
          token: 'secret-token',
        })
      ).resolves.toMatchObject({
        success: true,
        baseUrl: 'https://git.example.com',
        capabilities: { projectsView: true, repoRead: true, repoWrite: true },
      });
      const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
      expect(requestUrl.toString()).toBe('https://git.example.com/team/app.git/info/refs?service=git-upload-pack');
      expect(requestInit).toEqual({
        headers: {
          authorization: `Basic ${Buffer.from('deploy-user:secret-token').toString('base64')}`,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('requires a username before creating a generic Git connector', async () => {
    const service = new IntegrationsService({} as never, { log: vi.fn() } as never, {} as never);

    await expect(
      service.createGitConnector(
        'git',
        {
          name: 'Source',
          baseUrl: 'https://git.example.com',
          enabled: true,
          authMode: 'token',
          token: 'secret',
          allowlistEntries: [
            {
              entryType: 'project',
              remoteId: 'https://git.example.com/team/app.git',
              fullPath: 'https://git.example.com/team/app.git',
              name: 'app',
              webUrl: 'https://git.example.com/team/app.git',
            },
          ],
        },
        'user-1'
      )
    ).rejects.toMatchObject({ code: 'GIT_USERNAME_REQUIRED' });
  });

  it('requests personal GitHub authorization on first repository access for a non-manager', async () => {
    const select = vi.fn();
    select
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              connectorRow({
                provider: 'github',
                name: 'GitHub',
                baseUrl: 'https://github.com',
                authMode: 'oauth',
                username: 'owner',
              }),
            ]),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi
              .fn()
              .mockResolvedValue([
                { entryType: 'project', fullPath: 'https://github.com/acme/app', remoteId: 'repo-1' },
              ]),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })) })),
      });
    const service = new IntegrationsService({ select } as never, { log: vi.fn() } as never, {} as never);

    await expect(
      service.githubListRepositoryTree(
        { ...BASE_USER, scopes: ['integrations:github:view'] },
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          repositoryUrl: 'https://github.com/acme/app',
        }
      )
    ).rejects.toMatchObject({
      code: 'GITHUB_CREDENTIAL_REQUIRED',
      details: { provider: 'github', connectorId: '11111111-1111-4111-8111-111111111111' },
    });
  });

  it('allows every repository visible to an account-wide GitHub OAuth connector', async () => {
    const select = vi.fn();
    select
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              connectorRow({
                provider: 'github',
                name: 'GitHub',
                baseUrl: 'https://github.com',
                authMode: 'oauth',
                allowlistMode: 'all_visible',
                username: 'owner',
                encryptedToken: JSON.stringify('encrypted-token'),
              }),
            ]),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ orderBy: vi.fn().mockResolvedValue([]) })),
        })),
      });
    const service = new IntegrationsService(
      { select } as never,
      { log: vi.fn() } as never,
      { decryptString: vi.fn(() => 'github-oauth-token') } as never
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ name: 'README.md', path: 'README.md', type: 'file', size: 42, sha: 'abc' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    try {
      await expect(
        service.githubListRepositoryTree(
          {
            ...BASE_USER,
            scopes: ['integrations:github:view', 'integrations:github:system'],
          },
          {
            connectorId: '11111111-1111-4111-8111-111111111111',
            repositoryUrl: 'https://github.com/acme/another-repository',
          }
        )
      ).resolves.toEqual([{ name: 'README.md', path: 'README.md', type: 'file', size: 42, sha: 'abc' }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('discovers repositories visible to the GitHub account', async () => {
    const service = new IntegrationsService({} as never, { log: vi.fn() } as never, {} as never);
    (service as any).resolveGitHubAccount = vi.fn().mockResolvedValue({
      connector: connectorRow({ provider: 'github', baseUrl: 'https://github.com' }),
      token: 'github-secret-token',
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 42,
            name: 'app',
            full_name: 'acme/app',
            html_url: 'https://github.com/acme/app',
            owner: { login: 'acme' },
            default_branch: 'main',
            private: true,
            archived: false,
            updated_at: '2026-08-14T12:00:00Z',
            permissions: { admin: false, maintain: true, push: true, pull: true },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(
        service.githubListRepositories(
          { ...BASE_USER, scopes: ['integrations:github:view'] },
          { connectorId: '11111111-1111-4111-8111-111111111111' }
        )
      ).resolves.toEqual([
        expect.objectContaining({
          fullName: 'acme/app',
          repositoryUrl: 'https://github.com/acme/app',
          defaultBranch: 'main',
          private: true,
        }),
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/user/repos?'),
        expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer github-secret-token' }) })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('updates an allowed GitHub file without exposing the credential', async () => {
    const service = new IntegrationsService({} as never, { log: vi.fn() } as never, {} as never);
    (service as any).resolveGitRepository = vi.fn().mockResolvedValue({
      connector: connectorRow({ provider: 'github', baseUrl: 'https://github.com' }),
      repositoryUrl: 'https://github.com/acme/app',
      token: 'github-secret-token',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ commit: { sha: 'commit-1' }, content: { sha: 'content-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(
        service.githubUpsertRepositoryFile(
          { ...BASE_USER, scopes: ['integrations:github:manage'] },
          {
            connectorId: '11111111-1111-4111-8111-111111111111',
            repositoryUrl: 'https://github.com/acme/app',
            path: '.github/workflows/deploy.yml',
            branch: 'main',
            message: 'Configure deployment',
            content: 'name: deploy\n',
          }
        )
      ).resolves.toEqual({
        repositoryUrl: 'https://github.com/acme/app',
        path: '.github/workflows/deploy.yml',
        branch: 'main',
        commitSha: 'commit-1',
        contentSha: 'content-1',
      });
      expect(fetchMock).toHaveBeenLastCalledWith(
        'https://api.github.com/repos/acme/app/contents/.github/workflows/deploy.yml',
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({ authorization: 'Bearer github-secret-token' }),
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('encrypts an Actions secret before sending it to GitHub', async () => {
    const service = new IntegrationsService({} as never, { log: vi.fn() } as never, {} as never);
    (service as any).resolveGitRepository = vi.fn().mockResolvedValue({
      connector: connectorRow({ provider: 'github', baseUrl: 'https://github.com' }),
      repositoryUrl: 'https://github.com/acme/app',
      token: 'github-secret-token',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ key_id: 'key-1', key: Buffer.alloc(32, 7).toString('base64') }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(
        service.githubUpsertActionsSecret(
          { ...BASE_USER, scopes: ['integrations:github:manage'] },
          {
            connectorId: '11111111-1111-4111-8111-111111111111',
            repositoryUrl: 'https://github.com/acme/app',
            name: 'DEPLOY_TOKEN',
            value: 'one-time-secret',
          }
        )
      ).resolves.toEqual({
        repositoryUrl: 'https://github.com/acme/app',
        name: 'DEPLOY_TOKEN',
        updated: true,
      });
      const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
      expect(request.method).toBe('PUT');
      expect(String(request.body)).not.toContain('one-time-secret');
      expect(JSON.parse(String(request.body))).toMatchObject({ key_id: 'key-1' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lists and reads generic Git repository content from an isolated checkout', async () => {
    const checkoutDir = await mkdtemp(join(tmpdir(), 'gateway-git-test-'));
    await mkdir(join(checkoutDir, 'src'));
    await writeFile(join(checkoutDir, 'README.md'), '# App\n');
    await writeFile(join(checkoutDir, 'src', 'index.ts'), 'export const ready = true;\n');
    const service = new IntegrationsService({} as never, { log: vi.fn() } as never, {} as never);
    (service as any).withGenericGitCheckout = vi.fn(
      async (_user: unknown, _input: unknown, callback: (context: Record<string, unknown>) => Promise<unknown>) =>
        callback({
          checkoutDir,
          askpassPath: join(checkoutDir, 'askpass.sh'),
          username: 'git-user',
          token: 'git-token',
          repositoryUrl: 'https://git.example.com/acme/app.git',
        })
    );

    try {
      await expect(
        service.gitListRepositoryTree(
          { ...BASE_USER, scopes: ['integrations:git:view'] },
          {
            connectorId: '11111111-1111-4111-8111-111111111111',
            repositoryUrl: 'https://git.example.com/acme/app.git',
          }
        )
      ).resolves.toEqual([
        { name: 'README.md', path: 'README.md', type: 'blob' },
        { name: 'src', path: 'src', type: 'tree' },
      ]);
      await expect(
        service.gitReadRepositoryFile(
          { ...BASE_USER, scopes: ['integrations:git:view'] },
          {
            connectorId: '11111111-1111-4111-8111-111111111111',
            repositoryUrl: 'https://git.example.com/acme/app.git',
            path: 'src/index.ts',
          }
        )
      ).resolves.toMatchObject({ path: 'src/index.ts', content: 'export const ready = true;\n' });
    } finally {
      await rm(checkoutDir, { recursive: true, force: true });
    }
  });

  it('streams GitLab archives into the sandbox without materializing or base64-encoding the archive', async () => {
    const auditService = { log: vi.fn() };
    const service = new IntegrationsService({} as never, auditService as never, {} as never);
    const streamedChunks = [Buffer.alloc(256 * 1024, 1), Buffer.alloc(4 * 1024, 2)];
    async function* archiveChunks() {
      for (const chunk of streamedChunks) yield chunk;
    }
    const provider = {
      streamRepositoryArchive: vi.fn().mockResolvedValue({
        filename: 'app.tar.gz',
        contentType: 'application/gzip',
        chunks: archiveChunks(),
      }),
    };
    (service as any).resolveGitLabProjectContext = vi.fn().mockResolvedValue({
      connector: connectorRow({ capabilities: { repoRead: true } }),
      project: projectRow(),
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-never-exposed' },
      provider,
    });
    (service as any).auditGitLabTool = vi.fn().mockResolvedValue(undefined);
    const sandboxService = {
      runProcess: vi.fn().mockResolvedValue({ processId: 'process-1', jobId: 'job-1' }),
      uploadArtifactStream: vi.fn().mockResolvedValue({ sizeBytes: 260 * 1024 }),
      uploadArtifact: vi.fn().mockResolvedValue({ sizeBytes: 0 }),
      killProcess: vi.fn(),
    };
    const user = {
      ...BASE_USER,
      scopes: ['integrations:gitlab:sandbox:clone', 'ai:sandbox:use'],
    };

    await expect(
      service.gitLabCloneRepositoryToSandbox(
        user as never,
        { connectorId: 'connector-1', project: 'general/balanceify', ref: 'main' },
        sandboxService as never,
        'conversation-1'
      )
    ).resolves.toMatchObject({
      processId: 'process-1',
      archiveBytes: 260 * 1024,
      status: 'extracting',
    });

    expect(sandboxService.uploadArtifactStream).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ chunks: expect.anything(), maxBytes: 1024 * 1024 * 1024 })
    );
    expect(sandboxService.uploadArtifact).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        processId: 'process-1',
        path: expect.stringMatching(/\.tar\.gz\.ready$/),
        contentBase64: '',
      })
    );
    const command = sandboxService.runProcess.mock.calls[0][1].command.join(' ');
    expect(command).toContain('.tar.gz.ready');
    expect(command).not.toContain('glpat-never-exposed');
  });

  it('proves Cloudflare DNS edit capability with a temporary TXT record during preview test', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/user/tokens/verify')) {
        return Response.json({ success: true, result: { id: 'token-1', status: 'active' } });
      }
      if (url.includes('/zones?')) {
        return Response.json({
          success: true,
          result: [{ id: 'zone-1', name: 'example.com', status: 'active' }],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      if (url.includes('/zones/zone-1/dns_records') && method === 'GET') {
        return Response.json({ success: true, result: [], result_info: { page: 1, total_pages: 1 } });
      }
      if (url.includes('/zones/zone-1/dns_records') && method === 'POST') {
        return Response.json({
          success: true,
          result: { id: 'probe-1', type: 'TXT', name: '_gateway-permission-check.example.com', content: 'ok', ttl: 60 },
        });
      }
      if (url.endsWith('/zones/zone-1/dns_records/probe-1') && method === 'DELETE') {
        return Response.json({ success: true, result: { id: 'probe-1' } });
      }
      throw new Error(`Unexpected Cloudflare mock request: ${method} ${url}`);
    });
    globalThis.fetch = fetchMock as never;
    try {
      const service = new IntegrationsService({} as never, { log: vi.fn() } as never, {} as never);

      await expect(service.testCloudflareConnectorPreview({ token: 'cf-token' })).resolves.toMatchObject({
        capabilities: { apiReachable: true, tokenActive: true, zonesRead: true, dnsRead: true, dnsEdit: true },
        zones: [{ remoteId: 'zone-1', name: 'example.com' }],
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/zones/zone-1/dns_records'),
        expect.objectContaining({ method: 'POST' })
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/zones/zone-1/dns_records/probe-1'),
        expect.objectContaining({ method: 'DELETE' })
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('skips visible Cloudflare zones that deny DNS access and probes a manageable zone', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/user/tokens/verify')) {
        return Response.json({ success: true, result: { id: 'token-1', status: 'active' } });
      }
      if (url.includes('/zones?')) {
        return Response.json({
          success: true,
          result: [
            { id: 'zone-blocked', name: 'blocked.example', status: 'active' },
            { id: 'zone-1', name: 'example.com', status: 'active' },
          ],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      if (url.includes('/zones/zone-blocked/dns_records') && method === 'GET') {
        return Response.json(
          { success: false, result: null, errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }] },
          { status: 403 }
        );
      }
      if (url.includes('/zones/zone-1/dns_records') && method === 'GET') {
        return Response.json({ success: true, result: [], result_info: { page: 1, total_pages: 1 } });
      }
      if (url.includes('/zones/zone-1/dns_records') && method === 'POST') {
        return Response.json({
          success: true,
          result: { id: 'probe-1', type: 'TXT', name: '_gateway-permission-check.example.com', content: 'ok', ttl: 60 },
        });
      }
      if (url.endsWith('/zones/zone-1/dns_records/probe-1') && method === 'DELETE') {
        return Response.json({ success: true, result: { id: 'probe-1' } });
      }
      throw new Error(`Unexpected Cloudflare mock request: ${method} ${url}`);
    });
    globalThis.fetch = fetchMock as never;
    try {
      const service = new IntegrationsService({} as never, { log: vi.fn() } as never, {} as never);

      await expect(service.testCloudflareConnectorPreview({ token: 'cf-token' })).resolves.toMatchObject({
        capabilities: { dnsRead: true, dnsEdit: true },
        zones: [{ remoteId: 'zone-1', name: 'example.com' }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports the Cloudflare zone and provider error when no zone allows DNS access', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/user/tokens/verify')) {
        return Response.json({ success: true, result: { id: 'token-1', status: 'active' } });
      }
      if (url.includes('/zones?')) {
        return Response.json({
          success: true,
          result: [{ id: 'zone-blocked', name: 'blocked.example', status: 'active' }],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      if (url.includes('/zones/zone-blocked/dns_records')) {
        return Response.json(
          { success: false, result: null, errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }] },
          { status: 403 }
        );
      }
      throw new Error(`Unexpected Cloudflare mock request: ${url}`);
    });
    globalThis.fetch = fetchMock as never;
    try {
      const service = new IntegrationsService({} as never, { log: vi.fn() } as never, {} as never);

      await expect(service.testCloudflareConnectorPreview({ token: 'cf-token' })).rejects.toMatchObject({
        code: 'CLOUDFLARE_DNS_READ_REQUIRED',
        message: 'Cloudflare denied DNS access for blocked.example: Unauthorized to access requested resource',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('blocks deleting Cloudflare connectors still referenced by domains', async () => {
    const db = createCloudflareDeleteInUseDb(
      connectorRow({
        id: '11111111-1111-4111-8111-111111111111',
        provider: 'cloudflare',
        name: 'Cloudflare',
        baseUrl: 'https://api.cloudflare.com',
      })
    );
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);

    await expect(
      service.deleteCloudflareConnector('11111111-1111-4111-8111-111111111111', 'user-1')
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLOUDFLARE_CONNECTOR_IN_USE',
    });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('strips encrypted tokens and returns masked token metadata in list responses', async () => {
    const db = createListDb([connectorRow()]);
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);

    const [connector] = await service.listGitLabConnectors();

    expect(connector).toMatchObject({ hasToken: true, tokenMasked: '****abcd' });
    expect(connector).not.toHaveProperty('encryptedToken');
  });

  it('returns stored capabilities without decrypting the token', async () => {
    const db = createGetDb(connectorRow({ capabilities: { repoRead: true, repoWrite: false } }));
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);

    await expect(service.getGitLabConnectorCapabilities('11111111-1111-4111-8111-111111111111')).resolves.toEqual({
      repoRead: true,
      repoWrite: false,
    });
  });

  it('rejects malformed connector IDs before querying the database', async () => {
    const db = createGetDb(connectorRow());
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);

    await expect(service.listGitLabProjectsForTool(BASE_USER, { connectorId: 'connector-1' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_CONNECTOR_ID',
    } satisfies Partial<AppError>);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('lists only allowlisted GitLab projects for AI tools', async () => {
    const db = createToolProjectsDb({
      connector: connectorRow({ encryptedToken: JSON.stringify('encrypted-token') }),
      projects: [
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          remoteId: '10',
          fullPath: 'helmut/link4work',
          name: 'link4work',
          webUrl: 'https://gitlab.example.com/helmut/link4work',
          visibility: 'private',
          defaultBranch: 'main',
          archived: false,
          lastSeenAt: new Date('2026-01-01T00:00:00Z'),
          inaccessibleAt: null,
          metadata: {},
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          remoteId: '11',
          fullPath: 'allowed/app',
          name: 'app',
          webUrl: 'https://gitlab.example.com/allowed/app',
          visibility: 'private',
          defaultBranch: 'main',
          archived: false,
          lastSeenAt: new Date('2026-01-01T00:00:00Z'),
          inaccessibleAt: null,
          metadata: {},
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      allowlistEntries: [{ entryType: 'project', remoteId: '11', fullPath: 'allowed/app', name: null, webUrl: null }],
    });
    const auditService = { log: vi.fn() };
    const service = new IntegrationsService(
      db as never,
      auditService as never,
      { decryptString: vi.fn(() => 'glpat-system-token') } as never
    );

    const result = await service.listGitLabProjectsForTool(
      { ...BASE_USER, scopes: ['integrations:gitlab:projects:view', 'integrations:gitlab:system'] },
      { connectorId: '11111111-1111-4111-8111-111111111111', search: 'link', limit: 10 }
    );

    expect(result).toMatchObject({ data: [], total: 0, truncated: false });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          returned: 0,
          totalMatched: 0,
        }),
      })
    );
  });

  it('requires a personal PAT without falling back to the system credential', async () => {
    const decryptString = vi.fn(() => 'glpat-system-token');
    const db = createToolProjectsDb({
      connector: connectorRow({ encryptedToken: JSON.stringify('encrypted-token') }),
      projects: [projectRow()],
      allowlistEntries: [],
    });
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, { decryptString } as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue(null);

    await expect(
      service.listGitLabProjectsForTool(
        { ...BASE_USER, scopes: ['integrations:gitlab:projects:view'] },
        { connectorId: '11111111-1111-4111-8111-111111111111' }
      )
    ).rejects.toMatchObject({
      statusCode: 428,
      code: 'GITLAB_CREDENTIAL_REQUIRED',
      details: expect.objectContaining({ reason: 'missing' }),
    });
    expect(decryptString).not.toHaveBeenCalled();
  });

  it('intersects cached allowlisted projects with projects visible to the personal PAT', async () => {
    const cachedProjects = [projectRow(), projectRow({ remoteId: '29', fullPath: 'general/private', name: 'private' })];
    const db = createToolProjectsDb({
      connector: connectorRow({ allowlistMode: 'all_visible' }),
      projects: cachedProjects,
      allowlistEntries: [],
    });
    const provider = vcsProvider({
      listProjects: vi.fn().mockResolvedValue([
        {
          remoteId: '28',
          fullPath: 'general/balanceify',
          name: 'balanceify',
          webUrl: 'https://gitlab.example.com/general/balanceify',
        },
      ]),
    });
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });

    await expect(
      service.listGitLabProjectsForTool(
        { ...BASE_USER, scopes: ['integrations:gitlab:projects:view'] },
        { connectorId: '11111111-1111-4111-8111-111111111111' }
      )
    ).resolves.toMatchObject({
      total: 1,
      data: [expect.objectContaining({ remoteId: '28', fullPath: 'general/balanceify' })],
    });
    expect(provider.listProjects).toHaveBeenCalledWith(expect.objectContaining({ token: 'glpat-personal-token' }));
  });

  it('creates commits with the personal PAT after checking its write access', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, repoWrite: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 30 }),
      getBranchAccess: vi.fn().mockResolvedValue({ exists: true, canPush: true }),
      commitFiles: vi.fn().mockResolvedValue({ commitSha: 'abc123', branch: 'main', webUrl: null }),
    });
    const service = new IntegrationsService(
      db as never,
      { log: vi.fn() } as never,
      { decryptString: vi.fn(() => 'glpat-system-token') } as never
    );
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });

    await service.gitLabCommitFiles(
      { ...BASE_USER, scopes: ['integrations:gitlab:repo:write'] },
      {
        connectorId: '11111111-1111-4111-8111-111111111111',
        project: 'general/balanceify',
        branch: 'main',
        commitMessage: 'Update file',
        changes: [{ action: 'update', path: 'README.md', content: 'updated' }],
      }
    );

    expect(provider.getProjectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ fullPath: 'general/balanceify' })
    );
    expect(provider.getBranchAccess).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ fullPath: 'general/balanceify' }),
      'main'
    );
    expect(provider.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ commitMessage: 'Update file' })
    );
  });

  it('refuses personal commits without push access to an existing branch', async () => {
    const branchAccess = { exists: true, canPush: false };
    const branch = 'main';
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, repoWrite: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 30 }),
      getBranchAccess: vi.fn().mockResolvedValue(branchAccess),
      commitFiles: vi.fn(),
    });
    const service = new IntegrationsService(
      db as never,
      { log: vi.fn() } as never,
      { decryptString: vi.fn(() => 'glpat-system-token') } as never
    );
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });

    await expect(
      service.gitLabCommitFiles(
        { ...BASE_USER, scopes: ['integrations:gitlab:repo:write'] },
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          project: 'general/balanceify',
          branch,
          commitMessage: 'Update file',
          changes: [{ action: 'update', path: 'README.md', content: 'updated' }],
        }
      )
    ).rejects.toMatchObject({ statusCode: 403, code: 'GITLAB_PERSONAL_BRANCH_WRITE_ACCESS_REQUIRED' });
    expect(provider.commitFiles).not.toHaveBeenCalled();
  });

  it('creates a missing branch and commits with the personal PAT', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, repoWrite: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 30 }),
      getBranchAccess: vi.fn().mockResolvedValue({ exists: false, canPush: false }),
      createBranch: vi.fn().mockResolvedValue(undefined),
      commitFiles: vi.fn().mockResolvedValue({ commitSha: 'abc123', webUrl: null }),
    });
    const service = new IntegrationsService(
      db as never,
      { log: vi.fn() } as never,
      { decryptString: vi.fn(() => 'glpat-system-token') } as never
    );
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });

    await service.gitLabCommitFiles(
      { ...BASE_USER, scopes: ['integrations:gitlab:repo:write'] },
      {
        connectorId: '11111111-1111-4111-8111-111111111111',
        project: 'general/balanceify',
        branch: 'feature/new',
        startBranch: 'main',
        commitMessage: 'Add feature',
        changes: [{ action: 'create', path: 'feature.txt', content: 'new' }],
      }
    );

    expect(provider.createBranch).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ fullPath: 'general/balanceify' }),
      'feature/new',
      'main'
    );
    expect(provider.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ branch: 'feature/new', startBranch: undefined })
    );
  });

  it('commits a valid CI configuration with the personal PAT', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, ciEdit: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 30 }),
      getBranchAccess: vi.fn().mockResolvedValue({ exists: true, canPush: true }),
      lintCiConfig: vi.fn().mockResolvedValue({ valid: true, errors: [], warnings: [], mergedYaml: null }),
      commitFiles: vi.fn().mockResolvedValue({ commitSha: 'abc123', branch: 'main', webUrl: null }),
    });
    const decryptString = vi.fn(() => 'glpat-system-token');
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, { decryptString } as never);
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });

    await service.gitLabUpdateCiConfig(
      { ...BASE_USER, scopes: ['integrations:gitlab:ci:edit'] },
      {
        connectorId: '11111111-1111-4111-8111-111111111111',
        project: 'general/balanceify',
        branch: 'main',
        content: 'stages: [test]\n',
        commitMessage: 'Update CI',
      }
    );

    expect(provider.lintCiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ fullPath: 'general/balanceify' }),
      'stages: [test]\n'
    );
    expect(provider.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ changes: [{ action: 'update', path: '.gitlab-ci.yml', content: 'stages: [test]\n' }] })
    );
    expect(decryptString).not.toHaveBeenCalled();
  });

  it('uses the system PAT for a commit only when the caller has the explicit system scope', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, repoWrite: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 40 }),
      commitFiles: vi.fn().mockResolvedValue({ commitSha: 'abc123', branch: 'main', webUrl: null }),
    });
    const decryptString = vi.fn(() => 'glpat-system-token');
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, { decryptString } as never);
    service.registerProvider(provider as never);

    await service.gitLabCommitFiles(
      { ...BASE_USER, scopes: ['integrations:gitlab:repo:write', 'integrations:gitlab:system'] },
      {
        connectorId: '11111111-1111-4111-8111-111111111111',
        project: 'general/balanceify',
        branch: 'main',
        commitMessage: 'Update file',
        changes: [{ action: 'update', path: 'README.md', content: 'updated' }],
      }
    );

    expect(provider.commitFiles).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-system-token' }),
      expect.objectContaining({ commitMessage: 'Update file' })
    );
  });

  it('invalidates a personal PAT when a GitLab write returns 401', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, repoWrite: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 30 }),
      getBranchAccess: vi.fn().mockResolvedValue({ exists: true, canPush: true }),
      commitFiles: vi.fn().mockRejectedValue(new AppError(401, 'GITLAB_API_ERROR', 'Unauthorized')),
    });
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as {
        gitLabUserCredentials: {
          resolveAuth: (...args: unknown[]) => Promise<unknown>;
          markInvalid: (...args: unknown[]) => Promise<void>;
        };
      }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });
    const markInvalid = vi.spyOn(credentials, 'markInvalid').mockResolvedValue(undefined);

    await expect(
      service.gitLabCommitFiles(
        { ...BASE_USER, scopes: ['integrations:gitlab:repo:write'] },
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          project: 'general/balanceify',
          branch: 'main',
          commitMessage: 'Update file',
          changes: [{ action: 'update', path: 'README.md', content: 'updated' }],
        }
      )
    ).rejects.toMatchObject({ statusCode: 428, code: 'GITLAB_CREDENTIAL_REQUIRED' });
    expect(markInvalid).toHaveBeenCalledWith('user-1', '11111111-1111-4111-8111-111111111111');
  });

  it('requires startBranch when a personal PAT targets a missing branch', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, repoWrite: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 30 }),
      getBranchAccess: vi.fn().mockResolvedValue({ exists: false, canPush: false }),
      commitFiles: vi.fn(),
    });
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });

    await expect(
      service.gitLabCommitFiles(
        { ...BASE_USER, scopes: ['integrations:gitlab:repo:write'] },
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          project: 'general/balanceify',
          branch: 'feature/new',
          commitMessage: 'Add feature',
          changes: [{ action: 'create', path: 'feature.txt', content: 'new' }],
        }
      )
    ).rejects.toMatchObject({ statusCode: 400, code: 'GITLAB_START_BRANCH_REQUIRED' });
    expect(provider.createBranch).not.toHaveBeenCalled();
    expect(provider.commitFiles).not.toHaveBeenCalled();
  });

  it('refreshes capabilities with the personal PAT without touching the system credential', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, ciLint: false },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const db = createProjectActionDb({ connector, project: projectRow(), allowlistEntries: [] });
    const provider = vcsProvider({
      testConnection: vi.fn().mockResolvedValue({ projectsView: true, ciLint: true }),
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 20 }),
      lintCiConfig: vi.fn().mockResolvedValue({ valid: true, errors: [], warnings: [], mergedYaml: null }),
    });
    const decryptString = vi.fn(() => 'glpat-system-token');
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, { decryptString } as never);
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as { gitLabUserCredentials: { resolveAuth: (...args: unknown[]) => Promise<unknown> } }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });

    await expect(
      service.gitLabLintCiConfig(
        { ...BASE_USER, scopes: ['integrations:gitlab:ci:view'] },
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          project: 'general/balanceify',
          content: 'stages: [test]\n',
        }
      )
    ).resolves.toMatchObject({ valid: true });

    expect(provider.testConnection).toHaveBeenCalledWith(expect.objectContaining({ token: 'glpat-personal-token' }));
    expect(provider.lintCiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-personal-token' }),
      expect.objectContaining({ fullPath: 'general/balanceify' }),
      'stages: [test]\n'
    );
    expect(decryptString).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('invalidates a personal PAT after a GitLab 401 and requests authorization again', async () => {
    const db = createProjectActionDb({
      connector: connectorRow({ allowlistMode: 'all_visible' }),
      project: projectRow(),
      allowlistEntries: [],
    });
    const provider = vcsProvider({
      getProjectAccess: vi.fn().mockRejectedValue(new AppError(401, 'GITLAB_API_ERROR', 'Unauthorized')),
    });
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as {
        gitLabUserCredentials: {
          resolveAuth: (...args: unknown[]) => Promise<unknown>;
          markInvalid: (...args: unknown[]) => Promise<void>;
        };
      }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });
    const markInvalid = vi.spyOn(credentials, 'markInvalid').mockResolvedValue(undefined);

    await expect(
      service.getGitLabProjectForTool(
        { ...BASE_USER, scopes: ['integrations:gitlab:projects:view'] },
        { connectorId: '11111111-1111-4111-8111-111111111111', project: 'general/balanceify' }
      )
    ).rejects.toMatchObject({
      statusCode: 428,
      code: 'GITLAB_CREDENTIAL_REQUIRED',
      details: expect.objectContaining({ reason: 'invalid' }),
    });
    expect(markInvalid).toHaveBeenCalledWith('user-1', '11111111-1111-4111-8111-111111111111');
  });

  it('does not invalidate a personal PAT after a GitLab 403', async () => {
    const db = createProjectActionDb({
      connector: connectorRow({ allowlistMode: 'all_visible' }),
      project: projectRow(),
      allowlistEntries: [],
    });
    const forbidden = new AppError(403, 'GITLAB_API_ERROR', 'Forbidden');
    const provider = vcsProvider({ getProjectAccess: vi.fn().mockRejectedValue(forbidden) });
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);
    service.registerProvider(provider as never);
    const credentials = (
      service as unknown as {
        gitLabUserCredentials: {
          resolveAuth: (...args: unknown[]) => Promise<unknown>;
          markInvalid: (...args: unknown[]) => Promise<void>;
        };
      }
    ).gitLabUserCredentials;
    vi.spyOn(credentials, 'resolveAuth').mockResolvedValue({
      auth: { baseUrl: 'https://gitlab.example.com', token: 'glpat-personal-token' },
      scopes: ['api'],
      gitlabUserId: '42',
      gitlabUsername: 'alice',
    });
    const markInvalid = vi.spyOn(credentials, 'markInvalid').mockResolvedValue(undefined);

    await expect(
      service.getGitLabProjectForTool(
        { ...BASE_USER, scopes: ['integrations:gitlab:projects:view'] },
        { connectorId: '11111111-1111-4111-8111-111111111111', project: 'general/balanceify' }
      )
    ).rejects.toBe(forbidden);
    expect(markInvalid).not.toHaveBeenCalled();
  });

  it('refreshes stale GitLab capabilities before denying a project tool action', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, ciLint: false },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const project = {
      id: 'project-row-1',
      connectorId: '11111111-1111-4111-8111-111111111111',
      remoteId: '28',
      fullPath: 'general/balanceify',
      name: 'balanceify',
      webUrl: 'https://gitlab.example.com/general/balanceify',
      visibility: 'private',
      defaultBranch: 'main',
      archived: false,
      lastSeenAt: new Date('2026-01-01T00:00:00Z'),
      inaccessibleAt: null,
      metadata: {},
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const db = createProjectActionDb({ connector, project, allowlistEntries: [] });
    const provider = {
      provider: 'gitlab',
      testConnection: vi.fn().mockResolvedValue({ projectsView: true, ciLint: true }),
      searchAllowlist: vi.fn(),
      listProjects: vi.fn(),
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 40 }),
      listRegistries: vi.fn(),
      listTree: vi.fn(),
      readFile: vi.fn(),
      commitFiles: vi.fn(),
      lintCiConfig: vi.fn().mockResolvedValue({ valid: true, errors: [], warnings: [], mergedYaml: null }),
      listPipelines: vi.fn(),
      getPipeline: vi.fn(),
      listPipelineJobs: vi.fn(),
      getJobLog: vi.fn(),
      listProjectVariables: vi.fn(),
      setProjectVariable: vi.fn(),
      deleteProjectVariable: vi.fn(),
      listProjectWebhooks: vi.fn(),
      createOrUpdateProjectWebhook: vi.fn(),
      deleteProjectWebhook: vi.fn(),
      listRegistryRepositories: vi.fn(),
      createDeployToken: vi.fn(),
      updateProjectSettings: vi.fn(),
      downloadRepositoryArchive: vi.fn(),
    };
    const cryptoService = { decryptString: vi.fn(() => 'glpat-token') };
    const auditService = { log: vi.fn() };
    const service = new IntegrationsService(db as never, auditService as never, cryptoService as never);
    service.registerProvider(provider as never);

    await expect(
      service.gitLabLintCiConfig(
        { ...BASE_USER, scopes: ['integrations:gitlab:ci:view', 'integrations:gitlab:system'] },
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          project: 'general/balanceify',
          content: 'stages: [test]\n',
        }
      )
    ).resolves.toMatchObject({ valid: true });

    expect(provider.testConnection).toHaveBeenCalledWith({
      baseUrl: 'https://gitlab.example.com',
      token: 'glpat-token',
    });
    expect(db.update).toHaveBeenCalled();
    expect(provider.lintCiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-token' }),
      expect.objectContaining({ fullPath: 'general/balanceify' }),
      'stages: [test]\n'
    );
  });

  it('syncs the GitLab connector after updating project registry settings', async () => {
    const connector = connectorRow({
      allowlistMode: 'all_visible',
      capabilities: { projectsView: true, deployTokensManage: true },
      encryptedToken: JSON.stringify('encrypted-token'),
    });
    const project = {
      id: 'project-row-1',
      connectorId: '11111111-1111-4111-8111-111111111111',
      remoteId: '28',
      fullPath: 'general/balanceify',
      name: 'balanceify',
      webUrl: 'https://gitlab.example.com/general/balanceify',
      visibility: 'private',
      defaultBranch: 'main',
      archived: false,
      lastSeenAt: new Date('2026-01-01T00:00:00Z'),
      inaccessibleAt: null,
      metadata: {},
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const db = createProjectActionDb({ connector, project, allowlistEntries: [] });
    const provider = {
      provider: 'gitlab',
      testConnection: vi.fn(),
      searchAllowlist: vi.fn(),
      listProjects: vi.fn(),
      getProjectAccess: vi.fn().mockResolvedValue({ accessLevel: 40 }),
      listRegistries: vi.fn(),
      listTree: vi.fn(),
      readFile: vi.fn(),
      commitFiles: vi.fn(),
      lintCiConfig: vi.fn(),
      listPipelines: vi.fn(),
      getPipeline: vi.fn(),
      listPipelineJobs: vi.fn(),
      getJobLog: vi.fn(),
      listProjectVariables: vi.fn(),
      setProjectVariable: vi.fn(),
      deleteProjectVariable: vi.fn(),
      listProjectWebhooks: vi.fn(),
      createOrUpdateProjectWebhook: vi.fn(),
      deleteProjectWebhook: vi.fn(),
      listRegistryRepositories: vi.fn(),
      createDeployToken: vi.fn(),
      updateProjectSettings: vi.fn().mockResolvedValue({
        remoteId: '28',
        fullPath: 'general/balanceify',
        name: 'balanceify',
        containerRegistryAccessLevel: 'enabled',
      }),
      downloadRepositoryArchive: vi.fn(),
    };
    const cryptoService = { decryptString: vi.fn(() => 'glpat-token') };
    const auditService = { log: vi.fn() };
    const service = new IntegrationsService(db as never, auditService as never, cryptoService as never);
    const syncGitLabConnector = vi
      .spyOn(service, 'syncGitLabConnector')
      .mockResolvedValue({ status: 'success', projectCount: 1, registryCount: 1, skippedRegistryProjects: [] });
    service.registerProvider(provider as never);

    await expect(
      service.gitLabUpdateProjectSettings(
        { ...BASE_USER, scopes: ['integrations:gitlab:registry:manage', 'integrations:gitlab:system'] },
        {
          connectorId: '11111111-1111-4111-8111-111111111111',
          project: 'general/balanceify',
          containerRegistryAccessLevel: 'enabled',
        }
      )
    ).resolves.toMatchObject({
      fullPath: 'general/balanceify',
      sync: { status: 'success', registryCount: 1 },
      syncError: null,
    });

    expect(provider.updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'glpat-token' }),
      expect.objectContaining({ fullPath: 'general/balanceify' }),
      { containerRegistryAccessLevel: 'enabled' }
    );
    expect(syncGitLabConnector).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'user-1');
  });

  it('does not fake provider-backed actions before a provider is registered', async () => {
    const db = createGetDb(connectorRow());
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);

    await expect(service.testGitLabConnector('11111111-1111-4111-8111-111111111111', 'user-1')).rejects.toMatchObject({
      statusCode: 501,
      code: 'CONNECTOR_PROVIDER_UNAVAILABLE',
    } satisfies Partial<AppError>);
  });

  it('allows selected GitLab projects by exact project or parent group allowlist', () => {
    const service = new IntegrationsService({} as never, { log: vi.fn() } as never, {} as never);
    const allowlist = [
      { entryType: 'project', remoteId: '10', fullPath: 'other/app', name: null, webUrl: null },
      { entryType: 'group', remoteId: '20', fullPath: 'org/platform', name: null, webUrl: null },
    ] as never;

    expect(service.isGitLabProjectAllowed({ remoteId: '10', fullPath: 'unrelated/path', name: 'app' }, allowlist)).toBe(
      true
    );
    expect(
      service.isGitLabProjectAllowed({ remoteId: '11', fullPath: 'org/platform/api', name: 'api' }, allowlist)
    ).toBe(true);
    expect(service.isGitLabProjectAllowed({ remoteId: '12', fullPath: 'org/other', name: 'other' }, allowlist)).toBe(
      false
    );
  });

  it('rejects manual sync while a connector sync is already running', async () => {
    const db = createGetUpdateDb(connectorRow({ syncStatus: 'running', syncStartedAt: new Date(Date.now() - 1000) }));
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);

    await expect(service.syncGitLabConnector('11111111-1111-4111-8111-111111111111', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONNECTOR_SYNC_RUNNING',
    });
  });

  it('does not audit successful scheduled GitLab connector syncs', async () => {
    const db = createGetUpdateDb(connectorRow({ encryptedToken: JSON.stringify('encrypted-token') }));
    const auditService = { log: vi.fn() };
    const service = new IntegrationsService(
      db as never,
      auditService as never,
      { decryptString: vi.fn(() => 'gitlab-token') } as never
    );
    service.registerProvider({
      provider: 'gitlab',
      testConnection: vi.fn().mockResolvedValue({ projectsView: true }),
      listProjects: vi.fn().mockResolvedValue([]),
      listRegistries: vi.fn().mockResolvedValue({ registries: [], skippedProjects: [] }),
    } as never);
    vi.spyOn(service as any, 'listAllowlistRows').mockResolvedValue([]);
    vi.spyOn(service as any, 'persistProjects').mockResolvedValue(undefined);
    vi.spyOn(service as any, 'persistRegistries').mockResolvedValue(undefined);

    await service.syncGitLabConnector('11111111-1111-4111-8111-111111111111', null, { scheduled: true });

    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('does not audit successful scheduled Cloudflare connector syncs', async () => {
    const db = createGetUpdateDb(
      connectorRow({ provider: 'cloudflare', name: 'Cloudflare', encryptedToken: JSON.stringify('encrypted-token') })
    );
    const auditService = { log: vi.fn() };
    const service = new IntegrationsService(
      db as never,
      auditService as never,
      { decryptString: vi.fn(() => 'cloudflare-token') } as never
    );
    vi.spyOn(service as any, 'testCloudflareToken').mockResolvedValue({ capabilities: { dnsEdit: true }, zones: [] });
    vi.spyOn(service as any, 'persistCloudflareZones').mockResolvedValue(undefined);

    await service.syncCloudflareConnector('11111111-1111-4111-8111-111111111111', null, { scheduled: true });

    expect(auditService.log).not.toHaveBeenCalled();
  });
});
