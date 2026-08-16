import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const MANAGED_DATABASE_ID = '44444444-4444-4444-8444-444444444444';
const CANONICAL_DATABASE_ID = '55555555-5555-4555-8555-555555555555';
const BINDING_ID = '66666666-6666-4666-8666-666666666666';
const NODE_ID = 'node-1';
const DEPLOYMENT_ID = 'deployment-1';

const mocks = vi.hoisted(() => {
  class ManagedDatabaseService {}
  class ManagedDatabaseBindingService {}
  class DockerManagementService {}
  return {
    ManagedDatabaseService,
    ManagedDatabaseBindingService,
    DockerManagementService,
    scopes: [] as string[],
    managedDatabaseService: { getCanonicalScopeResourceId: vi.fn() },
    bindingService: { getTarget: vi.fn(), revealCredentials: vi.fn() },
    dockerService: { inspectContainer: vi.fn() },
  };
});

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token: unknown) => {
      if (token === mocks.ManagedDatabaseService) return mocks.managedDatabaseService;
      if (token === mocks.ManagedDatabaseBindingService) return mocks.bindingService;
      if (token === mocks.DockerManagementService) return mocks.dockerService;
      return {};
    }),
  },
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1' });
    c.set('effectiveScopes', mocks.scopes);
    await next();
  },
  requireScope: () => async (_c: any, next: () => Promise<void>) => next(),
  requireScopeBase: () => async (_c: any, next: () => Promise<void>) => next(),
  requireScopeForResource: () => async (_c: any, next: () => Promise<void>) => next(),
}));

vi.mock('./managed-databases.service.js', () => ({ ManagedDatabaseService: mocks.ManagedDatabaseService }));
vi.mock('./managed-database-bindings.service.js', () => ({
  ManagedDatabaseBindingService: mocks.ManagedDatabaseBindingService,
}));
vi.mock('@/modules/docker/docker.service.js', () => ({ DockerManagementService: mocks.DockerManagementService }));

import { databaseRoutes } from './databases.routes.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', databaseRoutes);
  return app;
}

function targetScopes() {
  return [
    `docker:containers:edit:${NODE_ID}/${DEPLOYMENT_ID}`,
    `docker:containers:manage:${NODE_ID}/${DEPLOYMENT_ID}`,
    `docker:containers:secrets:${NODE_ID}/${DEPLOYMENT_ID}`,
    'docker:networks:create',
    'docker:networks:edit',
    'docker:networks:delete',
  ];
}

describe('managed database binding credential reveal route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopes = [`databases:credentials:reveal:${CANONICAL_DATABASE_ID}`];
    mocks.managedDatabaseService.getCanonicalScopeResourceId.mockResolvedValue(CANONICAL_DATABASE_ID);
    mocks.bindingService.getTarget.mockResolvedValue({
      targetNodeId: NODE_ID,
      targetType: 'deployment',
      targetResourceId: DEPLOYMENT_ID,
    });
    mocks.bindingService.revealCredentials.mockResolvedValue({ username: 'app', password: 'secret' });
  });

  it('denies reveal before decrypting credentials when target-workload access is absent', async () => {
    const response = await createApp().request(
      `/managed/${MANAGED_DATABASE_ID}/bindings/${BINDING_ID}/reveal-credentials`
    );

    expect(response.status).toBe(403);
    expect(mocks.bindingService.getTarget).toHaveBeenCalledWith(MANAGED_DATABASE_ID, BINDING_ID);
    expect(mocks.bindingService.revealCredentials).not.toHaveBeenCalled();
  });

  it('reveals credentials after both database and target-workload access are authorized', async () => {
    mocks.scopes = [...mocks.scopes, ...targetScopes()];

    const response = await createApp().request(
      `/managed/${MANAGED_DATABASE_ID}/bindings/${BINDING_ID}/reveal-credentials`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { username: 'app', password: 'secret' } });
    expect(mocks.bindingService.revealCredentials).toHaveBeenCalledWith(MANAGED_DATABASE_ID, BINDING_ID);
  });
});
