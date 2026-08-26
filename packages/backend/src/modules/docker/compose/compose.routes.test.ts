import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { AppEnv } from '@/types.js';
import { registerDockerComposeRoutes } from './compose.routes.js';
import { DockerComposeService } from './compose.service.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

function appWithScopes(scopes: string[]) {
  const app = new OpenAPIHono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('effectiveScopes', scopes);
    c.set('user', {
      id: '33333333-3333-4333-8333-333333333333',
      oidcSubject: 'user',
      email: 'user@example.com',
      name: 'User',
      avatarUrl: null,
      groupId: 'group',
      groupName: 'admin',
      scopes,
      isBlocked: false,
    });
    await next();
  });
  app.onError(errorHandler);
  return app;
}

afterEach(() => container.reset());

describe('Docker Compose routes', () => {
  it('keeps external project reads outside the Personal entitlement gate', async () => {
    const compose = { list: vi.fn().mockResolvedValue([{ id: PROJECT_ID, nodeId: NODE_ID }]) };
    const license = { requireFeature: vi.fn() };
    container.registerInstance(DockerComposeService, compose as never);
    container.registerInstance(LicensePolicyService, license as never);
    const app = appWithScopes(['docker:compose:view']);
    registerDockerComposeRoutes(app);

    const response = await app.request('/compose-projects');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ id: PROJECT_ID, nodeId: NODE_ID }] });
    expect(license.requireFeature).not.toHaveBeenCalled();
  });

  it('checks the Personal feature before managed validation', async () => {
    const compose = { validate: vi.fn() };
    const error = new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'Personal required');
    const license = { requireFeature: vi.fn().mockRejectedValue(error) };
    container.registerInstance(DockerComposeService, compose as never);
    container.registerInstance(LicensePolicyService, license as never);
    const app = appWithScopes([`docker:compose:create:${NODE_ID}`]);
    registerDockerComposeRoutes(app);

    const response = await app.request(`/nodes/${NODE_ID}/compose-projects/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectName: 'demo',
        yaml: 'services:\n  api:\n    image: nginx:alpine\n',
        variables: {},
        secretKeys: [],
      }),
    });

    expect(response.status).toBe(403);
    expect(license.requireFeature).toHaveBeenCalledWith('compose-applications');
    expect(compose.validate).not.toHaveBeenCalled();
  });

  it('requires both create and manage scopes before adopting an external project', async () => {
    const compose = { adopt: vi.fn() };
    const license = { requireFeature: vi.fn() };
    container.registerInstance(DockerComposeService, compose as never);
    container.registerInstance(LicensePolicyService, license as never);
    const app = appWithScopes([`docker:compose:create:${NODE_ID}`]);
    registerDockerComposeRoutes(app);

    const response = await app.request(`/nodes/${NODE_ID}/compose-projects/${PROJECT_ID}/adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        yaml: 'services:\n  api:\n    image: nginx:alpine\n',
        variables: {},
        secretKeys: [],
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(license.requireFeature).not.toHaveBeenCalled();
    expect(compose.adopt).not.toHaveBeenCalled();
  });

  it('passes bounded cursor pagination to Compose activity listing', async () => {
    const compose = {
      listOperations: vi.fn().mockResolvedValue({ data: [{ id: 'operation-1' }], nextCursor: 'next-page' }),
    };
    container.registerInstance(DockerComposeService, compose as never);
    const app = appWithScopes([`docker:compose:view:${NODE_ID}/${PROJECT_ID}`]);
    registerDockerComposeRoutes(app);

    const response = await app.request(
      `/nodes/${NODE_ID}/compose-projects/${PROJECT_ID}/operations?limit=25&cursor=current-page`
    );

    expect(response.status).toBe(200);
    expect(compose.listOperations).toHaveBeenCalledWith(NODE_ID, PROJECT_ID, {
      limit: 25,
      cursor: 'current-page',
    });
    expect(await response.json()).toEqual({ data: [{ id: 'operation-1' }], nextCursor: 'next-page' });
  });

  it('allows delete-volume operations with the delete scope without requiring manage', async () => {
    const compose = { startOperation: vi.fn().mockResolvedValue({ id: 'operation-1' }) };
    const license = { requireFeature: vi.fn().mockResolvedValue(undefined) };
    container.registerInstance(DockerComposeService, compose as never);
    container.registerInstance(LicensePolicyService, license as never);
    const app = appWithScopes([`docker:compose:delete:${NODE_ID}/${PROJECT_ID}`]);
    registerDockerComposeRoutes(app);

    const response = await app.request(`/nodes/${NODE_ID}/compose-projects/${PROJECT_ID}/actions/delete_volumes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'request-0001', volumeNames: ['demo_data'] }),
    });

    expect(response.status).toBe(201);
    expect(compose.startOperation).toHaveBeenCalledWith(
      NODE_ID,
      PROJECT_ID,
      'delete_volumes',
      expect.objectContaining({ idempotencyKey: 'request-0001', volumeNames: ['demo_data'] }),
      '33333333-3333-4333-8333-333333333333'
    );
  });
});
