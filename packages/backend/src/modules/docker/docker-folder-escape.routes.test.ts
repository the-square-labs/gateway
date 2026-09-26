import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { boundScopes } from '@/lib/permissions.js';
import { canonicalizeScopes, isApiTokenScope, SYSTEM_ADMIN_SCOPES } from '@/lib/scopes.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { AppEnv } from '@/types.js';
import { DockerAvailabilityService } from './availability/docker-availability.service.js';
import { DockerWorkloadResolverService } from './availability/docker-workload-resolver.service.js';
import { DockerManagementService } from './docker.service.js';
import { registerContainerRoutes } from './docker-container.routes.js';
import { assertDockerCreationAccess } from './docker-creation-access.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';

/**
 * rc.10 report over REST: an API token restricted to one container folder, owned by a system administrator.
 * The request carries the owner as `user` (broad scopes) and the bounded token grant as `effectiveScopes`;
 * every route must authorize with the token grant, so the root and other folders stay out of reach.
 */

const NODE = '11111111-1111-4111-8111-111111111111';
const FOLDER = '22222222-2222-4222-8222-222222222222';
const OTHER_FOLDER = '33333333-3333-4333-8333-333333333333';

/** What TokensService.validateToken yields for this grant once expanded (one container "app" in the folder). */
const TOKEN_SCOPES = canonicalizeScopes(
  boundScopes(
    [
      `docker:containers:view:folder/${FOLDER}`,
      `docker:containers:create:folder/${FOLDER}`,
      `docker:containers:manage:folder/${FOLDER}`,
      `docker:containers:view:${NODE}/access-app`,
      `docker:containers:manage:${NODE}/access-app`,
    ],
    [...SYSTEM_ADMIN_SCOPES, `docker:containers:view:${NODE}/access-root`]
  )
).filter(isApiTokenScope);

const CONTAINERS = [
  { Id: 'runtime-app', name: 'app', state: 'running', scopeResourceId: 'access-app', folderId: FOLDER },
  { Id: 'runtime-root', name: 'root-app', state: 'running', scopeResourceId: 'access-root', folderId: null },
];

/** The Drizzle subset `assertDockerCreationAccess` uses to confirm a destination folder. */
function destinationDb(folderId: unknown) {
  const rows = [FOLDER, OTHER_FOLDER].filter((id) => id === folderId).map((id) => ({ id, isSystem: false }));
  return { select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }) };
}

function app() {
  const router = new OpenAPIHono<AppEnv>();
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('user', { id: 'owner', scopes: [...SYSTEM_ADMIN_SCOPES] } as never);
    c.set('effectiveScopes', TOKEN_SCOPES);
    c.set('isTokenAuth', true);
    c.set('authType', 'api-token');
    await next();
  });
  registerContainerRoutes(router);
  return router;
}

function registerServices() {
  const docker = {
    // The first statements of DockerManagementService.createContainer / duplicateContainer.
    createContainer: vi.fn(async (nodeId: string, config: { folderId?: string | null }, _user: string, scopes) => {
      await assertDockerCreationAccess(
        destinationDb(config.folderId) as never,
        scopes,
        'docker:containers:create',
        nodeId,
        config.folderId
      );
      return { id: 'runtime-new' };
    }),
    duplicateContainer: vi.fn(
      async (nodeId: string, _id: string, _name: string, _user: string, scopes: string[], folderId?: string | null) => {
        await assertDockerCreationAccess(
          destinationDb(folderId) as never,
          scopes,
          'docker:containers:create',
          nodeId,
          folderId
        );
        return { id: 'runtime-copy' };
      }
    ),
    inspectContainer: vi.fn(async (_nodeId: string, id: string) => {
      const row = CONTAINERS.find((item) => item.name === id || item.Id === id);
      return {
        Id: row?.Id,
        Name: `/${row?.name}`,
        Config: { Labels: {}, Env: [] },
        scopeResourceId: row?.scopeResourceId,
      };
    }),
    decoratePublicContainerSnapshot: vi.fn(async (_nodeId: string, rows: unknown[]) => rows),
    getContainerLogs: vi.fn().mockResolvedValue(['line']),
    getContainerTransition: vi.fn().mockReturnValue(null),
  };
  container.registerInstance(DockerManagementService, docker as never);
  container.registerInstance(DockerSnapshotService, {
    assertDockerNode: vi.fn(),
    getList: vi.fn().mockResolvedValue({ data: CONTAINERS }),
    availability: vi.fn().mockReturnValue('available'),
  } as never);
  container.registerInstance(DockerAvailabilityService, {
    resolveRuntimeAccessIdentity: vi.fn().mockResolvedValue(null),
    listContainerSurfaceStates: vi.fn().mockResolvedValue({}),
    isContainerManaged: vi.fn().mockResolvedValue(false),
  } as never);
  container.registerInstance(DockerWorkloadResolverService, { resolve: vi.fn().mockResolvedValue(null) } as never);
  container.registerInstance(LicensePolicyService, { requireFeature: vi.fn() } as never);
  container.registerInstance(TOKENS.DrizzleClient, destinationDb(undefined) as never);
  return docker;
}

function post(path: string, body: unknown) {
  return app().request(`/nodes/${NODE}/containers${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  container.reset();
});

describe('folder-restricted API token owned by an administrator (REST)', () => {
  it('holds no broad, node or root-level container scope', () => {
    for (const base of ['docker:containers:create', 'docker:containers:view', 'docker:containers:manage']) {
      expect(TOKEN_SCOPES).not.toContain(base);
      expect(TOKEN_SCOPES).not.toContain(`${base}:${NODE}`);
      expect(TOKEN_SCOPES).not.toContain(`${base}:node/${NODE}`);
    }
    expect(TOKEN_SCOPES.some((scope) => scope.includes('access-root'))).toBe(false);
  });

  it('POST /containers creates only inside the granted folder', async () => {
    const docker = registerServices();

    const root = await post('', { image: 'nginx:alpine', name: 'x1' });
    expect(root.status).toBe(403);
    // An agent learns where it may create and that it must name the folder.
    const denial = (await root.json()) as { message: string };
    expect(denial.message).toContain('Missing docker:containers:create at the root');
    expect(denial.message).toContain(FOLDER);
    expect(denial.message).toContain('pass folderId');
    expect((await post('', { image: 'nginx:alpine', name: 'x2', folderId: null })).status).toBe(403);
    expect((await post('', { image: 'nginx:alpine', name: 'x3', folderId: OTHER_FOLDER })).status).toBe(403);
    expect((await post('', { image: 'nginx:alpine', name: 'x4', folderId: FOLDER })).status).toBe(201);
    // The token grant, never the owner's scopes, reaches the destination check.
    expect(docker.createContainer).toHaveBeenLastCalledWith(
      NODE,
      expect.objectContaining({ folderId: FOLDER }),
      'owner',
      TOKEN_SCOPES
    );
  });

  it('POST /containers refuses a Compose label that would re-home the container at the root', async () => {
    const docker = registerServices();
    const response = await post('', {
      image: 'nginx:alpine',
      name: 'x5',
      folderId: FOLDER,
      labels: { 'com.docker.compose.project': 'escape' },
    });
    expect(response.status).toBe(400);
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('POST /containers/:id/duplicate never places the copy at the root', async () => {
    registerServices();
    // Duplicating also needs environment and secrets on the source; the folder grant does not carry them,
    // so the root attempt is refused before the destination check even runs.
    expect((await post('/app/duplicate', { name: 'copy' })).status).toBe(403);
  });

  it('GET /containers lists only the folder, GET logs of a root container is refused', async () => {
    const docker = registerServices();
    const listed = await app().request(`/nodes/${NODE}/containers`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { data: Array<{ name: string }> };
    expect(body.data.map((item) => item.name)).toEqual(['app']);

    expect((await app().request(`/nodes/${NODE}/containers/app/logs`)).status).toBe(200);
    expect((await app().request(`/nodes/${NODE}/containers/root-app/logs`)).status).toBe(403);
    expect(docker.getContainerLogs).toHaveBeenCalledTimes(1);
  });
});
