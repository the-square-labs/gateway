import '@/db/schema/index.js';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { createFakeAdvisoryLockDb } from '@/db/advisory-lock.test-helpers.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';
import { FolderService } from './folder.service.js';

const dialect = new PgDialect();

type Row = { id: string; name: string; parentId: string | null; depth: number; sortOrder: number };

const access = { scopes: ['proxy:edit'], editScope: 'proxy:edit' };

/**
 * In-memory route folder table that answers the service's queries by their shape and yields between statements, so
 * two operations interleave unless the tree lock serializes them.
 */
function createTreeDb(rows: Row[]) {
  const folders = new Map(rows.map((row) => [row.id, { ...row }]));
  let statements = 0;
  const tick = async () => {
    statements += 1;
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
          if (table === proxyHosts) return [];
          const found = matching(condition);
          if (fields && 'maxDepth' in fields) return [{ maxDepth: Math.max(...found.map((row) => row.depth)) }];
          if (fields && 'sortOrder' in fields) return [];
          if (fields) {
            return found.map((row) =>
              Object.fromEntries(Object.keys(fields).map((key) => [key, row[key as keyof Row]]))
            );
          }
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
  });
  const locks = createFakeAdvisoryLockDb(makeTx);
  const db = { ...makeTx(), transaction: locks.transaction };
  return { db, folders, locks };
}

function service(db: unknown) {
  return new FolderService(db as never, { log: vi.fn().mockResolvedValue(undefined) } as never);
}

describe('Ingress route folder moves', () => {
  it('lets only one of two crossing moves commit, so no parent cycle forms', async () => {
    const { db, folders, locks } = createTreeDb([
      { id: 'a', name: 'A', parentId: null, depth: 0, sortOrder: 0 },
      { id: 'b', name: 'B', parentId: null, depth: 0, sortOrder: 1 },
    ]);
    const folderService = service(db);

    const results = await Promise.allSettled([
      folderService.moveFolder('a', { parentId: 'b' }, 'user-1', access),
      folderService.moveFolder('b', { parentId: 'a' }, 'user-1', access),
    ]);

    expect(results[0]).toMatchObject({ status: 'fulfilled' });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'CIRCULAR_REFERENCE' } });
    expect(folders.get('a')).toMatchObject({ parentId: 'b', depth: 1 });
    expect(folders.get('b')).toMatchObject({ parentId: null, depth: 0 });
    expect(locks.acquired).toEqual(['resource-folders:proxy_host_folder', 'resource-folders:proxy_host_folder']);
  });

  it('refuses to move a folder under itself or its own subfolder', async () => {
    const { db } = createTreeDb([
      { id: 'a', name: 'A', parentId: null, depth: 0, sortOrder: 0 },
      { id: 'child', name: 'Child', parentId: 'a', depth: 1, sortOrder: 0 },
    ]);

    await expect(service(db).moveFolder('a', { parentId: 'a' }, 'user-1', access)).rejects.toMatchObject({
      code: 'CIRCULAR_REFERENCE',
    });
    await expect(service(db).moveFolder('a', { parentId: 'child' }, 'user-1', access)).rejects.toMatchObject({
      code: 'CIRCULAR_REFERENCE',
    });
  });

  it('moves a folder with its subfolders and refuses a duplicate name in the destination', async () => {
    const { db, folders } = createTreeDb([
      { id: 'a', name: 'Edge', parentId: null, depth: 0, sortOrder: 0 },
      { id: 'child', name: 'Child', parentId: 'a', depth: 1, sortOrder: 0 },
      { id: 'b', name: 'Team', parentId: null, depth: 0, sortOrder: 1 },
      { id: 'c', name: 'Prod', parentId: null, depth: 0, sortOrder: 2 },
      { id: 'd', name: ' edge ', parentId: 'c', depth: 1, sortOrder: 0 },
    ]);

    await expect(service(db).moveFolder('a', { parentId: 'c' }, 'user-1', access)).rejects.toMatchObject({
      statusCode: 409,
      code: 'FOLDER_NAME_CONFLICT',
    });
    await service(db).moveFolder('a', { parentId: 'b' }, 'user-1', access);
    expect(folders.get('a')).toMatchObject({ parentId: 'b', depth: 1 });
    expect(folders.get('child')).toMatchObject({ parentId: 'a', depth: 2 });
  });

  it('moves a folder only between places a folder-limited manager manages', async () => {
    const { db, folders } = createTreeDb([
      { id: 'team', name: 'Team', parentId: null, depth: 0, sortOrder: 0 },
      { id: 'a', name: 'A', parentId: 'team', depth: 1, sortOrder: 0 },
      { id: 'b', name: 'B', parentId: 'team', depth: 1, sortOrder: 1 },
      { id: 'other', name: 'Other', parentId: null, depth: 0, sortOrder: 1 },
    ]);
    const manage = {
      scopes: ['proxy:folders:manage:folder/team', 'proxy:folders:manage:folder/a', 'proxy:folders:manage:folder/b'],
      manageScope: 'proxy:folders:manage',
    };

    await expect(service(db).moveFolder('a', { parentId: 'other' }, 'user-1', access, manage)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(service(db).moveFolder('team', { parentId: 'b' }, 'user-1', access, manage)).rejects.toMatchObject({
      statusCode: 403,
    });
    await service(db).moveFolder('a', { parentId: 'b' }, 'user-1', access, manage);
    expect(folders.get('a')).toMatchObject({ parentId: 'b', depth: 2 });
  });
});
