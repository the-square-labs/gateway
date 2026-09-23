import { describe, expect, it, vi } from 'vitest';
import { assertFolderMoveAccess, FolderedResourceService } from './resource-folder.service.js';

const folderTable = {
  id: 'folder.id',
  parentId: 'folder.parentId',
  sortOrder: 'folder.sortOrder',
  depth: 'folder.depth',
};
const resourceTable = { id: 'resource.id', folderId: 'resource.folderId' };

type Row = Record<string, unknown>;

/** Minimal Drizzle stand-in: answers each select by table and selected columns. */
function createFakeDb(options: { folders: Row[]; resourceIds: string[] }) {
  const folderLookups = [...options.folders];
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ ...options.folders[0], parentId: 'destination' }]),
      })),
    })),
  }));
  const select = vi.fn((fields?: Row) => ({
    from: (table: unknown) => {
      const rows = (): Row[] => {
        if (table === resourceTable) return options.resourceIds.map((id) => ({ id }));
        if (!fields) return folderLookups.length > 0 ? [folderLookups.shift()!] : [];
        if ('maxDepth' in fields) return [{ maxDepth: 0 }];
        return [];
      };
      const query = {
        where: () => query,
        orderBy: () => query,
        limit: () => Promise.resolve(rows()),
        // biome-ignore lint/suspicious/noThenProperty: mimics Drizzle's awaitable query builder
        then: (resolve: (value: Row[]) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve(rows()).then(resolve, reject),
      };
      return query;
    },
  }));
  return { select, update };
}

function createService(resourceIds: string[]) {
  const source = { id: 'source', name: 'Production', parentId: null, depth: 0, sortOrder: 0 };
  const destination = { id: 'destination', name: 'Team', parentId: null, depth: 0, sortOrder: 1 };
  const db = createFakeDb({ folders: [source, destination], resourceIds });
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new FolderedResourceService(db as never, audit as never, {
    folderTable,
    resourceTable,
    resourceName: 'database_connection',
    resourcePlural: 'database_connections',
    auditResourceType: 'database_connection_folder',
    eventName: 'database.folder.changed',
  });
  return { db, service };
}

describe('assertFolderMoveAccess', () => {
  it('requires edit access on every moved resource and on the destination', () => {
    const scopes = [
      'databases:edit:db-1',
      'databases:edit:folder/destination',
      'databases:credentials:reveal:folder/destination',
    ];

    expect(() =>
      assertFolderMoveAccess({ scopes, editScope: 'databases:edit' }, ['db-1'], 'destination')
    ).not.toThrow();
    expect(() =>
      assertFolderMoveAccess({ scopes, editScope: 'databases:edit' }, ['db-1', 'db-prod'], 'destination')
    ).toThrow(/inside the moved folder/);
    expect(() => assertFolderMoveAccess({ scopes, editScope: 'databases:edit' }, ['db-1'], 'elsewhere')).toThrow(
      /move destination/
    );
    expect(() => assertFolderMoveAccess({ scopes, editScope: 'databases:edit' }, [], null)).toThrow(/move destination/);
    expect(() =>
      assertFolderMoveAccess({ scopes: ['databases:edit'], editScope: 'databases:edit' }, ['db-prod'], null)
    ).not.toThrow();
  });
});

describe('FolderedResourceService.moveFolder', () => {
  it('refuses to move a folder containing resources the caller cannot edit', async () => {
    const { db, service } = createService(['db-prod']);

    await expect(
      service.moveFolder('source', { parentId: 'destination' }, 'user-1', {
        scopes: [
          'databases:folders:manage',
          'databases:credentials:reveal:folder/destination',
          'databases:edit:folder/destination',
        ],
        editScope: 'databases:edit',
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('moves the folder when every resource and the destination are editable', async () => {
    const { db, service } = createService(['db-1']);

    await service.moveFolder('source', { parentId: 'destination' }, 'user-1', {
      scopes: ['databases:folders:manage', 'databases:edit:db-1', 'databases:edit:folder/destination'],
      editScope: 'databases:edit',
    });

    expect(db.update).toHaveBeenCalled();
  });
});
