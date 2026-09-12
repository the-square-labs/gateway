import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerAccessResourceService } from './docker-access-resource.service.js';
import { registerDockerFolderRoutes } from './docker-folder.routes.js';
import { DockerFolderResourceTypeSchema } from './docker-folder.schemas.js';
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
  it.each(
    DockerFolderResourceTypeSchema.options
  )('accepts the canonical %s folder type at the HTTP boundary', async (resourceType) => {
    const folders = [{ id: FOLDER_ID, resourceType, children: [] }];
    const getFolderTree = vi.fn().mockResolvedValue(folders);
    container.registerInstance(DockerFolderService, { getFolderTree } as never);
    const response = await appWithScopes(['docker:containers:folders:manage']).request(
      `/folders?resourceType=${resourceType}`
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: folders });
    expect(getFolderTree).toHaveBeenCalledExactlyOnceWith({ resourceType, includeAllFolders: true });
  });

  it('keeps the default container type when the query parameter is omitted', async () => {
    const getFolderTree = vi.fn().mockResolvedValue([]);
    container.registerInstance(DockerFolderService, { getFolderTree } as never);
    const response = await appWithScopes(['docker:containers:folders:manage']).request('/folders');
    expect(response.status).toBe(200);
    expect(getFolderTree).toHaveBeenCalledWith({ resourceType: 'container', includeAllFolders: true });
  });

  it('still rejects unknown resource types before loading folders', async () => {
    const getFolderTree = vi.fn();
    container.registerInstance(DockerFolderService, { getFolderTree } as never);
    const response = await appWithScopes(['docker:containers:folders:manage']).request(
      '/folders?resourceType=not-a-resource'
    );
    expect(response.status).toBe(400);
    expect(getFolderTree).not.toHaveBeenCalled();
  });

  it.each(['docker:compose:view', 'docker:compose:create'])('allows compose folder lookup with %s', async (scope) => {
    const getFolderTree = vi.fn().mockResolvedValue([]);
    container.registerInstance(DockerFolderService, { getFolderTree } as never);
    const response = await appWithScopes([scope]).request('/folders?resourceType=compose');
    expect(response.status).toBe(200);
    expect(getFolderTree).toHaveBeenCalledWith({ resourceType: 'compose', includeAllFolders: true });
  });

  it('preserves folder restrictions when loading compose folders', async () => {
    const getFolderTree = vi.fn().mockResolvedValue([]);
    container.registerInstance(DockerFolderService, { getFolderTree } as never);
    const response = await appWithScopes([`docker:compose:view:folder/${FOLDER_ID}`]).request(
      '/folders?resourceType=compose'
    );
    expect(response.status).toBe(200);
    expect(getFolderTree).toHaveBeenCalledWith({
      resourceType: 'compose',
      allowedFolderIds: [FOLDER_ID],
      allowedNodeIds: [],
      allowedResourceRefs: [],
    });
  });

  it.each([
    { scopes: [] },
    { scopes: ['docker:containers:view'] },
  ])('does not grant compose folder access from unrelated scopes $scopes', async ({ scopes }) => {
    const getFolderTree = vi.fn();
    container.registerInstance(DockerFolderService, { getFolderTree } as never);
    const response = await appWithScopes(scopes).request('/folders?resourceType=compose');
    expect(response.status).toBe(403);
    expect(getFolderTree).not.toHaveBeenCalled();
  });

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
