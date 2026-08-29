import { GitLabProvider } from '@/modules/integrations/gitlab-provider.js';
import { describe, expect, it, vi } from 'vitest';

const auth = { baseUrl: 'https://gitlab.test/', token: 'glpat-test-token' };
const project = { remoteId: 'group/app', fullPath: 'group/app', name: 'app' };

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

function requestBody(init: RequestInit | undefined) {
  return JSON.parse(String(init?.body));
}

describe('GitLabProvider request characterization', () => {
  it('creates a branch with an encoded project path and the requested branch/ref body', async () => {
    const { provider } = providerFor((url, init) => {
      expect(url.pathname).toBe('/api/v4/projects/group%2Fapp/repository/branches');
      expect(init).toMatchObject({
        method: 'POST',
        headers: expect.objectContaining({ 'PRIVATE-TOKEN': auth.token }),
      });
      expect(requestBody(init)).toEqual({ branch: 'feature/new', ref: 'main' });
      return jsonResponse({ name: 'feature/new' }, 201);
    });

    await expect(provider.createBranch(auth, project, 'feature/new', 'main')).resolves.toBeUndefined();
  });

  it('commits files using GitLab action field names and preserves base64 encoding', async () => {
    const { provider } = providerFor((url, init) => {
      expect(url.pathname).toBe('/api/v4/projects/group%2Fapp/repository/commits');
      expect(init?.method).toBe('POST');
      expect(requestBody(init)).toEqual({
        branch: 'feature/new',
        commit_message: 'Update files',
        start_branch: 'main',
        actions: [
          { action: 'update', file_path: 'README.md', content: 'hello' },
          {
            action: 'move',
            file_path: 'docs/new.md',
            previous_path: 'docs/old.md',
            content: 'encoded-content',
            encoding: 'base64',
          },
        ],
      });
      return jsonResponse({ id: 'commit-1', web_url: 'https://gitlab.test/group/app/-/commit/commit-1' });
    });

    await expect(
      provider.commitFiles(auth, {
        project,
        branch: 'feature/new',
        commitMessage: 'Update files',
        startBranch: 'main',
        changes: [
          { action: 'update', path: 'README.md', content: 'hello', encoding: 'text' },
          {
            action: 'move',
            path: 'docs/new.md',
            previousPath: 'docs/old.md',
            content: 'encoded-content',
            encoding: 'base64',
          },
        ],
      })
    ).resolves.toEqual({
      commitSha: 'commit-1',
      webUrl: 'https://gitlab.test/group/app/-/commit/commit-1',
    });
  });

  it('lints CI content with merged YAML requested and normalizes optional response fields', async () => {
    const content = 'stages: [test]\njob:\n  stage: test\n  script: echo ok\n';
    const { provider } = providerFor((url, init) => {
      expect(url.pathname).toBe('/api/v4/ci/lint');
      expect(init?.method).toBe('POST');
      expect(requestBody(init)).toEqual({ content, include_merged_yaml: true });
      return jsonResponse({ valid: false, errors: ['invalid job'], warnings: ['deprecated key'] });
    });

    await expect(provider.lintCiConfig(auth, project, content)).resolves.toEqual({
      valid: false,
      errors: ['invalid job'],
      warnings: ['deprecated key'],
      mergedYaml: null,
    });
  });

  it('updates an existing project variable with an environment-scope filter', async () => {
    const { provider } = providerFor((url, init) => {
      expect(url.pathname).toBe('/api/v4/projects/group%2Fapp/variables/API%2FTOKEN');
      expect(url.searchParams.get('filter')).toBe(JSON.stringify({ environment_scope: 'production' }));
      expect(init?.method).toBe('PUT');
      expect(requestBody(init)).toEqual({
        key: 'API/TOKEN',
        value: 'secret-value',
        variable_type: 'file',
        protected: true,
        masked: true,
        raw: true,
        environment_scope: 'production',
        description: 'deployment credential',
      });
      return jsonResponse({
        key: 'API/TOKEN',
        variable_type: 'file',
        protected: true,
        masked: true,
        raw: true,
        environment_scope: 'production',
        description: 'deployment credential',
      });
    });

    await expect(
      provider.setProjectVariable(auth, project, {
        key: 'API/TOKEN',
        value: 'secret-value',
        variableType: 'file',
        protected: true,
        masked: true,
        raw: true,
        environmentScope: 'production',
        description: 'deployment credential',
      })
    ).resolves.toEqual({
      key: 'API/TOKEN',
      variableType: 'file',
      protected: true,
      masked: true,
      raw: true,
      environmentScope: 'production',
      description: 'deployment credential',
    });
  });

  it('creates a project variable after GitLab reports that the update target is absent', async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const { provider } = providerFor((url, init) => {
      calls.push({ url, init });
      if (init?.method === 'PUT') return new Response('not found', { status: 404 });
      expect(url.pathname).toBe('/api/v4/projects/group%2Fapp/variables');
      expect(init?.method).toBe('POST');
      expect(requestBody(init)).toEqual({
        key: 'LOG_LEVEL',
        value: 'debug',
        variable_type: 'env_var',
      });
      return jsonResponse({ key: 'LOG_LEVEL' });
    });

    await expect(provider.setProjectVariable(auth, project, { key: 'LOG_LEVEL', value: 'debug' })).resolves.toEqual({
      key: 'LOG_LEVEL',
      variableType: null,
      protected: false,
      masked: false,
      raw: false,
      environmentScope: null,
      description: null,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.pathname).toBe('/api/v4/projects/group%2Fapp/variables/LOG_LEVEL');
  });

  it('deletes a project variable with the optional environment-scope filter', async () => {
    const { provider } = providerFor((url, init) => {
      expect(url.pathname).toBe('/api/v4/projects/group%2Fapp/variables/LOG_LEVEL');
      expect(url.searchParams.get('filter')).toBe(JSON.stringify({ environment_scope: 'staging' }));
      expect(init?.method).toBe('DELETE');
      return new Response(null, { status: 204 });
    });

    await expect(provider.deleteProjectVariable(auth, project, 'LOG_LEVEL', 'staging')).resolves.toBeUndefined();
  });

  it('creates and updates project webhooks through the corresponding GitLab endpoints', async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const { provider } = providerFor((url, init) => {
      requests.push({ url, init });
      expect(requestBody(init)).toEqual({
        url: 'https://gateway.test/hooks/gitlab',
        token: 'hook-secret',
        push_events: true,
        merge_requests_events: false,
        tag_push_events: true,
        job_events: false,
        pipeline_events: true,
        enable_ssl_verification: true,
      });
      return jsonResponse({
        id: init?.method === 'POST' ? 8 : 9,
        url: 'https://gateway.test/hooks/gitlab',
        push_events: true,
        tag_push_events: true,
        pipeline_events: true,
        enable_ssl_verification: true,
      });
    });
    const input = {
      url: 'https://gateway.test/hooks/gitlab',
      token: 'hook-secret',
      pushEvents: true,
      mergeRequestsEvents: false,
      tagPushEvents: true,
      jobEvents: false,
      pipelineEvents: true,
      enableSslVerification: true,
    };

    await expect(provider.createOrUpdateProjectWebhook(auth, project, input)).resolves.toMatchObject({ id: 8 });
    await expect(provider.createOrUpdateProjectWebhook(auth, project, { ...input, id: 9 })).resolves.toMatchObject({
      id: 9,
    });

    expect(requests.map(({ url, init }) => [url.pathname, init?.method])).toEqual([
      ['/api/v4/projects/group%2Fapp/hooks', 'POST'],
      ['/api/v4/projects/group%2Fapp/hooks/9', 'PUT'],
    ]);
  });

  it('deletes a project webhook by project and hook id', async () => {
    const { provider } = providerFor((url, init) => {
      expect(url.pathname).toBe('/api/v4/projects/group%2Fapp/hooks/8');
      expect(init?.method).toBe('DELETE');
      return new Response(null, { status: 204 });
    });

    await expect(provider.deleteProjectWebhook(auth, project, 8)).resolves.toBeUndefined();
  });

  it('creates deploy tokens with GitLab field names and applies response fallbacks', async () => {
    const { provider } = providerFor((url, init) => {
      expect(url.pathname).toBe('/api/v4/projects/group%2Fapp/deploy_tokens');
      expect(init?.method).toBe('POST');
      expect(requestBody(init)).toEqual({
        name: 'gateway-reader',
        scopes: ['read_registry'],
        expires_at: '2030-12-31',
      });
      return jsonResponse({ id: 77, name: 'gateway-reader', username: 'gldt-77', token: 'issued-token' });
    });

    await expect(
      provider.createDeployToken(auth, project, {
        name: 'gateway-reader',
        scopes: ['read_registry'],
        expiresAt: '2030-12-31',
      })
    ).resolves.toEqual({
      id: 77,
      name: 'gateway-reader',
      username: 'gldt-77',
      token: 'issued-token',
      scopes: ['read_registry'],
      expiresAt: '2030-12-31',
    });
  });

  it('updates project container-registry settings and normalizes the returned project', async () => {
    const { provider } = providerFor((url, init) => {
      expect(url.pathname).toBe('/api/v4/projects/group%2Fapp');
      expect(init?.method).toBe('PUT');
      expect(requestBody(init)).toEqual({ container_registry_access_level: 'private' });
      return jsonResponse({
        id: 42,
        path_with_namespace: 'group/app',
        name: 'app',
        web_url: 'https://gitlab.test/group/app',
        container_registry_access_level: 'private',
      });
    });

    await expect(
      provider.updateProjectSettings(auth, project, { containerRegistryAccessLevel: 'private' })
    ).resolves.toEqual({
      remoteId: '42',
      fullPath: 'group/app',
      name: 'app',
      webUrl: 'https://gitlab.test/group/app',
      containerRegistryAccessLevel: 'private',
    });
  });

  it('downloads and streams repository archives from the archive endpoint with the requested ref', async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const { provider } = providerFor((url, init) => {
      requests.push({ url, init });
      expect(url.pathname).toBe('/api/v4/projects/group%2Fapp/repository/archive.tar.gz');
      expect(url.searchParams.get('sha')).toBe('release/v1');
      expect(init).toMatchObject({
        method: 'GET',
        headers: expect.objectContaining({ 'PRIVATE-TOKEN': auth.token }),
      });
      return new Response(Buffer.from('archive-content'), {
        status: 200,
        headers: { 'content-type': 'application/gzip' },
      });
    });

    await expect(
      provider.downloadRepositoryArchive(auth, { ...project, name: '' }, 'release/v1', {
        maxBytes: 1024,
        timeoutMs: 2_000,
      })
    ).resolves.toEqual({
      filename: 'group/app.tar.gz',
      contentType: 'application/gzip',
      bytes: Buffer.from('archive-content'),
    });

    const streamed = await provider.streamRepositoryArchive(auth, project, 'release/v1', {
      maxBytes: 1024,
      timeoutMs: 2_000,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of streamed.chunks) chunks.push(chunk);

    expect(streamed.filename).toBe('app.tar.gz');
    expect(streamed.contentType).toBe('application/gzip');
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('archive-content'));
    expect(requests).toHaveLength(2);
  });
});
