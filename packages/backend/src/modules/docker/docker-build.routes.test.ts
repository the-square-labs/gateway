import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerAccessResourceService } from './docker-access-resource.service.js';
import { registerDockerBuildRoutes } from './docker-build.routes.js';
import { DockerBuildService } from './docker-build.service.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';

function app(scopes = ['docker:containers:view']) {
  const router = new OpenAPIHono<AppEnv>();
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('effectiveScopes', scopes);
    c.set('user', { id: 'user-1', scopes } as never);
    await next();
  });
  registerDockerBuildRoutes(router);
  return router;
}

afterEach(() => container.reset());

describe('Docker build list route', () => {
  it('shows builds using stable resource grants expanded from an inherited folder', async () => {
    const resolveContainer = vi.fn().mockResolvedValue('resource-1');
    container.registerInstance(DockerAccessResourceService, { resolveContainer } as never);
    container.registerInstance(DockerBuildService, { list: vi.fn().mockResolvedValue([build(0)]) } as never);
    const response = await app([
      'docker:containers:view:folder/unicorn',
      `docker:containers:view:${NODE_ID}/resource-1`,
    ]).request('/builds');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown[] }).data).toHaveLength(1);
    expect(resolveContainer).toHaveBeenCalledWith(NODE_ID, { name: 'api' });
  });

  it.each(['resource-other', null])('hides builds for inaccessible or unresolved identity %s', async (identity) => {
    container.registerInstance(DockerAccessResourceService, {
      resolveContainer: vi.fn().mockResolvedValue(identity),
    } as never);
    container.registerInstance(DockerBuildService, { list: vi.fn().mockResolvedValue([build(0)]) } as never);
    const response = await app([`docker:containers:view:${NODE_ID}/resource-1`]).request('/builds');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it.each([
    ['GET', '', 'view', 'get'],
    ['GET', '/logs', 'view', 'listLogs'],
    ['POST', '/cancel', 'manage', 'requestCancellation'],
    ['POST', '/retry', 'manage', 'retry'],
  ])('checks stable identity for %s %s', async (method, suffix, action, operation) => {
    const row = build(0);
    const service = {
      get: vi.fn().mockResolvedValue(row),
      listLogs: vi.fn().mockResolvedValue([]),
      requestCancellation: vi.fn().mockResolvedValue(row),
      retry: vi.fn().mockResolvedValue(row),
    };
    container.registerInstance(DockerBuildService, service as never);
    const resolveContainer = vi.fn().mockResolvedValue('resource-1');
    container.registerInstance(DockerAccessResourceService, { resolveContainer } as never);
    const scopes = [`docker:containers:${action}:${NODE_ID}/resource-1`];
    const response = await app(scopes).request(`/builds/${row.id}${suffix}`, { method });
    expect(response.status).toBe(suffix === '/retry' ? 201 : 200);
    expect(service[operation as keyof typeof service]).toHaveBeenCalled();
    resolveContainer.mockResolvedValue('other-resource');
    const denied = await app(scopes).request(`/builds/${row.id}${suffix}`, { method });
    expect(denied.status).toBe(403);
  });

  it('returns a stable cursor and applies it to the next page', async () => {
    const rows = Array.from({ length: 51 }, (_, index) => build(index));
    const list = vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    container.registerInstance(DockerBuildService, { list } as never);

    const firstResponse = await app().request('/builds?limit=50');
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      data: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(first.data).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));

    const secondResponse = await app().request(`/builds?limit=50&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(secondResponse.status).toBe(200);
    expect(list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        beforeCreatedAt: new Date(rows[49]!.createdAt),
        beforeId: rows[49]!.id,
        limit: 200,
      })
    );
  });

  it('rejects malformed cursors', async () => {
    container.registerInstance(DockerBuildService, { list: vi.fn() } as never);

    const response = await app().request('/builds?cursor=not-a-cursor');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_BUILD_CURSOR' });
  });
});

function build(index: number) {
  const suffix = String(index + 1).padStart(12, '0');
  return {
    id: `00000000-0000-4000-8000-${suffix}`,
    createdAt: new Date(Date.UTC(2026, 7, 24, 2, 59 - index)),
    target: { kind: 'container' as const, nodeId: NODE_ID, containerName: 'api', name: 'api' },
  };
}
