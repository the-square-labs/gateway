import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { AppEnv } from '@/types.js';
import { DockerComposeService } from './compose/compose.service.js';
import { DockerManagementService } from './docker.service.js';
import { DockerDeploymentService } from './docker-deployment.service.js';
import { registerDockerSourceRoutes } from './docker-source.routes.js';
import { DockerSourceService } from './docker-source.service.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTOR_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

function app(
  requireFeature = vi.fn().mockResolvedValue(undefined),
  scopes = [`docker:containers:create:${NODE_ID}`, `docker:compose:create:${NODE_ID}`]
) {
  const router = new OpenAPIHono<AppEnv>();
  container.registerInstance(LicensePolicyService, { requireFeature } as never);
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('effectiveScopes', scopes);
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
        createOnly: true,
        initialConfig: {
          name: 'payments-api',
          restartPolicy: 'unless-stopped',
          runtimeProfile: 'secure',
        },
      }
    );
    expect(source.remove).not.toHaveBeenCalled();
  });

  it('retains the reservation when first-build admission fails and sanitizes the error', async () => {
    const source = {
      upsert: vi.fn().mockResolvedValue({ id: 'source-1' }),
      createBuild: vi.fn().mockRejectedValue(new Error('postgres://user:secret@host/db')),
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

    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result).toMatchObject({
      data: { source: { id: 'source-1' }, build: null, initialBuildError: { code: 'INITIAL_BUILD_ENQUEUE_FAILED' } },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(source.remove).not.toHaveBeenCalled();
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
    const requireFeature = vi
      .fn()
      .mockRejectedValue(new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'Business required'));

    const response = await app(requireFeature).request(`/nodes/${NODE_ID}/source-resources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body()),
    });

    expect(response.status).toBe(403);
    expect(requireFeature).toHaveBeenCalledWith('git-push-to-deploy');
    expect(management.listContainers).not.toHaveBeenCalled();
    expect(source.upsert).not.toHaveBeenCalled();
    expect(source.createBuild).not.toHaveBeenCalled();
  });
});

describe('Source creation persistence boundary', () => {
  it.each([
    'container',
    'deployment',
    'compose',
  ] as const)('retains %s and Source when initial policy/enqueue rejects', async (kind) => {
    const source = {
      upsert: vi.fn().mockResolvedValue({ id: 'source-1' }),
      createBuild: vi
        .fn()
        .mockRejectedValue(new AppError(409, 'BUILD_ARTIFACT_POLICY_REJECTED', 'secret raw scanner output')),
      remove: vi.fn(),
    };
    const deployments = { createPending: vi.fn().mockResolvedValue({ id: PROJECT_ID }), discardPending: vi.fn() };
    const compose = {
      createPendingGitProject: vi.fn().mockResolvedValue({ id: PROJECT_ID }),
      discardPendingGitProject: vi.fn(),
    };
    container.registerInstance(DockerSourceService, source as never);
    container.registerInstance(DockerDeploymentService, deployments as never);
    container.registerInstance(DockerComposeService, compose as never);
    container.registerInstance(DockerManagementService, { listContainers: vi.fn().mockResolvedValue([]) } as never);
    const input =
      kind === 'compose'
        ? { projectName: 'payments-api', source: { ...body().source, composeFilePath: 'compose.yml' } }
        : kind === 'deployment'
          ? {
              ...body(),
              resource: { ...body().resource, kind, routes: [{ hostPort: 8080, containerPort: 80, isPrimary: true }] },
            }
          : body();
    const path = kind === 'compose' ? 'compose-projects/from-source' : 'source-resources';
    const response = await app().request(`/nodes/${NODE_ID}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result).toMatchObject({
      data: {
        source: { id: 'source-1' },
        build: null,
        target: {},
        initialBuildError: { code: 'BUILD_ARTIFACT_POLICY_REJECTED' },
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(source.upsert.mock.invocationCallOrder[0]).toBeLessThan(source.createBuild.mock.invocationCallOrder[0]!);
    expect(source.remove).not.toHaveBeenCalled();
    expect(deployments.discardPending).not.toHaveBeenCalled();
    expect(compose.discardPendingGitProject).not.toHaveBeenCalled();
  });

  it.each([
    'deployment',
    'compose',
  ] as const)('discards only its own pending %s on Source persistence failure', async (kind) => {
    const source = {
      upsert: vi.fn().mockRejectedValue(new AppError(400, 'SOURCE_INVALID', 'Invalid source')),
      createBuild: vi.fn(),
      remove: vi.fn(),
    };
    const discard = vi.fn().mockResolvedValue(true);
    container.registerInstance(DockerSourceService, source as never);
    container.registerInstance(DockerDeploymentService, {
      createPending: vi.fn().mockResolvedValue({ id: PROJECT_ID }),
      discardPending: discard,
    } as never);
    container.registerInstance(DockerComposeService, {
      createPendingGitProject: vi.fn().mockResolvedValue({ id: PROJECT_ID }),
      discardPendingGitProject: discard,
    } as never);
    const input =
      kind === 'compose'
        ? { projectName: 'payments-api', source: { ...body().source, composeFilePath: 'compose.yml' } }
        : {
            ...body(),
            resource: { ...body().resource, kind, routes: [{ hostPort: 8080, containerPort: 80, isPrimary: true }] },
          };
    const response = await app().request(
      `/nodes/${NODE_ID}/${kind === 'compose' ? 'compose-projects/from-source' : 'source-resources'}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }
    );
    expect(response.status).toBe(400);
    expect(discard).toHaveBeenCalledOnce();
    expect(source.createBuild).not.toHaveBeenCalled();
    expect(source.remove).not.toHaveBeenCalled();
  });

  it('does not remove a prior reservation when creation conflicts', async () => {
    const source = {
      upsert: vi.fn().mockRejectedValue(new AppError(409, 'SOURCE_RESOURCE_ALREADY_EXISTS', 'Already exists')),
      createBuild: vi.fn(),
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
    expect(response.status).toBe(409);
    expect(source.createBuild).not.toHaveBeenCalled();
    expect(source.remove).not.toHaveBeenCalled();
  });

  it.each([
    { permission: 'view', method: 'GET', suffix: '', allowed: true },
    { permission: 'edit', method: 'PUT', suffix: '', allowed: true },
    { permission: 'manage', method: 'POST', suffix: '/builds', allowed: true },
    { permission: 'view', method: 'GET', suffix: '/pending', allowed: true },
    { permission: 'create', method: 'GET', suffix: '', allowed: false },
    { permission: 'view', method: 'POST', suffix: '/builds', allowed: false },
  ])('checks ordinary pending resource RBAC for $permission $method $suffix', async ({
    permission,
    method,
    suffix,
    allowed,
  }) => {
    const pending = {
      pendingSourceBuild: true,
      Id: 'source-1',
      scopeResourceId: 'resource-1',
      nodeId: NODE_ID,
      containerName: 'payments-api',
    };
    const source = {
      getPendingContainer: vi.fn().mockResolvedValue(pending),
      get: vi.fn().mockResolvedValue({ id: 'source-1' }),
      upsert: vi.fn().mockResolvedValue({ id: 'source-1' }),
      createBuild: vi.fn().mockResolvedValue({ build: { id: 'build-1' }, created: true }),
    };
    container.registerInstance(DockerSourceService, source as never);
    const scopes =
      permission === 'create'
        ? [`docker:containers:create:${NODE_ID}`]
        : [`docker:containers:${permission}:${NODE_ID}/resource-1`];
    const response = await app(undefined, scopes).request(`/nodes/${NODE_ID}/containers/payments-api/source${suffix}`, {
      method,
      ...(method === 'GET'
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(method === 'PUT' ? body().source : {}),
          }),
    });
    expect(response.status).toBe(allowed ? (method === 'POST' ? 201 : 200) : 403);
    if (!allowed) {
      expect(source.get).not.toHaveBeenCalled();
      expect(source.upsert).not.toHaveBeenCalled();
      expect(source.createBuild).not.toHaveBeenCalled();
    }
  });
});
