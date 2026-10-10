import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { createFakeAdvisoryLockDb } from '@/db/advisory-lock.test-helpers.js';
import { dockerContainerFolders } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { DockerFolderService } from './docker-folder.service.js';

const dialect = new PgDialect();
const NODE = '11111111-1111-4111-8111-111111111111';

type Row = Record<string, unknown>;

function sqlParams(query: unknown): unknown[] {
  return dialect.sqlToQuery(query as SQL).params;
}

function folder(id: string, name: string, parentId: string | null, depth: number, extra: Row = {}) {
  return {
    id,
    name,
    resourceType: 'container',
    parentId,
    sortOrder: 0,
    depth,
    isSystem: false,
    nodeId: null,
    composeProject: null,
    createdById: 'user-1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...extra,
  };
}

/**
 * Minimal Drizzle stand-in: a select with `.limit()` and no ordering is a lookup by folder id (the id is read
 * from the rendered condition), an ordered one is the next-sort-order probe, anything else returns the whole table.
 */
function createService(folders: Row[], assignments: Row[] = []) {
  const updates: Array<{ values: Row; condition: unknown }> = [];
  const select = vi.fn(() => ({
    from: (table: unknown) => {
      let condition: unknown;
      let ordered = false;
      const query = {
        where: (value: unknown) => {
          condition = value;
          return query;
        },
        orderBy: () => {
          ordered = true;
          return query;
        },
        limit: async () =>
          ordered ? [{ sortOrder: 4 }] : folders.filter((row) => row.id === String(sqlParams(condition)[0])),
        // biome-ignore lint/suspicious/noThenProperty: mimics Drizzle's awaitable query builder
        then: (resolve: (value: Row[]) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve(table === dockerContainerFolders ? folders : assignments).then(resolve, reject),
      };
      return query;
    },
  }));
  const update = vi.fn(() => ({
    set: (values: Row) => ({
      where: (condition: unknown) => {
        updates.push({ values, condition });
        return {
          returning: async () => [{ ...folders.find((row) => row.id === String(sqlParams(condition)[0])), ...values }],
          // biome-ignore lint/suspicious/noThenProperty: mimics Drizzle's awaitable query builder
          then: (resolve: (value: undefined) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(undefined).then(resolve, reject),
        };
      },
    }),
  }));
  const locks = createFakeAdvisoryLockDb(() => ({ select, update }));
  const db = { select, update, transaction: locks.transaction };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const eventBus = { publish: vi.fn() };
  const service = new DockerFolderService(db as never, audit as never);
  service.setEventBus(eventBus as never);
  return { service, updates, update, audit, eventBus, locks };
}

const allow = vi.fn();

describe('DockerFolderService.moveFolder', () => {
  it('refuses to move a folder into itself or its own descendant', async () => {
    const { service, update } = createService([folder('a', 'A', null, 0), folder('b', 'B', 'a', 1)]);

    await expect(service.moveFolder('a', { parentId: 'b' }, 'user-1', allow)).rejects.toMatchObject({
      statusCode: 400,
      code: 'CIRCULAR_REFERENCE',
    });
    await expect(service.moveFolder('a', { parentId: 'a' }, 'user-1', allow)).rejects.toMatchObject({
      code: 'CIRCULAR_REFERENCE',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses to move a protected compose folder', async () => {
    const { service, update } = createService([
      folder('sys', 'stack', null, 0, { isSystem: true, nodeId: NODE, composeProject: 'stack' }),
      folder('x', 'X', null, 0),
    ]);

    await expect(service.moveFolder('sys', { parentId: 'x' }, 'user-1', allow)).rejects.toMatchObject({
      statusCode: 400,
      code: 'SYSTEM_FOLDER_LOCKED',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a protected compose folder as the destination', async () => {
    const { service, update } = createService([
      folder('sys', 'stack', null, 0, { isSystem: true, nodeId: NODE, composeProject: 'stack' }),
      folder('x', 'X', null, 0),
    ]);

    await expect(service.moveFolder('x', { parentId: 'sys' }, 'user-1', allow)).rejects.toMatchObject({
      statusCode: 400,
      code: 'SYSTEM_FOLDER_LOCKED',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 404 when the destination does not exist', async () => {
    const { service, update } = createService([folder('x', 'X', null, 0)]);

    await expect(service.moveFolder('x', { parentId: 'missing' }, 'user-1', allow)).rejects.toMatchObject({
      statusCode: 404,
      code: 'FOLDER_NOT_FOUND',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a destination that already holds a sibling with the same name (case and trim insensitive)', async () => {
    const { service, update } = createService([
      folder('x', 'Web', null, 0),
      folder('p', 'Team', null, 0),
      folder('q', '  web ', 'p', 1),
      folder('r', 'WEB', 'p', 1),
    ]);

    await expect(service.moveFolder('x', { parentId: 'p' }, 'user-1', allow)).rejects.toMatchObject({
      statusCode: 409,
      code: 'FOLDER_NAME_CONFLICT',
    });
    // Moving a nested folder to the root conflicts with a root folder of the same name too.
    await expect(service.moveFolder('q', { parentId: null }, 'user-1', allow)).rejects.toMatchObject({
      statusCode: 409,
      code: 'FOLDER_NAME_CONFLICT',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a move that would exceed the nesting depth, counting the moved subtree', async () => {
    const { service, update } = createService([
      folder('a', 'A', null, 0),
      folder('b', 'B', 'a', 1),
      folder('r', 'R', null, 0),
      folder('q', 'Q', 'r', 1),
    ]);

    await expect(service.moveFolder('a', { parentId: 'q' }, 'user-1', allow)).rejects.toMatchObject({
      statusCode: 400,
      code: 'MAX_DEPTH_EXCEEDED',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('is a no-op when the parent does not change', async () => {
    const { service, update, audit, eventBus } = createService([folder('a', 'A', null, 0)]);

    await expect(service.moveFolder('a', { parentId: null }, 'user-1', allow)).resolves.toMatchObject({ id: 'a' });
    expect(update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('does not move anything when the authorizer refuses', async () => {
    const { service, update, audit } = createService(
      [folder('a', 'A', null, 0), folder('r', 'R', null, 0)],
      [{ nodeId: NODE, resourceKey: 'web' }]
    );
    const refuse = vi.fn().mockRejectedValue(new AppError(403, 'FORBIDDEN', 'Missing required scope'));

    await expect(service.moveFolder('a', { parentId: 'r' }, 'user-1', refuse)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(refuse).toHaveBeenCalledWith({
      resourceType: 'container',
      resources: [{ nodeId: NODE, resourceKey: 'web' }],
      destinationFolderId: 'r',
    });
    expect(update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('moves the folder and shifts the depth of every descendant under the tree lock', async () => {
    const { service, updates, audit, eventBus, locks } = createService(
      [folder('a', 'A', null, 0), folder('b', 'B', 'a', 1), folder('r', 'R', null, 0)],
      [{ nodeId: NODE, resourceKey: 'web' }]
    );
    const authorize = vi.fn();

    const moved = await service.moveFolder('a', { parentId: 'r' }, 'user-1', authorize);

    expect(locks.acquired).toEqual(['docker-folders:container']);
    expect(authorize).toHaveBeenCalledWith({
      resourceType: 'container',
      resources: [{ nodeId: NODE, resourceKey: 'web' }],
      destinationFolderId: 'r',
    });
    expect(moved).toMatchObject({ id: 'a', parentId: 'r', depth: 1, sortOrder: 5 });
    expect(updates).toHaveLength(2);
    expect(updates[0].values).toMatchObject({ parentId: 'r', depth: 1, sortOrder: 5 });
    // The descendant moves one level deeper: depth + 1, for folder b only.
    expect(sqlParams(updates[1].values.depth)).toEqual([1]);
    expect(sqlParams(updates[1].condition)).toEqual(['b']);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: 'docker_folder.move',
        resourceType: 'docker_folder',
        resourceId: 'a',
        details: { oldParentId: null, newParentId: 'r', name: 'A' },
      })
    );
    expect(eventBus.publish).toHaveBeenCalledWith('docker.folder.changed', {
      action: 'folder_updated',
      folderId: 'a',
      nodeIds: [NODE],
    });
  });

  it('moves a nested folder to the root and lifts its descendants', async () => {
    const { service, updates } = createService([
      folder('a', 'A', null, 0),
      folder('b', 'B', 'a', 1),
      folder('c', 'C', 'b', 2),
    ]);

    await service.moveFolder('b', { parentId: null }, 'user-1', allow);

    expect(updates[0].values).toMatchObject({ parentId: null, depth: 0 });
    expect(sqlParams(updates[1].values.depth)).toEqual([-1]);
    expect(sqlParams(updates[1].condition)).toEqual(['c']);
  });
});
