import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { assertDockerFolderMoveAccess, registerDockerFolderRoutes } from './docker-folder.routes.js';
import { DockerFolderService } from './docker-folder.service.js';

const NODE = '11111111-1111-4111-8111-111111111111';
const FOLDER = '22222222-2222-4222-8222-222222222222';
const DESTINATION = '33333333-3333-4333-8333-333333333333';

function app(scopes: string[]) {
  const router = new OpenAPIHono<AppEnv>();
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('user', { id: 'user-1', scopes } as never);
    c.set('effectiveScopes', scopes);
    await next();
  });
  registerDockerFolderRoutes(router);
  return router;
}

function move(router: OpenAPIHono<AppEnv>, body: unknown) {
  return router.request(`/folders/${FOLDER}/move`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  container.reset();
});

describe('PUT /docker/folders/:id/move', () => {
  it('requires docker:folders:manage', async () => {
    const service = { moveFolder: vi.fn() };
    container.registerInstance(DockerFolderService, service as never);

    const response = await move(app(['docker:containers:edit']), { parentId: DESTINATION });

    expect(response.status).toBe(403);
    expect(service.moveFolder).not.toHaveBeenCalled();
  });

  it('moves the folder and hands the service an authorizer built from the caller scopes', async () => {
    const moved = { id: FOLDER, parentId: DESTINATION };
    const service = { moveFolder: vi.fn().mockResolvedValue(moved) };
    container.registerInstance(DockerFolderService, service as never);

    const response = await move(app(['docker:folders:manage', 'docker:containers:edit']), { parentId: DESTINATION });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: moved });
    expect(service.moveFolder).toHaveBeenCalledWith(FOLDER, { parentId: DESTINATION }, 'user-1', expect.any(Function));
  });

  it('accepts a null parent to move the folder to the root', async () => {
    const service = { moveFolder: vi.fn().mockResolvedValue({ id: FOLDER, parentId: null }) };
    container.registerInstance(DockerFolderService, service as never);

    const response = await move(app(['docker:folders:manage']), { parentId: null });

    expect(response.status).toBe(200);
    expect(service.moveFolder).toHaveBeenCalledWith(FOLDER, { parentId: null }, 'user-1', expect.any(Function));
  });

  it('rejects a body without parentId', async () => {
    const service = { moveFolder: vi.fn() };
    container.registerInstance(DockerFolderService, service as never);

    const response = await move(app(['docker:folders:manage']), {});

    expect(response.status).toBe(400);
    expect(service.moveFolder).not.toHaveBeenCalled();
  });

  it('passes an authorizer that enforces the per-resource and destination scopes', async () => {
    const service = { moveFolder: vi.fn().mockResolvedValue({ id: FOLDER }) };
    container.registerInstance(DockerFolderService, service as never);
    await move(app(['docker:folders:manage', 'docker:volumes:delete:folder/other']), { parentId: DESTINATION });
    const authorize = service.moveFolder.mock.calls[0][3] as (context: unknown) => Promise<void>;

    await expect(
      authorize({
        resourceType: 'volume',
        resources: [{ nodeId: NODE, resourceKey: 'data' }],
        sourceParentId: null,
        destinationFolderId: DESTINATION,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('assertDockerFolderMoveAccess', () => {
  const context = {
    resourceType: 'volume' as const,
    resources: [{ nodeId: NODE, resourceKey: 'data' }],
    sourceParentId: null,
    destinationFolderId: DESTINATION,
  };

  it('allows a caller holding the move scope on the volume and on the destination', async () => {
    await expect(
      assertDockerFolderMoveAccess(['docker:volumes:delete', `docker:volumes:delete:folder/${DESTINATION}`], context)
    ).resolves.toBeUndefined();
    await expect(assertDockerFolderMoveAccess(['docker:volumes:delete'], context)).resolves.toBeUndefined();
  });

  it('refuses a caller without the move scope on a contained resource', async () => {
    await expect(assertDockerFolderMoveAccess(['docker:images:delete'], context)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('refuses a caller who may edit the resource but not the destination', async () => {
    await expect(assertDockerFolderMoveAccess([`docker:volumes:delete:${NODE}/data`], context)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('has nothing to check for an empty folder', async () => {
    await expect(
      assertDockerFolderMoveAccess([], {
        resourceType: 'container',
        resources: [],
        sourceParentId: null,
        destinationFolderId: null,
      })
    ).resolves.toBeUndefined();
  });
});

describe('Docker folder management limited to a folder', () => {
  const TEAM = '44444444-4444-4444-8444-444444444444';
  const SUB = '55555555-5555-4555-8555-555555555555';
  const OTHER = '66666666-6666-4666-8666-666666666666';
  const PARENTS: Record<string, string | null> = { [TEAM]: null, [SUB]: TEAM, [OTHER]: null };
  // A grant on TEAM as folder-scopes.ts expands it: TEAM and its subfolder SUB.
  const granted = [
    `docker:folders:manage:folder/${TEAM}`,
    `docker:folders:manage:folder/${SUB}`,
    'docker:volumes:delete',
  ];

  function setup() {
    const service = {
      createFolder: vi.fn().mockResolvedValue({ id: SUB }),
      updateFolder: vi.fn().mockResolvedValue({ id: SUB }),
      deleteFolder: vi.fn().mockResolvedValue(undefined),
      moveFolder: vi.fn().mockResolvedValue({ id: SUB }),
      moveResourcesToFolder: vi.fn().mockResolvedValue(undefined),
      getFolderParentIds: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, PARENTS[id] ?? null]))),
      getResourcePlacementsForRefs: vi.fn(
        async (_type: string, items: Array<{ nodeId: string; resourceKey: string }>) =>
          items.map((item) => ({ ...item, folderId: item.resourceKey === 'in-sub' ? SUB : null }))
      ),
    };
    container.registerInstance(DockerFolderService, service as never);
    const router = app(granted);
    const call = (path: string, method: string, body?: unknown) =>
      router.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { service, call };
  }

  it('creates, renames and deletes only inside the granted folder', async () => {
    const { service, call } = setup();

    expect((await call('/folders', 'POST', { name: 'Data', resourceType: 'volume', parentId: TEAM })).status).toBe(201);
    expect((await call('/folders', 'POST', { name: 'Data', resourceType: 'volume' })).status).toBe(403);
    expect((await call('/folders', 'POST', { name: 'Data', resourceType: 'volume', parentId: OTHER })).status).toBe(
      403
    );
    expect(service.createFolder).toHaveBeenCalledTimes(1);
    expect((await call(`/folders/${SUB}`, 'PUT', { name: 'Renamed' })).status).toBe(200);
    expect((await call(`/folders/${TEAM}`, 'PUT', { name: 'Renamed' })).status).toBe(403);
    expect((await call(`/folders/${TEAM}`, 'DELETE')).status).toBe(403);
    expect(service.deleteFolder).not.toHaveBeenCalled();
  });

  it('moves resources only from and to managed folders', async () => {
    const { service, call } = setup();
    const items = (resourceKey: string) => [{ nodeId: NODE, resourceKey }];

    expect(
      (
        await call('/folders/move-resources', 'POST', {
          resourceType: 'volume',
          items: items('in-sub'),
          folderId: TEAM,
        })
      ).status
    ).toBe(200);
    expect(
      (
        await call('/folders/move-resources', 'POST', {
          resourceType: 'volume',
          items: items('in-sub'),
          folderId: OTHER,
        })
      ).status
    ).toBe(403);
    expect(
      (await call('/folders/move-resources', 'POST', { resourceType: 'volume', items: items('loose'), folderId: TEAM }))
        .status
    ).toBe(403);
    expect(service.moveResourcesToFolder).toHaveBeenCalledTimes(1);
  });

  it('moves a folder only between managed places', async () => {
    const { service, call } = setup();
    expect((await call(`/folders/${SUB}/move`, 'PUT', { parentId: OTHER })).status).toBe(200);
    const authorize = service.moveFolder.mock.calls[0][3] as (context: unknown) => Promise<void>;
    const context = (sourceParentId: string | null, destinationFolderId: string | null) => ({
      resourceType: 'volume',
      resources: [],
      sourceParentId,
      destinationFolderId,
    });

    await expect(authorize(context(TEAM, OTHER))).rejects.toMatchObject({ statusCode: 403 });
    await expect(authorize(context(TEAM, null))).rejects.toMatchObject({ statusCode: 403 });
    await expect(authorize(context(null, SUB))).rejects.toMatchObject({ statusCode: 403 });
    await expect(authorize(context(TEAM, SUB))).resolves.toBeUndefined();
  });
});
