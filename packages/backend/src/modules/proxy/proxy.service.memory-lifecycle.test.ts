import { describe, expect, it, vi } from 'vitest';
import { ProxyService } from './proxy.service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const service: any = Object.create(ProxyService.prototype);
  const host = { id: 'host', nodeId: 'node', upstreamKind: 'docker_container', domainNames: [] };
  const deletion = vi.fn().mockResolvedValue(undefined);
  Object.assign(service, {
    secureLinkRuntimeHistory: new Map(),
    secureLinkRuntimeSamplesInFlight: new Map(),
    hostConfigEpochs: new Map(),
    db: {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(host) } },
      delete: () => ({ where: deletion }),
    },
    secureLinks: {
      listAdditional: vi.fn().mockResolvedValue([{ id: 'child' }]),
      cleanupAdditionalForHost: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
      abandonOfflineSource: vi.fn().mockResolvedValue(undefined),
      deleteAdditional: vi.fn().mockResolvedValue(undefined),
      getRuntime: vi.fn().mockResolvedValue({}),
    },
    cache: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
    nodeDispatch: { isNodeConnected: () => false },
    certificateDistribution: { deactivateHost: vi.fn().mockResolvedValue(undefined) },
    removeConfigFromNode: vi.fn().mockResolvedValue(undefined),
    auditService: { log: vi.fn().mockResolvedValue(undefined) },
    emitHost: vi.fn(),
    reconcileMaintenanceAlerts: vi.fn(),
    requireManagedProxyHost: vi.fn().mockResolvedValue(host),
    queueDockerReconciliation: vi.fn(),
  });
  return { service, host, deletion };
}

const snapshot = { timestamp: '2026-09-15T10:00:00Z', runtime: {}, traffic: {} };

describe('ProxyService memory lifecycle', () => {
  it.each(['host', 'child'] as const)('does not start deleted %s from a stale later background batch', async (kind) => {
    const { service } = fixture();
    const pending = deferred<void>();
    const hosts = [1, 2, 3, 4, 5].map((i) => ({ id: i === 5 ? 'host' : `h${i}`, nodeId: 'node' }));
    service.db.query.proxyHosts.findMany = vi.fn().mockResolvedValue(hosts);
    service.db.query.proxyAdditionalSecureLinks = { findMany: vi.fn().mockResolvedValue([{ id: 'child' }]) };
    service.collectSecureLinkRuntimeSnapshot = vi.fn(async () => {
      await pending.promise;
      return snapshot;
    });
    const collecting = service.collectSecureLinkRuntimeSnapshots();
    await vi.waitFor(() => expect(service.collectSecureLinkRuntimeSnapshot).toHaveBeenCalledTimes(4));
    if (kind === 'host') await service.deleteProxyHost('host', 'user');
    else await service.deleteAdditionalSecureLink('host', 'child', 'user');
    pending.resolve();
    await collecting;
    expect(service.collectSecureLinkRuntimeSnapshot).toHaveBeenCalledTimes(4);
    expect(service.secureLinks.getRuntime).not.toHaveBeenCalled();
    expect(service.secureLinkRuntimeHistory.has('host')).toBe(false);
    expect(service.secureLinkRuntimeHistory.has('additional:child')).toBe(false);
    expect(service.secureLinkRuntimeSamplesInFlight.size).toBe(0);
    expect(service.secureLinkRuntimeBackgroundInFlight).toBeNull();

    // A fresh round must still collect unaffected live resources.
    service.db.query.proxyHosts.findMany.mockResolvedValue([{ id: 'survivor', nodeId: 'node' }]);
    service.db.query.proxyAdditionalSecureLinks.findMany.mockResolvedValue([]);
    await service.collectSecureLinkRuntimeSnapshots();
    expect(service.secureLinkRuntimeHistory.get('survivor')).toEqual([snapshot]);
  });

  it('invalidates a collection whose database snapshot returns after deletion', async () => {
    const { service } = fixture();
    const read = deferred<any[]>();
    service.db.query.proxyHosts.findMany = vi.fn().mockReturnValue(read.promise);
    service.collectSecureLinkRuntimeSnapshot = vi.fn().mockResolvedValue(snapshot);
    const collecting = service.collectSecureLinkRuntimeSnapshots();
    await service.deleteProxyHost('host', 'user');
    read.resolve([{ id: 'host', nodeId: 'node' }]);
    await collecting;
    expect(service.collectSecureLinkRuntimeSnapshot).not.toHaveBeenCalled();
    expect(service.secureLinkRuntimeHistory.size).toBe(0);
    expect(service.secureLinkRuntimeBackgroundInFlight).toBeNull();
  });

  it.each([
    false,
    true,
  ])('clears host and child history only after committed deletion (offline=%s)', async (offline) => {
    const { service, deletion } = fixture();
    const commit = deferred<void>();
    deletion.mockReturnValue(commit.promise);
    for (const key of ['host', 'additional:child', 'unrelated']) {
      service.secureLinkRuntimeHistory.set(key, [snapshot]);
      service.secureLinkRuntimeSamplesInFlight.set(key, Promise.resolve({}));
    }
    const deleting = service.deleteProxyHost('host', 'user', { abandonOfflineNode: offline });
    await vi.waitFor(() => expect(deletion).toHaveBeenCalledOnce());
    expect(service.secureLinkRuntimeHistory.size).toBe(3);
    commit.resolve();
    await deleting;
    expect([...service.secureLinkRuntimeHistory.keys()]).toEqual(['unrelated']);
    expect([...service.secureLinkRuntimeSamplesInFlight.keys()]).toEqual(['unrelated']);
  });

  it('preserves cache when persistence rejects deletion', async () => {
    const { service, deletion } = fixture();
    service.secureLinkRuntimeHistory.set('host', [snapshot]);
    const lease = Promise.resolve({});
    service.secureLinkRuntimeSamplesInFlight.set('host', lease);
    deletion.mockRejectedValue(new Error('delete failed'));
    await expect(service.deleteProxyHost('host', 'user')).rejects.toThrow('delete failed');
    expect(service.secureLinkRuntimeHistory.get('host')).toEqual([snapshot]);
    expect(service.secureLinkRuntimeSamplesInFlight.get('host')).toBe(lease);
  });

  it('cleans committed deletion even when audit logging subsequently fails', async () => {
    const { service } = fixture();
    service.secureLinkRuntimeHistory.set('host', [snapshot]);
    service.auditService.log.mockRejectedValue(new Error('audit failed'));
    await expect(service.deleteProxyHost('host', 'user')).rejects.toThrow('audit failed');
    expect(service.secureLinkRuntimeHistory.size).toBe(0);
  });

  it.each(['snapshot', 'cache'] as const)('fences a sample suspended in %s during host deletion', async (stage) => {
    const { service, host } = fixture();
    const pending = deferred<any>();
    service.collectSecureLinkRuntimeSnapshot = vi
      .fn()
      .mockReturnValue(stage === 'snapshot' ? pending.promise : Promise.resolve(snapshot));
    if (stage === 'cache') service.cache.get.mockReturnValue(pending.promise);
    const sampling = service.sampleSecureLinkRuntime(host, 200);
    if (stage === 'cache') await vi.waitFor(() => expect(service.cache.get).toHaveBeenCalledOnce());
    await service.deleteProxyHost('host', 'user');
    pending.resolve(stage === 'snapshot' ? snapshot : [snapshot]);
    await sampling;
    expect(service.secureLinkRuntimeHistory.size).toBe(0);
    expect(service.secureLinkRuntimeSamplesInFlight.size).toBe(0);
    expect(service.cache.set).not.toHaveBeenCalled();
  });

  it('does not promote a late standalone Redis history read into memory', async () => {
    const { service } = fixture();
    const read = deferred<any>();
    service.cache.get.mockReturnValue(read.promise);
    const history = service.getSecureLinkRuntimeHistory('host');
    await service.deleteProxyHost('host', 'user');
    read.resolve([snapshot]);
    await history;
    expect(service.secureLinkRuntimeHistory.size).toBe(0);
  });

  it('preserves persisted history when an owning sample appends a new point', async () => {
    const { service, host } = fixture();
    service.cache.get.mockResolvedValue([snapshot]);
    const next = { ...snapshot, timestamp: '2026-09-15T10:01:00Z' };
    service.collectSecureLinkRuntimeSnapshot = vi.fn().mockResolvedValue(next);
    await service.sampleSecureLinkRuntime(host, 200);
    expect(service.secureLinkRuntimeHistory.get('host')).toEqual([snapshot, next]);
    expect(service.secureLinkRuntimeSamplesInFlight.size).toBe(0);
  });

  it('fences late additional-link telemetry after committed child deletion', async () => {
    const { service } = fixture();
    const pending = deferred<any>();
    service.secureLinks.getRuntime.mockReturnValue(pending.promise);
    service.secureLinkRuntimeHistory.set('additional:child', [snapshot]);
    const sampling = service.sampleAdditionalSecureLinkRuntime({ id: 'child' });
    await service.deleteAdditionalSecureLink('host', 'child', 'user');
    pending.resolve({});
    await sampling;
    expect(service.secureLinkRuntimeHistory.size).toBe(0);
    expect(service.secureLinkRuntimeSamplesInFlight.size).toBe(0);
    expect(service.cache.set).not.toHaveBeenCalled();
  });

  it('does not clear an additional link when its deletion fails', async () => {
    const { service } = fixture();
    service.secureLinkRuntimeHistory.set('additional:child', [snapshot]);
    service.secureLinks.deleteAdditional.mockRejectedValue(new Error('delete failed'));
    await expect(service.deleteAdditionalSecureLink('host', 'child', 'user')).rejects.toThrow('delete failed');
    expect(service.secureLinkRuntimeHistory.size).toBe(1);
  });

  it('an invalidated finalizer cannot erase a successor sample', async () => {
    const { service, host } = fixture();
    const old = deferred<any>();
    const next = deferred<any>();
    service.collectSecureLinkRuntimeSnapshot = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise);
    const first = service.sampleSecureLinkRuntime(host, 200);
    service.forgetSecureLinkRuntime('host');
    const second = service.sampleSecureLinkRuntime(host, 200);
    old.resolve(snapshot);
    await first;
    expect(service.secureLinkRuntimeSamplesInFlight.get('host')).toBe(second);
    expect(service.secureLinkRuntimeHistory.size).toBe(0);
    next.resolve(snapshot);
    await second;
    expect(service.secureLinkRuntimeHistory.get('host')).toEqual([snapshot]);
    expect(service.secureLinkRuntimeSamplesInFlight.size).toBe(0);
  });
});
