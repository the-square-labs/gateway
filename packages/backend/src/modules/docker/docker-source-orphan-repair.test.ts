import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { dockerSourceBindings } from '@/db/schema/index.js';
import { DockerSourceService } from './docker-source.service.js';
import {
  type DockerSourceOrphanRepairDeps,
  ORPHAN_CONFIRMATION_MS,
  OrphanedSourceBindingRepair,
} from './docker-source-orphan-repair.js';

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

/** A repair whose clock the test advances; `passes` runs it that many times, `gapMs` apart. */
function repairWith(
  db: never,
  deps: Partial<DockerSourceOrphanRepairDeps> & Pick<DockerSourceOrphanRepairDeps, 'listContainers'>
) {
  let clock = 1_000_000;
  const repair = new OrphanedSourceBindingRepair(db, {
    isNodeOnline: () => true,
    hasActiveTransition: () => false,
    ...deps,
    now: () => clock,
  });
  return {
    repair,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const listing = (...names: string[]) => ({
  success: true,
  detail: JSON.stringify(names.map((name) => ({ id: name, name: `/${name}` }))),
});

describe('OrphanedSourceBindingRepair', () => {
  afterEach(() => {
    container.reset();
  });

  it('does not delete on a single absent observation', async () => {
    const { db, deleted } = fakeDb([binding('gone')]);
    const { repair } = repairWith(db, { listContainers: async () => listing('other') });
    expect(await repair.run()).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('deletes after two absent observations at least 5 minutes apart, not sooner', async () => {
    const { db, deleted } = fakeDb([binding('gone')]);
    const { repair, advance } = repairWith(db, { listContainers: async () => listing('other') });
    await repair.run();
    advance(ORPHAN_CONFIRMATION_MS - 1);
    expect(await repair.run()).toBe(0);
    expect(deleted).toEqual([]);
    advance(1);
    expect(await repair.run()).toBe(1);
    expect(deleted).toEqual([dockerSourceBindings]);
  });

  it('resets when the container reappears in between', async () => {
    const { db, deleted } = fakeDb([binding('gone')]);
    let present = false;
    const { repair, advance } = repairWith(db, {
      listContainers: async () => (present ? listing('gone') : listing()),
    });
    await repair.run();
    advance(ORPHAN_CONFIRMATION_MS);
    present = true;
    expect(await repair.run()).toBe(0);
    present = false;
    advance(ORPHAN_CONFIRMATION_MS);
    // First sighting again after the reset: not enough on its own.
    expect(await repair.run()).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('skips a container with an active transition and forgets its earlier sighting', async () => {
    const { db, deleted } = fakeDb([binding('gone')]);
    let busy = false;
    const { repair, advance } = repairWith(db, {
      listContainers: async () => listing(),
      hasActiveTransition: (_node, name) => busy && name === 'gone',
    });
    await repair.run();
    busy = true;
    advance(ORPHAN_CONFIRMATION_MS);
    expect(await repair.run()).toBe(0);
    busy = false;
    advance(ORPHAN_CONFIRMATION_MS);
    expect(await repair.run()).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('forgets the sighting when the node goes offline', async () => {
    const { db, deleted } = fakeDb([binding('gone')]);
    let online = true;
    const { repair, advance } = repairWith(db, { isNodeOnline: () => online, listContainers: async () => listing() });
    await repair.run();
    online = false;
    advance(ORPHAN_CONFIRMATION_MS);
    await repair.run();
    online = true;
    advance(ORPHAN_CONFIRMATION_MS);
    expect(await repair.run()).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('removes through the source service when it is registered', async () => {
    const remove = vi.fn().mockResolvedValue(true);
    container.registerInstance(DockerSourceService, {
      remove,
      listPendingContainers: vi.fn().mockResolvedValue([]),
    } as never);
    const { db, deleted } = fakeDb([binding('gone')]);
    const { repair, advance } = repairWith(db, { listContainers: async () => listing() });
    await repair.run();
    advance(ORPHAN_CONFIRMATION_MS);
    await repair.run();
    expect(remove).toHaveBeenCalledWith({ kind: 'container', nodeId: NODE, containerName: 'gone' }, 'system');
    expect(deleted).toEqual([]);
  });

  it('keeps the binding of an existing container', async () => {
    const { db, deleted } = fakeDb([binding('api')]);
    const { repair, advance } = repairWith(db, { listContainers: async () => listing('api') });
    await repair.run();
    advance(ORPHAN_CONFIRMATION_MS);
    expect(await repair.run()).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('keeps a pending Git source and a Compose rollout target that have no container', async () => {
    container.registerInstance(DockerSourceService, {
      remove: vi.fn(),
      listPendingContainers: vi.fn().mockResolvedValue([{ containerName: 'pending-a' }]),
    } as never);
    const { db, deleted } = fakeDb([
      binding('pending-a'),
      binding('pending-b', { initialConfig: { name: 'pending-b' }, deployedCommitSha: null }),
      binding('rolling', { deployingCommitSha: 'def' }),
    ]);
    const { repair, advance } = repairWith(db, { listContainers: async () => listing() });
    await repair.run();
    advance(ORPHAN_CONFIRMATION_MS);
    expect(await repair.run()).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('removes nothing on an offline node', async () => {
    const { db, deleted } = fakeDb([binding('gone')]);
    const listContainers = vi.fn();
    const { repair, advance } = repairWith(db, { isNodeOnline: () => false, listContainers });
    await repair.run();
    advance(ORPHAN_CONFIRMATION_MS);
    expect(await repair.run()).toBe(0);
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
    const { repair, advance } = repairWith(db, { listContainers });
    await repair.run();
    advance(ORPHAN_CONFIRMATION_MS);
    expect(await repair.run()).toBe(0);
    expect(deleted).toEqual([]);
  });
});
