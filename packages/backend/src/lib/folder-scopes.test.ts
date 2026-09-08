import { describe, expect, it, vi } from 'vitest';
import { expandFolderScopes, folderScopedScope, parseFolderScopedGrant } from './folder-scopes.js';
import { getResourceScopedIds, hasScopeForCreation, isScopeSubset } from './permissions.js';

describe('folder-scoped permissions', () => {
  it.each([
    'admin:groups',
    'admin:users',
  ])('expands %s management to the folder contents while creation remains destination-bound', async (base) => {
    const select = vi.fn((fields: Record<string, unknown>) => ({
      from: () =>
        'parentId' in fields
          ? Promise.resolve([{ id: 'f1', parentId: null }])
          : { where: async () => [{ id: 'r1', folderId: 'f1' }] },
    }));
    const scopes = await expandFolderScopes({ select } as never, [`${base}:folder/f1`]);
    expect(scopes).toContain(`${base}:r1`);
    expect(hasScopeForCreation(scopes, base, 'f1')).toBe(true);
    expect(hasScopeForCreation(scopes, base, null)).toBe(false);
    expect(isScopeSubset([`${base}:r2`], scopes)).toBe(false);
  });
  it('parses only supported folder targets', () => {
    expect(parseFolderScopedGrant('proxy:view:folder/folder-1')).toEqual({
      scope: 'proxy:view:folder/folder-1',
      baseScope: 'proxy:view',
      folderId: 'folder-1',
    });
    expect(parseFolderScopedGrant('proxy:create:folder/folder-1')?.folderId).toBe('folder-1');
    expect(parseFolderScopedGrant('proxy:view:host-1')).toBeNull();
  });

  it('expands Pages folders to projects, not CA identities', async () => {
    const select = vi.fn((fields: Record<string, unknown>) => ({
      from: vi.fn(() =>
        'parentId' in fields
          ? Promise.resolve([
              { id: 'folder-1', parentId: null },
              { id: 'folder-2', parentId: 'folder-1' },
            ])
          : { where: vi.fn().mockResolvedValue([{ id: 'project-1', folderId: 'folder-2' }]) }
      ),
    }));
    expect(await expandFolderScopes({ select } as never, ['pages:view:folder/folder-1'])).toEqual([
      'pages:view:folder/folder-1',
      'pages:view:folder/folder-2',
      'pages:view:project-1',
    ]);
  });

  it('creation expands destination subfolders without creating existing-resource grants', async () => {
    const select = vi.fn((fields: Record<string, unknown>) => ({
      from: vi.fn(() =>
        'parentId' in fields
          ? Promise.resolve([
              { id: 'folder-1', parentId: null },
              { id: 'folder-2', parentId: 'folder-1' },
            ])
          : { where: vi.fn().mockResolvedValue([{ id: 'db-1', folderId: 'folder-2' }]) }
      ),
    }));
    const scopes = await expandFolderScopes({ select } as never, ['databases:create:folder/folder-1']);
    expect(scopes).toEqual(['databases:create:folder/folder-1', 'databases:create:folder/folder-2']);
    expect(hasScopeForCreation(scopes, 'databases:create', 'folder-2')).toBe(true);
    expect(hasScopeForCreation(scopes, 'databases:create', 'unrelated')).toBe(false);
    expect(hasScopeForCreation(scopes, 'databases:create', null)).toBe(false);
    expect(hasScopeForCreation(scopes, 'databases:create', null, 'db-1')).toBe(false);
  });

  it('expands explicit node targets to current Pages projects only', async () => {
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ id: 'project-1' }]) })) }));
    const scopes = await expandFolderScopes({ select } as never, ['pages:edit:node/node-1']);
    expect(scopes).toEqual(['pages:edit:node/node-1', 'pages:edit:project-1']);
    expect(getResourceScopedIds(scopes, 'pages:view')).toEqual(['project-1']);
    expect(isScopeSubset(['pages:edit:project-2'], scopes)).toBe(false);
  });

  it('narrows provider creation grants to matching connected accounts and does not imply deletion', async () => {
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([
          { id: 'pve-account', provider: 'proxmox' },
          { id: 'do-account', provider: 'digitalocean' },
        ]),
      })),
    }));
    const scopes = await expandFolderScopes({ select } as never, ['hosting:resources:create:provider/proxmox']);
    expect(scopes).toEqual(['hosting:resources:create:provider/proxmox', 'hosting:resources:create:pve-account']);
    expect(getResourceScopedIds(scopes, 'hosting:resources:create')).toEqual(['pve-account']);
    expect(isScopeSubset(['hosting:resources:create:do-account'], scopes)).toBe(false);
    expect(isScopeSubset(['hosting:resources:delete:pve-account'], scopes)).toBe(false);
  });

  it('expands hosting node grants to binding identities without granting node access', async () => {
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ id: 'vm-1' }]) })) }));
    const scopes = await expandFolderScopes({ select } as never, ['hosting:resources:power:node/node-1']);
    expect(scopes).toEqual(['hosting:resources:power:node/node-1', 'hosting:resources:power:vm-1']);
    expect(isScopeSubset(['nodes:details:node-1'], scopes)).toBe(false);
  });

  it('expands a folder and its descendants to existing resource scopes', async () => {
    const folderRows = [
      { id: 'folder-1', parentId: null },
      { id: 'folder-2', parentId: 'folder-1' },
      { id: 'folder-3', parentId: null },
    ];
    const resourceRows = [
      { id: 'host-1', folderId: 'folder-1' },
      { id: 'host-2', folderId: 'folder-2' },
      { id: 'host-3', folderId: 'folder-3' },
    ];
    const select = vi.fn((fields: Record<string, unknown>) => ({
      from: vi.fn(() =>
        'parentId' in fields ? Promise.resolve(folderRows) : { where: vi.fn().mockResolvedValue(resourceRows) }
      ),
    }));

    const scopes = await expandFolderScopes({ select } as any, [folderScopedScope('proxy:view', 'folder-1')]);

    expect(scopes).toEqual([
      'proxy:view:folder/folder-1',
      'proxy:view:folder/folder-2',
      'proxy:view:host-1',
      'proxy:view:host-2',
    ]);
    expect(getResourceScopedIds(scopes, 'proxy:view')).toEqual(['host-1', 'host-2']);
    expect(isScopeSubset(['proxy:view:folder/folder-2'], scopes)).toBe(true);
    expect(isScopeSubset(['proxy:view:folder/folder-3'], scopes)).toBe(false);
  });

  it('expands Docker folders to stable container and deployment resource IDs', async () => {
    const select = vi.fn((fields: Record<string, unknown>) => ({
      from: vi.fn(() => {
        if ('parentId' in fields) {
          return Promise.resolve([{ id: 'docker-folder-1', parentId: null, resourceType: 'container' }]);
        }
        if ('folderId' in fields) {
          return {
            where: vi.fn().mockResolvedValue([
              {
                folderId: 'docker-folder-1',
                nodeId: 'node-1',
                resourceType: 'container',
                resourceKey: 'standalone',
              },
              {
                folderId: 'docker-folder-1',
                nodeId: 'node-1',
                resourceType: 'container',
                resourceKey: 'blue-green',
              },
            ]),
          };
        }
        if ('resourceKey' in fields) {
          return {
            where: vi.fn().mockResolvedValue([{ id: 'access-1', nodeId: 'node-1', resourceKey: 'standalone' }]),
          };
        }
        return {
          where: vi.fn().mockResolvedValue([{ id: 'deployment-1', nodeId: 'node-1', name: 'blue-green' }]),
        };
      }),
    }));

    const scopes = await expandFolderScopes({ select } as any, [
      folderScopedScope('docker:containers:view', 'docker-folder-1'),
    ]);

    expect(scopes).toEqual([
      'docker:containers:view:folder/docker-folder-1',
      'docker:containers:view:node-1/access-1',
      'docker:containers:view:node-1/deployment-1',
    ]);
  });

  it('expands Compose folders to stable project resource IDs only', async () => {
    const select = vi.fn((fields: Record<string, unknown>) => ({
      from: vi.fn(() => {
        if ('parentId' in fields) {
          return Promise.resolve([{ id: 'compose-folder-1', parentId: null, resourceType: 'compose' }]);
        }
        if ('folderId' in fields) {
          return {
            where: vi.fn().mockResolvedValue([
              {
                folderId: 'compose-folder-1',
                nodeId: 'node-1',
                resourceType: 'compose',
                resourceKey: 'project-1',
              },
              {
                folderId: 'compose-folder-1',
                nodeId: 'node-1',
                resourceType: 'container',
                resourceKey: 'standalone',
              },
            ]),
          };
        }
        return {
          where: vi.fn().mockResolvedValue([{ id: 'project-1', nodeId: 'node-1' }]),
        };
      }),
    }));

    const scopes = await expandFolderScopes({ select } as any, [
      folderScopedScope('docker:compose:view', 'compose-folder-1'),
    ]);

    expect(scopes).toEqual(['docker:compose:view:folder/compose-folder-1', 'docker:compose:view:node-1/project-1']);
  });
});
