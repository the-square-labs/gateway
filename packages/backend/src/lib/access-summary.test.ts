import { describe, expect, it } from 'vitest';
import { hasLimitedGrants, summarizeScopeGrants } from './access-summary.js';
import { boundScopes } from './permissions.js';
import { SYSTEM_ADMIN_SCOPES } from './scopes.js';

const FOLDER = 'aaaaaaaa-0000-4000-8000-000000000001';
const NODE = '44444444-4444-4444-8444-444444444444';
const ROUTE = 'eeeeeeee-0000-4000-8000-000000000001';

function area(scopes: string[], id: string, derived?: Set<string>) {
  return summarizeScopeGrants(scopes, { derived }).areas.find((entry) => entry.area.id === id);
}

describe('summarizeScopeGrants', () => {
  it('reports broad access without limits', () => {
    const summary = summarizeScopeGrants(['docker:containers:view', 'docker:containers:create', 'proxy:edit']);
    expect(summary.limited).toBe(false);
    const docker = summary.areas.find((entry) => entry.area.id === 'docker_containers')!;
    expect(docker).toMatchObject({ broad: true, broadActions: ['create', 'view'], folders: [], nodes: [] });
    expect(docker.create).toMatchObject({ scope: 'docker:containers:create', atRoot: true });
    // Holding edit implies view everywhere.
    expect(summary.areas.find((entry) => entry.area.id === 'routes')).toMatchObject({
      broad: true,
      broadActions: ['edit', 'view'],
    });
  });

  it('reports every area of a system administrator as broad', () => {
    const summary = summarizeScopeGrants([...SYSTEM_ADMIN_SCOPES]);
    expect(summary.limited).toBe(false);
    expect(summary.areas.filter((entry) => entry.area.viewScope && !entry.broad)).toEqual([]);
  });

  it('lists folder grants with their implied actions and creation destinations', () => {
    const scopes = [
      `docker:containers:create:folder/${FOLDER}`,
      `docker:containers:manage:folder/${FOLDER}`,
      // Expanded by the authentication layer from the folder grant.
      `docker:containers:manage:${NODE}/access-app`,
    ];
    const derived = new Set([`docker:containers:manage:${NODE}/access-app`]);
    const summary = summarizeScopeGrants(scopes, { derived });
    expect(summary.limited).toBe(true);
    const docker = summary.areas.find((entry) => entry.area.id === 'docker_containers')!;
    expect(docker).toMatchObject({
      broad: false,
      broadActions: [],
      folders: [{ id: FOLDER, actions: ['create', 'manage', 'view'] }],
      nodes: [],
      resources: [],
      create: { atRoot: false, folderIds: [FOLDER], nodeIds: [] },
    });
  });

  it('lists derived resources on their own when no expansion is known', () => {
    const docker = area(
      [`docker:containers:view:folder/${FOLDER}`, `docker:containers:view:${NODE}/access-app`],
      'docker_containers'
    )!;
    expect(docker.resources).toEqual([{ id: 'access-app', nodeId: NODE, actions: ['view'] }]);
  });

  it('lists node grants, including Docker bare node qualifiers and legacy route creation nodes', () => {
    const scopes = [`proxy:view:node/${NODE}`, `proxy:create:${NODE}`, `docker:images:view:${NODE}`];
    const routes = area(scopes, 'routes')!;
    expect(routes).toMatchObject({
      broad: false,
      nodes: [{ id: NODE, actions: ['create', 'view'] }],
      create: { atRoot: false, folderIds: [], nodeIds: [NODE] },
    });
    expect(area(scopes, 'docker_images')).toMatchObject({ broad: false, nodes: [{ id: NODE, actions: ['view'] }] });
    expect(hasLimitedGrants(scopes)).toBe(true);
  });

  it('lists resource grants and keeps view scopes of other families apart', () => {
    const scopes = [`proxy:edit:${ROUTE}`, 'pki:cert:issue:ca-1'];
    expect(area(scopes, 'routes')).toMatchObject({
      broad: false,
      resources: [{ id: ROUTE, actions: ['edit', 'view'] }],
    });
    expect(area(scopes, 'pki')).toMatchObject({ resources: [{ id: 'ca-1', actions: ['cert:issue'] }] });
  });

  it('flags creation limited to folders even when viewing is broad', () => {
    const summary = summarizeScopeGrants(['databases:view', `databases:create:folder/${FOLDER}`]);
    expect(summary.limited).toBe(true);
    expect(summary.areas.find((entry) => entry.area.id === 'databases')).toMatchObject({
      broad: true,
      create: { atRoot: false, folderIds: [FOLDER] },
    });
  });

  it('keeps a token bounded by its owner: a folder grant of a broad owner stays a folder grant', () => {
    const token = [`proxy:view:folder/${FOLDER}`, `proxy:create:folder/${FOLDER}`];
    const bounded = boundScopes(token, [...SYSTEM_ADMIN_SCOPES]);
    const routes = area(bounded, 'routes')!;
    expect(routes).toMatchObject({ broad: false, folders: [{ id: FOLDER, actions: ['create', 'view'] }] });
    expect(routes.create).toMatchObject({ atRoot: false, folderIds: [FOLDER] });

    // An owner limited to one route narrows a broad token to that route.
    const narrowed = area(boundScopes(['proxy:view'], [`proxy:view:${ROUTE}`]), 'routes')!;
    expect(narrowed).toMatchObject({ broad: false, resources: [{ id: ROUTE, actions: ['view'] }] });
  });

  it('groups hosting accounts and Git qualifiers under their areas', () => {
    const scopes = ['hosting:resources:create:account/conn-1', 'integrations:gitlab:repo:read:conn-2/project/42'];
    expect(area(scopes, 'hosting')).toMatchObject({
      accounts: [{ id: 'conn-1', actions: ['resources:create'] }],
      create: { atRoot: false, accountIds: ['conn-1'] },
    });
    expect(area(scopes, 'integrations')).toMatchObject({
      resources: [{ id: 'conn-2/project/42', actions: expect.arrayContaining(['gitlab:repo:read']) }],
    });
  });
});
