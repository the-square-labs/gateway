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
