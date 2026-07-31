import { describe, expect, it, vi } from 'vitest';
import { AIService } from './ai.service.js';

const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['proxy:view'],
  isBlocked: false,
};

function createService({
  proxyService = {},
  nodesService = {},
  dockerService = {},
}: {
  proxyService?: Record<string, unknown>;
  nodesService?: Record<string, unknown>;
  dockerService?: Record<string, unknown>;
}) {
  return new AIService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    proxyService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { log: vi.fn() } as never,
    {} as never,
    nodesService as never,
    {} as never,
    {} as never,
    dockerService as never
  );
}

describe('AIService resource search tool', () => {
  it('requires a query or a concrete resource type before delegating searches', async () => {
    const proxyService = { listProxyHosts: vi.fn() };
    const service = createService({ proxyService });

    await expect(service.executeTool(BASE_USER, 'find_resource', { query: '   ' })).resolves.toEqual({
      error: 'query or types is required',
      invalidateStores: [],
    });
    expect(proxyService.listProxyHosts).not.toHaveBeenCalled();
  });

  it('delegates proxy host search with limit clamping and skips post-filtering for service-filtered results', async () => {
    const proxyService = {
      listProxyHosts: vi.fn().mockResolvedValue({
        data: [
          { id: 'host-1', domainNames: ['api.example.com'], nodeId: 'node-1', enabled: true },
          { id: 'host-2', domainNames: ['worker.example.com'], nodeId: 'node-1', enabled: true },
        ],
        total: 2,
      }),
    };
    const service = createService({ proxyService });

    const result = await service.executeTool(BASE_USER, 'find_resource', {
      query: 'api',
      types: ['proxy_host'],
      limit: 100,
    });

    expect(proxyService.listProxyHosts).toHaveBeenCalledWith(
      { search: 'api', page: 1, limit: 50 },
      { allowedIds: undefined }
    );
    expect(result.error).toBeUndefined();
    expect((result.result as { results: Array<{ type: string; id: string; name: string }> }).results).toEqual([
      expect.objectContaining({
        type: 'proxy_host',
        id: 'host-1',
        name: 'api.example.com',
        nodeId: 'node-1',
      }),
      expect.objectContaining({
        type: 'proxy_host',
        id: 'host-2',
        name: 'worker.example.com',
        nodeId: 'node-1',
      }),
    ]);
    expect(result.result).toMatchObject({ query: 'api', total: 2, truncated: false });
  });

  it('discovers docker nodes from scoped grants and searches only authorized nodes', async () => {
    const nodesService = {
      list: vi.fn().mockResolvedValue({
        data: [
          { id: 'node-1', slug: 'node-one' },
          { id: 'node-2', slug: 'node-two' },
        ],
        totalPages: 1,
      }),
    };
    const dockerService = {
      listContainers: vi
        .fn()
        .mockResolvedValueOnce([{ Id: 'container-1', Name: '/api', Image: 'gateway/api:latest', State: 'running' }])
        .mockResolvedValueOnce([
          { Id: 'container-2', Name: '/worker', Image: 'gateway/worker:latest', State: 'running' },
        ]),
    };
    const service = createService({ nodesService, dockerService });

    const result = await service.executeTool(
      { ...BASE_USER, scopes: ['docker:containers:view:node-1', 'docker:containers:view:node-2'] },
      'find_resource',
      { query: 'gateway', types: ['docker_container'] }
    );

    expect(nodesService.list).toHaveBeenCalledWith(
      { type: 'docker', page: 1, limit: 100 },
      { allowedIds: ['node-1', 'node-2'] }
    );
    expect(dockerService.listContainers).toHaveBeenCalledTimes(2);
    expect(dockerService.listContainers).toHaveBeenNthCalledWith(1, 'node-1');
    expect(dockerService.listContainers).toHaveBeenNthCalledWith(2, 'node-2');
    expect((result.result as { results: Array<{ id: string; nodeId: string; nodeSlug: string }> }).results).toEqual([
      expect.objectContaining({
        type: 'docker_container',
        id: 'container-1',
        name: 'api',
        nodeId: 'node-1',
        nodeSlug: 'node-one',
      }),
      expect.objectContaining({
        type: 'docker_container',
        id: 'container-2',
        name: 'worker',
        nodeId: 'node-2',
        nodeSlug: 'node-two',
      }),
    ]);
  });

  it('lists typed resources when query is empty', async () => {
    const nodesService = {
      list: vi.fn().mockResolvedValue({
        data: [{ id: 'node-1', slug: 'node-one' }],
        totalPages: 1,
      }),
    };
    const dockerService = {
      listContainers: vi.fn().mockResolvedValue([
        { Id: 'container-1', Name: '/api', Image: 'gateway/api:latest', State: 'running' },
        { Id: 'container-2', Name: '/db', Image: 'postgres:16', State: 'exited' },
      ]),
    };
    const service = createService({ nodesService, dockerService });

    const result = await service.executeTool(
      { ...BASE_USER, scopes: ['docker:containers:view:node-1'] },
      'find_resource',
      { query: '', types: ['docker_container'], limit: 50 }
    );

    expect(result.error).toBeUndefined();
    expect(nodesService.list).toHaveBeenCalledWith({ type: 'docker', page: 1, limit: 100 }, { allowedIds: ['node-1'] });
    expect(dockerService.listContainers).toHaveBeenCalledWith('node-1');
    expect((result.result as { results: Array<{ id: string; nodeId: string }> }).results).toEqual([
      expect.objectContaining({ type: 'docker_container', id: 'container-1', name: 'api', nodeId: 'node-1' }),
      expect.objectContaining({ type: 'docker_container', id: 'container-2', name: 'db', nodeId: 'node-1' }),
    ]);
    expect(result.result).toMatchObject({ query: '', total: 2, truncated: false });
  });
});
