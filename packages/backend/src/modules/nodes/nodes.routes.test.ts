import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const mocks = vi.hoisted(() => ({
  scopes: [] as string[],
  impersonating: false,
  nodesService: {
    list: vi.fn(),
    get: vi.fn(),
    getHistory: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    regenerateEnrollmentToken: vi.fn(),
  },
  folderService: { assertFolderExists: vi.fn() },
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token) => (token?.name === 'NodeFolderService' ? mocks.folderService : mocks.nodesService)),
  },
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('effectiveScopes', mocks.scopes);
    c.set('user', { id: 'user-1' });
    if (mocks.impersonating) c.set('impersonation', { adminUserId: 'admin-1' });
    await next();
  },
  assertNotImpersonating: (c: any, message?: string) => {
    if (c.get('impersonation')) {
      throw new AppError(403, 'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN', message ?? 'forbidden');
    }
  },
  requireScope: () => async (_c: any, next: () => Promise<void>) => next(),
  requireScopeForResource: () => async (_c: any, next: () => Promise<void>) => next(),
  sessionOnly: async (_c: any, next: () => Promise<void>) => next(),
}));

vi.mock('@/modules/monitoring/log-relay.service.js', () => ({
  daemonLogRelay: {},
  getDaemonLogHistory: vi.fn(),
  getNginxLogHistory: vi.fn(),
  logRelay: {},
}));

import { compactMonitoringHistorySnapshot, nodesRoutes } from './nodes.routes.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', nodesRoutes);
  return app;
}

describe('compactMonitoringHistorySnapshot', () => {
  it('retains GPU inventory in the initial monitoring history payload', () => {
    const gpuDevices = [
      {
        id: 'nvidia:gpu-1',
        vendor: 'nvidia',
        model: 'RTX 3050',
        availableMetrics: ['utilization_percent', 'temperature_celsius'],
        utilizationPercent: 12.5,
        temperatureCelsius: 54,
      },
    ];

    const compacted = compactMonitoringHistorySnapshot({
      timestamp: '2026-08-08T00:00:00.000Z',
      health: { cpuPercent: 4, gpuDevices },
      stats: {},
    });

    expect(compacted.health.gpuDevices).toEqual(gpuDevices);
  });

  it('retains every field used by the initial nginx monitoring view', () => {
    const health = {
      nginxRunning: true,
      configValid: true,
      nginxUptimeSeconds: 123,
      workerCount: 4,
      nginxVersion: '1.28.3',
      nginxRssBytes: 76_120_064,
      cpuPercent: 7.5,
      loadAverage1m: 0.1,
      loadAverage5m: 0.2,
      loadAverage15m: 0.3,
      systemMemoryUsedBytes: 1024,
      systemMemoryTotalBytes: 4096,
      systemMemoryAvailableBytes: 3072,
      swapUsedBytes: 128,
      swapTotalBytes: 512,
    };

    const compacted = compactMonitoringHistorySnapshot({
      timestamp: '2026-08-31T08:00:00.000Z',
      health,
      stats: {},
    });

    expect(compacted.health).toEqual(expect.objectContaining(health));
  });
});

describe('nodesRoutes list access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopes = [];
    mocks.nodesService.list.mockResolvedValue({ data: [], page: 1, limit: 100, total: 0, totalPages: 0 });
  });

  it.each([
    'docker:containers:create:folder/f1',
    'docker:compose:create',
    'docker:networks:create:folder/f1',
  ])('allows creation destination discovery with %s without node details', async (scope) => {
    mocks.scopes = [scope];
    const response = await createApp().request('/?type=docker&limit=100');
    expect(response.status).toBe(200);
    expect(mocks.nodesService.list).toHaveBeenCalledWith(expect.objectContaining({ type: 'docker' }), undefined);
  });

  it('does not treat a folder qualifier as a node ID', async () => {
    mocks.scopes = ['docker:containers:view:folder/f1'];
    const response = await createApp().request('/?type=docker&limit=100');
    expect(response.status).toBe(403);
    expect(mocks.nodesService.list).not.toHaveBeenCalled();
  });

  it.each([
    ['pages:create:node/ingress-1', 'nginx', ['ingress-1']],
    ['databases:create:node/db-node', 'databases', ['db-node']],
    ['databases:create:node/db-node', 'storage', ['db-node']],
    ['storage:create:node/storage-node', 'storage', ['storage-node']],
    ['storage:create:node/storage-node', 'databases', ['storage-node']],
  ])('discovers explicit creation nodes for %s', async (scope, type, ids) => {
    mocks.scopes = [scope as string];
    const response = await createApp().request(`/?type=${type}&limit=100`);
    expect(response.status).toBe(200);
    expect(mocks.nodesService.list).toHaveBeenCalledWith(expect.objectContaining({ type }), { allowedIds: ids });
  });

  it('allows broad Docker view scopes to discover Docker nodes', async () => {
    mocks.scopes = ['docker:containers:view'];

    const response = await createApp().request('/?type=docker&limit=100');

    expect(response.status).toBe(200);
    expect(mocks.nodesService.list).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'docker', limit: 100 }),
      undefined
    );
  });

  it('allows resource-scoped Docker view scopes to discover their Docker node', async () => {
    mocks.scopes = ['docker:containers:view:node-1'];

    const response = await createApp().request('/?type=docker&limit=100');

    expect(response.status).toBe(200);
    expect(mocks.nodesService.list).toHaveBeenCalledWith(expect.objectContaining({ type: 'docker', limit: 100 }), {
      allowedIds: ['node-1'],
    });
  });

  it('allows a resource-scoped route creator to discover only its Ingress node', async () => {
    mocks.scopes = ['proxy:create:ingress-1'];

    const response = await createApp().request('/?type=nginx&limit=100');

    expect(response.status).toBe(200);
    expect(mocks.nodesService.list).toHaveBeenCalledWith(expect.objectContaining({ type: 'nginx', limit: 100 }), {
      allowedIds: ['ingress-1'],
    });
  });

  it('exposes only the safe Pages capabilities in compact Ingress discovery rows', async () => {
    mocks.scopes = ['proxy:create:ingress-1'];
    mocks.nodesService.list.mockResolvedValue({
      data: [
        {
          id: 'ingress-1',
          type: 'nginx',
          hostname: 'nginx-1.internal',
          displayName: 'Ingress 1',
          status: 'online',
          serviceCreationLocked: false,
          capabilities: {
            capabilities: ['nginx_pages_v1', 'nginx_pages_config_v1', 'private_daemon_capability'],
          },
          lastHealthReport: null,
        },
      ],
      page: 1,
      limit: 100,
      total: 1,
      totalPages: 1,
    });

    const response = await createApp().request('/?type=nginx&limit=100');
    const body = (await response.json()) as { data: Array<Record<string, any>> };

    expect(response.status).toBe(200);
    expect(body.data[0].capabilities).toEqual({
      nginx_pages_v1: true,
      nginx_pages_config_v1: true,
    });
  });

  it('discovers only the exact backup executor node and exposes allowlisted capabilities', async () => {
    mocks.scopes = ['nodes:backups:execute:storage-node'];
    mocks.nodesService.list.mockResolvedValue({
      data: [
        {
          id: 'storage-node',
          type: 'storage',
          hostname: 'storage-1.internal',
          displayName: 'Storage 1',
          status: 'online',
          serviceCreationLocked: false,
          daemonVersion: '1.2.3',
          osInfo: 'linux',
          configVersionHash: 'private-hash',
          capabilities: {
            capabilities: [
              'managed_databases_v1',
              'managed_storage_v1',
              'database_backups_v1',
              'private_daemon_capability',
            ],
          },
          metadata: { privateValue: 'must-not-leak' },
          lastHealthReport: null,
          lastStatsReport: { privateValue: 'must-not-leak' },
          isConnected: true,
          createdAt: '',
          updatedAt: '',
        },
      ],
      page: 1,
      limit: 100,
      total: 1,
      totalPages: 1,
    });

    const response = await createApp().request('/?type=storage&limit=100');
    const body = (await response.json()) as { data: Array<Record<string, any>> };

    expect(response.status).toBe(200);
    expect(mocks.nodesService.list).toHaveBeenCalledWith(expect.objectContaining({ type: 'storage' }), {
      allowedIds: ['storage-node'],
    });
    expect(body.data[0]).toMatchObject({
      id: 'storage-node',
      osInfo: null,
      configVersionHash: null,
      metadata: {},
      lastStatsReport: null,
      capabilities: {
        managedDatabasesV1: true,
        managedStorageV1: true,
        databaseBackupsV1: true,
      },
    });
    expect(body.data[0].capabilities).not.toHaveProperty('capabilities');
    expect(body.data[0].capabilities).not.toHaveProperty('private_daemon_capability');
    expect(body.data[0].metadata).not.toHaveProperty('privateValue');
  });

  it('does not let a backup executor grant list Docker or untyped inventory', async () => {
    mocks.scopes = ['nodes:backups:execute:storage-node'];

    const dockerResponse = await createApp().request('/?type=docker&limit=100');
    const untypedResponse = await createApp().request('/?limit=100');

    expect(dockerResponse.status).toBe(403);
    expect(untypedResponse.status).toBe(403);
    expect(mocks.nodesService.list).not.toHaveBeenCalled();
  });

  it('allows a global backup executor grant to discover both stateful node query types', async () => {
    mocks.scopes = ['nodes:backups:execute'];

    const databasesResponse = await createApp().request('/?type=databases&limit=100');
    const storageResponse = await createApp().request('/?type=storage&limit=100');

    expect(databasesResponse.status).toBe(200);
    expect(storageResponse.status).toBe(200);
    expect(mocks.nodesService.list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'databases', limit: 100 }),
      undefined
    );
    expect(mocks.nodesService.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'storage', limit: 100 }),
      undefined
    );
  });

  it('keeps safe Docker runtime metadata in compact node discovery rows', async () => {
    mocks.scopes = ['docker:containers:view'];
    mocks.nodesService.list.mockResolvedValue({
      data: [
        {
          id: 'node-1',
          type: 'docker',
          hostname: 'docker-1.internal',
          displayName: 'Docker 1',
          appearanceColor: 'blue',
          status: 'online',
          serviceCreationLocked: false,
          daemonVersion: '1.2.3',
          osInfo: 'linux',
          configVersionHash: 'hash',
          capabilities: {
            capabilities: ['docker_gpu_v1', 'docker_port_bind_ip_v1'],
          },
          lastSeenAt: null,
          lastHealthReport: {
            systemMemoryTotalBytes: 1024,
            swapTotalBytes: 512,
            networkInterfaces: [
              {
                name: 'eth0',
                rxBytes: 100,
                ipAddresses: ['192.168.1.20'],
              },
            ],
          },
          lastStatsReport: null,
          metadata: {},
          isConnected: true,
          createdAt: '',
          updatedAt: '',
        },
      ],
      page: 1,
      limit: 100,
      total: 1,
      totalPages: 1,
    });

    const response = await createApp().request('/?type=docker&limit=100');
    const body = (await response.json()) as { data: Array<Record<string, any>> };

    expect(response.status).toBe(200);
    expect(body.data[0]).toMatchObject({
      id: 'node-1',
      appearanceColor: 'blue',
      capabilities: {
        dockerPortBindIpV1: true,
      },
      lastHealthReport: {
        systemMemoryTotalBytes: 1024,
        swapTotalBytes: 512,
        networkInterfaces: [{ name: 'eth0', ipAddresses: ['192.168.1.20'] }],
      },
    });
    expect(body.data[0].capabilities).not.toHaveProperty('capabilities');
    expect(body.data[0].lastHealthReport.networkInterfaces[0]).not.toHaveProperty('rxBytes');
  });

  it('still rejects node listing without node or Docker access', async () => {
    mocks.scopes = [];

    const response = await createApp().request('/?type=docker&limit=100');

    expect(response.status).toBe(403);
    expect(mocks.nodesService.list).not.toHaveBeenCalled();
  });
});

describe('nodesRoutes create destination authorization', () => {
  const folderId = '22222222-2222-4222-8222-222222222222';
  const otherFolderId = '33333333-3333-4333-8333-333333333333';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopes = [];
    mocks.folderService.assertFolderExists.mockResolvedValue(undefined);
    mocks.nodesService.create.mockResolvedValue({ node: { id: 'node-1' } });
  });

  const createNode = (targetFolderId?: string) =>
    createApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'nginx',
        hostname: 'pending',
        displayName: 'Ingress',
        ...(targetFolderId === undefined ? {} : { folderId: targetFolderId }),
      }),
    });

  it('allows an exact folder grant and validates the folder before node creation', async () => {
    mocks.scopes = [`nodes:create:folder/${folderId}`];

    const response = await createNode(folderId);

    expect(response.status).toBe(201);
    expect(mocks.folderService.assertFolderExists).toHaveBeenCalledWith(folderId);
    expect(mocks.nodesService.create).toHaveBeenCalledWith(expect.objectContaining({ folderId }), 'user-1');
  });

  it('rejects root and unrelated folders for a folder-only create grant', async () => {
    mocks.scopes = [`nodes:create:folder/${folderId}`];

    const root = await createNode();
    const unrelated = await createNode(otherFolderId);

    expect(root.status).toBe(403);
    expect(unrelated.status).toBe(403);
    expect(mocks.nodesService.create).not.toHaveBeenCalled();
  });
});

describe('nodesRoutes monitoring bootstrap', () => {
  const nodeId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nodesService.get.mockResolvedValue({ id: nodeId, status: 'online' });
    mocks.nodesService.getHistory.mockResolvedValue([
      { timestamp: '2026-08-31T08:00:00.000Z', health: { cpuPercent: 12 }, stats: {}, traffic: null },
    ]);
  });

  it('includes persisted monitoring history in the initial node detail response', async () => {
    const response = await createApp().request(`/${nodeId}`);
    const body = (await response.json()) as { data: Record<string, any> };

    expect(response.status).toBe(200);
    expect(body.data.monitoringHistory).toEqual([
      { timestamp: '2026-08-31T08:00:00.000Z', health: { cpuPercent: 12 }, stats: {}, traffic: null },
    ]);
  });
});

describe('nodesRoutes service address access', () => {
  const nodeId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nodesService.update.mockResolvedValue({ id: nodeId, serviceAddress: 'docker.internal' });
    mocks.nodesService.get.mockResolvedValue({ id: nodeId, type: 'docker' });
  });

  it('rejects a patch without node fields before touching the node', async () => {
    mocks.scopes = [];

    for (const body of [{}, { confirmDomainDnsUpdate: true }]) {
      const response = await createApp().request(`/${nodeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'NO_NODE_CHANGES' });
    }
    expect(mocks.nodesService.update).not.toHaveBeenCalled();
  });

  it('rejects service address changes with rename-only access', async () => {
    mocks.scopes = ['nodes:rename'];

    const response = await createApp().request(`/${nodeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceAddress: 'docker.internal' }),
    });

    expect(response.status).toBe(403);
    expect(mocks.nodesService.update).not.toHaveBeenCalled();
  });

  it('allows service address changes with node config edit access', async () => {
    mocks.scopes = [`nodes:rename:${nodeId}`, `docker:containers:config:${nodeId}`];

    const response = await createApp().request(`/${nodeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceAddress: 'docker.internal' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.nodesService.update).toHaveBeenCalledWith(nodeId, { serviceAddress: 'docker.internal' }, 'user-1');
  });

  it('allows database node endpoint address changes with rename access', async () => {
    mocks.scopes = [`nodes:rename:${nodeId}`];
    mocks.nodesService.get.mockResolvedValue({ id: nodeId, type: 'databases' });

    const response = await createApp().request(`/${nodeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceAddress: 'database.internal' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.nodesService.update).toHaveBeenCalledWith(nodeId, { serviceAddress: 'database.internal' }, 'user-1');
  });

  it('requires node config edit access for Nginx service address changes', async () => {
    mocks.scopes = [`nodes:rename:${nodeId}`];
    mocks.nodesService.get.mockResolvedValue({ id: nodeId, type: 'nginx' });

    const response = await createApp().request(`/${nodeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceAddress: '8.8.8.8' }),
    });

    expect(response.status).toBe(403);
    expect(mocks.nodesService.update).not.toHaveBeenCalled();
  });

  it('allows Nginx service address changes with node config edit access', async () => {
    mocks.scopes = [`nodes:rename:${nodeId}`, `nodes:config:edit:${nodeId}`];
    mocks.nodesService.get.mockResolvedValue({ id: nodeId, type: 'nginx' });

    const response = await createApp().request(`/${nodeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceAddress: '8.8.8.8' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.nodesService.update).toHaveBeenCalledWith(nodeId, { serviceAddress: '8.8.8.8' }, 'user-1');
  });

  it('applies node config edit access to the canonical service address list', async () => {
    mocks.scopes = [`nodes:rename:${nodeId}`, `nodes:config:edit:${nodeId}`];
    mocks.nodesService.get.mockResolvedValue({ id: nodeId, type: 'nginx' });
    const serviceAddresses = ['8.8.8.8', '1.1.1.1', '9.9.9.9'];

    const response = await createApp().request(`/${nodeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceAddresses }),
    });

    expect(response.status).toBe(200);
    expect(mocks.nodesService.update).toHaveBeenCalledWith(nodeId, { serviceAddresses }, 'user-1');
  });

  it('requires domain edit access before confirming assigned DNS target changes', async () => {
    mocks.scopes = [`nodes:rename:${nodeId}`, `nodes:config:edit:${nodeId}`];
    mocks.nodesService.get.mockResolvedValue({ id: nodeId, type: 'nginx' });

    const response = await createApp().request(`/${nodeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceAddress: '8.8.8.8', confirmDomainDnsUpdate: true }),
    });

    expect(response.status).toBe(403);
    expect(mocks.nodesService.update).not.toHaveBeenCalled();
  });
});

describe('nodesRoutes Build Worker settings access', () => {
  const nodeId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nodesService.get.mockResolvedValue({ id: nodeId, type: 'builder' });
    mocks.nodesService.update.mockResolvedValue({ id: nodeId, type: 'builder' });
  });

  it('allows config-edit-only access to update Build Worker settings', async () => {
    mocks.scopes = [`nodes:config:edit:${nodeId}`];
    const builderSettings = { parallelism: 2, timeoutMinutes: 45 };

    const response = await createApp().request(`/${nodeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ builderSettings }),
    });

    expect(response.status).toBe(200);
    expect(mocks.nodesService.update).toHaveBeenCalledWith(nodeId, { builderSettings }, 'user-1');
  });

  it('rejects Build Worker settings with rename-only access', async () => {
    mocks.scopes = [`nodes:rename:${nodeId}`];

    const response = await createApp().request(`/${nodeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ builderSettings: { parallelism: 2, timeoutMinutes: 45 } }),
    });

    expect(response.status).toBe(403);
    expect(mocks.nodesService.update).not.toHaveBeenCalled();
  });

  it('does not let config-edit access modify the node identity', async () => {
    mocks.scopes = [`nodes:config:edit:${nodeId}`];

    const response = await createApp().request(`/${nodeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Renamed builder' }),
    });

    expect(response.status).toBe(403);
    expect(mocks.nodesService.update).not.toHaveBeenCalled();
  });
});

describe('nodesRoutes enrollment tokens under impersonation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopes = ['nodes:create'];
    mocks.impersonating = true;
  });

  afterEach(() => {
    mocks.impersonating = false;
  });

  it('refuses to create a node, which would return an enrollment token', async () => {
    const response = await createApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'docker', hostname: 'node-1' }),
    });

    expect(response.status).toBe(403);
    expect(mocks.nodesService.create).not.toHaveBeenCalled();
  });

  it('refuses to regenerate an enrollment token', async () => {
    const response = await createApp().request('/node-1/enrollment-token', { method: 'POST' });

    expect(response.status).toBe(403);
    expect(mocks.nodesService.regenerateEnrollmentToken).not.toHaveBeenCalled();
  });
});
