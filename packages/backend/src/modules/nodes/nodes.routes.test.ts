import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const mocks = vi.hoisted(() => ({
  scopes: [] as string[],
  nodesService: {
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn(() => mocks.nodesService),
  },
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('effectiveScopes', mocks.scopes);
    c.set('user', { id: 'user-1' });
    await next();
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
});

describe('nodesRoutes list access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopes = [];
    mocks.nodesService.list.mockResolvedValue({ data: [], page: 1, limit: 100, total: 0, totalPages: 0 });
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
      capabilities: { dockerPortBindIpV1: true },
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

describe('nodesRoutes service address access', () => {
  const nodeId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nodesService.update.mockResolvedValue({ id: nodeId, serviceAddress: 'docker.internal' });
    mocks.nodesService.get.mockResolvedValue({ id: nodeId, type: 'docker' });
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
