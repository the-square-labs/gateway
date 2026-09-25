import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { integrationConnectors } from '@/db/schema/index.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import type { AppEnv } from '@/types.js';
import { registerDockerSourceRoutes } from './docker-source.routes.js';
import { canListSourceConnectors, canPickDockerSource, listSourceConnectors } from './docker-source-connectors.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTOR_ID = '22222222-2222-4222-8222-222222222222';

const connectorRows = [
  { id: 'gh-1', name: 'GitHub', provider: 'github' },
  { id: 'gl-1', name: 'GitLab', provider: 'gitlab' },
  { id: 'git-1', name: 'Plain Git', provider: 'git' },
];

function connectorDb() {
  const orderBy = vi.fn().mockResolvedValue(connectorRows);
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select }, select, from, where };
}

function app(scopes: string[]) {
  const router = new OpenAPIHono<AppEnv>();
  const fakeDb = connectorDb();
  const repositories = vi.fn().mockResolvedValue([{ connectorId: CONNECTOR_ID, fullPath: 'team/app' }]);
  container.registerInstance(TOKENS.DrizzleClient, fakeDb.db as never);
  container.registerInstance(IntegrationsService, { listDockerBuildSourceRepositories: repositories } as never);
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('effectiveScopes', scopes);
    c.set('user', { id: 'user-1', scopes: [] } as never);
    await next();
  });
  registerDockerSourceRoutes(router);
  return { router, fakeDb, repositories };
}

afterEach(() => container.reset());

describe('source connector picker access', () => {
  it.each([
    [`docker:containers:create:${NODE_ID}`],
    ['docker:containers:create:folder/folder-1'],
    [`docker:containers:edit:${NODE_ID}/container-1`],
    ['docker:compose:create:folder/folder-1'],
    [`docker:compose:manage:${NODE_ID}/project-1`],
    ['pages:edit:project-1'],
    ['pages:create:folder/folder-1'],
  ])('lists enabled Git connectors for %s without any integration scope', async (scope) => {
    const { router, fakeDb } = app([scope]);

    const response = await router.request('/sources/connectors');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: connectorRows });
    expect(fakeDb.from).toHaveBeenCalledWith(integrationConnectors);
  });

  it.each([
    [['integrations:github:view', 'docker:containers:view']],
    [['docker:compose:view', 'pages:view']],
  ])('refuses the connector list for %j', async (scopes) => {
    const { router, fakeDb } = app(scopes);

    const response = await router.request('/sources/connectors');

    expect(response.status).toBe(403);
    expect(fakeDb.select).not.toHaveBeenCalled();
  });

  it('lists repositories for a Compose creator without docker:containers:view', async () => {
    const { router, repositories } = app(['docker:compose:create:folder/folder-1']);

    const response = await router.request(`/sources/connectors/${CONNECTOR_ID}/repositories`);

    expect(response.status).toBe(200);
    expect(repositories).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1' }), CONNECTOR_ID);
  });

  it('refuses the Docker repository list to viewers and to Pages-only editors', async () => {
    for (const scopes of [['docker:containers:view'], ['pages:edit']]) {
      const { router, repositories } = app(scopes);
      const response = await router.request(`/sources/connectors/${CONNECTOR_ID}/repositories`);
      expect(response.status).toBe(403);
      expect(repositories).not.toHaveBeenCalled();
    }
  });

  it('keeps the helpers aligned with the routes', () => {
    expect(canListSourceConnectors(['pages:edit'])).toBe(true);
    expect(canPickDockerSource(['pages:edit'])).toBe(false);
    expect(canPickDockerSource(['docker:containers:edit'])).toBe(true);
    expect(canListSourceConnectors([])).toBe(false);
  });

  it('only selects picker identity fields from enabled Git connectors', async () => {
    const { db, select } = connectorDb();

    await expect(listSourceConnectors(db as never)).resolves.toEqual(connectorRows);

    expect(Object.keys((select.mock.calls[0] as unknown[])[0] as object).sort()).toEqual(['id', 'name', 'provider']);
  });
});
