import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerAccessResourceService } from './docker-access-resource.service.js';
import { registerDockerFolderRoutes } from './docker-folder.routes.js';
import { DockerFolderService } from './docker-folder.service.js';
import { DockerNetworkAccessResourceService } from './docker-network-access-resource.service.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const FOLDER_ID = '22222222-2222-4222-8222-222222222222';

function appWithScopes(scopes: string[]) {
  const app = new OpenAPIHono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('effectiveScopes', scopes);
    c.set('user', { id: 'user-1' } as never);
    await next();
  });
  registerDockerFolderRoutes(app);
  return app;
}

afterEach(() => {
  container.reset();
});

describe('Docker folder routes', () => {
  it('resolves scoped network UUIDs to raw network assignment keys for folder visibility', async () => {
    const getFolderTree = vi.fn().mockResolvedValue([]);
    const resolveNetworkResourceKey = vi.fn().mockResolvedValue('raw-network-id');
    container.registerInstance(DockerFolderService, { getFolderTree } as never);
    container.registerInstance(DockerNetworkAccessResourceService, { resolveNetworkResourceKey } as never);

    const app = appWithScopes([`docker:networks:view:${NODE_ID}/network-resource-id`]);
    const response = await app.request('/folders?resourceType=network');

    expect(response.status).toBe(200);
    expect(resolveNetworkResourceKey).toHaveBeenCalledWith(NODE_ID, 'network-resource-id');
    expect(getFolderTree).toHaveBeenCalledWith({
      resourceType: 'network',
      allowedFolderIds: [],
      allowedNodeIds: [],
      allowedResourceRefs: [{ nodeId: NODE_ID, resourceKey: 'raw-network-id' }],
    });
  });

  it('moves a scoped network only after resolving its network access identity', async () => {
    const moveResourcesToFolder = vi.fn().mockResolvedValue(undefined);
    const resolveNetwork = vi.fn().mockResolvedValue('network-resource-id');
    container.registerInstance(DockerFolderService, { moveResourcesToFolder } as never);
    container.registerInstance(DockerNetworkAccessResourceService, { resolveNetwork } as never);

    const app = appWithScopes([
      'docker:containers:folders:manage',
      `docker:networks:edit:${NODE_ID}/network-resource-id`,
      `docker:networks:edit:folder/${FOLDER_ID}`,
    ]);
    const response = await app.request('/folders/move-resources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resourceType: 'network',
        folderId: FOLDER_ID,
        items: [{ nodeId: NODE_ID, resourceKey: 'raw-network-id' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(resolveNetwork).toHaveBeenCalledWith(NODE_ID, 'raw-network-id');
    expect(moveResourcesToFolder).toHaveBeenCalledWith(
      {
        resourceType: 'network',
        folderId: FOLDER_ID,
        items: [{ nodeId: NODE_ID, resourceKey: 'raw-network-id' }],
      },
      'user-1'
    );
  });

  it('keeps container moves on the container access-resource resolver', async () => {
    const moveContainersToFolder = vi.fn().mockResolvedValue(undefined);
    const resolveResourceByName = vi.fn().mockResolvedValue('container-resource-id');
    container.registerInstance(DockerFolderService, { moveContainersToFolder } as never);
    container.registerInstance(DockerAccessResourceService, { resolveResourceByName } as never);

    const app = appWithScopes([
      'docker:containers:folders:manage',
      `docker:containers:edit:${NODE_ID}/container-resource-id`,
      `docker:containers:edit:folder/${FOLDER_ID}`,
    ]);
    const response = await app.request('/folders/move-containers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        folderId: FOLDER_ID,
        items: [{ nodeId: NODE_ID, containerName: 'payments-api' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(resolveResourceByName).toHaveBeenCalledWith(NODE_ID, 'payments-api');
    expect(moveContainersToFolder).toHaveBeenCalledWith(
      { folderId: FOLDER_ID, items: [{ nodeId: NODE_ID, containerName: 'payments-api' }] },
      'user-1'
    );
  });
});
