import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerManagementService } from './docker.service.js';
import { registerContainerRoutes } from './docker-container.routes.js';
import { DockerSourceService } from './docker-source.service.js';

const NODE = '11111111-1111-4111-8111-111111111111';

function app(scopes: string[]) {
  const router = new OpenAPIHono<AppEnv>();
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('user', { id: 'user-1', scopes } as never);
    c.set('effectiveScopes', scopes);
    await next();
  });
  registerContainerRoutes(router);
  return router;
}

afterEach(() => container.reset());

describe('removing a Git-source container before its first build created it', () => {
  it('answers 409 SOURCE_CONTAINER_NOT_BUILT, not 404, and removes nothing', async () => {
    container.registerInstance(DockerSourceService, {
      getPendingContainer: vi.fn(async (_nodeId: string, name: string) =>
        name === 'shop' ? { containerName: 'shop', scopeResourceId: 'reserved-shop' } : null
      ),
    } as never);
    const docker = {
      inspectContainer: vi.fn().mockRejectedValue(Object.assign(new Error('No such container: shop'), { code: 'X' })),
      removeContainer: vi.fn(),
    };
    container.registerInstance(DockerManagementService, docker as never);

    const response = await app([`docker:containers:delete:${NODE}/reserved-shop`]).request(
      `/nodes/${NODE}/containers/shop`,
      { method: 'DELETE' }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SOURCE_CONTAINER_NOT_BUILT' });
    expect(docker.inspectContainer).not.toHaveBeenCalled();
    expect(docker.removeContainer).not.toHaveBeenCalled();
  });

  it('keeps the delete scope of the reserved container', async () => {
    container.registerInstance(DockerSourceService, {
      getPendingContainer: vi.fn().mockResolvedValue({ containerName: 'shop', scopeResourceId: 'reserved-shop' }),
    } as never);
    container.registerInstance(DockerManagementService, { removeContainer: vi.fn() } as never);

    const response = await app([`docker:containers:view:${NODE}`]).request(`/nodes/${NODE}/containers/shop`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(403);
  });
});
