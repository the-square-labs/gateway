import { describe, expect, it, vi } from 'vitest';
import {
  hostingNodeBindings,
  hostingOperations,
  hostingResources,
  integrationConnectors,
  nodes,
  permissionGroups,
  users,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { HostingProviderError } from './hosting-http.js';
import {
  HostingManagementService,
  hostingActionFinished,
  hostingRecoveryScript,
  proxmoxResizeFinished,
} from './hosting-management.service.js';
import type { HostingOperationRow } from './hosting-operations.service.js';
import { type HostingResourceSnapshot, hostingCapabilities } from './hosting-provider.types.js';
import { isHostedNodeReady } from './hosting-readiness.js';

const vm: HostingResourceSnapshot = {
  remoteId: '1',
  kind: 'vm',
  name: 'vm',
  location: 'lab',
  powerState: 'running',
  cpu: 2,
  memoryMb: 2048,
  diskGb: 32,
  addresses: [],
  incarnation: 'created-1',
  observedAt: new Date().toISOString(),
  capabilities: hostingCapabilities({}),
};
describe('hosting management semantics', () => {
  it('reconciles exact Proxmox dimensions without a size ID or saved success receipt', () => {
    const target = { action: 'resize', cpu: 2, memoryMb: 2048, diskGb: 32 } as const;
    expect(proxmoxResizeFinished(vm, target as never)).toBe(true);
    expect(proxmoxResizeFinished({ ...vm, diskGb: 16 }, target as never)).toBe(false);
    expect(proxmoxResizeFinished({ ...vm, memoryMb: null }, target as never)).toBe(false);
    expect(proxmoxResizeFinished(vm, { action: 'resize' } as never)).toBe(false);
  });
  it('rejects shrinking a Proxmox disk at admission, not only in the worker', async () => {
    const service = new HostingManagementService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const validate = (
      service as unknown as { validateResize: (adapter: unknown, resource: unknown, input: unknown) => Promise<void> }
    ).validateResize.bind(service);
    await expect(validate({ provider: 'proxmox' }, vm, { action: 'resize', diskGb: 16 })).rejects.toMatchObject({
      code: 'HOSTING_DISK_SHRINK_UNSUPPORTED',
    });
    await expect(validate({ provider: 'proxmox' }, vm, { action: 'resize', diskGb: 64 })).resolves.toBeUndefined();
  });
  function destroyRunner() {
    let row = {
      id: 'destroy',
      resourceId: 'resource',
      actorId: 'actor',
      action: 'delete',
      phase: 'pending',
      dispatchStartedAt: null,
      request: {
        action: 'delete',
        confirmed: true,
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        expectedIncarnation: vm.incarnation,
      },
      result: { destroyNodeIds: ['node'] },
      providerOperation: null,
      generation: 1,
      leaseOwner: 'worker',
      leaseExpiresAt: new Date(Date.now() + 60000),
    } as unknown as HostingOperationRow;
    const bound = [{ nodeId: 'node', type: 'docker', resourceId: 'resource', hostIdentityId: 'host' }];
    const adapter = {
      test: vi.fn(async () => ({ authority: 'account' })),
      listResources: vi.fn(async () => ({ complete: true, resources: [] as HostingResourceSnapshot[] })),
      getResource: vi
        .fn<() => Promise<HostingResourceSnapshot | null>>()
        .mockResolvedValue({ ...vm, capabilities: hostingCapabilities({ shutdown: true }) }),
      action: vi.fn(async (_vm, input) => ({ id: input.action, resourceId: '1', status: 'running' as const })),
      operation: vi.fn(async (id: string) => ({ id, status: 'succeeded' as const })),
    };
    const operations = {
      due: async () => (['ready', 'failed'].includes(row.phase) ? [] : [row]),
      claim: async () => row,
      renew: async () => {},
      release: async () => {},
      update: vi.fn(async (_row, patch) => (row = { ...row, ...patch })),
      dispatch: vi.fn(async (_row, phase) => (row = { ...row, phase, dispatchStartedAt: new Date() })),
      finish: vi.fn(
        async (_row, phase, result, error) => (row = { ...row, phase, result, errorMessage: error?.message })
      ),
    };
    const actor = {
      id: 'actor',
      scopes: ['integrations:hosting:view', 'hosting:resources:delete', 'nodes:details', 'nodes:delete'],
    };
    const connector = {
      id: 'connector',
      provider: 'proxmox',
      enabled: true,
      updatedAt: new Date(),
      settings: { authority: 'account' },
    };
    const resource = {
      id: 'resource',
      connectorId: 'connector',
      remoteId: '1',
      incarnation: vm.incarnation,
      snapshot: vm,
      kind: 'vm',
      authority: 'account',
      managedHostIdentity: 'host',
      observedAt: new Date(),
    };
    const tx = {
      execute: vi.fn(async () => {}),
      select: () => ({
        from: (table: unknown) => {
          const data =
            table === hostingResources
              ? [resource]
              : table === integrationConnectors
                ? [connector]
                : table === hostingOperations
                  ? [row]
                  : table === users
                    ? [{ ...actor, groupId: 'group', additionalScopes: actor.scopes }]
                    : table === permissionGroups
                      ? []
                      : table === nodes
                        ? bound.map((n) => ({ id: n.nodeId, hostIdentityId: 'host' }))
                        : table === hostingNodeBindings
                          ? bound
                          : [];
          return {
            where: () => Object.assign(Promise.resolve(data), { for: async () => data }),
            orderBy: () => ({ for: async () => data }),
          };
        },
      }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    };
    const nodeService = {
      remove: vi.fn(async (_id, _actorId, options) => {
        await options.hostingDelete.guard(tx);
        bound.length = 0;
      }),
    };
    const db = {
      update: () => ({ set: () => ({ where: async () => {} }) }),
      select: () => ({ from: () => ({ where: async () => [{ id: 'node' }] }) }),
      transaction: async (callback: (executor: unknown) => Promise<void>) => callback(tx),
    };
    const service = new HostingManagementService(
      db as never,
      { adapter: () => adapter, settings: () => connector.settings } as never,
      operations as never,
      {
        getUserById: async () => actor,
      } as never,
      { isNodeConnected: () => false },
      {} as never,
      nodeService as never
    );
    const lookup = vi
      .spyOn(service as unknown as { resource: (...args: unknown[]) => Promise<unknown> }, 'resource')
      .mockImplementation(async () => ({
        resource: structuredClone(resource),
        bound: [...bound],
        connector: structuredClone(connector),
      }));
    return { service, adapter, operations, nodeService, bound, resource, actor, connector, tx, lookup, row: () => row };
  }
  it('cleans up an already absent VM before first dispatch, including inventory-marked missing resources', async () => {
    const test = destroyRunner();
    test.adapter.getResource.mockResolvedValue(null);
    await test.service.reconcileDue();
    expect(test.lookup).toHaveBeenCalledWith('resource', test.actor, 'delete', true);
    expect(test.adapter.action).not.toHaveBeenCalled();
    expect(test.operations.dispatch).not.toHaveBeenCalled();
    expect(test.nodeService.remove).toHaveBeenCalledWith(
      'node',
      'actor',
      expect.objectContaining({ hostingDelete: { operationId: 'destroy', guard: expect.any(Function) } })
    );
    expect(test.row()).toMatchObject({ phase: 'ready', result: { deletedIncarnation: vm.incarnation } });
  });
  it.each([
    'running',
    'stopped',
  ] as const)('reconciles external deletion racing with %s VM destruction', async (powerState) => {
    const test = destroyRunner();
    test.adapter.getResource
      .mockResolvedValueOnce({ ...vm, powerState, capabilities: hostingCapabilities({ shutdown: true }) })
      .mockResolvedValue(null);
    test.adapter.action.mockRejectedValue(new HostingProviderError(404, false, 'VM not found'));
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('provisioning');
    expect(test.nodeService.remove).not.toHaveBeenCalled();
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('ready');
    expect(test.nodeService.remove).toHaveBeenCalledWith('node', 'actor', expect.any(Object));
    expect(test.adapter.action).toHaveBeenCalledOnce();
  });
  it('does not treat a route-level 404 as proof of VM absence', async () => {
    const test = destroyRunner();
    test.adapter.getResource.mockResolvedValue({ ...vm, powerState: 'stopped' });
    test.adapter.action.mockRejectedValue(new HostingProviderError(404, false, 'Route not found'));
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('failed');
    expect(test.nodeService.remove).not.toHaveBeenCalled();
  });
  it.each([
    'still_present',
    'incomplete',
    'wrong_account',
    'inventory_404',
  ] as const)('requires complete account inventory when GET falsely reports null: %s', async (scenario) => {
    const test = destroyRunner();
    test.adapter.getResource.mockResolvedValue(null);
    if (scenario === 'still_present') test.adapter.listResources.mockResolvedValue({ complete: true, resources: [vm] });
    if (scenario === 'incomplete') test.adapter.listResources.mockResolvedValue({ complete: false, resources: [] });
    if (scenario === 'wrong_account') test.adapter.test.mockResolvedValue({ authority: 'other-account' });
    if (scenario === 'inventory_404')
      test.adapter.listResources.mockRejectedValue(new HostingProviderError(404, false, 'Route missing'));
    await test.service.reconcileDue();
    expect(test.nodeService.remove).not.toHaveBeenCalled();
    expect(test.row().phase).toBe('failed');
  });
  it.each([
    'incarnation',
    'permissions',
    'connector',
    'lease',
    'binding',
  ] as const)('fences %s changes after the last preflight, inside actual node deletion', async (change) => {
    const test = destroyRunner();
    test.adapter.getResource.mockResolvedValue(null);
    const guardedRemove = test.nodeService.remove.getMockImplementation()!;
    test.nodeService.remove.mockImplementation(async (...args) => {
      if (change === 'incarnation') test.resource.incarnation = 'replacement';
      if (change === 'permissions') test.actor.scopes = [];
      if (change === 'connector') test.connector.updatedAt = new Date(Date.now() + 1000);
      if (change === 'lease') test.row().generation += 1;
      if (change === 'binding') test.bound[0].resourceId = 'other-resource';
      await guardedRemove(...args);
    });
    await test.service.reconcileDue();
    expect(test.bound).toHaveLength(1);
    expect(test.row().phase).not.toBe('ready');
  });
  it('does not mark a replacement incarnation missing after removing the old node', async () => {
    const test = destroyRunner();
    test.adapter.getResource.mockResolvedValue(null);
    const guardedRemove = test.nodeService.remove.getMockImplementation()!;
    test.nodeService.remove.mockImplementation(async (...args) => {
      await guardedRemove(...args);
      test.resource.incarnation = 'replacement';
    });
    const missingWrite = vi.spyOn(test.tx, 'update');
    await test.service.reconcileDue();
    expect(test.bound).toHaveLength(0);
    expect(missingWrite).not.toHaveBeenCalled();
    expect(test.row().phase).not.toBe('ready');
  });
  it('re-verifies absence when sync commits a fresher same-incarnation presence snapshot before cleanup', async () => {
    const test = destroyRunner();
    test.adapter.getResource.mockResolvedValue(null);
    const inventory = test.adapter.listResources.getMockImplementation()!;
    test.adapter.listResources.mockImplementationOnce(async () => {
      const result = await inventory();
      test.resource.observedAt = new Date(test.resource.observedAt.getTime() + 1000);
      return result;
    });
    await test.service.reconcileDue();
    expect(test.bound).toHaveLength(1);
    expect(test.row().phase).toBe('pending');
    expect(test.operations.finish).not.toHaveBeenCalled();
    await test.service.reconcileDue();
    expect(test.adapter.test).toHaveBeenCalledTimes(2);
    expect(test.adapter.listResources).toHaveBeenCalledTimes(2);
    expect(test.row().phase).toBe('ready');
    expect(test.bound).toHaveLength(0);
    expect(test.adapter.action).not.toHaveBeenCalled();
  });
  it('keeps delete fenced when the independent absence check fails', async () => {
    const test = destroyRunner();
    test.adapter.getResource
      .mockResolvedValueOnce({ ...vm, powerState: 'stopped' })
      .mockRejectedValue(new HostingProviderError(502, true, 'Read unavailable'));
    test.adapter.action.mockRejectedValue(new HostingProviderError(404, false, 'VM not found'));
    await test.service.reconcileDue();
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('unknown');
    expect(test.adapter.action).toHaveBeenCalledOnce();
    expect(test.nodeService.remove).not.toHaveBeenCalled();
  });
  it('refuses absent-VM cleanup if the stored incarnation changed', async () => {
    const test = destroyRunner();
    test.resource.incarnation = 'replacement';
    test.adapter.getResource.mockResolvedValue(null);
    await test.service.reconcileDue();
    expect(test.nodeService.remove).not.toHaveBeenCalled();
    expect(test.row().phase).toBe('failed');
  });
  it.each(['identity', 'permissions', 'binding'] as const)('rechecks %s after a slow absence read', async (change) => {
    const test = destroyRunner();
    test.adapter.getResource.mockImplementation(async () => {
      if (change === 'identity') test.resource.incarnation = 'replacement';
      if (change === 'permissions') test.actor.scopes = [];
      if (change === 'binding') test.bound.length = 0;
      return null;
    });
    await test.service.reconcileDue();
    expect(test.nodeService.remove).not.toHaveBeenCalled();
    expect(test.row().phase).toBe('failed');
  });
  it('stops Proxmox, observes completion, destroys once, then removes Gateway nodes only after absence', async () => {
    const test = destroyRunner();
    await test.service.reconcileDue();
    expect(test.adapter.action.mock.calls.map(([, input]) => input.action)).toEqual(['shutdown']);
    await test.service.reconcileDue();
    expect(test.adapter.action).toHaveBeenCalledOnce();
    test.adapter.getResource.mockResolvedValue({ ...vm, powerState: 'stopped' });
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('pending');
    await test.service.reconcileDue();
    expect(test.adapter.action.mock.calls.map(([, input]) => input.action)).toEqual(['shutdown', 'delete']);
    await test.service.reconcileDue();
    expect(test.nodeService.remove).not.toHaveBeenCalled();
    test.adapter.getResource.mockResolvedValue(null);
    await test.service.reconcileDue();
    expect(test.nodeService.remove).toHaveBeenCalledWith('node', 'actor', expect.any(Object));
    expect(test.row().phase).toBe('ready');
  });
  it('does not delete when shutdown fails', async () => {
    const test = destroyRunner();
    await test.service.reconcileDue();
    test.adapter.operation.mockResolvedValue({ id: 'shutdown', status: 'failed' } as never);
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('failed');
    expect(test.adapter.action).toHaveBeenCalledOnce();
    expect(test.nodeService.remove).not.toHaveBeenCalled();
  });
  it('keeps an uncertain delete fenced and preserves the original diagnostic', async () => {
    const test = destroyRunner();
    test.adapter.getResource.mockResolvedValue({ ...vm, powerState: 'stopped' });
    test.adapter.action.mockRejectedValue(new HostingProviderError(502, true, 'Transport lost'));
    await test.service.reconcileDue();
    await test.service.reconcileDue();
    expect(test.row()).toMatchObject({ phase: 'unknown', errorMessage: 'Transport lost' });
    expect(test.adapter.action).toHaveBeenCalledOnce();
    expect(test.nodeService.remove).not.toHaveBeenCalled();
  });
  it('treats a known no-write local rejection as failed, not unknown', async () => {
    const test = destroyRunner();
    test.adapter.getResource.mockResolvedValue({ ...vm, powerState: 'stopped' });
    test.adapter.action.mockRejectedValue(new AppError(409, 'HOSTING_VM_MUST_STOP', 'VM state changed; stop first'));
    await test.service.reconcileDue();
    expect(test.row().phase).toBe('failed');
  });
  it('refuses cleanup if a node was detached during destruction', async () => {
    const test = destroyRunner();
    test.adapter.getResource.mockResolvedValue({ ...vm, powerState: 'stopped' });
    await test.service.reconcileDue();
    test.bound.length = 0;
    test.adapter.getResource.mockResolvedValue(null);
    await test.service.reconcileDue();
    expect(test.nodeService.remove).not.toHaveBeenCalled();
    expect(test.row().errorMessage).toContain('binding changed');
  });
  it('persists the one-shot QGA result while waiting for a fresh health report', async () => {
    let row = {
      id: 'operation',
      resourceId: 'resource',
      actorId: 'actor',
      action: 'recover',
      phase: 'provisioning',
      request: {
        action: 'recover',
        confirmed: true,
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        expectedIncarnation: vm.incarnation,
      },
      dispatchStartedAt: new Date(),
      providerOperation: { id: 'guest:lab:101:123', status: 'running' },
      result: { recoveryHealthBefore: { node: 10 } },
    } as unknown as HostingOperationRow;
    const bound = [
      {
        nodeId: 'node',
        type: 'docker',
        status: 'online',
        capabilities: { dockerRuntimeStatus: { state: 'healthy' } },
        lastHealthReport: { timestamp: 10 },
      },
    ];
    const adapter = {
      getResource: vi.fn(async () => vm),
      operation: vi
        .fn()
        .mockResolvedValueOnce({ id: 'guest:lab:101:123', status: 'succeeded' })
        .mockRejectedValue(new Error('QGA pid already reaped')),
      bootstrap: vi.fn(),
    };
    const operations = {
      due: async () => [row],
      claim: async () => row,
      renew: async () => {},
      release: async () => {},
      update: vi.fn(async (_row, patch) => (row = { ...row, ...patch })),
      finish: vi.fn(async () => {}),
    };
    const db = { update: () => ({ set: () => ({ where: async () => {} }) }) };
    const service = new HostingManagementService(
      db as never,
      { adapter: () => adapter } as never,
      operations as never,
      { getUserById: async () => ({ id: 'actor' }) } as never,
      { isNodeConnected: () => true },
      {} as never,
      { remove: vi.fn() } as never
    );
    vi.spyOn(
      service as unknown as { resource: (...args: unknown[]) => Promise<unknown> },
      'resource'
    ).mockResolvedValue({
      resource: { id: 'resource', remoteId: '101', incarnation: vm.incarnation },
      bound,
      connector: {},
    });
    await service.reconcileDue();
    expect(row.providerOperation?.status).toBe('succeeded');
    expect(operations.finish).not.toHaveBeenCalled();
    bound[0].lastHealthReport.timestamp = 11;
    await service.reconcileDue();
    expect(adapter.operation).toHaveBeenCalledOnce();
    expect(adapter.bootstrap).not.toHaveBeenCalled();
    expect(operations.finish).toHaveBeenCalledWith(row, 'ready', { resourceId: 'resource' });
  });
  it('requires the actual daemon and role runtime, not provider power, for readiness', () => {
    const node = {
      type: 'docker',
      status: 'online',
      capabilities: { dockerRuntimeStatus: { state: 'healthy' } },
      lastHealthReport: null,
    } as Parameters<typeof isHostedNodeReady>[0];
    expect(isHostedNodeReady(node, false)).toBe(false);
    expect(isHostedNodeReady(node, true)).toBe(true);
    expect(isHostedNodeReady({ ...node, capabilities: {} }, true)).toBe(false);
    expect(isHostedNodeReady({ ...node, status: 'offline' }, true)).toBe(false);
    expect(isHostedNodeReady({ ...node, type: 'nginx' }, true)).toBe(false);
  });
  it('does not equate VM running with daemon recovery or a completed reboot', () => {
    expect(hostingActionFinished('start', vm)).toBe(true);
    expect(hostingActionFinished('recover', vm)).toBe(false);
    expect(hostingActionFinished('reboot', vm)).toBe(false);
    expect(hostingActionFinished('delete', vm)).toBe(false);
    expect(hostingActionFinished('delete', null)).toBe(true);
    expect(hostingActionFinished('shutdown', { ...vm, powerState: 'stopped' })).toBe(true);
  });
  it('restarts known daemon services only, never the whole VM or OS', () => {
    const script = hostingRecoveryScript(['docker', 'databases', 'nginx']);
    expect(script).toContain("'docker-daemon' 'nginx-daemon'");
    expect(script).not.toMatch(/^\s*(?:sudo\s+)?reboot\b/m);
    expect(script).not.toContain('curl');
    expect(script).not.toContain('setup-node');
    expect(() => hostingRecoveryScript(['unknown'])).toThrow();
    expect(() => hostingRecoveryScript([])).toThrow();
  });
});
