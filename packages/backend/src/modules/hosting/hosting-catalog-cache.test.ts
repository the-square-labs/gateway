import { describe, expect, it, vi } from 'vitest';
import { ResourceSnapshotStore } from '@/services/resource-snapshot.store.js';
import {
  type CachedHostingCatalog,
  HOSTING_CATALOG_SNAPSHOT,
  HostingInventoryService,
} from './hosting-inventory.service.js';
import { HostingProvisioningService } from './hosting-provisioning.service.js';

function fixture() {
  const entries = new Map<string, unknown>();
  const store = new ResourceSnapshotStore({
    get: async (key: string) => entries.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      entries.set(key, value);
    },
    getClient: () => ({
      set: async () => {
        throw new Error('no lease transport');
      },
      del: async (...keys: string[]) => {
        for (const key of keys) entries.delete(key);
      },
    }),
  } as never);
  const connector = { id: 'account', enabled: true, updatedAt: new Date('2026-09-05T12:00:00Z') };
  const catalog = { locations: [{ id: 'ams3', name: 'Amsterdam' }], sizes: [], images: [] };
  const adapter = { catalog: vi.fn(async () => catalog) };
  const connectors = { get: vi.fn(async () => connector), adapter: vi.fn(() => adapter), changed: vi.fn() };
  const inventory = new HostingInventoryService(
    {} as never,
    connectors as never,
    {} as never,
    {} as never,
    {} as never,
    store
  );
  const service = new HostingProvisioningService(
    {} as never,
    connectors as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    store
  );
  return { connector, catalog, adapter, connectors, inventory, service, store };
}

describe('hosting catalog read model', () => {
  it('filters legacy cached images without new provider IO, even if old role flags claim support', async () => {
    const f = fixture();
    await f.store.replace(HOSTING_CATALOG_SNAPSHOT, f.connector.id, {
      configurationRevision: f.connector.updatedAt.toISOString(),
      catalog: { ...f.catalog, images: [{ id: 'legacy', name: 'Ubuntu unknown', supportedRoles: ['docker'] }] },
    });
    expect((await f.service.catalog('account', {} as never)).images).toEqual([]);
    expect(f.adapter.catalog).not.toHaveBeenCalled();
  });
  it('fetches during synchronization, then serves repeated reads without provider IO', async () => {
    const f = fixture();
    await f.inventory.refreshCatalog(f.connector as never, f.adapter as never);
    expect(await f.service.catalog('account', {} as never)).toEqual(f.catalog);
    expect(await f.service.catalog('account', {} as never)).toEqual(f.catalog);
    expect(f.adapter.catalog).toHaveBeenCalledOnce();
    expect(f.connectors.adapter).not.toHaveBeenCalled();
  });
  it('returns a readiness error on miss without fetching the provider', async () => {
    const f = fixture();
    await expect(f.service.catalog('account', {} as never)).rejects.toMatchObject({
      code: 'HOSTING_CATALOG_NOT_READY',
    });
    expect(f.adapter.catalog).not.toHaveBeenCalled();
  });
  it('retains last good data when background refresh fails', async () => {
    const f = fixture();
    await f.inventory.refreshCatalog(f.connector as never, f.adapter as never);
    f.adapter.catalog.mockRejectedValueOnce(new Error('provider timeout with secret'));
    await expect(f.inventory.refreshCatalog(f.connector as never, f.adapter as never)).rejects.toThrow();
    expect(await f.service.catalog('account', {} as never)).toEqual(f.catalog);
    const stored = await f.store.get<CachedHostingCatalog>(HOSTING_CATALOG_SNAPSHOT, 'account');
    expect(stored?.refreshStatus).toBe('error');
    expect(JSON.stringify(stored)).not.toContain('secret');
  });
  it('does not expose a failed first refresh as an empty catalog', async () => {
    const f = fixture();
    f.adapter.catalog.mockRejectedValueOnce(new Error('failed'));
    await expect(f.inventory.refreshCatalog(f.connector as never, f.adapter as never)).rejects.toThrow();
    await expect(f.service.catalog('account', {} as never)).rejects.toMatchObject({
      code: 'HOSTING_CATALOG_NOT_READY',
    });
  });
  it('rejects stale configuration snapshots without live fallback', async () => {
    const f = fixture();
    await f.inventory.refreshCatalog(f.connector as never, f.adapter as never);
    f.connector.updatedAt = new Date('2026-09-05T13:00:00Z');
    await expect(f.service.catalog('account', {} as never)).rejects.toMatchObject({
      code: 'HOSTING_CATALOG_NOT_READY',
    });
    expect(f.adapter.catalog).toHaveBeenCalledOnce();
  });
  it('does not publish a catalog fetched across a configuration change', async () => {
    const f = fixture();
    f.adapter.catalog.mockImplementationOnce(async () => {
      f.connector.updatedAt = new Date('2026-09-05T13:00:00Z');
      return f.catalog;
    });
    await expect(f.inventory.refreshCatalog(f.connector as never, f.adapter as never)).rejects.toMatchObject({
      code: 'HOSTING_CATALOG_SUPERSEDED',
    });
    await expect(f.service.catalog('account', {} as never)).rejects.toMatchObject({
      code: 'HOSTING_CATALOG_NOT_READY',
    });
  });
  it('checks connector permissions before accessing cached data', async () => {
    const f = fixture();
    f.connectors.get.mockRejectedValueOnce(new Error('denied'));
    await expect(f.service.catalog('account', {} as never)).rejects.toThrow('denied');
    expect(f.adapter.catalog).not.toHaveBeenCalled();
  });
});
