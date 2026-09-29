import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { dockerSourceBindings } from '@/db/schema/index.js';
import { DockerSourceService } from './docker-source.service.js';
import { repairOrphanedContainerSourceBindings } from './docker-source-orphan-repair.js';

const NODE = 'node-1';

type Row = {
  id: string;
  nodeId: string;
  containerName: string;
  initialConfig: Record<string, unknown> | null;
  deployedCommitSha: string | null;
  deployingCommitSha: string | null;
};

function binding(containerName: string, patch: Partial<Row> = {}): Row {
  return {
    id: `binding-${containerName}`,
    nodeId: NODE,
    containerName,
    initialConfig: null,
    deployedCommitSha: 'abc',
    deployingCommitSha: null,
    ...patch,
  };
}

function fakeDb(rows: Row[]) {
  const deleted: unknown[] = [];
  const db = {
    select: () => ({ from: () => ({ where: async () => rows }) }),
    delete: (table: unknown) => ({
      where: async () => {
        deleted.push(table);
      },
    }),
  };
  return { db: db as never, deleted };
}

const listing = (...names: string[]) => ({
  success: true,
  detail: JSON.stringify(names.map((name) => ({ id: name, name: `/${name}` }))),
});

describe('repairOrphanedContainerSourceBindings', () => {
  afterEach(() => {
    container.reset();
  });

  it('removes the binding of a container that is absent on an online node', async () => {
    const { db, deleted } = fakeDb([binding('gone')]);
    const removed = await repairOrphanedContainerSourceBindings(db, {
      isNodeOnline: () => true,
      listContainers: async () => listing('other'),
    });
    expect(removed).toBe(1);
    expect(deleted).toEqual([dockerSourceBindings]);
  });

  it('removes through the source service when it is registered', async () => {
    const remove = vi.fn().mockResolvedValue(true);
    container.registerInstance(DockerSourceService, {
      remove,
      listPendingContainers: vi.fn().mockResolvedValue([]),
    } as never);
    const { db, deleted } = fakeDb([binding('gone')]);
    await repairOrphanedContainerSourceBindings(db, {
      isNodeOnline: () => true,
      listContainers: async () => listing(),
    });
    expect(remove).toHaveBeenCalledWith({ kind: 'container', nodeId: NODE, containerName: 'gone' }, 'system');
    expect(deleted).toEqual([]);
  });

  it('keeps the binding of an existing container', async () => {
    const { db, deleted } = fakeDb([binding('api')]);
    const removed = await repairOrphanedContainerSourceBindings(db, {
      isNodeOnline: () => true,
      listContainers: async () => listing('api'),
    });
    expect(removed).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('keeps a pending Git source that has no container yet', async () => {
    container.registerInstance(DockerSourceService, {
      remove: vi.fn(),
      listPendingContainers: vi.fn().mockResolvedValue([{ containerName: 'pending-a' }]),
    } as never);
    const { db, deleted } = fakeDb([
      binding('pending-a'),
      binding('pending-b', { initialConfig: { name: 'pending-b' }, deployedCommitSha: null }),
      binding('rolling', { deployingCommitSha: 'def' }),
    ]);
    const removed = await repairOrphanedContainerSourceBindings(db, {
      isNodeOnline: () => true,
      listContainers: async () => listing(),
    });
    expect(removed).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('removes nothing on an offline node', async () => {
    const { db, deleted } = fakeDb([binding('gone')]);
    const listContainers = vi.fn();
    const removed = await repairOrphanedContainerSourceBindings(db, { isNodeOnline: () => false, listContainers });
    expect(removed).toBe(0);
    expect(listContainers).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it.each([
    ['a failed list', async () => ({ success: false })],
    ['an unparsable list', async () => ({ success: true, detail: 'not json' })],
    ['a non-array list', async () => ({ success: true, detail: '{}' })],
    ['a missing list', async () => ({ success: true })],
    [
      'a thrown list',
      async () => {
        throw new Error('timeout');
      },
    ],
  ])('removes nothing when the inventory is unknown (%s)', async (_label, listContainers) => {
    const { db, deleted } = fakeDb([binding('gone')]);
    const removed = await repairOrphanedContainerSourceBindings(db, { isNodeOnline: () => true, listContainers });
    expect(removed).toBe(0);
    expect(deleted).toEqual([]);
  });
});
