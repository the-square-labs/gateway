import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerAccessResourceService } from './docker-access-resource.service.js';
import { registerDockerBuildRoutes } from './docker-build.routes.js';
import { DockerBuildService } from './docker-build.service.js';

const NODE = '11111111-1111-4111-8111-111111111111';
const BUILD = '22222222-2222-4222-8222-222222222222';
const build = {
  id: BUILD,
  createdAt: new Date('2026-10-07T10:00:00Z'),
  target: { kind: 'container', nodeId: NODE, containerName: 'shop' },
};

function app(scopes: string[]) {
  const router = new OpenAPIHono<AppEnv>();
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('user', { id: 'user-1', scopes } as never);
    c.set('effectiveScopes', scopes);
    await next();
  });
  registerDockerBuildRoutes(router);
  return router;
}

function register() {
  // Only the reservation exists: the first build has not created the container yet.
  const resolveContainer = vi.fn(async (_nodeId: string, options: { name?: string; includeReservations?: boolean }) =>
    options.name === 'shop' && options.includeReservations ? 'reserved-shop' : null
  );
  container.registerInstance(DockerAccessResourceService, { resolveContainer } as never);
  const builds = {
    get: vi.fn().mockResolvedValue(build),
    list: vi.fn().mockResolvedValue([build]),
    listLogs: vi.fn().mockResolvedValue([{ sequence: 0, message: 'step 1/3' }]),
    requestCancellation: vi.fn().mockResolvedValue({ ...build, status: 'cancelling' }),
    retry: vi.fn().mockResolvedValue({ ...build, id: 'retry' }),
  };
  container.registerInstance(DockerBuildService, builds as never);
  return builds;
}

afterEach(() => container.reset());

describe('the first build of a pending Git-source container', () => {
  // Folder grants reach the reserved identity as `<node>/<resourceId>` qualifiers in the effective scopes.
  const folderUser = [`docker:containers:view:${NODE}/reserved-shop`, `docker:containers:manage:${NODE}/reserved-shop`];

  it('is listed, readable and its logs are readable for a holder of view on the reservation', async () => {
    register();
    const client = app(folderUser);

    const list = await client.request('/builds');
    expect(list.status).toBe(200);
    expect((await list.json()).data.map((item: { id: string }) => item.id)).toEqual([BUILD]);
    expect((await client.request(`/builds/${BUILD}`)).status).toBe(200);
    expect((await client.request(`/builds/${BUILD}/logs`)).status).toBe(200);
  });

  it('can be cancelled and retried by a holder of manage on the reservation', async () => {
    const builds = register();
    const client = app(folderUser);

    expect((await client.request(`/builds/${BUILD}/cancel`, { method: 'POST' })).status).toBe(200);
    expect((await client.request(`/builds/${BUILD}/retry`, { method: 'POST' })).status).toBe(201);
    expect(builds.requestCancellation).toHaveBeenCalledWith(BUILD, 'user-1');
    expect(builds.retry).toHaveBeenCalledWith(BUILD, 'user-1');
  });

  it('stays hidden from a user whose grant covers another container', async () => {
    const builds = register();
    const client = app([`docker:containers:view:${NODE}/other`, `docker:containers:manage:${NODE}/other`]);

    expect((await (await client.request('/builds')).json()).data).toEqual([]);
    expect((await client.request(`/builds/${BUILD}/logs`)).status).toBe(403);
    expect((await client.request(`/builds/${BUILD}/cancel`, { method: 'POST' })).status).toBe(403);
    expect(builds.requestCancellation).not.toHaveBeenCalled();
  });
});
