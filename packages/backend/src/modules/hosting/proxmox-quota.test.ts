import { describe, expect, it, vi } from 'vitest';
import { hostingOperations, hostingResources, integrationConnectors } from '@/db/schema/index.js';
import type { HostingProxmoxProfile } from './hosting-provider.types.js';
import { assertProxmoxQuota, reserveProxmoxQuota } from './proxmox-quota.js';

const profile: HostingProxmoxProfile = {
  nodes: ['pve'],
  storage: 'zfs',
  bridge: 'vmbr0',
  network: 'dhcp',
  maxCpu: 8,
  maxMemoryMb: 8192,
  maxDiskGb: 100,
};
const vector = { cpu: 2, memoryMb: 2048, diskGb: 20 };
const resource = { id: 'r1', remoteId: '250', missingSince: null, snapshot: vector };
const create = {
  action: 'create',
  phase: 'pending',
  resourceId: null,
  dispatchStartedAt: null,
  request: { ...vector, vmid: 251 },
};
describe('aggregate Proxmox resource budgets', () => {
  it('reads pending allocations only after the shared transaction lock is acquired', async () => {
    let unlock!: () => void;
    const pending = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const order: string[] = [];
    const requests = [{ ...create }];
    const tx = {
      execute: vi.fn(async () => {
        order.push('lock');
        await pending;
      }),
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table === integrationConnectors)
              return [{ settings: { proxmox: { ...profile, maxCpu: 4 }, proxmoxAllocationAuthority: 'cluster' } }];
            order.push(table === hostingResources ? 'resources' : 'operations');
            return table === hostingResources ? [] : table === hostingOperations ? requests : [];
          },
        }),
      }),
    };
    const admission = reserveProxmoxQuota(tx as never, 'connector', vector);
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['lock']);
    // Another serialized reservation became visible while this transaction waited.
    requests.push({ ...create, request: { ...vector, vmid: 252 } });
    unlock();
    await expect(admission).rejects.toMatchObject({ code: 'HOSTING_RESOURCE_LIMIT' });
    expect(order).toEqual(['lock', 'resources', 'operations']);
  });
  it('includes in-flight creates and rejects every exhausted dimension', () => {
    expect(() => assertProxmoxQuota(profile, [resource], [create], vector)).not.toThrow();
    for (const exhausted of [{ cpu: 5 }, { memoryMb: 5000 }, { diskGb: 70 }])
      expect(() => assertProxmoxQuota(profile, [resource], [create], { ...vector, ...exhausted })).toThrow(/limit/);
  });
  it('does not count a tracked create twice even before the operation records its resourceId', () => {
    expect(() =>
      assertProxmoxQuota(
        { ...profile, maxCpu: 4 },
        [resource],
        [{ ...create, request: { ...vector, vmid: 250 } }],
        vector
      )
    ).not.toThrow();
  });
  it('reserves resize increases but never spends pending decreases', () => {
    const resize = { ...create, action: 'resize', resourceId: 'r1', request: { cpu: 6 } };
    expect(() => assertProxmoxQuota(profile, [resource], [resize], { ...vector, cpu: 3 })).toThrow(/limit/);
    expect(() =>
      assertProxmoxQuota(profile, [resource], [{ ...resize, request: { cpu: 1 } }], { ...vector, cpu: 7 })
    ).toThrow(/limit/);
    expect(() => assertProxmoxQuota(profile, [resource], [], { ...vector, cpu: 8 }, 'r1')).not.toThrow();
  });
  it('keeps uncertain reservations, releases proven undispatched failures and fails closed on unknown inventory', () => {
    expect(() => assertProxmoxQuota({ ...profile, maxCpu: 3 }, [], [{ ...create, phase: 'unknown' }], vector)).toThrow(
      /limit/
    );
    expect(() =>
      assertProxmoxQuota({ ...profile, maxCpu: 3 }, [], [{ ...create, phase: 'failed' }], vector)
    ).not.toThrow();
    expect(() =>
      assertProxmoxQuota(profile, [{ ...resource, snapshot: { ...vector, cpu: null } }], [], vector)
    ).toThrow(/inventory/);
    expect(() =>
      assertProxmoxQuota(
        profile,
        [{ ...resource, snapshot: { ...vector, cpu: null } }],
        [{ ...create, resourceId: 'r1' }],
        vector
      )
    ).not.toThrow();
  });
  it('does not release a missing VM allocation until deletion of its incarnation is confirmed', () => {
    const missing = { ...resource, missingSince: new Date(), incarnation: 'original' };
    const limited = { ...profile, maxCpu: 3 };
    expect(() => assertProxmoxQuota(limited, [missing], [], vector)).toThrow(/limit/);
    const deletion = {
      ...create,
      action: 'delete',
      phase: 'ready',
      resourceId: resource.id,
      result: { providerDeleted: true, deletedIncarnation: 'original' },
    };
    expect(() => assertProxmoxQuota(limited, [missing], [deletion], vector)).not.toThrow();
    expect(() =>
      assertProxmoxQuota(
        limited,
        [missing],
        [{ ...deletion, result: { providerDeleted: true, deletedIncarnation: 'other' } }],
        vector
      )
    ).toThrow(/limit/);
  });
});

it('counts Gateway allocations rather than all discovered Proxmox capacity', () => {
  const managed = { ...resource, origin: 'adopted', snapshot: { ...vector, cpu: 20 } };
  const discovered = { ...resource, id: 'unmanaged', origin: 'discovered', snapshot: { ...vector, cpu: 34 } };
  const budget = { ...profile, maxCpu: 24 };
  expect(() => assertProxmoxQuota(budget, [managed, discovered], [], vector)).not.toThrow();
  expect(() =>
    assertProxmoxQuota(budget, [managed, discovered], [{ ...create, request: { ...vector, cpu: 4 } }], vector)
  ).toThrow(/limit/);
});

it.each([
  'cpu',
  'memoryMb',
  'diskGb',
] as const)('reserves pending install %s from the observed resource allocation exactly once', (dimension) => {
  const limits = { cpu: 'maxCpu', memoryMb: 'maxMemoryMb', diskGb: 'maxDiskGb' } as const;
  const installed = { ...resource, origin: 'discovered', snapshot: { ...vector, [dimension]: 20 } };
  const pending = { ...create, action: 'install', resourceId: installed.id, request: installed.snapshot };
  const budget = { ...profile, [limits[dimension]]: 24 };
  const small = { ...vector, [dimension]: 2 },
    large = { ...vector, [dimension]: 5 };
  expect(() => assertProxmoxQuota(budget, [installed], [pending], small)).not.toThrow();
  expect(() => assertProxmoxQuota(budget, [installed], [pending], large)).toThrow(/limit/);
  expect(() => assertProxmoxQuota(budget, [{ ...installed, origin: 'adopted' }], [pending], small)).not.toThrow();
  expect(() =>
    assertProxmoxQuota(budget, [installed], [{ ...pending, phase: 'failed', dispatchStartedAt: new Date() }], large)
  ).not.toThrow();
});
