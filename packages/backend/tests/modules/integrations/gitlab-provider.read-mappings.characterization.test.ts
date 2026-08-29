import { GitLabProvider } from '@/modules/integrations/gitlab-provider.js';
import { describe, expect, it, vi } from 'vitest';

const auth = { baseUrl: 'https://gitlab.test/', token: 'glpat-test-token' };
const project = { remoteId: '42', fullPath: 'group/app', name: 'app' };

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
  return { provider: new GitLabProvider(fetchImpl as typeof fetch) };
}

describe('GitLabProvider read mapping characterization', () => {
  it('normalizes project variables, webhooks, and registry repositories', async () => {
    const { provider } = providerFor((url) => {
      if (url.pathname === '/api/v4/projects/42/variables') {
        return jsonResponse([
          {
            key: 'CONFIG',
            variable_type: 'file',
            protected: true,
            masked: true,
            raw: true,
            environment_scope: 'production',
            description: 'config file',
          },
          { key: 'EMPTY' },
        ]);
      }
      if (url.pathname === '/api/v4/projects/42/hooks') {
        return jsonResponse([
          {
            id: 8,
            url: 'https://gateway.test/hooks/gitlab',
            push_events: true,
            merge_requests_events: true,
            tag_push_events: false,
            job_events: true,
            pipeline_events: false,
            enable_ssl_verification: true,
            created_at: '2030-01-01T00:00:00Z',
          },
        ]);
      }
      if (url.pathname === '/api/v4/projects/42/registry/repositories') {
        return jsonResponse([
          { id: 100, name: 'app', path: 'group/app', location: 'registry.gitlab.test/group/app', tags_count: 4 },
          { id: 101, path: 'group/worker' },
        ]);
      }
      throw new Error(`Unexpected GitLab request: ${url}`);
    });

    await expect(provider.listProjectVariables(auth, project)).resolves.toEqual([
      {
        key: 'CONFIG',
        variableType: 'file',
        protected: true,
        masked: true,
        raw: true,
        environmentScope: 'production',
        description: 'config file',
      },
      {
        key: 'EMPTY',
        variableType: null,
        protected: false,
        masked: false,
        raw: false,
        environmentScope: null,
        description: null,
      },
    ]);
    await expect(provider.listProjectWebhooks(auth, project)).resolves.toEqual([
      {
        id: 8,
        url: 'https://gateway.test/hooks/gitlab',
        pushEvents: true,
        mergeRequestsEvents: true,
        tagPushEvents: false,
        jobEvents: true,
        pipelineEvents: false,
        enableSslVerification: true,
        createdAt: '2030-01-01T00:00:00Z',
      },
    ]);
    await expect(provider.listRegistryRepositories(auth, project)).resolves.toEqual([
      {
        id: '100',
        name: 'app',
        path: 'group/app',
        location: 'registry.gitlab.test/group/app',
        tagsCount: 4,
      },
      { id: '101', name: 'group/worker', path: 'group/worker', location: null, tagsCount: null },
    ]);
  });
});
