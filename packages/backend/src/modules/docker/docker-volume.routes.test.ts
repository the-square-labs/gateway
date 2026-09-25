import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerManagementService } from './docker.service.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';
import { registerVolumeRoutes } from './docker-volume.routes.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const BROAD_SCOPES = [
  'docker:volumes:view',
  'docker:volumes:files:read',
  'docker:volumes:files:write',
  'docker:volumes:export',
  'docker:volumes:edit',
  'docker:volumes:delete',
];

function appWithScopes(scopes: string[]) {
  const app = new OpenAPIHono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('effectiveScopes', scopes);
    c.set('user', { id: 'user-1' } as never);
    await next();
  });
  registerVolumeRoutes(app);
  return app;
}

function registerService(visible: boolean) {
  const service = {
    assertUserVolumeVisible: vi.fn(async () => {
      if (!visible) throw new AppError(404, 'VOLUME_NOT_FOUND', 'Volume not found');
    }),
    readVolumeFile: vi.fn().mockResolvedValue(Buffer.from('secret')),
    exportVolume: vi.fn().mockResolvedValue(Buffer.from('archive')),
    removeVolume: vi.fn().mockResolvedValue(undefined),
    decoratePublicVolumeSnapshot: vi.fn(async (_nodeId: string, volumes: unknown[]) => (visible ? volumes : [])),
  };
  container.registerInstance(DockerManagementService, service as never);
  return service;
}

afterEach(() => {
  container.reset();
});

describe('volume routes hide Gateway-internal volumes', () => {
  it('refuses file reads, exports and removal of hidden volumes even with broad scopes', async () => {
    const service = registerService(false);
    const app = appWithScopes(BROAD_SCOPES);

    const read = await app.request(`/nodes/${NODE_ID}/volumes/gateway-db-data/files/read?path=/pg_hba.conf`);
    const exported = await app.request(`/nodes/${NODE_ID}/volumes/gateway-db-data/export`);
    const removed = await app.request(`/nodes/${NODE_ID}/volumes/gateway-db-data`, { method: 'DELETE' });

    expect([read.status, exported.status, removed.status]).toEqual([404, 404, 404]);
    expect(service.assertUserVolumeVisible).toHaveBeenCalledWith(NODE_ID, 'gateway-db-data');
    expect(service.readVolumeFile).not.toHaveBeenCalled();
    expect(service.exportVolume).not.toHaveBeenCalled();
    expect(service.removeVolume).not.toHaveBeenCalled();
  });

  it('serves visible volumes', async () => {
    const service = registerService(true);

    const response = await appWithScopes(BROAD_SCOPES).request(`/nodes/${NODE_ID}/volumes/app-data/files/read?path=/a`);

    expect(response.status).toBe(200);
    expect(service.readVolumeFile).toHaveBeenCalledWith(NODE_ID, 'app-data', '/a');
  });

  it('applies snapshot visibility to volume metrics', async () => {
    registerService(false);
    const getDetail = vi.fn();
    container.registerInstance(DockerSnapshotService, {
      assertDockerNode: vi.fn().mockResolvedValue(undefined),
      getList: vi.fn(async (_nodeId: string, kind: string) => ({
        data: kind === 'volumes' ? [{ Name: 'gateway-db-data', UsedBy: ['gateway-db-connector'] }] : [],
      })),
      getDetail,
    } as never);

    const response = await appWithScopes(BROAD_SCOPES).request(`/nodes/${NODE_ID}/volumes/gateway-db-data/metrics`);

    expect(response.status).toBe(404);
    expect(getDetail).not.toHaveBeenCalled();
  });
});

describe('volume edit routes with folder-derived grants', () => {
  function registerEditService() {
    const service = {
      assertUserVolumeVisible: vi.fn().mockResolvedValue(undefined),
      renameVolume: vi.fn().mockResolvedValue(undefined),
      updateVolumeLabels: vi.fn().mockResolvedValue(undefined),
      resizeVolume: vi.fn().mockResolvedValue(undefined),
      adoptVolume: vi.fn().mockResolvedValue({ name: 'app-data', managementState: 'managed' }),
    };
    container.registerInstance(DockerManagementService, service as never);
    container.registerInstance(DockerSnapshotService, {
      getList: vi.fn().mockResolvedValue({ revision: 1, refreshStatus: 'ok', data: [{ Name: 'app-data' }] }),
    } as never);
    return service;
  }

  async function edit(scopes: string[]) {
    const app = appWithScopes(scopes);
    const base = `/nodes/${NODE_ID}/volumes/app-data`;
    const json = (method: string, body: unknown) => ({
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return Promise.all([
      app.request(`${base}/rename`, json('POST', { name: 'app-data-2' })),
      app.request(`${base}/labels`, json('PUT', { labels: { tier: 'db' } })),
      app.request(`${base}/resize`, json('POST', { capacityBytes: 2 * 1024 ** 3 })),
      app.request(`${base}/adopt`, { method: 'POST' }),
    ]).then((responses) => responses.map((response) => response.status));
  }

  it('lets a folder grant edit the volumes in that folder without any per-volume create scope', async () => {
    const service = registerEditService();
    // What folder expansion produces for view + edit + create on the volume's folder.
    const folderScopes = [
      `docker:volumes:view:${NODE_ID}/app-data`,
      `docker:volumes:edit:${NODE_ID}/app-data`,
      'docker:volumes:create:folder/folder-1',
    ];

    expect(await edit(folderScopes)).toEqual([200, 200, 200, 200]);
    expect(service.renameVolume).toHaveBeenCalledWith(NODE_ID, 'app-data', 'app-data-2', 'user-1');
    expect(service.updateVolumeLabels).toHaveBeenCalledWith(NODE_ID, 'app-data', { tier: 'db' }, 'user-1');
    expect(service.resizeVolume).toHaveBeenCalledWith(NODE_ID, 'app-data', 2 * 1024 ** 3, 'user-1');
    expect(service.adoptVolume).toHaveBeenCalledWith(NODE_ID, 'app-data', 'user-1');
  });

  it('refuses volume edits without the volume mutation scope, even with create on its folder or node', async () => {
    const service = registerEditService();

    expect(
      await edit([
        `docker:volumes:view:${NODE_ID}/app-data`,
        'docker:volumes:create:folder/folder-1',
        `docker:volumes:create:${NODE_ID}`,
        `docker:volumes:edit:${NODE_ID}/other-volume`,
        // Deleting a volume is not editing it.
        `docker:volumes:delete:${NODE_ID}/app-data`,
      ])
    ).toEqual([403, 403, 403, 403]);
    expect(service.renameVolume).not.toHaveBeenCalled();
    expect(service.updateVolumeLabels).not.toHaveBeenCalled();
    expect(service.resizeVolume).not.toHaveBeenCalled();
    expect(service.adoptVolume).not.toHaveBeenCalled();
  });
});
