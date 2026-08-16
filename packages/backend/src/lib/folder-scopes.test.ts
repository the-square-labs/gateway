import { describe, expect, it, vi } from 'vitest';
import { expandFolderScopes, folderScopedScope, parseFolderScopedGrant } from './folder-scopes.js';
import { getResourceScopedIds, isScopeSubset } from './permissions.js';

describe('folder-scoped permissions', () => {
  it('parses only supported folder targets', () => {
    expect(parseFolderScopedGrant('proxy:view:folder/folder-1')).toEqual({
      scope: 'proxy:view:folder/folder-1',
      baseScope: 'proxy:view',
      folderId: 'folder-1',
    });
    expect(parseFolderScopedGrant('proxy:create:folder/folder-1')).toBeNull();
    expect(parseFolderScopedGrant('proxy:view:host-1')).toBeNull();
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
});
