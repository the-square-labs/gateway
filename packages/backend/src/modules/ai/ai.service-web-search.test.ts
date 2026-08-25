import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIService } from './ai.service.js';

const USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['ai:workspace:use'],
  isBlocked: false,
};

function createService(config: Record<string, unknown>) {
  return new AIService(
    {
      getConfig: vi.fn().mockResolvedValue(config),
      getDecryptedWebSearchKey: vi.fn().mockResolvedValue(config.webSearchApiKey ?? null),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { log: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AIService web search tool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls Tavily with a clamped result limit and normalizes results', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            title: 'TLS guide',
            url: 'https://example.com/tls',
            content: 'Modern TLS guidance',
          },
        ],
      })
    );
    const service = createService({
      webSearchProvider: 'tavily',
      webSearchApiKey: 'tavily-key',
      webSearchBaseUrl: '',
    });

    await expect(service.executeTool(USER, 'web_search', { query: 'tls', maxResults: 20 })).resolves.toEqual({
      result: { results: [{ title: 'TLS guide', url: 'https://example.com/tls', snippet: 'Modern TLS guidance' }] },
      invalidateStores: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: 'tavily-key',
          query: 'tls',
          max_results: 10,
          search_depth: 'basic',
        }),
      })
    );
  });

  it('calls SearXNG without requiring an API key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            title: 'Proxy docs',
            url: 'https://example.com/proxy',
            content: 'Reverse proxy docs',
          },
        ],
      })
    );
    const service = createService({
      webSearchProvider: 'searxng',
      webSearchBaseUrl: 'https://search.example.com/',
    });

    await expect(service.executeTool(USER, 'web_search', { query: 'proxy', maxResults: 3 })).resolves.toEqual({
      result: { results: [{ title: 'Proxy docs', url: 'https://example.com/proxy', snippet: 'Reverse proxy docs' }] },
      invalidateStores: [],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://search.example.com/search?q=proxy&format=json&pageno=1');
  });

  it('returns a clear tool error when provider credentials are missing', async () => {
    const service = createService({
      webSearchProvider: 'brave',
      webSearchBaseUrl: '',
    });

    await expect(service.executeTool(USER, 'web_search', { query: 'certificates' })).resolves.toEqual({
      result: { error: 'Web search is not configured. An admin must set up the web search API key.' },
      invalidateStores: [],
    });
  });
});
