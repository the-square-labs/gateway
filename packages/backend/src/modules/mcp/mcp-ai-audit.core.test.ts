import { describe, expect, it, vi } from 'vitest';
import { markAuditEmitted, runWithAuditRequestContext } from '@/modules/audit/audit-request-context.js';
import {
  container,
  createService,
  DockerDeploymentService,
  DockerRegistryService,
  ProxyService,
  registerMcpResources,
  USER,
} from './mcp-ai-audit.test-helpers.js';

describe('AIService MCP audit core behavior', () => {
  it('writes mcp audit entries for mutating MCP tool calls', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const nodesService = {
      create: vi.fn().mockResolvedValue({ node: { id: 'node-1' }, enrollmentToken: 'gw_node_secret' }),
    };
    const service = createService({ nodesService, auditService });

    const result = await service.executeTool(
      USER,
      'create_node',
      { hostname: 'node-1', type: 'docker' },
      { source: 'mcp', scopes: ['nodes:create'], tokenId: 'token-1', tokenPrefix: 'gw_abc1234' }
    );

    expect(result.error).toBeUndefined();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER.id,
        action: 'mcp.create_node',
        resourceType: 'nodes',
        details: expect.objectContaining({
          source: 'mcp',
          success: true,
          tokenId: 'token-1',
          tokenPrefix: 'gw_abc1234',
          toolName: 'create_node',
          arguments: { hostname: 'node-1', type: 'docker' },
        }),
      })
    );
  });

  it('writes failed mcp audit entries for mutating MCP tool failures', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const nodesService = {
      create: vi.fn().mockRejectedValue(new Error('create failed')),
    };
    const service = createService({ nodesService, auditService });

    const result = await service.executeTool(
      USER,
      'create_node',
      { hostname: 'node-1', type: 'docker' },
      { source: 'mcp', scopes: ['nodes:create'], tokenId: 'token-1', tokenPrefix: 'gw_abc1234' }
    );

    expect(result.error).toBe('create failed');
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mcp.create_node',
        details: expect.objectContaining({
          success: false,
          error: 'create failed',
          tokenId: 'token-1',
        }),
      })
    );
  });

  it('writes descriptive audit entries for read-only MCP tool calls', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const nodesService = {
      list: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 }),
    };
    const service = createService({ nodesService, auditService });

    const result = await service.executeTool(USER, 'list_nodes', {}, { source: 'mcp', scopes: ['nodes:details'] });

    expect(result.error).toBeUndefined();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER.id,
        action: 'mcp.list_nodes',
        resourceType: 'nodes',
        details: expect.objectContaining({
          source: 'mcp',
          success: true,
          toolName: 'list_nodes',
          arguments: {},
        }),
      })
    );
  });

  it('does not add a duplicate MCP entry when the domain service already audited the tool', async () => {
    const auditService = {
      log: vi.fn(async (_entry: unknown) => {
        markAuditEmitted();
      }),
    };
    const nodesService = {
      create: vi.fn(async () => {
        await auditService.log({ action: 'node.create' });
        return { node: { id: 'node-1' }, enrollmentToken: 'gw_node_secret' };
      }),
    };
    const service = createService({ nodesService, auditService });

    const result = await runWithAuditRequestContext({ auditEmitted: false }, () =>
      service.executeTool(
        USER,
        'create_node',
        { hostname: 'node-1', type: 'docker' },
        { source: 'mcp', scopes: ['nodes:create'] }
      )
    );

    expect(result.error).toBeUndefined();
    expect(auditService.log).toHaveBeenCalledTimes(1);
    expect(auditService.log).toHaveBeenCalledWith({ action: 'node.create' });
  });

  it('passes explicit Docker registry selection through MCP image pulls', async () => {
    const registryId = '22222222-2222-4222-8222-222222222222';
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const dockerService = {
      pullImage: vi.fn().mockResolvedValue({ taskId: 'task-1' }),
    };
    const registryService = {
      resolveAuthForImagePull: vi.fn().mockResolvedValue({
        registryId,
        url: 'registry.example.com',
        authJson: 'encoded-auth',
      }),
    };
    container.registerInstance(DockerRegistryService, registryService as never);
    const service = createService({ nodesService: {}, dockerService, auditService });

    const result = await service.executeTool(
      USER,
      'pull_docker_image',
      { nodeId: 'node-1', imageRef: 'team/app:v1', registryId },
      { source: 'mcp', scopes: ['docker:images:pull:node-1'] }
    );

    expect(result.error).toBeUndefined();
    expect(registryService.resolveAuthForImagePull).toHaveBeenCalledWith('node-1', 'team/app:v1', registryId, {
      actorScopes: ['docker:images:pull:node-1'],
    });
    expect(dockerService.pullImage).toHaveBeenCalledWith(
      'node-1',
      'registry.example.com/team/app:v1',
      'encoded-auth',
      USER.id,
      registryId
    );
  });

  it('enforces operation-specific scopes inside aggregated MCP tools', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const dockerService = {
      updateContainerEnv: vi.fn(),
    };
    const service = createService({ nodesService: {}, dockerService, auditService });

    const result = await service.executeTool(
      USER,
      'manage_docker_container_config',
      { operation: 'update_env', nodeId: 'node-1', containerId: 'container-1', env: { FOO: 'bar' } },
      { source: 'mcp', scopes: ['docker:containers:view:node-1'] }
    );

    expect(result.error).toContain('PERMISSION_DENIED');
    expect(dockerService.updateContainerEnv).not.toHaveBeenCalled();
  });

  it('returns compact node list payloads without bulky health report blobs', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const nodesService = {
      list: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'node-1',
            type: 'docker',
            hostname: 'docker-1',
            displayName: 'Docker 1',
            status: 'online',
            isConnected: true,
            serviceCreationLocked: false,
            daemonVersion: '1.0.0',
            osInfo: 'linux',
            configVersionHash: 'hash',
            capabilities: { dockerVersion: '26.0.0' },
            lastSeenAt: new Date('2026-04-30T00:00:00.000Z'),
            lastHealthReport: { healthChecks: Array.from({ length: 100 }, (_, index) => ({ index })) },
            lastStatsReport: { history: Array.from({ length: 100 }, (_, index) => ({ index })) },
            healthHistory: Array.from({ length: 100 }, (_, index) => ({ index })),
            metadata: { noisy: true },
            createdAt: new Date('2026-04-29T00:00:00.000Z'),
            updatedAt: new Date('2026-04-30T00:00:00.000Z'),
          },
        ],
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1,
      }),
    };
    const service = createService({ nodesService, auditService });

    const result = await service.executeTool(USER, 'list_nodes', {}, { source: 'mcp', scopes: ['nodes:details'] });

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      data: [
        {
          id: 'node-1',
          type: 'docker',
          hostname: 'docker-1',
          status: 'online',
          isConnected: true,
        },
      ],
      total: 1,
    });
    expect(JSON.stringify(result.result)).not.toContain('lastHealthReport');
    expect(JSON.stringify(result.result)).not.toContain('lastStatsReport');
    expect(JSON.stringify(result.result)).not.toContain('healthHistory');
  });

  it('returns compact proxy host list payloads without health history or detailed health check body', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const proxyService = {
      listProxyHosts: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'proxy-1',
            type: 'proxy',
            domainNames: ['app.example.com'],
            enabled: true,
            nodeId: 'node-1',
            forwardScheme: 'http',
            forwardHost: 'app',
            forwardPort: 3000,
            sslEnabled: true,
            sslForced: true,
            sslCertificateId: 'cert-1',
            accessListId: null,
            healthCheckEnabled: true,
            healthCheckExpectedBody: 'large expected body',
            healthHistory: Array.from({ length: 100 }, (_, index) => ({ index })),
            healthStatus: 'online',
            effectiveHealthStatus: 'online',
            lastHealthCheckAt: new Date('2026-04-30T00:00:00.000Z'),
            rawConfig: 'proxy_set_header X-Test value;',
            rawConfigEnabled: true,
            createdAt: new Date('2026-04-29T00:00:00.000Z'),
            updatedAt: new Date('2026-04-30T00:00:00.000Z'),
          },
        ],
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      }),
    };
    const service = createService({ nodesService: {}, proxyService, auditService });

    const result = await service.executeTool(USER, 'list_routes', {}, { source: 'mcp', scopes: ['proxy:view'] });

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      data: [
        {
          id: 'proxy-1',
          domainNames: ['app.example.com'],
          healthCheckEnabled: true,
          healthStatus: 'online',
        },
      ],
    });
    expect(JSON.stringify(result.result)).not.toContain('healthHistory');
    expect(JSON.stringify(result.result)).not.toContain('healthCheckExpectedBody');
    expect(JSON.stringify(result.result)).not.toContain('rawConfig');
    expect(JSON.stringify(result.result)).not.toContain('rawConfigEnabled');
    expect(JSON.stringify(result.result)).not.toContain('proxy_set_header X-Test value');
  });

  it('returns compact proxy host detail payloads without raw config fields', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const proxyService = {
      getProxyHost: vi.fn().mockResolvedValue({
        id: 'proxy-1',
        type: 'raw',
        domainNames: ['app.example.com'],
        enabled: true,
        nodeId: 'node-1',
        rawConfig: 'server { proxy_set_header Authorization secret; }',
        rawConfigEnabled: true,
      }),
    };
    const service = createService({ nodesService: {}, proxyService, auditService });

    const result = await service.executeTool(
      USER,
      'get_route',
      { routeId: 'proxy-1' },
      { source: 'mcp', scopes: ['proxy:view:proxy-1'] }
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ id: 'proxy-1', type: 'raw', domainNames: ['app.example.com'] });
    expect(JSON.stringify(result.result)).not.toContain('rawConfig');
    expect(JSON.stringify(result.result)).not.toContain('rawConfigEnabled');
    expect(JSON.stringify(result.result)).not.toContain('proxy_set_header Authorization');
  });

  it('returns compact proxy mutation payloads without raw config fields', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const rawProxyHost = {
      id: 'proxy-1',
      type: 'raw',
      domainNames: ['app.example.com'],
      enabled: true,
      nodeId: 'node-1',
      forwardHost: 'app',
      forwardPort: 3000,
      rawConfig: 'server { proxy_set_header Authorization secret; }',
      rawConfigEnabled: true,
    };
    const proxyService = {
      createProxyHost: vi.fn().mockResolvedValue(rawProxyHost),
      updateProxyHost: vi.fn().mockResolvedValue(rawProxyHost),
      getProxyHost: vi.fn().mockResolvedValue(rawProxyHost),
    };
    const service = createService({ nodesService: {}, proxyService, auditService });

    const results = await Promise.all([
      service.executeTool(
        USER,
        'create_route',
        { nodeId: 'node-1', domainNames: ['app.example.com'], forwardHost: 'app', forwardPort: 3000 },
        { source: 'mcp', scopes: ['proxy:create'] }
      ),
      service.executeTool(
        USER,
        'update_route',
        { routeId: 'proxy-1', enabled: false },
        { source: 'mcp', scopes: ['proxy:edit:proxy-1'] }
      ),
      service.executeTool(
        USER,
        'update_route_raw_config',
        { routeId: 'proxy-1', rawConfig: 'server { return 204; }' },
        { source: 'mcp', scopes: ['proxy:raw:write:proxy-1'] }
      ),
      service.executeTool(
        USER,
        'toggle_route_raw_mode',
        { routeId: 'proxy-1', enabled: true },
        { source: 'mcp', scopes: ['proxy:raw:toggle:proxy-1'] }
      ),
    ]);

    for (const result of results) {
      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({ id: 'proxy-1', type: 'raw', domainNames: ['app.example.com'] });
      expect(JSON.stringify(result.result)).not.toContain('rawConfig');
      expect(JSON.stringify(result.result)).not.toContain('rawConfigEnabled');
      expect(JSON.stringify(result.result)).not.toContain('proxy_set_header Authorization');
    }
  });

  it('rejects raw proxy field smuggling through generic proxy host updates', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const proxyService = {
      updateProxyHost: vi.fn().mockResolvedValue({ id: 'proxy-1' }),
    };
    const service = createService({ nodesService: {}, proxyService, auditService });

    const result = await service.executeTool(
      { ...USER, scopes: ['proxy:edit:proxy-1'] },
      'update_route',
      { routeId: 'proxy-1', rawConfig: 'server { return 204; }' },
      { source: 'mcp', scopes: ['proxy:edit:proxy-1'], tokenId: 'token-1', tokenPrefix: 'gwo_abc1234' }
    );

    expect(result.error).toBe('Raw config changes require dedicated raw config tools');
    expect(proxyService.updateProxyHost).not.toHaveBeenCalled();
  });

  it('requires explicit raw read scope before returning rendered proxy config through MCP', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const proxyService = {
      getProxyHost: vi.fn().mockResolvedValue({ id: 'proxy-1' }),
      getRenderedConfig: vi.fn().mockResolvedValue('server { return 204; }'),
    };
    const service = createService({ nodesService: {}, proxyService, auditService });

    const denied = await service.executeTool(
      { ...USER, scopes: ['proxy:raw:write:proxy-1'] },
      'get_route_rendered_config',
      { routeId: 'proxy-1' },
      { source: 'mcp', scopes: ['proxy:raw:write:proxy-1'], tokenId: 'token-1', tokenPrefix: 'gwo_abc1234' }
    );

    expect(denied.error).toContain('PERMISSION_DENIED');
    expect(proxyService.getRenderedConfig).not.toHaveBeenCalled();

    const allowed = await service.executeTool(
      { ...USER, scopes: ['proxy:raw:read:proxy-1'] },
      'get_route_rendered_config',
      { routeId: 'proxy-1' },
      { source: 'mcp', scopes: ['proxy:raw:read:proxy-1'], tokenId: 'token-1', tokenPrefix: 'gwo_abc1234' }
    );

    expect(allowed.error).toBeUndefined();
    expect(allowed.result).toEqual({ routeId: 'proxy-1', config: 'server { return 204; }' });
  });

  it('returns MCP proxy host resources without raw config fields', async () => {
    const callbacks: Record<string, (uri: URL) => Promise<unknown>> = {};
    const server = {
      registerResource: vi.fn((_: string, uri: string, __: unknown, read: (uri: URL) => Promise<unknown>) => {
        callbacks[uri] = read;
      }),
    };
    container.registerInstance(ProxyService, {
      listProxyHosts: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'proxy-1',
            type: 'raw',
            domainNames: ['app.example.com'],
            enabled: true,
            nodeId: 'node-1',
            forwardHost: 'app',
            forwardPort: 3000,
            sslEnabled: false,
            healthStatus: 'online',
            effectiveHealthStatus: 'online',
            rawConfig: 'server { proxy_set_header X-Test value; }',
            rawConfigEnabled: true,
          },
        ],
        pagination: { total: 1 },
      }),
    } as unknown as ProxyService);

    registerMcpResources(server as never, ['proxy:view']);

    const result = (await callbacks['gateway://proxy/hosts'](new URL('gateway://proxy/hosts'))) as {
      contents: Array<{ text: string }>;
    };
    const body = JSON.parse(result.contents[0].text);

    expect(body.hosts[0]).toMatchObject({ id: 'proxy-1', type: 'raw', domainNames: ['app.example.com'] });
    expect(JSON.stringify(body)).not.toContain('rawConfig');
    expect(JSON.stringify(body)).not.toContain('rawConfigEnabled');
    expect(JSON.stringify(body)).not.toContain('proxy_set_header X-Test value');
  });

  it('returns compact Docker container list payloads without embedded health check details', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const dockerService = {
      listContainers: vi.fn().mockResolvedValue([
        {
          id: 'container-1',
          name: '/app',
          image: 'app:latest',
          state: 'running',
          status: 'Up 1 hour',
          ports: [{ privatePort: 3000, publicPort: 8080 }],
          labels: { noisy: 'metadata' },
          healthCheckId: 'health-1',
          healthCheckEnabled: true,
          healthStatus: 'online',
          lastHealthCheckAt: new Date('2026-04-30T00:00:00.000Z'),
          healthHistory: Array.from({ length: 100 }, (_, index) => ({ index })),
          healthCheck: { healthHistory: Array.from({ length: 100 }, (_, index) => ({ index })) },
        },
      ]),
    };
    const service = createService({ nodesService: {}, dockerService, auditService });

    const result = await service.executeTool(
      USER,
      'list_docker_containers',
      { nodeId: 'node-1' },
      { source: 'mcp', scopes: ['docker:containers:view:node-1'] }
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      data: [
        {
          id: 'container-1',
          name: 'app',
          image: 'app:latest',
          healthCheckEnabled: true,
          healthStatus: 'online',
        },
      ],
      truncated: false,
      total: 1,
    });
    expect(JSON.stringify(result.result)).not.toContain('healthHistory');
    expect(JSON.stringify(result.result)).not.toContain('labels');
  });

  it('returns compact Docker image, volume, and network list payloads for agents', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const dockerService = {
      listImages: vi.fn().mockResolvedValue([
        {
          Id: 'image-1',
          RepoTags: ['app:latest'],
          RepoDigests: ['app@sha256:abc'],
          Created: 123,
          Size: 456,
          Labels: { noisy: 'metadata' },
        },
      ]),
      listVolumes: vi.fn().mockResolvedValue([
        {
          Name: 'data',
          Driver: 'local',
          Mountpoint: '/var/lib/docker/volumes/data/_data',
          UsedBy: Array.from({ length: 101 }, (_, index) => `app-${index}`),
          Labels: { noisy: 'metadata' },
        },
      ]),
      listNetworks: vi.fn().mockResolvedValue([
        {
          Id: 'network-1',
          Name: 'app-net',
          Driver: 'bridge',
          Containers: { a: {}, b: {} },
          IPAM: { Config: Array.from({ length: 100 }, (_, index) => ({ index })) },
        },
      ]),
    };
    const service = createService({ nodesService: {}, dockerService, auditService });

    const images = await service.executeTool(
      USER,
      'list_docker_images',
      { nodeId: 'node-1' },
      { source: 'mcp', scopes: ['docker:images:view:node-1'] }
    );
    const volumes = await service.executeTool(
      USER,
      'list_docker_volumes',
      { nodeId: 'node-1' },
      { source: 'mcp', scopes: ['docker:volumes:view:node-1'] }
    );
    const networks = await service.executeTool(
      USER,
      'list_docker_networks',
      { nodeId: 'node-1' },
      { source: 'mcp', scopes: ['docker:networks:view:node-1'] }
    );

    expect(images.error).toBeUndefined();
    expect(images.result).toMatchObject({
      data: [{ id: 'image-1', repoTags: ['app:latest'], size: 456 }],
      truncated: false,
      total: 1,
    });
    expect(volumes.error).toBeUndefined();
    expect(volumes.result).toMatchObject({
      data: [{ name: 'data', driver: 'local', usedByCount: 101, usedByTruncated: true }],
      truncated: false,
      total: 1,
    });
    expect((volumes.result as any).data[0].usedBy).toHaveLength(100);
    expect(networks.error).toBeUndefined();
    expect(networks.result).toMatchObject({
      data: [{ id: 'network-1', name: 'app-net', containersCount: 2 }],
      truncated: false,
      total: 1,
    });
    expect(JSON.stringify(images.result)).not.toContain('Labels');
    expect(JSON.stringify(volumes.result)).not.toContain('Labels');
    expect(JSON.stringify(networks.result)).not.toContain('IPAM');
    expect(JSON.stringify(networks.result)).not.toContain('"Containers"');
  });

  it('marks agent Docker list payloads as truncated when result caps apply', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const dockerService = {
      listImages: vi.fn().mockResolvedValue(
        Array.from({ length: 1001 }, (_, index) => ({
          Id: `image-${index}`,
          RepoTags: [`app:${index}`],
          Size: index,
        }))
      ),
    };
    const service = createService({ nodesService: {}, dockerService, auditService });

    const result = await service.executeTool(
      USER,
      'list_docker_images',
      { nodeId: 'node-1' },
      { source: 'mcp', scopes: ['docker:images:view:node-1'] }
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ truncated: true, total: 1001, limit: 1000 });
    expect((result.result as { data: unknown[] }).data).toHaveLength(1000);
  });

  it('returns compact Docker deployment list payloads without health history or desired env', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const deploymentService = {
      listSummary: vi.fn().mockResolvedValue([
        {
          id: 'dep-1',
          nodeId: 'node-1',
          name: 'app',
          status: 'ready',
          activeSlot: 'blue',
          desiredConfig: { image: 'app:latest', env: { SECRET: 'hidden' } },
          routes: [{ isPrimary: true, hostPort: 8080, containerPort: 3000, host: 'app.example.com', path: '/' }],
          slots: [{ slot: 'blue', status: 'running', image: 'app:latest', containerId: 'container-1' }],
          healthCheck: {
            id: 'health-1',
            enabled: true,
            healthStatus: 'online',
            lastHealthCheckAt: new Date('2026-04-30T00:00:00.000Z'),
            healthHistory: Array.from({ length: 100 }, (_, index) => ({ index })),
          },
          releases: Array.from({ length: 20 }, (_, index) => ({ index })),
          webhook: { secret: 'hidden' },
          createdAt: new Date('2026-04-29T00:00:00.000Z'),
          updatedAt: new Date('2026-04-30T00:00:00.000Z'),
        },
      ]),
    };
    container.registerInstance(DockerDeploymentService, deploymentService as unknown as DockerDeploymentService);
    const service = createService({ nodesService: {}, auditService });

    const result = await service.executeTool(
      USER,
      'list_docker_deployments',
      { nodeId: 'node-1' },
      { source: 'mcp', scopes: ['docker:containers:view:node-1'] }
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      data: [
        {
          id: 'dep-1',
          name: 'app',
          desiredImage: 'app:latest',
          healthCheck: { id: 'health-1', enabled: true, healthStatus: 'online' },
        },
      ],
      truncated: false,
      total: 1,
    });
    expect(JSON.stringify(result.result)).not.toContain('healthHistory');
    expect(JSON.stringify(result.result)).not.toContain('SECRET');
    expect(JSON.stringify(result.result)).not.toContain('webhook');
    expect(JSON.stringify(result.result)).not.toContain('releases');
  });

  it('keeps existing ai audit entries for mutating AI tool calls', async () => {
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const nodesService = {
      create: vi.fn().mockResolvedValue({ node: { id: 'node-1' }, enrollmentToken: 'gw_node_secret' }),
    };
    const service = createService({ nodesService, auditService });

    const result = await service.executeTool(USER, 'create_node', { hostname: 'node-1', type: 'docker' });

    expect(result.error).toBeUndefined();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ai.create_node',
        details: { ai_initiated: true, arguments: { hostname: 'node-1', type: 'docker' } },
      })
    );
  });
});
