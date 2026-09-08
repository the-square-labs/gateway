import { describe, expect, it, vi } from 'vitest';
import { hostingNodeBindings, hostingResources, nodes } from '@/db/schema/index.js';
import { HostingProviderError } from './hosting-http.js';
import type { HostingResourceSnapshot } from './hosting-provider.types.js';
import { HostingSnapshotEntities } from './hosting-snapshot-entities.js';
import {
  assertSnapshotSelection,
  HostingSnapshotInputSchema,
  HostingSnapshotsService,
} from './hosting-snapshots.service.js';

const snap = {
  id: '100',
  name: 'before',
  createdAt: '2026-09-07',
  fingerprint: 'a'.repeat(64),
  sizeGb: 2,
  minDiskGb: 20,
  ready: true,
};
const live = { remoteId: '42', incarnation: 'original', powerState: 'stopped', diskGb: 40 } as HostingResourceSnapshot;
const input = {
  action: 'snapshot_restore' as const,
  idempotencyKey: '11111111-1111-4111-8111-111111111111',
  expectedIncarnation: 'original',
  snapshotId: '100',
  snapshotFingerprint: snap.fingerprint,
  confirmed: true as const,
};
describe('snapshot admission', () => {
  it('validates the RAM option for Proxmox running VMs only', () => {
    const create = { ...input, action: 'snapshot_create' as const, name: 'With memory', includeRam: true };
    expect(HostingSnapshotInputSchema.safeParse(create).success).toBe(true);
    expect(HostingSnapshotInputSchema.safeParse({ ...create, includeRam: 'true' }).success).toBe(false);
    expect(HostingSnapshotInputSchema.safeParse({ ...input, includeRam: true }).success).toBe(false);
    const running = { ...live, kind: 'vm' as const, powerState: 'running' as const };
    expect(assertSnapshotSelection(create, [], running, 'proxmox')).toBeUndefined();
    for (const provider of ['hetzner', 'digitalocean', 'hostkey'] as const)
      expect(() => assertSnapshotSelection(create, [], running, provider)).toThrow('only for Proxmox');
    expect(() => assertSnapshotSelection(create, [], { ...running, kind: 'ct' }, 'proxmox')).toThrow(
      'only for Proxmox'
    );
    expect(() => assertSnapshotSelection(create, [], { ...running, powerState: 'stopped' }, 'proxmox')).toThrow(
      'must be running'
    );
    expect(
      assertSnapshotSelection({ ...create, includeRam: false }, [], { ...running, powerState: 'stopped' }, 'proxmox')
    ).toBeUndefined();
  });
  it('allows snapshot creation while the VM is running without requiring a shutdown', () => {
    expect(
      assertSnapshotSelection(
        { ...input, action: 'snapshot_create', name: 'Live snapshot' },
        [],
        {
          ...live,
          powerState: 'running',
        },
        'proxmox'
      )
    ).toBeUndefined();
  });
  it('requires explicit snapshot identity and destructive confirmation', () => {
    expect(HostingSnapshotInputSchema.safeParse(input).success).toBe(true);
    expect(HostingSnapshotInputSchema.safeParse({ ...input, confirmed: false }).success).toBe(false);
    expect(HostingSnapshotInputSchema.safeParse({ ...input, snapshotFingerprint: undefined }).success).toBe(false);
  });
  it('rejects wrong snapshots, changing fingerprints, running VMs and undersized disks', () => {
    expect(assertSnapshotSelection(input, [snap], live, 'hetzner')).toBe(snap);
    expect(() => assertSnapshotSelection(input, [], live, 'hetzner')).toThrow('does not belong');
    expect(() => assertSnapshotSelection(input, [{ ...snap, fingerprint: 'b'.repeat(64) }], live, 'hetzner')).toThrow();
    expect(() => assertSnapshotSelection(input, [snap], { ...live, powerState: 'running' }, 'hetzner')).toThrow(
      'Shut down'
    );
    expect(() => assertSnapshotSelection(input, [snap], { ...live, diskGb: 10 }, 'hetzner')).toThrow('smaller');
  });
  it('allows running Proxmox rollback but rejects unstable power and preserves identity checks', () => {
    expect(assertSnapshotSelection(input, [snap], { ...live, powerState: 'running' }, 'proxmox')).toBe(snap);
    for (const powerState of ['starting', 'stopping', 'unknown'] as const) {
      expect(() => assertSnapshotSelection(input, [snap], { ...live, powerState }, 'proxmox')).toThrow('stable');
    }
    expect(() => assertSnapshotSelection(input, [], { ...live, powerState: 'running' }, 'proxmox')).toThrow(
      'does not belong'
    );
    for (const provider of ['digitalocean', 'hetzner', 'hostkey'] as const) {
      expect(() => assertSnapshotSelection(input, [snap], { ...live, powerState: 'running' }, provider)).toThrow(
        'Shut down'
      );
    }
  });
});
function runner() {
  let row: any = {
    id: 'op',
    action: 'snapshot_restore',
    phase: 'pending',
    resourceId: 'resource',
    actorId: 'actor',
    request: input,
    dispatchStartedAt: null,
    result: { snapshotNodeIds: ['node'], connectorRevision: '2026-09-07T00:00:00.000Z' },
    providerOperation: null,
  };
  const user: any = {
    id: 'actor',
    scopes: ['hosting:resources:view', 'hosting:snapshots:restore', 'nodes:details', 'nodes:config:edit'],
  };
  const resource: any = {
    id: 'resource',
    connectorId: 'connector',
    origin: 'created',
    remoteId: '42',
    authority: 'account',
    incarnation: 'original',
    managedHostIdentity: 'host',
    snapshot: live,
  };
  const connector: any = { id: 'connector', provider: 'hetzner', updatedAt: new Date('2026-09-07'), enabled: true };
  const bindings = [{ nodeId: 'node', hostIdentityId: 'host' }];
  const db: any = {
    select: () => ({
      from: (table: any) => ({
        where: async () =>
          table === hostingResources
            ? [resource]
            : table === hostingNodeBindings
              ? bindings
              : table === nodes
                ? [{ id: 'node', status: 'offline', hostIdentityId: 'host' }]
                : [row],
      }),
    }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
  };
  const operations: any = {
    due: vi.fn(async () => (['ready', 'failed'].includes(row.phase) ? [] : [row])),
    claim: vi.fn(async () => row),
    renew: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    dispatch: vi.fn(async () => (row = { ...row, phase: 'dispatching', dispatchStartedAt: new Date() })),
    update: vi.fn(async (_r: any, p: any) => (row = { ...row, ...p })),
    finish: vi.fn(async (_r: any, phase: any) => (row = { ...row, phase })),
  };
  let before: () => Promise<void> = async () => {};
  const snapshots = {
    list: vi.fn(async () => [snap]),
    create: vi.fn(),
    remove: vi.fn(),
    restore: vi.fn(async () => {
      await before();
      return { id: 'task', status: 'running' };
    }),
  };
  const adapter = {
    snapshots: () => snapshots,
    getResource: vi.fn(async () => {
      await before();
      return live;
    }),
    operation: vi.fn(async () => ({ id: 'task', status: 'succeeded' })),
  };
  const connectors: any = {
    get: vi.fn(async () => connector),
    settings: () => ({ resourceIds: [] }),
    adapter: vi.fn((_c: any, guard: any) => {
      before = guard;
      return adapter;
    }),
    changed: vi.fn(),
  };
  const auth = { getUserById: vi.fn(async () => user) };
  const events = { publish: vi.fn() };
  const service = new HostingSnapshotsService(
    db,
    connectors,
    operations,
    auth as any,
    { log: vi.fn() } as any,
    undefined,
    events as any
  );
  vi.spyOn(service.entities, 'list').mockResolvedValue([
    { ...snap, entityId: 'entity', status: 'ready', providerSnapshotId: snap.id },
  ] as never);
  vi.spyOn(service.entities, 'get').mockResolvedValue({
    ...snap,
    id: 'entity',
    status: 'ready',
    providerSnapshotId: snap.id,
  } as never);
  vi.spyOn(service.entities, 'transition').mockResolvedValue(null);
  return {
    service,
    events,
    adapter,
    snapshots,
    operations,
    auth,
    connector,
    resource,
    bindings,
    user,
    row: () => row,
    setRow: (patch: any) => (row = { ...row, ...patch }),
  };
}
describe('durable snapshot execution', () => {
  it('does not turn an orphaned failed create into ready if cleanup is rejected', async () => {
    const t = runner();
    const transition = vi
      .spyOn(HostingSnapshotEntities.prototype, 'transition')
      .mockImplementation(async (_r, _i, _id, patch) => ({ ...snap, ...patch }) as never);
    t.operations.finish.mockImplementation(async (_row: any, phase: any, _result: any, _error: any, finalize: any) => {
      await finalize({});
      return { ...t.row(), phase };
    });
    const row = {
      ...t.row(),
      resourceId: 'resource',
      result: { snapshotEntityId: 'entity', failedSnapshotDelete: true },
    };
    await (t.service as any).finishWithEntity(row, { ...input, action: 'snapshot_delete' }, 'failed', undefined, {
      code: 'denied',
      message: 'denied',
    });
    expect(transition).toHaveBeenCalledWith(
      'resource',
      'original',
      'entity',
      expect.objectContaining({ status: 'failed' })
    );
    transition.mockRestore();
  });
  it.each([
    0, 1, 2,
  ])('checks orphaned provider evidence before failed create cleanup (%s candidates)', async (count) => {
    const t = runner();
    t.user.scopes.push('hosting:snapshots:delete');
    t.setRow({
      action: 'snapshot_delete',
      request: { ...input, action: 'snapshot_delete', snapshotId: 'unbound' },
      result: {
        ...t.row().result,
        snapshotEntityId: 'entity',
        localFailedDelete: true,
        failedSnapshotDelete: true,
        failedSnapshotName: 'before',
        failedCreateBeforeIds: [],
      },
    });
    t.snapshots.list.mockResolvedValue(Array.from({ length: count }, (_, i) => ({ ...snap, id: String(i) })));
    t.snapshots.remove.mockResolvedValue({ id: 'delete-task', status: 'running' });
    await t.service.reconcileDue();
    expect(t.snapshots.list).toHaveBeenCalledOnce();
    expect(t.snapshots.remove).toHaveBeenCalledTimes(count === 1 ? 1 : 0);
    expect(t.row().phase).toBe(count === 0 ? 'ready' : count === 1 ? 'provisioning' : 'failed');
  });
  it.each([true, false])('reconciles a lost delete receipt only from confirmed absence (%s)', async (absent) => {
    const t = runner();
    t.user.scopes.push('hosting:snapshots:delete');
    t.setRow({
      action: 'snapshot_delete',
      phase: 'unknown',
      dispatchStartedAt: new Date(),
      request: { ...input, action: 'snapshot_delete' },
      result: { ...t.row().result, snapshotEntityId: 'entity' },
      providerOperation: null,
    });
    t.snapshots.list.mockResolvedValue(absent ? [] : [snap]);
    await t.service.reconcileDue();
    expect(t.row().phase).toBe(absent ? 'ready' : 'unknown');
    expect(t.snapshots.list).toHaveBeenCalledOnce();
    expect(t.snapshots.remove).not.toHaveBeenCalled();
  });
  it('allows failed Proxmox snapshot cleanup even with a reserved provider marker', async () => {
    const t = runner();
    t.connector.provider = 'proxmox';
    t.user.scopes.push('hosting:snapshots:delete');
    vi.mocked(t.service.entities.get).mockResolvedValue({
      ...snap,
      id: 'entity',
      status: 'failed',
      providerSnapshotId: snap.id,
    } as never);
    t.operations.findIntent = vi.fn(async () => null);
    t.operations.reserve = vi.fn(async () => ({ created: true, operation: t.row() }));
    await t.service.action(t.resource.id, { ...input, action: 'snapshot_delete' }, t.user as never);
    expect(t.operations.reserve).toHaveBeenCalledOnce();
  });
  it('publishes folder changes through the same VM identity boundary', async () => {
    const t = runner();
    await (t.service as any).publishSnapshot('resource', 'original');
    expect(t.events.publish).toHaveBeenCalledWith(
      'hosting.snapshot.folder.changed',
      expect.objectContaining({
        resourceId: 'resource',
        incarnation: 'original',
        connectorId: 'connector',
        nodeIds: ['node'],
      })
    );
  });
  it('publishes snapshot billing for per-recipient projection without actor-only operation data', async () => {
    const t = runner();
    const priced = {
      ...snap,
      monthlyCost: { amount: '0.16', currency: 'USD' },
      storageRate: { amount: '0.06', currency: 'USD', unit: 'GB-month' },
    };
    await (t.service as any).publishSnapshot('resource', 'original', priced, {
      id: 'op',
      phase: 'ready',
      result: { privateResult: true },
      errorCode: 'PRIVATE',
      errorMessage: 'private',
    });
    expect(t.events.publish).toHaveBeenCalledWith('hosting.snapshot.changed', {
      resourceId: 'resource',
      incarnation: 'original',
      connectorId: 'connector',
      nodeIds: ['node'],
      snapshot: priced,
      operation: { id: 'op', phase: 'ready', result: undefined, errorCode: null, errorMessage: null },
    });
    t.events.publish.mockClear();
    await (t.service as any).publishSnapshot('resource', 'old-incarnation', priced);
    expect(t.events.publish).not.toHaveBeenCalled();
  });
  it('reconciles an applied Proxmox create after the response was lost without replaying it', async () => {
    const t = runner();
    t.connector.provider = 'proxmox';
    t.user.scopes.push('hosting:snapshots:create');
    t.setRow({
      action: 'snapshot_create',
      phase: 'unknown',
      dispatchStartedAt: new Date(),
      request: { ...input, action: 'snapshot_create', name: 'Recovered' },
      result: { ...t.row().result, snapshotEntityId: 'entity', beforeSnapshotIds: [] },
    });
    t.snapshots.list.mockResolvedValue([{ ...snap, id: 'gwop', name: 'Recovered' }]);
    await t.service.reconcileDue();
    expect(t.row().phase).toBe('ready');
    expect(t.snapshots.create).not.toHaveBeenCalled();
    expect(t.operations.finish).toHaveBeenCalledWith(
      expect.anything(),
      'ready',
      expect.anything(),
      undefined,
      expect.any(Function)
    );
  });
  it('keeps the existing inventory when admitting a new operation', async () => {
    const t = runner();
    t.operations.findIntent = vi.fn(async () => null);
    t.operations.reserve = vi.fn(async () => ({ created: true, operation: t.row() }));
    t.adapter.getResource.mockResolvedValue(live);
    const invalidate = vi.spyOn(t.service.readModel, 'invalidate');
    await t.service.action(t.resource.id, input, t.user as never);
    expect(t.operations.reserve).toHaveBeenCalledOnce();
    expect(invalidate).not.toHaveBeenCalled();
  });
  it.each([true, false])('forwards the persisted RAM choice to the provider (includeRam=%s)', async (includeRam) => {
    const t = runner();
    t.connector.provider = 'proxmox';
    t.setRow({
      action: 'snapshot_create',
      request: { ...input, action: 'snapshot_create', name: 'Memory test', includeRam },
    });
    t.user.scopes.push('hosting:snapshots:create');
    const running = { ...live, kind: 'vm' as const, powerState: 'running' as const };
    t.adapter.getResource.mockResolvedValue(running);
    t.snapshots.create.mockResolvedValue({ id: 'task', status: 'running' });
    await t.service.reconcileDue();
    expect(t.snapshots.create).toHaveBeenCalledWith(running, 'Memory test', 'op', { includeRam });
  });
  it('does not silently omit requested RAM if the VM stops during snapshot listing', async () => {
    const t = runner();
    t.connector.provider = 'proxmox';
    t.setRow({
      action: 'snapshot_create',
      request: { ...input, action: 'snapshot_create', name: 'Memory test', includeRam: true },
    });
    t.user.scopes.push('hosting:snapshots:create');
    t.adapter.getResource
      .mockResolvedValueOnce({ ...live, kind: 'vm', powerState: 'running' })
      .mockResolvedValueOnce({ ...live, kind: 'vm' });
    await t.service.reconcileDue();
    expect(t.snapshots.create).not.toHaveBeenCalled();
    expect(t.operations.dispatch).not.toHaveBeenCalled();
    expect(t.row().phase).toBe('failed');
  });
  it('dispatches Proxmox rollback using fresh running state without a separate power operation', async () => {
    const t = runner();
    t.connector.provider = 'proxmox';
    t.adapter.getResource.mockResolvedValueOnce(live).mockResolvedValueOnce({ ...live, powerState: 'running' });
    await t.service.reconcileDue();
    expect(t.snapshots.restore).toHaveBeenCalledWith(expect.objectContaining({ powerState: 'running' }), snap);
    expect(t.row().phase).toBe('provisioning');
  });
  it('rechecks stopped power after a slow snapshot listing', async () => {
    const t = runner();
    t.adapter.getResource.mockResolvedValueOnce(live).mockResolvedValueOnce({ ...live, powerState: 'running' });
    await t.service.reconcileDue();
    expect(t.snapshots.restore).not.toHaveBeenCalled();
    expect(t.operations.dispatch).not.toHaveBeenCalled();
    expect(t.row().phase).toBe('failed');
  });
  it('never releases the VM lock for a foreign completed callback', async () => {
    const t = runner();
    await t.service.reconcileDue();
    t.adapter.operation.mockResolvedValueOnce({ id: 'task', status: 'succeeded', resourceId: 'other' } as never);
    await t.service.reconcileDue();
    expect(t.row().phase).toBe('unknown');
    expect(t.snapshots.restore).toHaveBeenCalledOnce();
  });
  it('finishes a definite provider rejection instead of leaving it pending forever', async () => {
    const t = runner();
    t.snapshots.restore.mockRejectedValue(new HostingProviderError(403, false, 'Permission denied'));
    await t.service.reconcileDue();
    expect(t.row().phase).toBe('failed');
    expect(t.snapshots.restore).toHaveBeenCalledOnce();
  });
  it('persists dispatch once and completes from the provider task', async () => {
    const t = runner();
    const refresh = vi.spyOn(t.service.readModel, 'refreshAfterOperation').mockResolvedValue();
    await t.service.reconcileDue();
    expect(refresh).not.toHaveBeenCalled();
    expect(t.operations.dispatch).toHaveBeenCalledOnce();
    expect(t.snapshots.restore).toHaveBeenCalledOnce();
    await t.service.reconcileDue();
    expect(t.row().phase).toBe('ready');
    expect(refresh).toHaveBeenCalledWith(t.resource.id);
    expect(t.snapshots.restore).toHaveBeenCalledOnce();
  });
  it('does not turn a completed operation into unknown when inventory refresh fails', async () => {
    const t = runner();
    vi.spyOn(t.service.readModel, 'refreshAfterOperation').mockRejectedValue(Error('Redis unavailable'));
    await t.service.reconcileDue();
    await t.service.reconcileDue();
    expect(t.row().phase).toBe('ready');
    expect(t.snapshots.restore).toHaveBeenCalledOnce();
  });
  it('never replays an uncertain restore after a worker interruption', async () => {
    const t = runner();
    t.snapshots.restore.mockRejectedValue(new HostingProviderError(504, true, 'Timeout'));
    await t.service.reconcileDue();
    await t.service.reconcileDue();
    expect(t.row().phase).toBe('unknown');
    expect(t.snapshots.restore).toHaveBeenCalledOnce();
  });
  it.each(['revoked', 'connector', 'binding', 'identity'] as const)('blocks %s before dispatch', async (change) => {
    const t = runner();
    if (change === 'revoked') t.user.scopes = [];
    if (change === 'connector') t.connector.updatedAt = new Date(0);
    if (change === 'binding') t.bindings.push({ nodeId: 'other', hostIdentityId: 'host' });
    if (change === 'identity') t.resource.incarnation = 'replacement';
    await t.service.reconcileDue();
    expect(t.snapshots.restore).not.toHaveBeenCalled();
    expect(t.row().phase).toBe('failed');
  });
  it('does not allow node deletion to erase the all-node check', async () => {
    const t = runner();
    t.bindings.splice(0);
    await t.service.reconcileDue();
    expect(t.snapshots.restore).not.toHaveBeenCalled();
  });
});
