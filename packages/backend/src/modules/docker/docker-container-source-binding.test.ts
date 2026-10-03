import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { dockerSourceBindings } from '@/db/schema/index.js';
import {
  type DockerContainerMutationContext,
  removeContainer,
  renameContainer,
} from './docker-container-mutation-operations.js';
import { DockerSourceService } from './docker-source.service.js';

type Recorded = { table: unknown; values?: Record<string, unknown> };

function recordingDb() {
  const updates: Recorded[] = [];
  const deletes: Recorded[] = [];
  const db = {
    // The proxy-link guard finds no linked proxy host.
    select: () => {
      const chain: Record<string, unknown> = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: async () => [],
      };
      return chain;
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table, values });
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        deletes.push({ table });
      },
    }),
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run({ update: db.update }),
  };
  return { db, updates, deletes };
}

function baseContext(db: unknown, dispatch: ReturnType<typeof vi.fn>): DockerContainerMutationContext {
  return {
    db,
    auditService: { log: vi.fn().mockResolvedValue(undefined) },
    nodeDispatch: { sendDockerContainerCommand: dispatch },
    validateDockerNode: vi.fn().mockResolvedValue({}),
    assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
    resolveContainerName: vi.fn().mockResolvedValue('api'),
    inspectContainer: vi.fn().mockResolvedValue({ State: { Status: 'exited' } }),
    requireNoTransition: vi.fn(),
    waitWhileTransition: vi.fn().mockResolvedValue(undefined),
    lifecycleWatchTimeoutMs: vi.fn().mockReturnValue(60000),
    claimTransitions: vi.fn().mockReturnValue({}),
    releaseTransitions: vi.fn(),
    acquireTransitionLeases: vi.fn().mockResolvedValue(undefined),
    recheckMigrationGuard: vi.fn().mockResolvedValue(undefined),
    assertNameAvailable: vi.fn().mockResolvedValue(undefined),
    translateNameConflict: vi.fn((err: unknown) => {
      throw err;
    }),
    parseResult: vi.fn(),
    emitContainer: vi.fn(),
  } as unknown as DockerContainerMutationContext;
}

const sourceUpdates = (updates: Recorded[]) => updates.filter((u) => u.table === dockerSourceBindings);

describe('container Git source binding lifecycle', () => {
  afterEach(() => {
    container.reset();
  });

  it('deletes the source binding row when a container is removed without the source service', async () => {
    const { db, deletes } = recordingDb();
    const ctx = baseContext(db, vi.fn().mockResolvedValue({ success: true }));
    await removeContainer(ctx, 'node-1', 'container-1', false, 'user-1');
    expect(deletes.some((d) => d.table === dockerSourceBindings)).toBe(true);
    expect(ctx.emitContainer).toHaveBeenCalledWith('node-1', 'api', 'container-1', 'removed', {});
  });

  it('detaches through the source service when registered, and survives its failure', async () => {
    const { db, deletes, updates } = recordingDb();
    const remove = vi.fn().mockRejectedValue(new Error('provider unreachable'));
    container.registerInstance(DockerSourceService, { remove } as never);
    const ctx = baseContext(db, vi.fn().mockResolvedValue({ success: true }));
    await removeContainer(ctx, 'node-1', 'container-1', false, 'user-1');
    expect(remove).toHaveBeenCalledWith({ kind: 'container', nodeId: 'node-1', containerName: 'api' }, 'user-1');
    expect(deletes.some((d) => d.table === dockerSourceBindings)).toBe(false);
    // The kept binding can no longer rebuild the removed container.
    expect(sourceUpdates(updates)[0]?.values).toMatchObject({ autoBuild: false, autoDeploy: false });
    expect(ctx.emitContainer).toHaveBeenCalled();
  });

  it('deletes the source binding row when the source service is the host stub', async () => {
    const { db, deletes } = recordingDb();
    const remove = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'COMMERCIAL_MODULE_UNAVAILABLE' }));
    container.registerInstance(DockerSourceService, { remove } as never);
    const ctx = baseContext(db, vi.fn().mockResolvedValue({ success: true }));
    await removeContainer(ctx, 'node-1', 'container-1', false, 'user-1');
    expect(deletes.some((d) => d.table === dockerSourceBindings)).toBe(true);
  });

  it('keeps the source binding when the Docker removal itself fails', async () => {
    const { db, deletes } = recordingDb();
    const remove = vi.fn();
    container.registerInstance(DockerSourceService, { remove } as never);
    const ctx = baseContext(db, vi.fn().mockResolvedValue({ success: false, error: 'rejected' }));
    (ctx.parseResult as ReturnType<typeof vi.fn>).mockImplementation((r: { success: boolean }) => {
      if (!r.success) throw new Error('rejected');
    });
    await expect(removeContainer(ctx, 'node-1', 'container-1', false, 'user-1')).rejects.toThrow('rejected');
    expect(remove).not.toHaveBeenCalled();
    expect(deletes.some((d) => d.table === dockerSourceBindings)).toBe(false);
  });

  it('moves the source binding to the new name on rename', async () => {
    const { db, updates } = recordingDb();
    const ctx = baseContext(db, vi.fn().mockResolvedValue({ success: true }));
    await renameContainer(ctx, 'node-1', 'container-1', 'api-2', 'user-1');
    const moved = sourceUpdates(updates);
    expect(moved).toHaveLength(1);
    expect(moved[0].values).toMatchObject({ containerName: 'api-2' });
  });

  it('moves the Git source with the access identity before any other record, and rolls back by runtime ID', async () => {
    const { db, updates } = recordingDb();
    const runtimeId = 'f'.repeat(64);
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const ctx = baseContext(db, dispatch);
    (ctx.inspectContainer as ReturnType<typeof vi.fn>).mockResolvedValue({
      Id: runtimeId,
      State: { Status: 'exited' },
    });
    const renameEnvironment = vi.fn().mockResolvedValue(undefined);
    (ctx as { environmentService?: unknown }).environmentService = {
      deleteImported: vi.fn().mockResolvedValue(undefined),
      rename: renameEnvironment,
    };
    // The access identity moves the Git source binding in its own transaction and checks the source there: a
    // source binding already moved to the new name would make it refuse the rename as "reserved by another source".
    const renameIdentity = vi.fn(async () => {
      if (sourceUpdates(updates).length > 0) throw new Error('This name is reserved by another build source');
      throw new Error('A build started meanwhile');
    });
    (ctx as { accessResourceService?: unknown }).accessResourceService = {
      assertContainerRenameAllowed: vi.fn().mockResolvedValue(undefined),
      removeContainer: vi.fn().mockResolvedValue(null),
      renameContainer: renameIdentity,
    };

    // The request names the container by its old name, which no longer exists after the daemon renamed it.
    await expect(renameContainer(ctx, 'node-1', 'api', 'api-2', 'user-1')).rejects.toThrow('A build started meanwhile');

    expect(renameIdentity).toHaveBeenCalledWith('node-1', 'api', 'api-2');
    expect(sourceUpdates(updates)).toEqual([]);
    expect(renameEnvironment).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith('node-1', 'rename', { containerId: runtimeId, newName: 'api-2' });
    expect(dispatch).toHaveBeenLastCalledWith('node-1', 'rename', { containerId: runtimeId, newName: 'api' });
  });

  it('refuses a rename the Git source does not allow before the daemon renames anything', async () => {
    const { db } = recordingDb();
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const ctx = baseContext(db, dispatch);
    (ctx as { accessResourceService?: unknown }).accessResourceService = {
      assertContainerRenameAllowed: vi.fn().mockRejectedValue(new Error('Wait for the current build to finish')),
      removeContainer: vi.fn(),
      renameContainer: vi.fn(),
    };

    await expect(renameContainer(ctx, 'node-1', 'api', 'api-2', 'user-1')).rejects.toThrow('current build');

    expect(dispatch).not.toHaveBeenCalledWith('node-1', 'rename', expect.anything());
  });
});
