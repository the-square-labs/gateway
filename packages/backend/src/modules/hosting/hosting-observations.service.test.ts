import { describe, expect, it, vi } from 'vitest';
import { hostingFirewalls, hostingResources, integrationConnectors } from '@/db/schema/index.js';
import { HostingInventoryService } from './hosting-inventory.service.js';
import { HostingObservationsService } from './hosting-observations.service.js';

function fixture() {
  const now = new Date();
  const account = {
    id: 'account',
    name: 'Account',
    provider: 'digitalocean',
    enabled: true,
    updatedAt: now,
    syncStatus: 'success',
    syncFinishedAt: now,
  };
  const resource = {
    id: 'vm',
    connectorId: 'account',
    remoteId: '42',
    incarnation: 'i',
    snapshot: { incarnation: 'i', powerState: 'running', name: 'VM' },
    observedAt: now,
    missingSince: null,
  };
  const firewall = {
    connectorRevision: now.toISOString(),
    status: 'ready',
    observedAt: now,
    updatedAt: new Date(0),
    error: null,
  };
  const cached = {
    refreshStatus: 'success',
    data: {
      configurationRevision: now.toISOString(),
      summary: {
        balance: { amount: '0', currency: 'USD', estimated: false },
        monthlyExpenses: null,
        observedAt: now.toISOString(),
      },
    },
  };
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: async () =>
          table === integrationConnectors
            ? [account]
            : table === hostingResources
              ? [resource]
              : table === hostingFirewalls
                ? [firewall]
                : [],
      }),
    }),
  };
  const connectors = {
    settings: () => ({ autoSyncIntervalSeconds: 60, resourceIds: [] }),
    get: vi.fn(async () => account),
  };
  const store = {
    get: vi.fn(async () => cached),
    withLease: vi.fn(async (_kind: string, _id: string, run: (lease: { token: string }) => Promise<unknown>) => ({
      acquired: true,
      value: await run({ token: 'lease' }),
    })),
    markRefreshing: vi.fn(),
    replace: vi.fn(),
    markError: vi.fn(),
  };
  const events = { publish: vi.fn() };
  const service = new HostingObservationsService(db as never, connectors as never, store as never, events as never);
  return { now, account, resource, firewall, cached, db, connectors, store, events, service };
}
describe('hosting persisted observations', () => {
  it.each([
    hostingResources,
    hostingFirewalls,
  ])('fences observations after later database reads', async (changedTable) => {
    const f = fixture();
    const originalSelect = f.db.select;
    f.db.select = () => ({
      from: (table: unknown) => ({
        where: async () => {
          const rows = await originalSelect().from(table).where();
          if (table === changedTable) f.account.syncFinishedAt = new Date(f.now.getTime() + 1);
          return rows;
        },
      }),
    });
    await f.service.publish();
    expect(f.events.publish).not.toHaveBeenCalled();
  });
  it('discards a captured failure if sync completes during the Redis read', async () => {
    const f = fixture();
    f.account.syncStatus = 'error';
    f.store.get.mockImplementationOnce(async () => {
      f.account.syncStatus = 'success';
      f.account.syncFinishedAt = new Date(f.now.getTime() + 1);
      return f.cached;
    });
    await f.service.publish();
    expect(f.events.publish).not.toHaveBeenCalled();
  });
  it('publishes fresh VM, account and firewall evidence without provider requests', async () => {
    const f = fixture();
    await f.service.publish();
    expect(f.events.publish).toHaveBeenCalledWith(
      'hosting.account.observed',
      expect.objectContaining({ summary: f.cached.data.summary })
    );
    expect(f.events.publish).toHaveBeenCalledWith(
      'hosting.vm.observed',
      expect.objectContaining({ powerState: 'running', resourceId: 'vm' })
    );
    expect(f.events.publish).toHaveBeenCalledWith(
      'hosting.firewall.observed',
      expect.objectContaining({ status: 'ready' })
    );
  });
  it.each(['error', 'refreshing'])('does not publish a balance from %s Redis state', async (status) => {
    const f = fixture();
    f.cached.refreshStatus = status;
    await f.service.publish();
    expect(f.events.publish).toHaveBeenCalledWith(
      'hosting.account.observed',
      expect.objectContaining({ summary: null })
    );
  });
  it('ignores a stale balance and a replaced configuration', async () => {
    const f = fixture();
    f.cached.data.summary.observedAt = new Date(0).toISOString();
    await f.service.publish();
    expect(f.events.publish.mock.calls.find((x) => x[0] === 'hosting.account.observed')?.[1].summary).toBeNull();
    f.cached.data.summary.observedAt = f.now.toISOString();
    f.cached.data.configurationRevision = 'old';
    f.events.publish.mockClear();
    await f.service.publish();
    expect(f.events.publish.mock.calls.find((x) => x[0] === 'hosting.account.observed')?.[1].summary).toBeNull();
  });
  it('does not treat stale VM evidence as a fresh state or suppress a confirmed sync error', async () => {
    const f = fixture();
    f.account.syncFinishedAt = new Date(0);
    await f.service.publish();
    expect(f.events.publish).not.toHaveBeenCalled();
    f.account.syncStatus = 'error';
    await f.service.publish();
    expect(f.events.publish).toHaveBeenCalledTimes(1);
    expect(f.events.publish).toHaveBeenCalledWith(
      'hosting.account.observed',
      expect.objectContaining({ syncStatus: 'error', summary: null })
    );
  });
  it('ignores changed VM incarnation', async () => {
    const f = fixture();
    f.resource.snapshot.incarnation = 'replacement';
    await f.service.publish();
    expect(f.events.publish.mock.calls.some((x) => x[0] === 'hosting.vm.observed')).toBe(false);
  });
});
describe('hosting account summary cache fencing', () => {
  it('rechecks configuration after provider I/O and never replaces a newer configuration', async () => {
    const f = fixture();
    const original = { ...f.account };
    const service = new HostingInventoryService(
      f.db as never,
      f.connectors as never,
      {} as never,
      {} as never,
      {} as never,
      f.store as never
    );
    const adapter = {
      accountSummary: async () => {
        f.account.updatedAt = new Date(f.now.getTime() + 1000);
        return f.cached.data.summary;
      },
    };
    await service.refreshAccountSummary(original as never, adapter as never, []);
    expect(f.store.replace).not.toHaveBeenCalled();
  });
  it('writes with the distributed lease and marks unavailable billing errors without failing inventory', async () => {
    const f = fixture();
    const service = new HostingInventoryService(
      f.db as never,
      f.connectors as never,
      {} as never,
      {} as never,
      {} as never,
      f.store as never
    );
    await service.refreshAccountSummary(
      f.account as never,
      { accountSummary: async () => f.cached.data.summary } as never,
      []
    );
    expect(f.store.replace).toHaveBeenCalledWith('hosting-account-summary', 'account', expect.anything(), {
      lease: { token: 'lease' },
      availability: 'available',
    });
    await service.refreshAccountSummary(
      f.account as never,
      {
        accountSummary: async () => {
          throw Error('secret provider message');
        },
      } as never,
      []
    );
    expect(f.store.markError).toHaveBeenCalledWith(
      'hosting-account-summary',
      'account',
      expect.anything(),
      'Hosting account summary is unavailable',
      'unavailable',
      { token: 'lease' }
    );
  });
});
