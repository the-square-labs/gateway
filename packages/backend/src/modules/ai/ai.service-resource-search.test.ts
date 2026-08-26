import { describe, expect, it, vi } from 'vitest';
import { findResource } from './ai.resource-search.js';
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
  dockerSnapshotService = {},
}: {
  proxyService?: Record<string, unknown>;
  nodesService?: Record<string, unknown>;
  dockerService?: Record<string, unknown>;
  dockerSnapshotService?: Record<string, unknown>;
}) {
  const resolvedDockerService = {
    decoratePublicContainerSnapshot: vi.fn(async (_nodeId: string, containers: unknown) => containers),
    ...dockerService,
  };
  const resolvedDockerSnapshotService = {
    getList: vi.fn().mockResolvedValue({ data: [] }),
    ...dockerSnapshotService,
  };
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
    resolvedDockerService as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    resolvedDockerSnapshotService as never
  );
}

describe('AIService resource search tool', () => {
  it('discovers Compose projects and build jobs through their first-class tools', async () => {
    const executeToolInternal = vi.fn(async (_user, toolName: string) => {
      if (toolName === 'manage_docker_compose') {
        return [{ id: 'compose-1', name: 'storefront', nodeId: 'node-1' }];
      }
      if (toolName === 'list_docker_builds') {
        return [
          {
            id: 'build-1',
            repositoryPath: 'wiolett/storefront',
            branch: 'main',
            target: { kind: 'compose_project', nodeId: 'node-1', composeProjectId: 'compose-1' },
          },
        ];
      }
      return [];
    });

    const result = await findResource(
      {
        executeToolInternal,
        nodesService: {} as never,
        dockerService: {} as never,
      },
      { ...BASE_USER, scopes: ['docker:compose:view:node-1/compose-1'] },
      { query: '', types: ['docker_compose_project', 'docker_build'] }
    );

    expect(result.results).toEqual([
      expect.objectContaining({ type: 'docker_compose_project', id: 'compose-1', name: 'storefront' }),
      expect.objectContaining({ type: 'docker_build', id: 'build-1', name: 'wiolett/storefront' }),
    ]);
  });

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
    const dockerSnapshotService = {
      getList: vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ Id: 'container-1', Name: '/api', Image: 'gateway/api:latest', State: 'running' }],
        })
        .mockResolvedValueOnce({
          data: [{ Id: 'container-2', Name: '/worker', Image: 'gateway/worker:latest', State: 'running' }],
        }),
    };
    const dockerService = { listContainers: vi.fn() };
    const service = createService({ nodesService, dockerService, dockerSnapshotService });

    const result = await service.executeTool(
      { ...BASE_USER, scopes: ['docker:containers:view:node-1', 'docker:containers:view:node-2'] },
      'find_resource',
      { query: 'gateway', types: ['docker_container'] }
    );

    expect(nodesService.list).toHaveBeenCalledWith(
      { type: 'docker', page: 1, limit: 100 },
      { allowedIds: ['node-1', 'node-2'] }
    );
    expect(dockerSnapshotService.getList).toHaveBeenCalledTimes(2);
    expect(dockerSnapshotService.getList).toHaveBeenNthCalledWith(1, 'node-1', 'containers');
    expect(dockerSnapshotService.getList).toHaveBeenNthCalledWith(2, 'node-2', 'containers');
    expect(dockerService.listContainers).not.toHaveBeenCalled();
    expect((result.result as { results: Array<{ id: string; nodeId: string; nodeSlug: string }> }).results).toEqual([
      expect.objectContaining({
        type: 'docker_container',
        id: 'api',
        name: 'api',
        nodeId: 'node-1',
        nodeSlug: 'node-one',
      }),
      expect.objectContaining({
        type: 'docker_container',
        id: 'worker',
        name: 'worker',
        nodeId: 'node-2',
        nodeSlug: 'node-two',
      }),
    ]);
  });

  it('searches independent sources concurrently while preserving source order', async () => {
    let resolveProxySearch!: (value: { data: Array<Record<string, unknown>>; total: number }) => void;
    const proxyService = {
      listProxyHosts: vi.fn().mockReturnValue(
        new Promise<{ data: Array<Record<string, unknown>>; total: number }>((resolve) => {
          resolveProxySearch = resolve;
        })
      ),
    };
    const nodesService = {
      list: vi.fn().mockResolvedValue({
        data: [{ id: 'node-1', slug: 'node-one' }],
        totalPages: 1,
      }),
    };
    const dockerSnapshotService = {
      getList: vi.fn().mockResolvedValue({
        data: [{ Id: 'container-1', Name: '/api', Image: 'gateway/api:latest', State: 'running' }],
      }),
    };
    const service = createService({ proxyService, nodesService, dockerSnapshotService });

    const resultPromise = service.executeTool(
      { ...BASE_USER, scopes: ['proxy:view', 'docker:containers:view:node-1'] },
      'find_resource',
      { query: 'api', types: ['proxy_host', 'docker_container'] }
    );

    await vi.waitFor(() => expect(dockerSnapshotService.getList).toHaveBeenCalledOnce());
    resolveProxySearch({
      data: [{ id: 'host-1', domainNames: ['api.example.com'], nodeId: 'node-1', enabled: true }],
      total: 1,
    });

    const result = await resultPromise;
    expect((result.result as { results: Array<{ type: string }> }).results.map((item) => item.type)).toEqual([
      'proxy_host',
      'docker_container',
    ]);
  });

  it('reads Docker image, volume, and network inventories from snapshots without daemon calls', async () => {
    const nodesService = {
      list: vi.fn().mockResolvedValue({
        data: [{ id: 'node-1', slug: 'node-one' }],
        totalPages: 1,
      }),
    };
    const dockerSnapshotService = {
      getList: vi.fn(async (_nodeId: string, kind: string) => ({
        data:
          kind === 'images'
            ? [{ Id: 'image-1', RepoTags: ['example/app:secure'] }]
            : kind === 'volumes'
              ? [{ Name: 'secure-data', Driver: 'local' }]
              : [{ Id: 'network-1', Name: 'secure-network', Driver: 'bridge' }],
      })),
    };
    const dockerService = {
      listImages: vi.fn(),
      listVolumes: vi.fn(),
      listNetworks: vi.fn(),
    };
    const service = createService({ nodesService, dockerService, dockerSnapshotService });

    const result = await service.executeTool(
      {
        ...BASE_USER,
        scopes: ['docker:images:view:node-1', 'docker:volumes:view:node-1', 'docker:networks:view:node-1'],
      },
      'find_resource',
      { query: 'secure', types: ['docker_image', 'docker_volume', 'docker_network'] }
    );

    expect((result.result as { results: Array<{ type: string; name: string }> }).results).toEqual([
      expect.objectContaining({ type: 'docker_image', name: 'example/app:secure' }),
      expect.objectContaining({ type: 'docker_volume', name: 'secure-data' }),
      expect.objectContaining({ type: 'docker_network', name: 'secure-network' }),
    ]);
    expect(dockerSnapshotService.getList).toHaveBeenCalledTimes(3);
    expect(dockerService.listImages).not.toHaveBeenCalled();
    expect(dockerService.listVolumes).not.toHaveBeenCalled();
    expect(dockerService.listNetworks).not.toHaveBeenCalled();
  });

  it('lists typed resources when query is empty', async () => {
    const nodesService = {
      list: vi.fn().mockResolvedValue({
        data: [{ id: 'node-1', slug: 'node-one' }],
        totalPages: 1,
      }),
    };
    const dockerSnapshotService = {
      getList: vi.fn().mockResolvedValue({
        data: [
          { Id: 'container-1', Name: '/api', Image: 'gateway/api:latest', State: 'running' },
          { Id: 'container-2', Name: '/db', Image: 'postgres:16', State: 'exited' },
        ],
      }),
    };
    const service = createService({ nodesService, dockerSnapshotService });

    const result = await service.executeTool(
      { ...BASE_USER, scopes: ['docker:containers:view:node-1'] },
      'find_resource',
      { query: '', types: ['docker_container'], limit: 50 }
    );

    expect(result.error).toBeUndefined();
    expect(nodesService.list).toHaveBeenCalledWith({ type: 'docker', page: 1, limit: 100 }, { allowedIds: ['node-1'] });
    expect(dockerSnapshotService.getList).toHaveBeenCalledWith('node-1', 'containers');
    expect((result.result as { results: Array<{ id: string; nodeId: string }> }).results).toEqual([
      expect.objectContaining({ type: 'docker_container', id: 'api', name: 'api', nodeId: 'node-1' }),
      expect.objectContaining({ type: 'docker_container', id: 'db', name: 'db', nodeId: 'node-1' }),
    ]);
    expect(result.result).toMatchObject({ query: '', total: 2, truncated: false });
  });
});
