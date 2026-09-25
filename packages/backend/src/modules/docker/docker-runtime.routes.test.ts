import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerManagementService } from './docker.service.js';
import { registerDockerRuntimeRoutes } from './docker-runtime.routes.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_NODE_ID = '22222222-2222-4222-8222-222222222222';

function appWithScopes(scopes: string[]) {
  const app = new OpenAPIHono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('effectiveScopes', scopes);
    c.set('user', { id: 'user-1' } as never);
    await next();
  });
  registerDockerRuntimeRoutes(app);
  return app;
}

function registerDocker() {
  const docker = { manageRunsc: vi.fn().mockResolvedValue({ state: 'ready' }) };
  container.registerInstance(DockerManagementService, docker as never);
  return docker;
}

afterEach(() => {
  container.reset();
});

describe('Docker secure runtime routes', () => {
  it.each([
    [[`nodes:manage:${NODE_ID}`]],
    [['nodes:manage']],
    [['nodes:manage:folder/folder-1', `nodes:manage:${NODE_ID}`]],
    // Accepted for one release after the move to nodes:manage.
    [['admin:update']],
  ])('installs with %j', async (scopes) => {
    const docker = registerDocker();

    const response = await appWithScopes(scopes).request(`/nodes/${NODE_ID}/runtime/runsc/install`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(docker.manageRunsc).toHaveBeenCalledWith(NODE_ID, 'install');
  });

  it.each([
    [[`nodes:manage:${OTHER_NODE_ID}`]],
    [[`nodes:config:view:${NODE_ID}`, `docker:containers:manage:${NODE_ID}`]],
  ])('refuses preflight and install with %j', async (scopes) => {
    const docker = registerDocker();
    const app = appWithScopes(scopes);

    const preflight = await app.request(`/nodes/${NODE_ID}/runtime/runsc/preflight`, { method: 'POST' });
    const install = await app.request(`/nodes/${NODE_ID}/runtime/runsc/install`, { method: 'POST' });

    expect([preflight.status, install.status]).toEqual([403, 403]);
    expect(docker.manageRunsc).not.toHaveBeenCalled();
  });
});
