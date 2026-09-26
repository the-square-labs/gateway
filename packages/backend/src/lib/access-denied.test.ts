import { describe, expect, it } from 'vitest';
import { dockerContainerFolders, nodes, proxyHostFolders } from '@/db/schema/index.js';
import {
  describeRootAccessDenied,
  grantedDestinations,
  rootAccessDeniedMessage,
  scopeNamedInMessage,
  withLimitedAccessGuidance,
} from './access-denied.js';

const FOLDER = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_FOLDER = 'aaaaaaaa-0000-4000-8000-000000000002';
const NODE = '44444444-4444-4444-8444-444444444444';
const ROUTE = 'eeeeeeee-0000-4000-8000-000000000001';

function testDb() {
  const rows = new Map<unknown, Array<Record<string, unknown>>>([
    [dockerContainerFolders, [{ id: FOLDER, name: 'MyProject', parentId: null, resourceType: 'container' }]],
    [proxyHostFolders, [{ id: FOLDER, name: 'Web', parentId: null }]],
    [nodes, [{ id: NODE, hostname: 'edge-01.internal', displayName: 'edge-01' }]],
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

describe('grantedDestinations', () => {
  it('finds root, folder, node and resource grants, including implying scopes', () => {
    expect(
      grantedDestinations(
        [`docker:containers:create:folder/${FOLDER}`, `docker:containers:create:${NODE}`],
        'docker:containers:create'
      )
    ).toEqual({ atRoot: false, folderIds: [FOLDER], nodeIds: [NODE], resourceIds: [] });
    expect(grantedDestinations([`proxy:edit:${ROUTE}`, `proxy:view:folder/${FOLDER}`], 'proxy:view')).toEqual({
      atRoot: false,
      folderIds: [FOLDER],
      nodeIds: [],
      resourceIds: [ROUTE],
    });
    expect(grantedDestinations(['proxy:create'], 'proxy:create').atRoot).toBe(true);
  });
});

describe('rootAccessDeniedMessage', () => {
  it('names the allowed folders and nodes and asks for folderId', () => {
    expect(
      rootAccessDeniedMessage({
        scope: 'docker:containers:create',
        folders: [{ id: FOLDER, name: 'MyProject', path: 'Clients / MyProject' }, { id: OTHER_FOLDER }],
      })
    ).toBe(
      `Missing docker:containers:create at the root. Your docker:containers:create access is limited to folders 'Clients / MyProject' (${FOLDER}), ${OTHER_FOLDER}: pass folderId for one of them. Call get_my_access to see every folder and node you can use.`
    );
    expect(
      rootAccessDeniedMessage({
        scope: 'proxy:create',
        action: 'Creating a route at the root',
        folders: [{ id: FOLDER, name: 'Web' }],
        nodes: [{ id: NODE, name: 'edge-01' }],
      })
    ).toContain(`limited to folder 'Web' (${FOLDER}) and node 'edge-01' (${NODE}): pass folderId or nodeId`);
  });

  it('stays a plain denial without limited grants', () => {
    expect(rootAccessDeniedMessage({ scope: 'proxy:create' })).toBe('Missing proxy:create at the root.');
  });

  it('reads folder and node names from the database', async () => {
    await expect(
      describeRootAccessDenied(
        testDb(),
        [`docker:containers:create:folder/${FOLDER}`],
        'docker:containers:create',
        'Creating a container at the root'
      )
    ).resolves.toBe(
      `Creating a container at the root requires docker:containers:create there. Your docker:containers:create access is limited to folder 'MyProject' (${FOLDER}): pass folderId for one of them. Call get_my_access to see every folder and node you can use.`
    );
  });
});

describe('withLimitedAccessGuidance', () => {
  it('names the create destinations of a create refused at the root', async () => {
    await expect(
      withLimitedAccessGuidance(
        'Missing proxy:create permission for the selected destination',
        [`proxy:create:folder/${FOLDER}`, `proxy:create:node/${NODE}`],
        testDb()
      )
    ).resolves.toBe(
      `Missing proxy:create permission for the selected destination. Your proxy:create access is limited to folder 'Web' (${FOLDER}) and node 'edge-01' (${NODE}): pass folderId or nodeId for one of them. Call get_my_access to see every folder and node you can use.`
    );
  });

  it('points a root-level denial at the folders that hold the scope', async () => {
    const message = await withLimitedAccessGuidance('PERMISSION_DENIED: "proxy:view" is not granted for this target.', [
      `proxy:view:folder/${FOLDER}`,
    ]);
    expect(message).toContain(`Your proxy:view access is limited to folder ${FOLDER} (and what they contain)`);
    expect(message).toContain('get_my_access');
  });

  it('leaves genuine, per-resource and unrelated errors unchanged', async () => {
    // No grant of the scope anywhere.
    await expect(
      withLimitedAccessGuidance('Missing proxy:create permission for the selected destination', ['proxy:view'])
    ).resolves.toBe('Missing proxy:create permission for the selected destination');
    // A denial of one specific resource.
    await expect(
      withLimitedAccessGuidance(`Missing required scope: proxy:view:${ROUTE}`, [`proxy:view:folder/${FOLDER}`])
    ).resolves.toBe(`Missing required scope: proxy:view:${ROUTE}`);
    // Broad access: the denial has another cause.
    await expect(
      withLimitedAccessGuidance('PERMISSION_DENIED: Missing required scope proxy:create', ['proxy:create'])
    ).resolves.toBe('PERMISSION_DENIED: Missing required scope proxy:create');
    // Not a permission error.
    await expect(
      withLimitedAccessGuidance('Invalid hostname for proxy:create', [`proxy:create:folder/${FOLDER}`])
    ).resolves.toBe('Invalid hostname for proxy:create');
  });

  it('reads the scope a message names', () => {
    expect(scopeNamedInMessage('Missing docker:containers:create for the destination node or folder')).toEqual({
      scope: 'docker:containers:create',
      qualifier: null,
    });
    expect(scopeNamedInMessage(`Missing required scope: nodes:create:folder/${FOLDER}.`)).toEqual({
      scope: 'nodes:create',
      qualifier: `folder/${FOLDER}`,
    });
    expect(scopeNamedInMessage('Request to https://example.com failed')).toBeNull();
  });
});
