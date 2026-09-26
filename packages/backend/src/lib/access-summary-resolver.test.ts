import { describe, expect, it } from 'vitest';
import {
  dockerAccessResources,
  dockerComposeProjects,
  dockerContainerFolderAssignments,
  dockerContainerFolders,
  dockerDeployments,
  nodes,
  proxyHostFolders,
  proxyHosts,
} from '@/db/schema/index.js';
import { accessSummaryPrincipal, buildAccessSummary, renderAccessSummaryText } from './access-summary-resolver.js';
import { expandFolderScopes } from './folder-scopes.js';
import { boundScopes } from './permissions.js';
import { canonicalizeScopes, isMcpTokenScope, SYSTEM_ADMIN_SCOPES } from './scopes.js';

const NODE = '44444444-4444-4444-8444-444444444444';
const CLIENTS = 'aaaaaaaa-0000-4000-8000-000000000001';
const MY_PROJECT = 'aaaaaaaa-0000-4000-8000-000000000002';
const WEB = 'bbbbbbbb-0000-4000-8000-000000000001';
const ROUTE_IN = 'eeeeeeee-0000-4000-8000-000000000001';
const ROUTE_OUT = 'eeeeeeee-0000-4000-8000-000000000002';
const APP = 'cccccccc-0000-4000-8000-000000000001';

/** `select().from(table)` resolves to the rows of that table, with or without `.where(...)`. */
function testDb() {
  const rows = new Map<unknown, Array<Record<string, unknown>>>([
    [
      dockerContainerFolders,
      [
        { id: CLIENTS, name: 'Clients', parentId: null, resourceType: 'container' },
        { id: MY_PROJECT, name: 'MyProject', parentId: CLIENTS, resourceType: 'container' },
      ],
    ],
    [
      dockerContainerFolderAssignments,
      [{ folderId: MY_PROJECT, nodeId: NODE, resourceType: 'container', resourceKey: 'app' }],
    ],
    [dockerAccessResources, [{ id: APP, nodeId: NODE, resourceKey: 'app' }]],
    [dockerDeployments, []],
    [dockerComposeProjects, []],
    [proxyHostFolders, [{ id: WEB, name: 'Web', parentId: null }]],
    [
      proxyHosts,
      [
        { id: ROUTE_IN, folderId: WEB, nodeId: NODE, domainNames: ['app.example.com'] },
        { id: ROUTE_OUT, folderId: null, nodeId: NODE, domainNames: ['other.example.com'] },
      ],
    ],
    [nodes, [{ id: NODE, hostname: 'edge-01.internal', displayName: 'edge-01', folderId: null }]],
  ]);
  return {
    select: () => ({
      from: (table: unknown) => {
        const result = () => Promise.resolve([...(rows.get(table) ?? [])]);
        return Object.assign(result(), { where: () => result() });
      },
    }),
  } as never;
}

async function summaryFor(grants: string[], ownerScopes?: string[]) {
  const db = testDb();
  const expanded = await expandFolderScopes(db, grants);
  const scopes = ownerScopes
    ? canonicalizeScopes(boundScopes(expanded, ownerScopes)).filter(isMcpTokenScope)
    : expanded;
  return buildAccessSummary(db, scopes);
}

describe('buildAccessSummary', () => {
  it("names a folder-limited principal's folders with their paths and hides what the grants expanded to", async () => {
    const summary = await summaryFor([
      `docker:containers:view:folder/${MY_PROJECT}`,
      `docker:containers:manage:folder/${MY_PROJECT}`,
      `docker:containers:create:folder/${MY_PROJECT}`,
    ]);

    expect(summary.limited).toBe(true);
    const docker = summary.areas.find((area) => area.area === 'docker_containers')!;
    expect(docker).toMatchObject({
      title: 'Docker containers and deployments',
      access: 'limited',
      broadActions: [],
      folders: [
        {
          id: MY_PROJECT,
          name: 'MyProject',
          path: 'Clients / MyProject',
          actions: ['create', 'manage', 'view'],
          includesSubfolders: true,
        },
      ],
      nodes: [],
      // The container inside the folder is covered by the folder grant, not listed on its own.
      resources: [],
      create: {
        scope: 'docker:containers:create',
        atRoot: false,
        folders: [{ id: MY_PROJECT, name: 'MyProject', path: 'Clients / MyProject' }],
      },
      folderListing: {
        tool: 'list_resource_folders',
        arguments: { resourceType: 'docker', dockerResourceType: 'container' },
      },
    });
    expect(docker.create?.howTo).toContain('Creation at the root is refused');
    expect(summary.summary).toContain(
      "- Docker containers and deployments: folder 'Clients / MyProject' (create, manage, view); create only in the folders or nodes listed."
    );
    expect(summary.summary).toContain('get_my_access');
    expect(summary.rules.join(' ')).toContain('Folder-, node- and resource-limited access is normal');
  });

  it('lists a granted parent folder once instead of each subfolder', async () => {
    const summary = await summaryFor([`docker:containers:view:folder/${CLIENTS}`]);
    const docker = summary.areas.find((area) => area.area === 'docker_containers')!;
    expect(docker.folders.map((folder) => folder.path)).toEqual(['Clients']);
  });

  it('names node-limited grants and the nodes of Docker resources', async () => {
    const summary = await summaryFor([`proxy:view:node/${NODE}`, `docker:containers:view:${NODE}/${APP}`]);
    const routes = summary.areas.find((area) => area.area === 'routes')!;
    expect(routes).toMatchObject({
      access: 'limited',
      nodes: [{ id: NODE, name: 'edge-01', actions: ['view'] }],
      // Routes on the node come from the node grant.
      resources: [],
    });
    const docker = summary.areas.find((area) => area.area === 'docker_containers')!;
    expect(docker.resources).toEqual([{ id: APP, name: 'app', actions: ['view'], nodeId: NODE, nodeName: 'edge-01' }]);
    expect(summary.summary).toContain("- Ingress routes: node 'edge-01' (view).");
  });

  it('names resource-limited grants', async () => {
    const summary = await summaryFor([`proxy:edit:${ROUTE_IN}`]);
    expect(summary.areas.find((area) => area.area === 'routes')).toMatchObject({
      access: 'limited',
      resources: [{ id: ROUTE_IN, name: 'app.example.com', actions: ['edit', 'view'] }],
    });
    expect(summary.summary).toContain("resource 'app.example.com' (edit, view)");
  });

  it('bounds a token by its owner: a system administrator owner does not widen a folder grant', async () => {
    const summary = await summaryFor(
      [`proxy:view:folder/${WEB}`, `proxy:create:folder/${WEB}`],
      [...SYSTEM_ADMIN_SCOPES]
    );
    expect(summary.limited).toBe(true);
    expect(summary.areas.map((area) => area.area)).toEqual(['routes']);
    expect(summary.areas[0]).toMatchObject({
      access: 'limited',
      folders: [{ id: WEB, name: 'Web', path: 'Web', actions: ['create', 'view'] }],
      resources: [],
      create: { atRoot: false, folders: [{ id: WEB, name: 'Web' }] },
    });
  });

  it('stays empty for broad access', async () => {
    const summary = await summaryFor(['proxy:view', 'proxy:create', 'docker:containers:view']);
    expect(summary.limited).toBe(false);
    expect(summary.summary).toBe('');
    expect(summary.areas.every((area) => area.access === 'broad')).toBe(true);
  });

  it('falls back to ids without a database', async () => {
    const summary = await buildAccessSummary(null, [`proxy:view:folder/${WEB}`]);
    expect(summary.areas[0]).toMatchObject({
      folders: [{ id: WEB, name: null, path: null, actions: ['view'] }],
    });
    expect(summary.summary).toContain(`folder ${WEB} (view)`);
  });
});

describe('renderAccessSummaryText', () => {
  it('caps the text and points at get_my_access for the rest', async () => {
    const grants = [
      'proxy',
      'domains',
      'databases',
      'storage',
      'pages',
      'nodes',
      'logs:environments',
      'logs:schemas',
      'ssl:cert',
    ].flatMap((family) =>
      Array.from(
        { length: 5 },
        (_, index) => `${family === 'nodes' ? 'nodes:details' : `${family}:view`}:folder/f${index}-${'x'.repeat(40)}`
      )
    );
    const summary = await buildAccessSummary(null, grants);
    const text = renderAccessSummaryText(summary, 600);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toMatch(/more limited areas \(see get_my_access\)/);
    expect(text.endsWith('pass folderId (and nodeId) when creating.')).toBe(true);
  });
});

describe('accessSummaryPrincipal', () => {
  const owner = { id: 'user-1', name: 'Dev', email: 'dev@example.com', groupName: 'developers' };

  it('returns the owner identity only to browser sessions', () => {
    for (const credential of ['session', 'assistant'] as const) {
      expect(accessSummaryPrincipal(owner, credential)).toEqual({
        credential,
        boundedByOwner: false,
        userId: 'user-1',
        name: 'Dev',
        email: 'dev@example.com',
        group: 'developers',
      });
    }
    for (const credential of ['api-token', 'oauth-token', 'mcp'] as const) {
      expect(accessSummaryPrincipal(owner, credential)).toEqual({ credential, boundedByOwner: true });
    }
  });
});
