import type { SQL } from 'drizzle-orm';
import { integer, PgDialect, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { createFakeAdvisoryLockDb } from '@/db/advisory-lock.test-helpers.js';
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
  const db: Record<string, unknown> = { select, update, execute: vi.fn().mockResolvedValue(undefined) };
  db.transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  return db as { select: typeof select; update: typeof update; transaction: ReturnType<typeof vi.fn> };
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

const treeFolders = pgTable('test_folders', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  parentId: uuid('parent_id'),
  sortOrder: integer('sort_order').notNull(),
  depth: integer('depth').notNull(),
  createdById: uuid('created_by_id').notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});
const treeResources = pgTable('test_resources', {
  id: uuid('id').primaryKey(),
  folderId: uuid('folder_id'),
});
const dialect = new PgDialect();

type TreeRow = { id: string; name: string; parentId: string | null; depth: number; sortOrder: number };

/**
 * In-memory folder table that answers the service's queries by their shape
 * (selected fields, filtered column) and yields between statements, so two
 * operations interleave unless something serializes them.
 */
function createTreeDb(rows: TreeRow[]) {
  const folders = new Map(rows.map((row) => [row.id, { ...row }]));
  let statements = 0;
  const tick = async () => {
    statements += 1;
    // A walk that never ends would hang the test; fail loudly instead.
    if (statements > 500) throw new Error('runaway folder query loop');
    await Promise.resolve();
  };
  const render = (condition: SQL | undefined) => (condition ? dialect.sqlToQuery(condition) : { sql: '', params: [] });
  const matching = (condition: SQL | undefined) => {
    const { sql: text, params } = render(condition);
    const values = new Set(params as string[]);
    if (text.includes('"parent_id" in')) return [...folders.values()].filter((row) => values.has(row.parentId ?? ''));
    if (text.includes('"parent_id" is null')) return [...folders.values()].filter((row) => row.parentId === null);
    if (text.includes('"parent_id" =')) return [...folders.values()].filter((row) => values.has(row.parentId ?? ''));
    return [...folders.values()].filter((row) => values.has(row.id));
  };
  const makeTx = () => ({
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        let condition: SQL | undefined;
        const run = async () => {
          await tick();
          if (table === treeResources) return [];
          const found = matching(condition);
          if (fields && 'maxDepth' in fields) return [{ maxDepth: Math.max(...found.map((row) => row.depth)) }];
          if (fields && 'sortOrder' in fields) return [];
          if (fields) return found.map((row) => ({ id: row.id }));
          return found.map((row) => ({ ...row }));
        };
        const query = {
          where: (next: SQL | undefined) => {
            condition = next;
            return query;
          },
          orderBy: () => query,
          limit: () => run(),
          // biome-ignore lint/suspicious/noThenProperty: mimics Drizzle's awaitable query builder
          then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            run().then(resolve, reject),
        };
        return query;
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: SQL | undefined) => {
          const run = async () => {
            await tick();
            const targets = matching(condition);
            const delta = values.depth instanceof Object ? Number(render(values.depth as SQL).params[0]) : null;
            for (const row of targets) {
              if ('parentId' in values) row.parentId = values.parentId as string | null;
              if (delta !== null) row.depth += delta;
              else if (typeof values.depth === 'number') row.depth = values.depth;
            }
            return targets.map((row) => ({ ...row }));
          };
          return {
            returning: run,
            // biome-ignore lint/suspicious/noThenProperty: mimics Drizzle's awaitable query builder
            then: (resolve: (value: unknown) => unknown) => run().then(resolve),
          };
        },
      }),
    }),
    delete: () => ({
      where: async (condition: SQL | undefined) => {
        await tick();
        for (const row of matching(condition)) folders.delete(row.id);
      },
    }),
  });
  const locks = createFakeAdvisoryLockDb(makeTx);
  const db = { ...makeTx(), transaction: locks.transaction };
  return { db, folders, locks };
}

function treeService(db: unknown) {
  return new FolderedResourceService(db as never, { log: vi.fn().mockResolvedValue(undefined) } as never, {
    folderTable: treeFolders,
    resourceTable: treeResources,
    resourceName: 'database_connection',
    resourcePlural: 'database_connections',
    auditResourceType: 'database_connection_folder',
    eventName: 'database.folder.changed',
  });
}

describe('FolderedResourceService tree consistency', () => {
  // Regression (rc10 audit F2): "A under B" and "B under A" both passed the
  // descendant check before either committed, leaving a parent cycle.
  it('lets only one of two crossing moves commit, so no parent cycle forms', async () => {
    const { db, folders, locks } = createTreeDb([
      { id: 'a', name: 'A', parentId: null, depth: 0, sortOrder: 0 },
      { id: 'b', name: 'B', parentId: null, depth: 0, sortOrder: 1 },
    ]);
    const service = treeService(db);

    const results = await Promise.allSettled([
      service.moveFolder('a', { parentId: 'b' }, 'user-1'),
      service.moveFolder('b', { parentId: 'a' }, 'user-1'),
    ]);

    expect(results[0]).toMatchObject({ status: 'fulfilled' });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'CIRCULAR_REFERENCE' } });
    expect(folders.get('a')).toMatchObject({ parentId: 'b', depth: 1 });
    expect(folders.get('b')).toMatchObject({ parentId: null, depth: 0 });
    expect(locks.acquired).toEqual([
      'resource-folders:database_connection_folder',
      'resource-folders:database_connection_folder',
    ]);
  });

  it('refuses to move a folder under itself', async () => {
    const { db } = createTreeDb([{ id: 'a', name: 'A', parentId: null, depth: 0, sortOrder: 0 }]);

    await expect(treeService(db).moveFolder('a', { parentId: 'a' }, 'user-1')).rejects.toMatchObject({
      code: 'CIRCULAR_REFERENCE',
    });
  });

  it('still deletes a folder whose stored tree already contains a cycle', async () => {
    const { db, folders } = createTreeDb([
      { id: 'a', name: 'A', parentId: 'b', depth: 1, sortOrder: 0 },
      { id: 'b', name: 'B', parentId: 'a', depth: 1, sortOrder: 0 },
    ]);

    await treeService(db).deleteFolder('a', 'user-1');

    expect(folders.has('a')).toBe(false);
  });
});
