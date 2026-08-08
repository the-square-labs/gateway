import { describe, expect, it, vi } from 'vitest';
import { GitLabProvider } from './gitlab-provider.js';

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('GitLabProvider', () => {
  it('detects read/write capabilities from safe probes and token scopes', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v4/user') return jsonResponse({ id: 1, username: 'bot' });
      if (url.pathname === '/api/v4/personal_access_tokens/self') {
        return jsonResponse({ scopes: ['api', 'write_repository', 'read_registry'] });
      }
      if (url.pathname === '/api/v4/projects') {
        return jsonResponse([
          { id: 10, path_with_namespace: 'org/app', name: 'app', web_url: 'https://gitlab.test/org/app' },
        ]);
      }
      if (url.pathname === '/api/v4/groups') {
        return jsonResponse([{ id: 20, full_path: 'org', name: 'org', web_url: 'https://gitlab.test/org' }]);
      }
      if (url.pathname === '/api/v4/projects/10/repository/tree') return jsonResponse([]);
      if (url.pathname === '/api/v4/projects/10/pipelines') return jsonResponse([]);
      if (url.pathname === '/api/v4/projects/10/variables') return jsonResponse([]);
      if (url.pathname === '/api/v4/projects/10/registry/repositories') return jsonResponse([]);
      if (url.pathname === '/api/v4/ci/lint') return jsonResponse({ valid: true });
      return new Response('not found', { status: 404 });
    });

    const provider = new GitLabProvider(fetchImpl as typeof fetch);
    const capabilities = await provider.testConnection({ baseUrl: 'https://gitlab.test/', token: 'glpat-secret' });

    expect(capabilities).toMatchObject({
      apiReachable: true,
      tokenSelf: true,
      projectsView: true,
      groupsView: true,
      repoRead: true,
      repoWrite: true,
      ciLint: true,
      variablesDelete: true,
      registryUse: true,
      webhooksManage: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/api/v4/user'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'glpat-secret' }),
      })
    );
  });

  it('allows CI lint from API token scopes even when the live lint probe is unavailable', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v4/user') return jsonResponse({ id: 1, username: 'bot' });
      if (url.pathname === '/api/v4/personal_access_tokens/self') {
        return jsonResponse({ scopes: ['read_api'] });
      }
      if (url.pathname === '/api/v4/projects') {
        return jsonResponse([
          { id: 10, path_with_namespace: 'org/app', name: 'app', web_url: 'https://gitlab.test/org/app' },
        ]);
      }
      if (url.pathname === '/api/v4/groups') return jsonResponse([]);
      if (url.pathname === '/api/v4/projects/10/repository/tree') return new Response('forbidden', { status: 403 });
      if (url.pathname === '/api/v4/projects/10/pipelines') return new Response('forbidden', { status: 403 });
      if (url.pathname === '/api/v4/projects/10/variables') return new Response('forbidden', { status: 403 });
      if (url.pathname === '/api/v4/projects/10/registry/repositories')
        return new Response('forbidden', { status: 403 });
      if (url.pathname === '/api/v4/ci/lint') return new Response('not acceptable', { status: 406 });
      return new Response('not found', { status: 404 });
    });

    const provider = new GitLabProvider(fetchImpl as typeof fetch);
    const capabilities = await provider.testConnection({ baseUrl: 'https://gitlab.test/', token: 'glpat-secret' });

    expect(capabilities).toMatchObject({
      tokenSelf: true,
      ciView: true,
      ciLint: true,
    });
  });

  it('combines group and project search results for allowlist selection', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v4/groups') {
        return jsonResponse([{ id: 1, full_path: 'org', name: 'Org', web_url: 'https://gitlab.test/org' }]);
      }
      if (url.pathname === '/api/v4/projects') {
        return jsonResponse([
          { id: 2, path_with_namespace: 'org/app', name: 'App', web_url: 'https://gitlab.test/org/app' },
        ]);
      }
      return jsonResponse([]);
    });

    const provider = new GitLabProvider(fetchImpl as typeof fetch);
    const results = await provider.searchAllowlist({ baseUrl: 'https://gitlab.test', token: 'token' }, 'org');

    expect(results).toEqual([
      { entryType: 'group', remoteId: '1', fullPath: 'org', name: 'Org', webUrl: 'https://gitlab.test/org' },
      { entryType: 'project', remoteId: '2', fullPath: 'org/app', name: 'App', webUrl: 'https://gitlab.test/org/app' },
    ]);
  });

  it('reports branch-specific push access for the authenticated user', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v4/projects/42/repository/branches/feature%2Fsecure') {
        return jsonResponse({ name: 'feature/secure', protected: true, can_push: false });
      }
      return new Response('not found', { status: 404 });
    });
    const provider = new GitLabProvider(fetchImpl as typeof fetch);
    const auth = { baseUrl: 'https://gitlab.test', token: 'personal-token' };
    const project = { remoteId: '42', fullPath: 'org/app', name: 'app' };

    await expect(provider.getBranchAccess(auth, project, 'feature/secure')).resolves.toEqual({
      exists: true,
      canPush: false,
    });
    await expect(provider.getBranchAccess(auth, project, 'missing')).resolves.toEqual({
      exists: false,
      canPush: false,
    });
  });

  it('creates branches through the authenticated user credential', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/v4/projects/42/repository/branches');
      expect(init).toMatchObject({
        method: 'POST',
        body: JSON.stringify({ branch: 'feature/new', ref: 'main' }),
      });
      return jsonResponse({ name: 'feature/new' }, {}, 201);
    });
    const provider = new GitLabProvider(fetchImpl as typeof fetch);

    await expect(
      provider.createBranch(
        { baseUrl: 'https://gitlab.test', token: 'personal-token' },
        { remoteId: '42', fullPath: 'org/app', name: 'app' },
        'feature/new',
        'main'
      )
    ).resolves.toBeUndefined();
  });

  it('lists registries only for the provided project scope', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v4/projects') {
        return jsonResponse([{ id: 12, path_with_namespace: 'org/private', name: 'private' }]);
      }
      if (url.pathname === '/api/v4/projects/11/registry/repositories') {
        return jsonResponse([
          {
            id: 101,
            location: 'registry.gitlab.test/org/app',
            name: 'app',
            path: 'org/app',
          },
        ]);
      }
      if (url.pathname === '/api/v4/projects/12/registry/repositories') {
        return new Response('forbidden', { status: 403 });
      }
      return jsonResponse([]);
    });

    const provider = new GitLabProvider(fetchImpl as typeof fetch);
    const result = await provider.listRegistries({ baseUrl: 'https://gitlab.test', token: 'token' }, [
      { remoteId: '11', fullPath: 'org/app', name: 'app' },
    ]);

    expect(result.registries).toEqual([
      {
        remoteRegistryId: '101',
        projectRemoteId: '11',
        projectFullPath: 'org/app',
        registryUrl: 'registry.gitlab.test/org/app',
        name: 'app',
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/api/v4/projects/11/registry/repositories'),
      expect.any(Object)
    );
  });

  it('downloads repository archives through the default tar.gz archive endpoint', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/v4/projects/42/repository/archive.tar.gz');
      expect(url.searchParams.get('sha')).toBe('main');
      return new Response(Buffer.from('archive-body'), {
        status: 200,
        headers: { 'content-type': 'application/gzip' },
      });
    });

    const provider = new GitLabProvider(fetchImpl as typeof fetch);
    const archive = await provider.downloadRepositoryArchive(
      { baseUrl: 'https://gitlab.test', token: 'token' },
      { remoteId: '42', fullPath: 'org/app', name: 'app' },
      'main'
    );

    expect(archive).toEqual({
      filename: 'app.tar.gz',
      contentType: 'application/gzip',
      bytes: Buffer.from('archive-body'),
    });
  });

  it('streams repository archives through the same authenticated endpoint', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/v4/projects/42/repository/archive.tar.gz');
      expect(url.searchParams.get('sha')).toBe('main');
      return new Response(Buffer.alloc(300 * 1024, 3), {
        status: 200,
        headers: { 'content-type': 'application/gzip' },
      });
    });

    const provider = new GitLabProvider(fetchImpl as typeof fetch);
    const archive = await provider.streamRepositoryArchive(
      { baseUrl: 'https://gitlab.test', token: 'token' },
      { remoteId: '42', fullPath: 'org/app', name: 'app' },
      'main'
    );
    const chunks: Buffer[] = [];
    for await (const chunk of archive.chunks) chunks.push(chunk);

    expect(archive.filename).toBe('app.tar.gz');
    expect(chunks.every((chunk) => chunk.byteLength <= 256 * 1024)).toBe(true);
    expect(Buffer.concat(chunks)).toHaveLength(300 * 1024);
  });

  it('skips forbidden project registries without failing the whole registry discovery', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v4/projects/10/registry/repositories') {
        return new Response('forbidden', { status: 403 });
      }
      if (url.pathname === '/api/v4/projects/11/registry/repositories') {
        return jsonResponse([{ id: 101, location: 'registry.gitlab.test/org/app', name: 'app' }]);
      }
      return jsonResponse([]);
    });

    const provider = new GitLabProvider(fetchImpl as typeof fetch);
    const result = await provider.listRegistries({ baseUrl: 'https://gitlab.test', token: 'token' }, [
      { remoteId: '10', fullPath: 'org/blocked', name: 'blocked' },
      { remoteId: '11', fullPath: 'org/app', name: 'app' },
    ]);

    expect(result.registries).toEqual([
      {
        remoteRegistryId: '101',
        projectRemoteId: '11',
        projectFullPath: 'org/app',
        registryUrl: 'registry.gitlab.test/org/app',
        name: 'app',
      },
    ]);
    expect(result.skippedProjects).toEqual([{ remoteId: '10', fullPath: 'org/blocked', reason: 'forbidden' }]);
  });
});
