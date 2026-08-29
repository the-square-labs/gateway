import type { VcsConnectorProvider } from '@/modules/integrations/integration-provider.types.js';
import { GitLabProvider } from '@/modules/integrations/gitlab-provider.js';
import { describe, expect, it, vi } from 'vitest';

const auth = { baseUrl: 'https://gitlab.test/', token: 'glpat-test-token' };
const project = { remoteId: '42', fullPath: 'group/app', name: 'app', defaultBranch: 'main' };

type FetchHandler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function providerFor(handler: FetchHandler) {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(new URL(String(input)), init)
  );
  return { fetchImpl, provider: new GitLabProvider(fetchImpl as typeof fetch) };
}

describe('GitLabProvider characterization contracts', () => {
  it('implements the shared VCS provider contract with the GitLab identity', () => {
    const { provider } = providerFor(() => jsonResponse([]));
    const contract: VcsConnectorProvider = provider;

    expect(contract.provider).toBe('gitlab');
  });

  it('maps the authenticated user and token metadata into the public identity', async () => {
    const { provider } = providerFor((url) => {
      if (url.pathname === '/api/v4/user') return jsonResponse({ id: 17, username: 'alice' });
      if (url.pathname === '/api/v4/personal_access_tokens/self') {
        return jsonResponse({ scopes: ['api', 'read_repository'], expires_at: '2030-01-02' });
      }
      throw new Error(`Unexpected GitLab request: ${url}`);
    });

    await expect(provider.validateUserToken(auth)).resolves.toEqual({
      userId: '17',
      username: 'alice',
      scopes: ['api', 'read_repository'],
      expiresAt: new Date('2030-01-02T00:00:00.000Z'),
    });
  });

  it('defaults token scopes and expiry when token metadata is unavailable', async () => {
    const { provider } = providerFor((url) => {
      if (url.pathname === '/api/v4/user') return jsonResponse({ id: 17, username: 'alice' });
      if (url.pathname === '/api/v4/personal_access_tokens/self') return jsonResponse({}, 404);
      throw new Error(`Unexpected GitLab request: ${url}`);
    });

    await expect(provider.validateUserToken(auth)).resolves.toEqual({
      userId: '17',
      username: 'alice',
      scopes: [],
      expiresAt: null,
    });
  });

  it('uses the strongest project or group permission level and normalizes project fields', async () => {
    const { provider } = providerFor((url) => {
      if (url.pathname === '/api/v4/projects/42') {
        return jsonResponse({
          id: 42,
          path_with_namespace: 'group/app',
          name: 'app',
          web_url: 'https://gitlab.test/group/app',
          visibility: 'private',
          default_branch: 'main',
          archived: true,
          permissions: {
            project_access: { access_level: 30 },
            group_access: { access_level: 40 },
          },
        });
      }
      throw new Error(`Unexpected GitLab request: ${url}`);
    });

    await expect(provider.getProjectAccess(auth, project)).resolves.toEqual({
      project: {
        remoteId: '42',
        fullPath: 'group/app',
        name: 'app',
        webUrl: 'https://gitlab.test/group/app',
        visibility: 'private',
        defaultBranch: 'main',
        archived: true,
      },
      accessLevel: 40,
    });
  });

  it('reports every capability as available for an API-scoped token when safe discovery has no sample project', async () => {
    const { provider } = providerFor((url) => {
      if (url.pathname === '/api/v4/user') return jsonResponse({ id: 1, username: 'bot' });
      if (url.pathname === '/api/v4/personal_access_tokens/self') return jsonResponse({ scopes: ['api'] });
      if (url.pathname === '/api/v4/projects' || url.pathname === '/api/v4/groups') return jsonResponse([]);
      throw new Error(`Unexpected GitLab request: ${url}`);
    });

    await expect(provider.testConnection(auth)).resolves.toEqual({
      apiReachable: true,
      tokenSelf: true,
      projectsView: true,
      groupsView: true,
      repoRead: true,
      repoWrite: true,
      ciView: true,
      ciLint: true,
      ciEdit: true,
      pipelineRead: true,
      variablesView: true,
      variablesEdit: true,
      variablesDelete: true,
      registryView: true,
      registryUse: true,
      webhooksManage: true,
      deployTokensManage: true,
    });
  });

  it('keeps read-only capability defaults when token introspection is unavailable', async () => {
    const { provider } = providerFor((url) => {
      if (url.pathname === '/api/v4/user') return jsonResponse({ id: 1, username: 'bot' });
      if (url.pathname === '/api/v4/personal_access_tokens/self') return jsonResponse({}, 404);
      if (url.pathname === '/api/v4/projects' || url.pathname === '/api/v4/groups') return jsonResponse([]);
      throw new Error(`Unexpected GitLab request: ${url}`);
    });

    await expect(provider.testConnection(auth)).resolves.toEqual({
      apiReachable: true,
      tokenSelf: false,
      projectsView: true,
      groupsView: true,
      repoRead: false,
      repoWrite: false,
      ciView: false,
      ciLint: false,
      ciEdit: false,
      pipelineRead: false,
      variablesView: false,
      variablesEdit: false,
      variablesDelete: false,
      registryView: false,
      registryUse: false,
      webhooksManage: false,
      deployTokensManage: false,
    });
  });

  it('combines allowlist groups and projects while preserving the search query', async () => {
    const { provider } = providerFor((url) => {
      expect(url.searchParams.get('search')).toBe('group app');
      expect(url.searchParams.get('page')).toBe('1');
      expect(url.searchParams.get('per_page')).toBe('20');
      if (url.pathname === '/api/v4/groups') {
        return jsonResponse([{ id: 7, full_path: 'group', name: 'Group', web_url: 'https://gitlab.test/group' }]);
      }
      if (url.pathname === '/api/v4/projects') {
        expect(url.searchParams.get('simple')).toBe('true');
        return jsonResponse([{ id: 42, path_with_namespace: 'group/app', name: 'app' }]);
      }
      throw new Error(`Unexpected GitLab request: ${url}`);
    });

    await expect(provider.searchAllowlist(auth, 'group app')).resolves.toEqual([
      {
        entryType: 'group',
        remoteId: '7',
        fullPath: 'group',
        name: 'Group',
        webUrl: 'https://gitlab.test/group',
      },
      { entryType: 'project', remoteId: '42', fullPath: 'group/app', name: 'app', webUrl: null },
    ]);
  });

  it('maps paginated project discovery and preserves the provider ordering', async () => {
    const { provider } = providerFor((url) => {
      expect(url.pathname).toBe('/api/v4/projects');
      expect(url.searchParams.get('simple')).toBe('true');
      expect(url.searchParams.get('order_by')).toBe('last_activity_at');
      expect(url.searchParams.get('sort')).toBe('desc');
      expect(url.searchParams.get('per_page')).toBe('100');
      if (url.searchParams.get('page') === '1') {
        return jsonResponse(
          [{ id: 1, path_with_namespace: 'group/one', name: 'one' }],
          200,
          { 'x-next-page': '2' }
        );
      }
      return jsonResponse([
        {
          id: 2,
          path_with_namespace: 'group/two',
          name: 'two',
          web_url: 'https://gitlab.test/group/two',
          visibility: 'public',
          default_branch: 'develop',
          archived: true,
        },
      ]);
    });

    await expect(provider.listProjects(auth)).resolves.toEqual([
      {
        remoteId: '1',
        fullPath: 'group/one',
        name: 'one',
        webUrl: null,
        visibility: null,
        defaultBranch: null,
        archived: false,
      },
      {
        remoteId: '2',
        fullPath: 'group/two',
        name: 'two',
        webUrl: 'https://gitlab.test/group/two',
        visibility: 'public',
        defaultBranch: 'develop',
        archived: true,
      },
    ]);
  });

  it('discovers registries, skips forbidden projects, and falls back to repository path for names', async () => {
    const projects = [
      { remoteId: '42', fullPath: 'group/app', name: 'app' },
      { remoteId: '43', fullPath: 'group/blocked', name: 'blocked' },
    ];
    const { provider } = providerFor((url) => {
      if (url.pathname === '/api/v4/projects/42/registry/repositories') {
        return jsonResponse([
          { id: 100, path: 'group/app', location: 'registry.gitlab.test/group/app' },
          { id: 101, path: 'group/no-location' },
        ]);
      }
      if (url.pathname === '/api/v4/projects/43/registry/repositories') return new Response('forbidden', { status: 403 });
      throw new Error(`Unexpected GitLab request: ${url}`);
    });

    await expect(provider.listRegistries(auth, projects)).resolves.toEqual({
      registries: [
        {
          remoteRegistryId: '100',
          projectRemoteId: '42',
          projectFullPath: 'group/app',
          registryUrl: 'registry.gitlab.test/group/app',
          name: 'group/app',
        },
      ],
      skippedProjects: [{ remoteId: '43', fullPath: 'group/blocked', reason: 'forbidden' }],
    });
  });

  it('encodes project and tree path values and normalizes tree entries', async () => {
    const treeProject = { ...project, remoteId: 'group/app' };
    const { provider } = providerFor((url) => {
      expect(url.pathname).toBe('/api/v4/projects/group%2Fapp/repository/tree');
      expect(url.searchParams.get('path')).toBe('src/dir');
      expect(url.searchParams.get('ref')).toBe('release/v1');
      expect(url.searchParams.get('page')).toBe('1');
      return jsonResponse([
        { id: 'tree-1', name: 'dir', type: 'tree', path: 'src/dir', mode: '040000' },
        { name: 'README.md', type: 'blob', path: 'README.md' },
      ]);
    });

    await expect(provider.listTree(auth, treeProject, 'src/dir', 'release/v1')).resolves.toEqual([
      { id: 'tree-1', name: 'dir', type: 'tree', path: 'src/dir', mode: '040000' },
      { id: null, name: 'README.md', type: 'blob', path: 'README.md', mode: null },
    ]);
  });

  it('decodes and slices repository file content using the project default branch', async () => {
    const { provider } = providerFor((url) => {
      expect(url.pathname).toBe('/api/v4/projects/42/repository/files/docs%2Fread%20me.txt');
      expect(url.searchParams.get('ref')).toBe('main');
      return jsonResponse({
        file_path: 'docs/read me.txt',
        ref: 'main',
        blob_id: 'blob-1',
        commit_id: 'commit-1',
        size: 10,
        encoding: 'base64',
        content: Buffer.from('0123456789').toString('base64'),
      });
    });

    await expect(
      provider.readFile(auth, { project, path: 'docs/read me.txt', offset: 2.9, length: 4.9 })
    ).resolves.toEqual({
      path: 'docs/read me.txt',
      ref: 'main',
      content: '2345',
      encoding: 'utf8',
      size: 10,
      offset: 2,
      bytesRead: 4,
      truncated: true,
      nextOffset: 6,
      blobId: 'blob-1',
      commitId: 'commit-1',
    });
  });

  it('reports branch push access and treats a missing branch as an absent resource', async () => {
    const { provider } = providerFor((url) => {
      if (url.pathname === '/api/v4/projects/42/repository/branches/feature%2Fsecure') {
        return jsonResponse({ can_push: true, commit: { id: 'sha-1' } });
      }
      if (url.pathname === '/api/v4/projects/42/repository/branches/missing') return new Response('missing', { status: 404 });
      throw new Error(`Unexpected GitLab request: ${url}`);
    });

    await expect(provider.getBranchAccess(auth, project, 'feature/secure')).resolves.toEqual({
      exists: true,
      canPush: true,
      commitSha: 'sha-1',
    });
    await expect(provider.getBranchAccess(auth, project, 'missing')).resolves.toEqual({
      exists: false,
      canPush: false,
    });
  });

  it('maps pipeline, job, and job-log responses while applying result limits', async () => {
    const { provider } = providerFor((url) => {
      if (url.pathname === '/api/v4/projects/42/pipelines') {
        expect(url.searchParams.get('ref')).toBe('main');
        expect(url.searchParams.get('per_page')).toBe('1');
        return jsonResponse([
          {
            id: 10,
            iid: 3,
            ref: 'main',
            sha: 'sha-10',
            status: 'success',
            source: 'push',
            web_url: 'https://gitlab.test/pipelines/10',
            created_at: '2030-01-01T00:00:00Z',
            updated_at: '2030-01-01T01:00:00Z',
          },
          { id: 11, ref: 'ignored-by-limit' },
        ]);
      }
      if (url.pathname === '/api/v4/projects/42/pipelines/99') return jsonResponse({ id: 99, ref: 'develop' });
      if (url.pathname === '/api/v4/projects/42/pipelines/99/jobs') {
        expect(url.searchParams.get('per_page')).toBe('1');
        return jsonResponse([
          {
            id: 501,
            name: 'test',
            stage: 'test',
            status: 'success',
            ref: 'main',
            web_url: 'https://gitlab.test/jobs/501',
            created_at: '2030-01-01T00:00:00Z',
            started_at: '2030-01-01T00:01:00Z',
            finished_at: '2030-01-01T00:02:00Z',
          },
          { id: 502, name: 'ignored-by-limit' },
        ]);
      }
      if (url.pathname === '/api/v4/projects/42/jobs/501/trace') {
        return new Response('job output', { headers: { 'content-type': 'text/plain' } });
      }
      throw new Error(`Unexpected GitLab request: ${url}`);
    });

    await expect(provider.listPipelines(auth, project, 'main', 1)).resolves.toEqual([
      {
        id: 10,
        iid: 3,
        ref: 'main',
        sha: 'sha-10',
        status: 'success',
        source: 'push',
        webUrl: 'https://gitlab.test/pipelines/10',
        createdAt: '2030-01-01T00:00:00Z',
        updatedAt: '2030-01-01T01:00:00Z',
      },
    ]);
    await expect(provider.getPipeline(auth, project, 99)).resolves.toEqual({
      id: 99,
      iid: null,
      ref: 'develop',
      sha: null,
      status: null,
      source: null,
      webUrl: null,
      createdAt: null,
      updatedAt: null,
    });
    await expect(provider.listPipelineJobs(auth, project, 99, 1)).resolves.toEqual([
      {
        id: 501,
        name: 'test',
        stage: 'test',
        status: 'success',
        ref: 'main',
        webUrl: 'https://gitlab.test/jobs/501',
        createdAt: '2030-01-01T00:00:00Z',
        startedAt: '2030-01-01T00:01:00Z',
        finishedAt: '2030-01-01T00:02:00Z',
      },
    ]);
    await expect(provider.getJobLog(auth, project, 501, 1_000)).resolves.toEqual({
      jobId: 501,
      output: 'job output',
      bytesRead: 10,
      totalBytes: 10,
      truncated: false,
    });
  });
});
