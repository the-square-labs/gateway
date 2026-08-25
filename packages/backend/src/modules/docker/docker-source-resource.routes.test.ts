import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { AppEnv } from '@/types.js';
import { DockerManagementService } from './docker.service.js';
import { DockerDeploymentService } from './docker-deployment.service.js';
import { registerDockerSourceRoutes } from './docker-source.routes.js';
import { DockerSourceService } from './docker-source.service.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTOR_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

function app(requireMinimumPlan = vi.fn().mockResolvedValue(undefined)) {
  const router = new OpenAPIHono<AppEnv>();
  container.registerInstance(LicensePolicyService, { requireMinimumPlan } as never);
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('effectiveScopes', [`docker:containers:create:${NODE_ID}`]);
    c.set('user', { id: 'user-1', scopes: [] } as never);
    await next();
  });
  registerDockerSourceRoutes(router);
  return router;
}

function body() {
  return {
    source: {
      connectorId: CONNECTOR_ID,
      projectId: PROJECT_ID,
      branch: 'main',
      dockerfilePath: 'Dockerfile',
      contextPath: '.',
      autoBuild: true,
      autoDeploy: true,
      buildArgs: {},
      buildSecretNames: [],
      policy: {},
    },
    resource: {
      kind: 'container',
      name: 'payments-api',
      restartPolicy: 'unless-stopped',
      runtimeProfile: 'secure',
    },
  };
}

afterEach(() => container.reset());

describe('Docker source resource route', () => {
  it('reserves a missing container through the normal source binding and queues its first build', async () => {
    const source = {
      upsert: vi.fn().mockResolvedValue({ id: 'source-1' }),
      createBuild: vi.fn().mockResolvedValue({ build: { id: 'build-1' }, created: true }),
      remove: vi.fn(),
    };
    container.registerInstance(DockerSourceService, source as never);
    container.registerInstance(DockerDeploymentService, {} as never);
    container.registerInstance(DockerManagementService, { listContainers: vi.fn().mockResolvedValue([]) } as never);

    const response = await app().request(`/nodes/${NODE_ID}/source-resources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body()),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        source: { id: 'source-1' },
        build: { id: 'build-1' },
        target: { kind: 'container', nodeId: NODE_ID, containerName: 'payments-api' },
      },
    });
    expect(source.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'container', nodeId: NODE_ID, containerName: 'payments-api' },
      }),
      expect.objectContaining({ id: 'user-1' }),
      {
        allowMissingTarget: true,
        initialConfig: {
          name: 'payments-api',
          restartPolicy: 'unless-stopped',
          runtimeProfile: 'secure',
        },
      }
    );
    expect(source.remove).not.toHaveBeenCalled();
  });

  it('removes the reservation when first-build admission fails', async () => {
    const source = {
      upsert: vi.fn().mockResolvedValue({ id: 'source-1' }),
      createBuild: vi.fn().mockRejectedValue(new Error('No Build Worker available')),
      remove: vi.fn().mockResolvedValue(true),
    };
    container.registerInstance(DockerSourceService, source as never);
    container.registerInstance(DockerDeploymentService, {} as never);
    container.registerInstance(DockerManagementService, { listContainers: vi.fn().mockResolvedValue([]) } as never);

    const response = await app().request(`/nodes/${NODE_ID}/source-resources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body()),
    });

    expect(response.status).toBe(500);
    expect(source.remove).toHaveBeenCalledWith(
      { kind: 'container', nodeId: NODE_ID, containerName: 'payments-api' },
      'user-1'
    );
  });

  it('enforces Business before reserving a resource or touching its Git source', async () => {
    const source = {
      upsert: vi.fn(),
      createBuild: vi.fn(),
      remove: vi.fn(),
    };
    container.registerInstance(DockerSourceService, source as never);
    container.registerInstance(DockerDeploymentService, {} as never);
    const management = { listContainers: vi.fn() };
    container.registerInstance(DockerManagementService, management as never);
    const requireMinimumPlan = vi
      .fn()
      .mockRejectedValue(new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'Business required'));

    const response = await app(requireMinimumPlan).request(`/nodes/${NODE_ID}/source-resources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body()),
    });

    expect(response.status).toBe(403);
    expect(requireMinimumPlan).toHaveBeenCalledWith('business');
    expect(management.listContainers).not.toHaveBeenCalled();
    expect(source.upsert).not.toHaveBeenCalled();
    expect(source.createBuild).not.toHaveBeenCalled();
  });
});
