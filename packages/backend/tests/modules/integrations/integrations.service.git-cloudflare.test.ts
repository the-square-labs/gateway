import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import {
  BASE_USER,
  connectorRow,
  createCloudflareDeleteInUseDb,
  createDockerSourceListDb,
  createDockerSourceResolveDb,
  createGetDb,
  createGetUpdateDb,
  createListDb,
  createProjectActionDb,
  createToolProjectsDb,
  projectRow,
  vcsProvider,
} from './integrations.service.test-support.js';

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
          {
            success: false,
            result: null,
            errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }],
          },
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
          {
            success: false,
            result: null,
            errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }],
          },
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

});
