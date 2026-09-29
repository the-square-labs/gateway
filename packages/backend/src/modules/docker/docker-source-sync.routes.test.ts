import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { registerDockerSourceRoutes } from './docker-source.routes.js';
import { DockerSourceService } from './docker-source.service.js';

/** Sync now can queue a build and a rollout, so every entrypoint requires the build scope, never only edit. */

const NODE = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT = '22222222-2222-4222-8222-222222222222';
const COMPOSE = '33333333-3333-4333-8333-333333333333';
const PENDING_RESOURCE = 'access-pending';

function setup(scopes: string[]) {
  const sync = vi.fn(async () => ({ source: { id: 'source' }, changed: false, build: null }));
  container.registerInstance(DockerSourceService, {
    sync,
    getPendingContainer: vi.fn(async (_nodeId: string, name: string) =>
      name === 'queued' ? { scopeResourceId: PENDING_RESOURCE } : null
    ),
  } as never);
  // assertDockerSourceTargetOnNode: the deployment and the Compose Project live on NODE.
  container.registerInstance(TOKENS.DrizzleClient, {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ nodeId: NODE }] }) }) }),
  } as never);
  const router = new OpenAPIHono<AppEnv>();
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('user', { id: 'operator', scopes } as never);
    c.set('effectiveScopes', scopes);
    await next();
  });
  registerDockerSourceRoutes(router);
  return { sync, request: (path: string) => router.request(path, { method: 'POST' }) };
}

afterEach(() => {
  container.reset();
});

const cases = [
  {
    name: 'pending container',
    path: `/nodes/${NODE}/containers/queued/source/sync`,
    edit: [`docker:containers:view:${NODE}/${PENDING_RESOURCE}`, `docker:containers:edit:${NODE}/${PENDING_RESOURCE}`],
    manage: [`docker:containers:manage:${NODE}/${PENDING_RESOURCE}`],
    target: { kind: 'container', nodeId: NODE, containerName: 'queued' },
  },
  {
    name: 'deployment',
    path: `/nodes/${NODE}/deployments/${DEPLOYMENT}/source/sync`,
    edit: [`docker:containers:view:${NODE}/${DEPLOYMENT}`, `docker:containers:edit:${NODE}/${DEPLOYMENT}`],
    manage: [`docker:containers:manage:${NODE}/${DEPLOYMENT}`],
    target: { kind: 'deployment', deploymentId: DEPLOYMENT },
  },
  {
    name: 'Compose Project',
    path: `/nodes/${NODE}/compose-projects/${COMPOSE}/source/sync`,
    edit: [`docker:compose:view:${NODE}/${COMPOSE}`],
    manage: [`docker:compose:manage:${NODE}/${COMPOSE}`],
    target: { kind: 'compose_project', composeProjectId: COMPOSE },
  },
] as const;

describe('POST …/source/sync authorization', () => {
  it.each(cases)('refuses a $name caller without the build scope before syncing', async ({ path, edit }) => {
    const { sync, request } = setup([...edit]);
    const response = await request(path);
    expect(response.status).toBe(403);
    expect(sync).not.toHaveBeenCalled();
  });

  it.each(cases)('syncs a $name for a caller with the build scope on it', async ({ path, manage, target }) => {
    const { sync, request } = setup([...manage]);
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(sync).toHaveBeenCalledWith(target, expect.objectContaining({ id: 'operator' }));
  });

  it('does not let a build grant on another resource sync this one', async () => {
    const { sync, request } = setup([`docker:compose:manage:${NODE}/44444444-4444-4444-8444-444444444444`]);
    expect((await request(`/nodes/${NODE}/compose-projects/${COMPOSE}/source/sync`)).status).toBe(403);
    expect(sync).not.toHaveBeenCalled();
  });
});
