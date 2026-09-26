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

const GITHUB_ID = '33333333-3333-4333-8333-333333333333';
const GITLAB_ID = '44444444-4444-4444-8444-444444444444';
const GIT_ID = '55555555-5555-4555-8555-555555555555';
const connectorRows = [
  { id: GITHUB_ID, name: 'GitHub', provider: 'github' },
  { id: GITLAB_ID, name: 'GitLab', provider: 'gitlab' },
  { id: GIT_ID, name: 'Plain Git', provider: 'git' },
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
  ])('lets %s open the connector picker, listing only connectors its Git scopes cover', async (scope) => {
    const { router, fakeDb } = app([scope]);

    const response = await router.request('/sources/connectors');

    expect(response.status).toBe(200);
    // No Git scope: nothing to pick from.
    await expect(response.json()).resolves.toEqual({ data: [] });
    expect(fakeDb.from).toHaveBeenCalledWith(integrationConnectors);

    const scoped = app([scope, `integrations:gitlab:use:${GITLAB_ID}/project/42`, 'integrations:git:view']);
    const scopedResponse = await scoped.router.request('/sources/connectors');
    await expect(scopedResponse.json()).resolves.toEqual({
      data: [connectorRows[1], connectorRows[2]],
    });
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

    await expect(
      listSourceConnectors(db as never, [
        'integrations:github:view',
        'integrations:gitlab:view',
        'integrations:git:use',
      ])
    ).resolves.toEqual(connectorRows);

    expect(Object.keys((select.mock.calls[0] as unknown[])[0] as object).sort()).toEqual(['id', 'name', 'provider']);
  });

  it.each([
    [[`integrations:github:repo:read:${GITHUB_ID}/owner/7`], [GITHUB_ID]],
    [[`integrations:gitlab:use:${GITLAB_ID}`], [GITLAB_ID]],
    [
      [`integrations:gitlab:repo:write:${GITLAB_ID}/group/9`, `integrations:git:use:${GIT_ID}`],
      [GITLAB_ID, GIT_ID],
    ],
    [['integrations:gitlab:manage'], [GITLAB_ID]],
    [['integrations:cloudflare:view'], []],
  ])('offers the connectors %j covers through implied view', async (scopes, expected) => {
    const { db } = connectorDb();

    const listed = await listSourceConnectors(db as never, scopes);

    expect(listed.map((connector) => connector.id)).toEqual(expected);
  });
});
