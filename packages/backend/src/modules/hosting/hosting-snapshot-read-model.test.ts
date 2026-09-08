import { describe, expect, it, vi } from 'vitest';
import { hostingNodeBindings, hostingOperations, hostingResources, nodes } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { ResourceSnapshotStore } from '@/services/resource-snapshot.store.js';
import { HOSTING_VM_SNAPSHOT_READ_MODEL } from './hosting-snapshot-read-model.js';
import { HostingSnapshotsService } from './hosting-snapshots.service.js';

function fixture() {
  const entries = new Map<string, unknown>();
  const store = new ResourceSnapshotStore({
    get: async (key: string) => entries.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      entries.set(key, value);
    },
    getClient: () => ({
      set: async () => {
        throw Error('offline Redis lease transport');
      },
      del: async (...keys: string[]) => {
        keys.forEach((key) => {
          entries.delete(key);
        });
      },
    }),
  } as never);
  const now = new Date();
  const live = { remoteId: '42', incarnation: 'i', powerState: 'stopped', observedAt: now.toISOString() };
  const resource = {
    id: 'vm',
    connectorId: 'account',
    remoteId: '42',
    origin: 'created',
    incarnation: 'i',
    managedHostIdentity: 'host',
    snapshot: live,
    observedAt: now,
    missingSince: null,
  };
  const connector = { id: 'account', provider: 'digitalocean', updatedAt: now, enabled: true };
  const snapshot = {
    id: 'snap',
    name: 'Snapshot',
    fingerprint: 'a'.repeat(64),
    ready: true,
    createdAt: now.toISOString(),
    sizeGb: 1,
    minDiskGb: 1,
    monthlyCost: { amount: '1', currency: 'USD', estimated: true, tax: 'net' },
  };
  const provider = { list: vi.fn(async () => [snapshot]) };
  const adapter = { snapshots: () => provider, getResource: vi.fn(async () => live) };
  const user = {
    id: 'owner',
    scopes: [
      'hosting:resources:view',
      'hosting:snapshots:create',
      'hosting:snapshots:delete',
      'hosting:snapshots:restore',
      'nodes:details',
      'nodes:config:edit',
    ],
  };
  const connectors = {
    get: vi.fn(async () => connector),
    owner: vi.fn(async () => user),
    settings: () => ({ resourceIds: [] }),
    adapter: () => adapter,
    changed: vi.fn(),
  };
  const operationRows: unknown[] = [];
  const operations = {
    get: vi.fn(async (_id: string, _user: unknown): Promise<any> => {
      throw new AppError(403, 'HOSTING_ACCESS_DENIED', 'Forbidden');
    }),
  };
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === hostingResources
            ? [resource]
            : table === hostingNodeBindings
              ? [{ nodeId: 'node', hostIdentityId: 'host' }]
              : table === nodes
                ? [{ id: 'node', status: 'online', hostIdentityId: 'host' }]
                : table === hostingOperations
                  ? operationRows
                  : [];
        return Object.assign(Promise.resolve(rows), {
          where: () => Object.assign(Promise.resolve(rows), { orderBy: () => ({ limit: async () => rows }) }),
        });
      },
    }),
  };
  const service = new HostingSnapshotsService(
    db as never,
    connectors as never,
    operations as never,
    {} as never,
    {} as never,
    store
  );
  let persisted: any[] = [];
  vi.spyOn(service.entities, 'list').mockImplementation(async (_id, incarnation) =>
    incarnation === resource.incarnation ? persisted : []
  );
  vi.spyOn(service.entities, 'mergeInventory').mockImplementation(async (_id, _incarnation, items) => {
    persisted = items.map((s) => ({ ...s, entityId: s.id, status: 'ready', revision: new Date().toISOString() }));
    return persisted;
  });
  return {
    service,
    resource,
    connector,
    provider,
    adapter,
    user,
    connectors,
    store,
    entries,
    operationRows,
    operations,
  };
}
describe('hosting snapshot read model', () => {
  it('retains visible rows during refresh and removes them only after a successful new inventory', async () => {
    const f = fixture();
    await f.service.readModel.refresh('vm');
    let resolve!: (value: never[]) => void;
    f.provider.list.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const refresh = f.service.readModel.refresh('vm');
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    const updating = await f.service.view('vm', f.user as never);
    expect(updating.snapshots).toHaveLength(1);
    expect(updating.readModel.refreshStatus).toBe('refreshing');
    expect(updating.canDelete).toBe(true); // Permission, not a cache freshness/operation lock.
    resolve([]);
    await refresh;
    expect((await f.service.view('vm', f.user as never)).snapshots).toEqual([]);
  });
  it('rereads after an in-flight pre-completion refresh rather than reusing its stale result', async () => {
    const f = fixture();
    let resolve!: (value: never[]) => void;
    f.provider.list.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const earlier = f.service.readModel.refresh('vm');
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    const completion = f.service.readModel.refreshAfterOperation('vm');
    resolve([]);
    await Promise.all([earlier, completion]);
    expect(f.provider.list).toHaveBeenCalledTimes(2);
    expect((await f.service.view('vm', f.user as never)).snapshots).toHaveLength(1);
  });
  it('permits running Proxmox restore only with snapshot and node mutation access', async () => {
    const f = fixture();
    f.connector.provider = 'proxmox';
    f.resource.snapshot.powerState = 'running';
    await f.service.readModel.refresh('vm');
    expect((await f.service.view('vm', f.user as never)).canRestore).toBe(true);
    const noRestore = { ...f.user, scopes: f.user.scopes.filter((s) => s !== 'hosting:snapshots:restore') };
    expect((await f.service.view('vm', noRestore as never)).canRestore).toBe(false);
    const noNodeEdit = { ...f.user, scopes: f.user.scopes.filter((s) => s !== 'nodes:config:edit') };
    expect((await f.service.view('vm', noNodeEdit as never)).canRestore).toBe(false);
    f.resource.snapshot.powerState = 'unknown';
    expect((await f.service.view('vm', f.user as never)).canRestore).toBe(false);
  });
  it('rejects snapshot and folder reads when only VM inventory access is granted', async () => {
    const f = fixture();
    const viewer = { ...f.user, scopes: ['hosting:resources:view', 'nodes:details'] };
    await expect(f.service.view('vm', viewer as never)).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.service.folders('vm', viewer as never)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.provider.list).not.toHaveBeenCalled();
  });
  it('allows a snapshot viewer to read but not mutate, and never requires shutdown for creation', async () => {
    const f = fixture();
    f.resource.snapshot.powerState = 'running';
    await f.service.readModel.refresh('vm');
    const viewer = { ...f.user, scopes: ['hosting:resources:view', 'hosting:snapshots:view', 'nodes:details'] };
    const readOnly = await f.service.view('vm', viewer as never);
    expect(readOnly.snapshots).toHaveLength(1);
    expect(readOnly).toMatchObject({ canCreate: false, canDelete: false, canRestore: false, canManageFolders: false });
    expect(await f.service.view('vm', f.user as never)).toMatchObject({ canCreate: true, canRestore: false });
  });
  it('keeps an unauthorized operation private while preserving the VM busy lock', async () => {
    const f = fixture();
    await f.service.readModel.refresh('vm');
    f.operationRows.push({
      id: 'foreign',
      phase: 'pending',
      action: 'resize',
      actorId: 'other',
      errorMessage: 'private',
      result: { secret: 'hidden' },
    });
    const view = await f.service.view('vm', f.user as never);
    expect(f.operations.get).toHaveBeenCalledWith('foreign', f.user);
    expect(view.operation).toBeNull();
    expect(view.busy).toBe(true);
    expect(view.canCreate).toBe(true); // busy is the independent interaction lock.
    expect(JSON.stringify(view)).not.toContain('private');
    expect(JSON.stringify(view)).not.toContain('hidden');
    f.operations.get.mockResolvedValueOnce({ id: 'foreign', phase: 'pending', action: 'resize' });
    expect((await f.service.view('vm', f.user as never)).operation).toMatchObject({ id: 'foreign' });
  });
  it('keeps cold GET cache-only, then serves a background refresh with billing redaction', async () => {
    const f = fixture();
    const cold = await f.service.view('vm', f.user as never);
    expect(cold.readModel.refreshStatus).toBe('never');
    expect(cold.canCreate).toBe(true); // Admission persists pending; worker validates live state.
    expect(f.adapter.getResource).not.toHaveBeenCalled();
    expect(f.provider.list).not.toHaveBeenCalled();
    await f.service.readModel.refresh('vm');
    const warm = await f.service.view('vm', f.user as never);
    expect(warm.canCreate).toBe(true);
    expect(warm.canRestore).toBe(true);
    expect(warm.snapshots).toHaveLength(1);
    expect(warm.snapshots[0]).not.toHaveProperty('monthlyCost');
    expect(f.provider.list).toHaveBeenCalledTimes(1);
    const billing = await f.service.view('vm', {
      ...f.user,
      scopes: [...f.user.scopes, 'hosting:billing:view'],
    } as never);
    expect(billing.snapshots[0].monthlyCost?.amount).toBe('1');
  });
  it('retains persisted snapshots and permissions on refresh failure', async () => {
    const f = fixture();
    await f.service.readModel.refresh('vm');
    f.provider.list.mockRejectedValueOnce(Error('secret provider response'));
    await f.service.readModel.refresh('vm');
    const view = await f.service.view('vm', f.user as never);
    expect(view.snapshots).toHaveLength(1);
    expect(view.canDelete).toBe(true);
    expect(view.readModel.lastError).toBe('Snapshot refresh failed');
  });
  it('discards changed configuration and never replaces it with a late provider response', async () => {
    const f = fixture();
    f.provider.list.mockImplementationOnce(async () => {
      f.connector.updatedAt = new Date(0);
      return [];
    });
    await f.service.readModel.refresh('vm');
    const view = await f.service.view('vm', f.user as never);
    expect(view.canCreate).toBe(true);
    expect(view.snapshots).toEqual([]);
  });
  it('coalesces refreshes and skips recently refreshed resources on the next scheduler pass', async () => {
    const f = fixture();
    await Promise.all([f.service.readModel.refresh('vm'), f.service.readModel.refresh('vm')]);
    await f.service.readModel.refreshDue();
    expect(f.provider.list).toHaveBeenCalledTimes(1);
  });
  it('cleans detached or disabled resources without provider I/O', async () => {
    const f = fixture();
    await f.service.readModel.refresh('vm');
    f.connector.enabled = false;
    await f.service.readModel.refreshDue();
    expect(await f.store.get(HOSTING_VM_SNAPSHOT_READ_MODEL, 'vm')).toBeNull();
    expect(f.provider.list).toHaveBeenCalledTimes(1);
  });
  it('keeps persisted entities and permissions independent of cache freshness', async () => {
    const f = fixture();
    await f.service.readModel.refresh('vm');
    const cached = await f.store.get(HOSTING_VM_SNAPSHOT_READ_MODEL, 'vm');
    f.entries.set('gateway:read-model:v1:hosting-vm-snapshots:vm', {
      ...cached,
      observedAt: new Date(0).toISOString(),
    });
    const view = await f.service.view('vm', f.user as never);
    expect(view.canRestore).toBe(true);
    expect(view.readModel.availability).toBe('unknown');
  });
});
