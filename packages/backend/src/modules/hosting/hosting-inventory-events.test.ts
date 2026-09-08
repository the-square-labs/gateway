import { expect, it, vi } from 'vitest';
import { HostingInventoryService } from './hosting-inventory.service.js';

it('includes accepted pending nodes with their latest operation phase and applies node scopes', async () => {
  const connector = { id: 'connector', name: 'DO', provider: 'digitalocean' };
  const pending = [
    { operation: { nodeId: 'visible', phase: 'failed', resourceId: null }, connector },
    { operation: { nodeId: 'visible', phase: 'pending', resourceId: null }, connector },
    { operation: { nodeId: 'hidden', phase: 'pending', resourceId: null }, connector },
  ];
  const db = {
    select: vi
      .fn()
      .mockReturnValueOnce({ from: () => ({ innerJoin: () => ({ leftJoin: async () => [] }) }) })
      .mockReturnValueOnce({
        from: () => ({ innerJoin: () => ({ innerJoin: () => ({ where: () => ({ orderBy: async () => pending }) }) }) }),
      })
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ orderBy: async () => [] }) }),
      }),
  };
  const inventory = new HostingInventoryService(db as never, {} as never, {} as never, {} as never, {} as never);
  expect(await inventory.nodeBindings({ scopes: ['nodes:details:visible'] } as never)).toEqual({
    visible: {
      resourceId: null,
      connectorId: 'connector',
      provider: 'digitalocean',
      connectorName: 'DO',
      operationPhase: 'failed',
    },
  });
});

it('projects destruction onto bound nodes without changing daemon status or exposing hidden nodes', async () => {
  const connector = { id: 'connector', name: 'Proxmox', provider: 'proxmox' };
  const resource = { id: 'resource', connectorId: connector.id, provider: connector.provider };
  const rows = ['visible', 'hidden'].map((nodeId) => ({ binding: { nodeId }, resource, connector }));
  const db = {
    select: vi
      .fn()
      .mockReturnValueOnce({ from: () => ({ innerJoin: () => ({ leftJoin: async () => rows }) }) })
      .mockReturnValueOnce({
        from: () => ({ innerJoin: () => ({ innerJoin: () => ({ where: () => ({ orderBy: async () => [] }) }) }) }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ orderBy: async () => [{ resourceId: resource.id, action: 'delete', phase: 'unknown' }] }),
        }),
      }),
  };
  const inventory = new HostingInventoryService(db as never, {} as never, {} as never, {} as never, {} as never);
  expect(await inventory.nodeBindings({ scopes: ['nodes:details:visible'] } as never)).toEqual({
    visible: {
      resourceId: 'resource',
      connectorId: 'connector',
      provider: 'proxmox',
      connectorName: 'Proxmox',
      operationPhase: 'unknown',
      operationAction: 'delete',
    },
  });
});

it('exposes a pending hosting operation before a provider resource or node binding exists', async () => {
  const connector = { id: 'connector', name: 'DO', provider: 'digitalocean' };
  const pending = {
    connector,
    resource: null,
    operation: { action: 'create', phase: 'provisioning', updatedAt: new Date('2026-09-05T12:00:00Z') },
  };
  const db = {
    select: vi
      .fn()
      .mockReturnValueOnce({ from: () => ({ innerJoin: () => ({ leftJoin: () => ({ where: async () => [] }) }) }) })
      .mockReturnValueOnce({
        from: () => ({
          innerJoin: () => ({
            leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [pending] }) }) }),
          }),
        }),
      }),
  };
  const inventory = new HostingInventoryService(db as never, {} as never, {} as never, {} as never, {} as never);
  const projection = await inventory.nodeProjection('visible', { scopes: ['nodes:details:visible'] } as never);
  expect(projection).toMatchObject({
    resourceId: null,
    connectorId: 'connector',
    operation: { action: 'create', phase: 'provisioning' },
    actions: {},
  });
  await expect(inventory.nodeProjection('hidden', { scopes: ['nodes:details:visible'] } as never)).rejects.toThrow();
});

it('runs a trailing adoption pass when a node connects during reconciliation', async () => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((done) => {
    entered = done;
  });
  const hold = new Promise<void>((done) => {
    release = done;
  });
  const row = { id: 'connector' };
  const db = { select: () => ({ from: () => ({ where: async () => [row] }) }) };
  const connectors = { adapter: vi.fn(() => ({})), changed: vi.fn() };
  const inventory = new HostingInventoryService(
    db as never,
    connectors as never,
    {} as never,
    {} as never,
    {} as never
  );
  const adopt = vi
    .spyOn(inventory as unknown as { adopt: () => Promise<void> }, 'adopt')
    .mockImplementationOnce(async () => {
      entered();
      await hold;
    })
    .mockResolvedValue(undefined);
  const first = inventory.reconcileAdoption();
  await ready;
  const second = inventory.reconcileAdoption();
  expect(second).toBe(first);
  release();
  await first;
  expect(adopt).toHaveBeenCalledTimes(2);
  expect(connectors.changed).toHaveBeenCalledTimes(2);
});

it('retains failed provisioning after VM creation but before node binding', async () => {
  const connector = { id: 'connector', name: 'Proxmox', provider: 'proxmox', enabled: true };
  const resource = {
    id: 'vm',
    connectorId: 'connector',
    provider: 'proxmox',
    incarnation: 'original',
    snapshot: {
      remoteId: '1140',
      kind: 'vm',
      powerState: 'stopped',
      incarnation: 'original',
      capabilities: {},
      observedAt: new Date().toISOString(),
    },
  };
  const pending = { connector, resource, operation: { action: 'create', phase: 'failed' } };
  const db = {
    select: vi
      .fn()
      .mockReturnValueOnce({ from: () => ({ innerJoin: () => ({ leftJoin: () => ({ where: async () => [] }) }) }) })
      .mockReturnValueOnce({
        from: () => ({
          innerJoin: () => ({
            leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [pending] }) }) }),
          }),
        }),
      })
      .mockReturnValueOnce({ from: () => ({ where: async () => [] }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }),
  };
  const inventory = new HostingInventoryService(db as never, {} as never, {} as never, {} as never, {} as never);
  const projection = await inventory.nodeProjection('pending', { scopes: ['nodes:details:pending'] } as never);
  expect(projection?.operation).toEqual({ action: 'create', phase: 'failed' });
});
