import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const PROJECT_1 = '11111111-1111-4111-8111-111111111111';
const PROJECT_2 = '22222222-2222-4222-8222-222222222222';
const DEPLOYMENT_ID = '33333333-3333-4333-8333-333333333333';
const TAG_ID = '44444444-4444-4444-8444-444444444444';

const mocks = vi.hoisted(() => ({
  scopes: [] as string[],
  deployment: { list: vi.fn(), getForProject: vi.fn() },
  token: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
  tag: { list: vi.fn(), delete: vi.fn() },
  publication: { moveUserTag: vi.fn() },
  retention: { setPinned: vi.fn(), deleteDeployment: vi.fn() },
  runtimeConfig: { list: vi.fn(), saveDefault: vi.fn(), saveTag: vi.fn(), resetTag: vi.fn() },
  licensePolicy: { requireFeature: vi.fn() },
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token) => {
      const name = token?.name;
      if (name === 'PageDeploymentService') return mocks.deployment;
      if (name === 'PageDeployTokenService') return mocks.token;
      if (name === 'PageTagService') return mocks.tag;
      if (name === 'PagePublicationService') return mocks.publication;
      if (name === 'PageRuntimeConfigService') return mocks.runtimeConfig;
      if (name === 'LicensePolicyService') return mocks.licensePolicy;
      return mocks.retention;
    }),
  },
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1', email: 'operator@example.test' });
    c.set('effectiveScopes', mocks.scopes);
    await next();
  },
  requireScopeForResource: (scope: string, parameter: string) => async (c: any, next: () => Promise<void>) => {
    const resourceId = c.req.param(parameter);
    if (!mocks.scopes.includes(scope) && !mocks.scopes.includes(`${scope}:${resourceId}`)) {
      return c.json({ code: 'FORBIDDEN', message: 'Forbidden' }, 403);
    }
    await next();
  },
}));

import { pageManagementRoutes } from './page-management.routes.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', pageManagementRoutes);
  return app;
}

function jsonRequest(method: string, path: string, body?: unknown) {
  return createApp().request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('Pages management authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopes = [];
    mocks.licensePolicy.requireFeature.mockResolvedValue(undefined);
    mocks.tag.list.mockResolvedValue([]);
    mocks.publication.moveUserTag.mockResolvedValue({ changed: true });
    mocks.retention.setPinned.mockResolvedValue({ id: DEPLOYMENT_ID, pinned: true });
    mocks.runtimeConfig.list.mockResolvedValue({ default: { generation: 0 }, overrides: [], tags: [] });
    mocks.runtimeConfig.saveDefault.mockResolvedValue({ generation: 1 });
    mocks.runtimeConfig.saveTag.mockResolvedValue({ generation: 1 });
    mocks.runtimeConfig.resetTag.mockResolvedValue({ generation: 1, inherited: true });
  });

  it('returns the standard entitlement denial before invoking a Pages service', async () => {
    mocks.scopes = [`pages:view:${PROJECT_1}`];
    mocks.licensePolicy.requireFeature.mockRejectedValueOnce(
      new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'A higher license plan is required', {
        feature: 'pages',
        requiredPlan: 'personal',
      })
    );

    const response = await jsonRequest('GET', `/${PROJECT_1}/tags`);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'LICENSE_ENTITLEMENT_REQUIRED',
      details: { feature: 'pages', requiredPlan: 'personal' },
    });
    expect(mocks.licensePolicy.requireFeature).toHaveBeenCalledWith('pages');
    expect(mocks.tag.list).not.toHaveBeenCalled();
  });

  it('filters Tag reads through the parent Project scope', async () => {
    mocks.scopes = [`pages:view:${PROJECT_1}`];

    expect((await jsonRequest('GET', `/${PROJECT_1}/tags`)).status).toBe(200);
    expect((await jsonRequest('GET', `/${PROJECT_2}/tags`)).status).toBe(403);
    expect(mocks.tag.list).toHaveBeenCalledOnce();
    expect(mocks.tag.list).toHaveBeenCalledWith(PROJECT_1);
  });

  it('requires Project-qualified Tag management and keeps latest system-managed', async () => {
    mocks.scopes = [`pages:tags:manage:${PROJECT_1}`];

    const moved = await jsonRequest('PUT', `/${PROJECT_1}/tags/mr-42`, { deploymentId: DEPLOYMENT_ID });
    const latest = await jsonRequest('PUT', `/${PROJECT_1}/tags/latest`, { deploymentId: DEPLOYMENT_ID });
    const otherProject = await jsonRequest('PUT', `/${PROJECT_2}/tags/mr-42`, { deploymentId: DEPLOYMENT_ID });

    expect(moved.status).toBe(200);
    expect(latest.status).toBe(400);
    expect(otherProject.status).toBe(403);
    expect(mocks.publication.moveUserTag).toHaveBeenCalledOnce();
    expect(mocks.publication.moveUserTag).toHaveBeenCalledWith(PROJECT_1, 'mr-42', DEPLOYMENT_ID, 'user-1');
  });

  it('requires Deployment management for pin and delete operations', async () => {
    mocks.scopes = [`pages:deployments:manage:${PROJECT_1}`];

    const pin = await jsonRequest('PATCH', `/${PROJECT_1}/deployments/${DEPLOYMENT_ID}/pin`, { pinned: true });
    const remove = await jsonRequest('DELETE', `/${PROJECT_1}/deployments/${DEPLOYMENT_ID}`);
    const denied = await jsonRequest('DELETE', `/${PROJECT_2}/deployments/${DEPLOYMENT_ID}`);

    expect(pin.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(denied.status).toBe(403);
    expect(mocks.retention.setPinned).toHaveBeenCalledWith(PROJECT_1, DEPLOYMENT_ID, true, 'user-1');
    expect(mocks.retention.deleteDeployment).toHaveBeenCalledWith(PROJECT_1, DEPLOYMENT_ID, 'user-1');
  });

  it('uses Project read and edit scopes for runtime configuration', async () => {
    mocks.scopes = [`pages:view:${PROJECT_1}`];
    expect((await jsonRequest('GET', `/${PROJECT_1}/runtime-configs`)).status).toBe(200);
    expect((await jsonRequest('GET', `/${PROJECT_2}/runtime-configs`)).status).toBe(403);

    const denied = await jsonRequest('PUT', `/${PROJECT_1}/runtime-configs/default`, {
      source: '{}',
      expectedGeneration: 0,
    });
    expect(denied.status).toBe(403);

    mocks.scopes = [`pages:edit:${PROJECT_1}`];
    expect(
      (
        await jsonRequest('PUT', `/${PROJECT_1}/runtime-configs/default`, {
          source: '{"api":"/v1"}',
          expectedGeneration: 0,
        })
      ).status
    ).toBe(200);
    expect(
      (
        await jsonRequest('PUT', `/${PROJECT_1}/runtime-configs/tags/${TAG_ID}`, {
          source: '{"api":"/preview"}',
          expectedGeneration: 0,
        })
      ).status
    ).toBe(200);
    expect(
      (
        await jsonRequest('DELETE', `/${PROJECT_1}/runtime-configs/tags/${TAG_ID}`, {
          expectedGeneration: 1,
        })
      ).status
    ).toBe(200);

    expect(mocks.runtimeConfig.saveDefault).toHaveBeenCalledWith(
      PROJECT_1,
      { source: '{"api":"/v1"}', expectedGeneration: 0 },
      'user-1'
    );
    expect(mocks.runtimeConfig.saveTag).toHaveBeenCalledWith(
      PROJECT_1,
      TAG_ID,
      { source: '{"api":"/preview"}', expectedGeneration: 0 },
      'user-1'
    );
    expect(mocks.runtimeConfig.resetTag).toHaveBeenCalledWith(PROJECT_1, TAG_ID, 1, 'user-1');
  });
});
