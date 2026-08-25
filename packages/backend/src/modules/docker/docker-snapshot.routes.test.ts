import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { AppEnv } from '@/types.js';
import { DockerManagementService } from './docker.service.js';
import { registerContainerRoutes } from './docker-container.routes.js';
import { registerNetworkRoutes } from './docker-network.routes.js';
import { registerDockerSnapshotRoutes } from './docker-snapshot.routes.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';
import { DockerSnapshotReconciler } from './docker-snapshot-reconciler.service.js';
import { registerVolumeRoutes } from './docker-volume.routes.js';

const NODE_1 = '11111111-1111-4111-8111-111111111111';
const NODE_2 = '22222222-2222-4222-8222-222222222222';

class MemoryCache {
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  hashes = new Map<string, Map<string, string>>();
  async get<T>(key: string): Promise<T | null> {
    const value = this.strings.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }
  async set<T>(key: string, value: T) {
    this.strings.set(key, JSON.stringify(value));
  }
  async sadd(key: string, ...values: string[]) {
    this.sets.set(key, new Set([...(this.sets.get(key) ?? []), ...values]));
    return values.length;
  }
  getClient() {
    return {
      hget: vi.fn(async (key: string, field: string) => this.hashes.get(key)?.get(field) ?? null),
      hset: vi.fn(async (key: string, field: string, value: string) => {
        const hash = this.hashes.get(key) ?? new Map<string, string>();
        hash.set(field, value);
        this.hashes.set(key, hash);
        return 1;
      }),
      hkeys: vi.fn(async (key: string) => [...(this.hashes.get(key)?.keys() ?? [])]),
      hdel: vi.fn(async (key: string, field: string) => (this.hashes.get(key)?.delete(field) ? 1 : 0)),
      del: vi.fn(),
    };
  }
}

const NODES = [
  { id: NODE_1, type: 'docker', slug: 'one', hostname: 'one', displayName: null, appearanceColor: null },
  { id: NODE_2, type: 'docker', slug: 'two', hostname: 'two', displayName: null, appearanceColor: null },
];

function fakeDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const rows = [...NODES];
          return Object.assign(Promise.resolve(rows), { limit: vi.fn().mockResolvedValue([NODES[0]]) });
        }),
      })),
    })),
  };
}

async function setup() {
  const cache = new MemoryCache();
  const snapshots = new DockerSnapshotService(
    fakeDb() as never,
    cache as never,
    { getNode: vi.fn((id) => ({ nodeId: id })) } as never,
    new EventBusService()
  );
  await snapshots.replaceList(NODE_1, 'containers', [{ id: 'c1', name: 'one', state: 'running' }]);
  await snapshots.replaceList(NODE_2, 'containers', [{ id: 'c2', name: 'two', state: 'running' }]);
  const docker = {
    decorateContainerSnapshot: vi.fn(async (_nodeId, data) => data),
    decoratePublicContainerSnapshot: vi.fn(async (_nodeId, data) => data),
    decoratePublicVolumeSnapshot: vi.fn(async (_nodeId, data) => data),
    decorateContainerDetailSnapshot: vi.fn(async (_nodeId, data) => data),
    listContainers: vi.fn(),
    listGpuAttachmentUsers: vi.fn(),
  };
  const dispatch = {
    sendDockerContainerCommand: vi.fn(),
    sendDockerImageCommand: vi.fn(),
    sendDockerVolumeCommand: vi.fn(),
    sendDockerNetworkCommand: vi.fn(),
  };
  const reconciler = { enqueue: vi.fn(), refreshNow: vi.fn().mockResolvedValue(undefined) };
  container.registerInstance(DockerSnapshotService, snapshots);
  container.registerInstance(DockerManagementService, docker as never);
  container.registerInstance(NodeDispatchService, dispatch as never);
  container.registerInstance(DockerSnapshotReconciler, reconciler as never);
  return { snapshots, docker, dispatch, reconciler };
}

function appWithScopes(scopes: string[]) {
  const app = new OpenAPIHono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('effectiveScopes', scopes);
    await next();
  });
  return app;
}

afterEach(() => {
  container.reset();
});

describe('Docker snapshot routes', () => {
  it('hides Gateway-managed database networks from aggregate snapshots', async () => {
    const { snapshots } = await setup();
    await snapshots.replaceList(NODE_1, 'networks', [
      { Id: 'managed', Name: 'gateway-db-79c029a3cedc4af1', Driver: 'bridge' },
      { Id: 'application', Name: 'application', Driver: 'bridge' },
    ]);
    const app = appWithScopes([`docker:networks:view:${NODE_1}`]);
    registerDockerSnapshotRoutes(app);

    const response = await app.request('/networks');

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.data.map((network: any) => network.name)).toEqual(['application']);
  });

  it('hides Compose-owned children from aggregate standalone lists while retaining shared resources', async () => {
    const { snapshots } = await setup();
    await snapshots.replaceList(NODE_1, 'containers', [
      { id: 'compose', name: 'demo-api-1', labels: { 'com.docker.compose.project': 'demo' } },
      { id: 'standalone', name: 'standalone' },
    ]);
    await snapshots.replaceList(NODE_1, 'volumes', [
      {
        Name: 'demo-data',
        Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.volume': 'data' },
      },
      { Name: 'shared-data', Labels: { external: 'true' } },
    ]);
    await snapshots.replaceList(NODE_1, 'networks', [
      {
        Id: 'demo',
        Name: 'demo_default',
        Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.network': 'default' },
      },
      { Id: 'shared', Name: 'shared', Labels: { external: 'true' } },
    ]);
    const app = appWithScopes([
      `docker:containers:view:${NODE_1}`,
      `docker:volumes:view:${NODE_1}`,
      `docker:networks:view:${NODE_1}`,
    ]);
    registerDockerSnapshotRoutes(app);

    const containerResponse = await app.request('/containers');
    await expect(containerResponse.json()).resolves.toMatchObject({
      data: [expect.objectContaining({ name: 'standalone' })],
      total: 1,
    });
    const volumeResponse = await app.request('/volumes');
    await expect(volumeResponse.json()).resolves.toMatchObject({
      data: [expect.objectContaining({ name: 'shared-data' })],
      total: 1,
    });
    const networkResponse = await app.request('/networks');
    await expect(networkResponse.json()).resolves.toMatchObject({
      data: [expect.objectContaining({ name: 'shared' })],
      total: 1,
    });
  });

  it('applies the Compose ownership filter to node-specific lists', async () => {
    const { snapshots } = await setup();
    await snapshots.replaceList(NODE_1, 'containers', [
      { id: 'compose', name: 'demo-api-1', labels: { 'com.docker.compose.project': 'demo' } },
      { id: 'standalone', name: 'standalone' },
    ]);
    await snapshots.replaceList(NODE_1, 'volumes', [
      {
        Name: 'demo-data',
        Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.volume': 'data' },
      },
      { Name: 'shared-data', Labels: { external: 'true' } },
    ]);
    await snapshots.replaceList(NODE_1, 'networks', [
      {
        Id: 'demo',
        Name: 'demo_default',
        Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.network': 'default' },
      },
      { Id: 'shared', Name: 'shared', Labels: { external: 'true' } },
    ]);
    const app = appWithScopes([
      `docker:containers:view:${NODE_1}`,
      `docker:volumes:view:${NODE_1}`,
      `docker:networks:view:${NODE_1}`,
    ]);
    registerContainerRoutes(app);
    registerVolumeRoutes(app);
    registerNetworkRoutes(app);

    for (const [path, key] of [
      [`/nodes/${NODE_1}/containers`, 'name'],
      [`/nodes/${NODE_1}/volumes`, 'name'],
      [`/nodes/${NODE_1}/networks`, 'name'],
    ] as const) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: Array<Record<string, unknown>>; total: number };
      expect(body.total).toBe(1);
      expect(body.data[0]?.[key]).toMatch(/standalone|shared/);
    }
  });

  it('aggregate GET filters unauthorized nodes and never dispatches a daemon command', async () => {
    const { dispatch } = await setup();
    const app = appWithScopes([`docker:containers:view:${NODE_1}`]);
    registerDockerSnapshotRoutes(app);

    const response = await app.request('/containers');
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ nodeId: NODE_1, name: 'one', availability: 'available' });
    expect(body.nodes.map((node: any) => node.id)).toEqual([NODE_1]);
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalled();
  });

  it('per-node list GET reads the snapshot and does not call the live list service or dispatch', async () => {
    const { docker, dispatch } = await setup();
    const app = appWithScopes([`docker:containers:view:${NODE_1}`]);
    registerContainerRoutes(app);

    const response = await app.request(`/nodes/${NODE_1}/containers`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.data[0]).toMatchObject({ nodeId: NODE_1, name: 'one', availability: 'available' });
    expect(docker.listContainers).not.toHaveBeenCalled();
    expect(docker.decoratePublicContainerSnapshot).toHaveBeenCalledWith(NODE_1, [
      { id: 'c1', name: 'one', state: 'running' },
    ]);
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalled();
  });

  it('cache-busted by-name inspect refreshes the list before the detail snapshot', async () => {
    const { snapshots, reconciler } = await setup();
    vi.spyOn(snapshots, 'getContainerDetailSnapshot').mockResolvedValue({
      data: { Id: 'c2', Name: '/one' },
      revision: 2,
      observedAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      lastError: null,
      refreshStatus: 'success',
    });
    const app = appWithScopes(['docker:containers:view']);
    registerContainerRoutes(app);

    const response = await app.request(`/nodes/${NODE_1}/containers/by-name/one?_t=123`);

    expect(response.status).toBe(200);
    expect(reconciler.refreshNow).toHaveBeenNthCalledWith(1, NODE_1, 'containers');
    expect(reconciler.refreshNow).toHaveBeenNthCalledWith(2, NODE_1, 'container-detail', 'one');
  });

  it('serves volume metrics from the snapshot cache without live daemon dispatch', async () => {
    const { snapshots, dispatch, reconciler } = await setup();
    const metrics = {
      storageKind: 'regular',
      usedBytes: 42,
      capacityBytes: null,
      availableBytes: null,
      usedInodes: null,
      totalInodes: null,
      runningAttachmentCount: 1,
      collectedAt: '2026-08-24T12:00:00.000Z',
    };
    await snapshots.replaceList(NODE_1, 'volumes', [{ name: 'data' }]);
    await snapshots.replaceDetail(NODE_1, 'volume-metrics', 'data', metrics);
    const app = appWithScopes([`docker:volumes:view:${NODE_1}`]);
    registerVolumeRoutes(app);

    const response = await app.request(`/nodes/${NODE_1}/volumes/data/metrics`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: metrics });
    expect(dispatch.sendDockerVolumeCommand).not.toHaveBeenCalled();
    expect(reconciler.enqueue).not.toHaveBeenCalled();
  });

  it('queues a missing volume metrics snapshot and returns immediately', async () => {
    const { snapshots, dispatch, reconciler } = await setup();
    await snapshots.replaceList(NODE_1, 'volumes', [{ name: 'data' }]);
    const app = appWithScopes([`docker:volumes:view:${NODE_1}`]);
    registerVolumeRoutes(app);

    const response = await app.request(`/nodes/${NODE_1}/volumes/data/metrics`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'DOCKER_VOLUME_METRICS_PENDING' });
    expect(reconciler.enqueue).toHaveBeenCalledWith(
      { nodeId: NODE_1, kind: 'volume-metrics', key: 'data' },
      { urgent: true }
    );
    expect(dispatch.sendDockerVolumeCommand).not.toHaveBeenCalled();
  });

  it('returns GPU users only for containers visible to the caller', async () => {
    const { docker } = await setup();
    docker.listGpuAttachmentUsers.mockResolvedValue([
      {
        containerId: 'visible-runtime-id',
        name: 'visible',
        scopeResourceId: 'resource-visible',
        deviceIds: ['nvidia:GPU-1'],
      },
      {
        containerId: 'hidden-runtime-id',
        name: 'hidden',
        scopeResourceId: 'resource-hidden',
        deviceIds: ['nvidia:GPU-1'],
      },
    ]);
    const app = appWithScopes([`docker:containers:view:${NODE_1}/resource-visible`]);
    registerContainerRoutes(app);

    const response = await app.request(`/nodes/${NODE_1}/containers/gpu-usage`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [
        {
          deviceId: 'nvidia:GPU-1',
          containerCount: 1,
          containers: [{ name: 'visible' }],
        },
      ],
    });
  });

  it('manual refresh submits an urgent deduplicated hint', async () => {
    const { reconciler } = await setup();
    const app = appWithScopes([`docker:containers:view:${NODE_1}`]);
    registerDockerSnapshotRoutes(app);

    const response = await app.request('/snapshots/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: NODE_1, resource: 'containers' }),
    });

    expect(response.status).toBe(202);
    expect(reconciler.enqueue).toHaveBeenCalledWith(
      { nodeId: NODE_1, kind: 'containers', key: undefined },
      { urgent: true }
    );
  });
});
