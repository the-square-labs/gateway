import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { AppEnv } from '@/types.js';
import { registerDockerDeploymentRoutes } from './docker-deployment.routes.js';
import { DockerDeploymentService } from './docker-deployment.service.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';

function appWithScopes(scopes: string[]) {
  const app = new OpenAPIHono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('effectiveScopes', scopes);
    c.set('user', { id: 'user-1' } as never);
    await next();
  });
  registerDockerDeploymentRoutes(app);
  return app;
}

function register() {
  const deployments = {
    listSummary: vi.fn().mockResolvedValue([{ id: 'deployment-1', nodeId: NODE_ID, name: 'api', slots: [] }]),
  };
  container.registerInstance(DockerDeploymentService, deployments as never);
  container.registerInstance(NodeRegistryService, { getNode: vi.fn().mockReturnValue({ id: NODE_ID }) } as never);
  return deployments;
}

afterEach(() => container.reset());

describe('per-node deployment list', () => {
  it.each([
    ['docker:containers:view:folder/folder-1'],
    ['docker:containers:create:folder/folder-1'],
  ])('answers an empty list for %s without listing the node', async (scope) => {
    const deployments = register();

    const response = await appWithScopes([scope]).request(`/nodes/${NODE_ID}/deployments`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [], total: 0, truncated: false });
    expect(deployments.listSummary).not.toHaveBeenCalled();
  });

  it('filters the deployments of a node the caller holds grants on', async () => {
    const deployments = register();

    const allowed = await appWithScopes([`docker:containers:view:${NODE_ID}/deployment-1`]).request(
      `/nodes/${NODE_ID}/deployments`
    );
    const denied = await appWithScopes(['docker:images:view']).request(`/nodes/${NODE_ID}/deployments`);

    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ total: 1 });
    expect(deployments.listSummary).toHaveBeenCalledWith(NODE_ID);
    expect(denied.status).toBe(403);
  });
});
