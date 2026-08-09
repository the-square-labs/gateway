import { describe, expect, it, vi } from 'vitest';
import { DashboardReadModelService, dashboardStatsFromSourceSnapshots } from './dashboard-read-model.service.js';

function makeService() {
  const definitions: Array<{ id: string; refresh: () => Promise<void> }> = [];
  const snapshots = {
    withLease: vi.fn(
      async (kind: string, id: string, work: (lease: { kind: string; id: string; token: string }) => Promise<void>) => {
        await work({ kind, id, token: 'lease-token' });
        return { acquired: true as const, value: undefined };
      }
    ),
    markRefreshing: vi.fn(async () => undefined),
    replace: vi.fn(async () => undefined),
    markError: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
  };
  const coordinator = {
    register: vi.fn((definition) => definitions.push(definition)),
  };
  const monitoring = {
    getHealthOverview: vi.fn(async () => []),
    getDashboardStats: vi.fn(async () => ({
      proxyHosts: {},
      sslCertificates: {},
      pkiCertificates: {},
      cas: {},
      nodes: {},
    })),
  };
  const proxies = { listProxyHosts: vi.fn(async () => ({ data: [{ id: 'proxy-1' }] })) };
  const databases = { list: vi.fn(async () => ({ data: [{ id: 'database-1' }] })) };
  const ssl = { listCerts: vi.fn(async () => ({ data: [{ id: 'ssl-1' }] })) };
  const certificates = { listCertificates: vi.fn(async () => ({ data: [{ id: 'cert-1' }] })) };
  const cas = { getCATree: vi.fn(async () => [{ id: 'ca-1' }]) };
  return {
    service: new DashboardReadModelService(
      snapshots as never,
      coordinator as never,
      monitoring as never,
      proxies as never,
      databases as never,
      ssl as never,
      certificates as never,
      cas as never
    ),
    coordinator,
    definitions,
    snapshots,
    proxies,
    ssl,
    certificates,
  };
}

describe('DashboardReadModelService', () => {
  it('registers all global dashboard sources for event-first refresh', () => {
    const { coordinator, definitions } = makeService();

    expect(coordinator.register).toHaveBeenCalledTimes(8);
    expect(definitions.map((definition) => definition.id)).toEqual([
      'dashboard-source:health',
      'dashboard-source:proxies',
      'dashboard-source:databases',
      'dashboard-source:ssl',
      'dashboard-source:pki',
      'dashboard-source:cas',
      'dashboard-source:stats-user',
      'dashboard-source:stats-system',
    ]);
  });

  it('only replaces the proxy projection after its complete source succeeds', async () => {
    const { definitions, snapshots, proxies } = makeService();
    const definition = definitions.find((item) => item.id === 'dashboard-source:proxies');

    await definition!.refresh();

    expect(proxies.listProxyHosts).toHaveBeenCalledWith({ page: 1, limit: 1_000 });
    expect(snapshots.markRefreshing).toHaveBeenCalledWith(
      'dashboard-source',
      'proxies',
      [],
      'unknown',
      expect.objectContaining({ token: 'lease-token' })
    );
    expect(snapshots.replace).toHaveBeenCalledWith('dashboard-source', 'proxies', [{ id: 'proxy-1' }], {
      availability: 'available',
      lease: expect.objectContaining({ token: 'lease-token' }),
    });
    expect(snapshots.markError).not.toHaveBeenCalled();
  });

  it('derives resource-scoped dashboard counts from hot global projections', () => {
    const stats = dashboardStatsFromSourceSnapshots(
      {
        proxies: [
          { id: 'proxy-allowed', enabled: true, healthStatus: 'online' },
          { id: 'proxy-hidden', enabled: true, healthStatus: 'offline' },
        ],
        ssl: [
          { id: 'ssl-allowed', status: 'active', notAfter: '2026-08-20T00:00:00.000Z', isSystem: false },
          { id: 'ssl-expired', status: 'expired', isSystem: false },
          { id: 'ssl-system', status: 'active', isSystem: true },
        ],
        pki: [
          { id: 'pki-allowed', status: 'revoked', isSystem: false },
          { id: 'pki-hidden', status: 'active', isSystem: false },
        ],
        cas: [
          { id: 'ca-root', type: 'root', status: 'active', isSystem: false },
          { id: 'ca-intermediate', type: 'intermediate', status: 'active', isSystem: false },
        ],
        nodes: [
          { id: 'node-allowed', status: 'online' },
          { id: 'node-hidden', status: 'offline' },
        ],
      },
      {
        showSystem: false,
        allowedCaTypes: ['root'],
        allowedProxyHostIds: ['proxy-allowed'],
        allowedSslCertificateIds: ['ssl-allowed', 'ssl-expired'],
        allowedPkiCertificateIds: ['pki-allowed'],
        allowedNodeIds: ['node-allowed'],
        now: new Date('2026-08-07T00:00:00.000Z'),
      }
    );

    expect(stats).toEqual({
      proxyHosts: { total: 1, enabled: 1, online: 1, offline: 0, degraded: 0 },
      sslCertificates: { total: 2, active: 1, expiringSoon: 1, expired: 1 },
      pkiCertificates: { total: 1, active: 0, revoked: 1, expired: 0 },
      cas: { total: 1, active: 1 },
      nodes: { total: 1, online: 1, offline: 0, pending: 0 },
    });
  });

  it('keeps non-active certificate rows in global projections for scoped aggregate counts', async () => {
    const { definitions, ssl, certificates } = makeService();

    await definitions.find((item) => item.id === 'dashboard-source:ssl')!.refresh();
    await definitions.find((item) => item.id === 'dashboard-source:pki')!.refresh();

    expect(ssl.listCerts).toHaveBeenCalledWith({ page: 1, limit: 1_000, showSystem: true });
    expect(certificates.listCertificates).toHaveBeenCalledWith({ page: 1, limit: 1_000, showSystem: true });
  });
});
