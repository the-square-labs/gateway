import type { DatabaseConnectionService } from '@/modules/databases/databases.service.js';
import type { CAService } from '@/modules/pki/ca.service.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { SSLService } from '@/modules/ssl/ssl.service.js';
import type { ReadModelCoordinator, ReadModelEventSubscription } from '@/services/read-model-coordinator.service.js';
import type { ResourceSnapshotEnvelope, ResourceSnapshotStore } from '@/services/resource-snapshot.store.js';
import type { DashboardStats, HealthOverviewEntry, MonitoringService } from './monitoring.service.js';

export const DASHBOARD_READ_MODEL_KIND = 'dashboard-source';

export type DashboardReadModelName =
  | 'health'
  | 'proxies'
  | 'databases'
  | 'ssl'
  | 'pki'
  | 'cas'
  | 'stats-user'
  | 'stats-system';

type DashboardSourceRow = Record<string, unknown>;

export interface DashboardScopedStatsOptions {
  showSystem: boolean;
  allowedCaTypes: Array<'root' | 'intermediate'>;
  allowedProxyHostIds?: string[];
  allowedSslCertificateIds?: string[];
  allowedPkiCertificateIds?: string[];
  allowedNodeIds?: string[];
  now?: Date;
}

export interface DashboardSourceSnapshots {
  proxies: DashboardSourceRow[];
  ssl: DashboardSourceRow[];
  pki: DashboardSourceRow[];
  cas: DashboardSourceRow[];
  nodes: DashboardSourceRow[];
}

const EMPTY: Record<DashboardReadModelName, unknown[]> = {
  health: [],
  proxies: [],
  databases: [],
  ssl: [],
  pki: [],
  cas: [],
  'stats-user': [],
  'stats-system': [],
};

/**
 * Global, sanitized dashboard sources. Request handlers only filter these
 * projections by the caller's scopes; refreshes never run in a user request.
 */
export class DashboardReadModelService {
  constructor(
    private readonly snapshots: ResourceSnapshotStore,
    private readonly coordinator: ReadModelCoordinator,
    private readonly monitoring: MonitoringService,
    private readonly proxies: ProxyService,
    private readonly databases: DatabaseConnectionService,
    private readonly ssl: SSLService,
    private readonly certificates: CertService,
    private readonly cas: CAService
  ) {
    this.register('health', () => this.monitoring.getHealthOverview(), ['proxy.host.changed']);
    this.register(
      'proxies',
      () => this.listAll((page) => this.proxies.listProxyHosts({ page, limit: 1_000 } as never)),
      ['proxy.host.changed']
    );
    this.register('databases', () => this.listAll((page) => this.databases.list({ page, limit: 1_000 } as never)), [
      {
        channel: 'database.changed',
        matches: (payload) => (payload as { action?: string } | null)?.action !== 'health.sampled',
      },
    ]);
    this.register(
      'ssl',
      () => this.listAll((page) => this.ssl.listCerts({ page, limit: 1_000, showSystem: true } as never)),
      ['ssl.cert.changed']
    );
    this.register(
      'pki',
      () =>
        this.listAll((page) => this.certificates.listCertificates({ page, limit: 1_000, showSystem: true } as never)),
      ['cert.changed', 'ca.changed']
    );
    this.register('cas', () => this.cas.getCATree(true), ['ca.changed', 'cert.changed']);
    this.register('stats-user', () => this.monitoring.getDashboardStats({ showSystem: false }), [
      'proxy.host.changed',
      'ssl.cert.changed',
      'cert.changed',
      'ca.changed',
      'node.changed',
    ]);
    this.register('stats-system', () => this.monitoring.getDashboardStats({ showSystem: true }), [
      'proxy.host.changed',
      'ssl.cert.changed',
      'cert.changed',
      'ca.changed',
      'node.changed',
    ]);
  }

  async get<T>(name: DashboardReadModelName): Promise<ResourceSnapshotEnvelope<T> | null> {
    return this.snapshots.get<T>(DASHBOARD_READ_MODEL_KIND, name);
  }

  private register<T>(
    name: DashboardReadModelName,
    source: () => Promise<T>,
    subscriptions: Array<string | ReadModelEventSubscription>
  ): void {
    this.coordinator.register({
      id: `dashboard-source:${name}`,
      refresh: () => this.refresh(name, source),
      events: subscriptions.map((subscription) =>
        typeof subscription === 'string' ? { channel: subscription } : subscription
      ),
      fallbackIntervalMs: 10_000,
    });
  }

  private async refresh<T>(name: DashboardReadModelName, source: () => Promise<T>): Promise<void> {
    const leased = await this.snapshots.withLease(DASHBOARD_READ_MODEL_KIND, name, async (lease) => {
      await this.snapshots.markRefreshing(DASHBOARD_READ_MODEL_KIND, name, EMPTY[name] as T, 'unknown', lease);
      try {
        const data = await source();
        await this.snapshots.replace(DASHBOARD_READ_MODEL_KIND, name, data, { availability: 'available', lease });
      } catch (error) {
        await this.snapshots.markError(DASHBOARD_READ_MODEL_KIND, name, EMPTY[name] as T, error, 'unknown', lease);
      }
    });
    if (!leased.acquired) return;
  }

  private async listAll<T>(
    fetchPage: (page: number) => Promise<{ data: T[]; pagination?: { page?: number; totalPages?: number } }>
  ): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; ; page += 1) {
      const result = await fetchPage(page);
      rows.push(...(result.data ?? []));
      const totalPages = result.pagination?.totalPages;
      if (!totalPages || page >= totalPages) return rows;
    }
  }
}

export type DashboardHealthSnapshot = HealthOverviewEntry[];
export type DashboardStatsSnapshot = DashboardStats;

function inScope(row: DashboardSourceRow, ids: string[] | undefined): boolean {
  return ids === undefined || ids.includes(String(row.id));
}

function statusIs(row: DashboardSourceRow, status: string): boolean {
  return row.status === status;
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Builds a caller-scoped dashboard aggregate from hot global projections.
 * This keeps scoped permissions server-side without falling back to a new
 * multi-query stats read for every dashboard opening.
 */
export function dashboardStatsFromSourceSnapshots(
  sources: DashboardSourceSnapshots,
  options: DashboardScopedStatsOptions
): DashboardStats {
  const now = options.now ?? new Date();
  const expiresBy = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const visibleProxies = sources.proxies.filter((row) => inScope(row, options.allowedProxyHostIds));
  const visibleSsl = sources.ssl.filter(
    (row) => (options.showSystem || row.isSystem !== true) && inScope(row, options.allowedSslCertificateIds)
  );
  const visiblePki = sources.pki.filter(
    (row) => (options.showSystem || row.isSystem !== true) && inScope(row, options.allowedPkiCertificateIds)
  );
  const visibleCas = sources.cas.filter(
    (row) =>
      (options.showSystem || row.isSystem !== true) &&
      options.allowedCaTypes.includes(row.type as 'root' | 'intermediate')
  );
  const visibleNodes = sources.nodes.filter((row) => inScope(row, options.allowedNodeIds));
  const expiringSoon = (row: DashboardSourceRow) => {
    const notAfter = dateValue(row.notAfter);
    return statusIs(row, 'active') && !!notAfter && notAfter > now && notAfter <= expiresBy;
  };

  return {
    proxyHosts: {
      total: visibleProxies.length,
      enabled: visibleProxies.filter((row) => row.enabled === true).length,
      online: visibleProxies.filter((row) => row.healthStatus === 'online').length,
      offline: visibleProxies.filter((row) => row.healthStatus === 'offline').length,
      degraded: visibleProxies.filter((row) => row.healthStatus === 'degraded').length,
    },
    sslCertificates: {
      total: visibleSsl.length,
      active: visibleSsl.filter((row) => statusIs(row, 'active')).length,
      expiringSoon: visibleSsl.filter(expiringSoon).length,
      expired: visibleSsl.filter((row) => statusIs(row, 'expired')).length,
    },
    pkiCertificates: {
      total: visiblePki.length,
      active: visiblePki.filter((row) => statusIs(row, 'active')).length,
      revoked: visiblePki.filter((row) => statusIs(row, 'revoked')).length,
      expired: visiblePki.filter((row) => statusIs(row, 'expired')).length,
    },
    cas: {
      total: visibleCas.length,
      active: visibleCas.filter((row) => statusIs(row, 'active')).length,
    },
    nodes: {
      total: visibleNodes.length,
      online: visibleNodes.filter((row) => statusIs(row, 'online')).length,
      offline: visibleNodes.filter((row) => statusIs(row, 'offline')).length,
      pending: visibleNodes.filter((row) => statusIs(row, 'pending')).length,
    },
  };
}
