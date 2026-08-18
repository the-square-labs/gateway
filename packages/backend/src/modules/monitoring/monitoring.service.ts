import { and, count, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { certificateAuthorities, certificates, nodes, proxyHosts, sslCertificates } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere } from '@/lib/utils.js';

const logger = createChildLogger('MonitoringService');

export interface DashboardStats {
  proxyHosts: {
    total: number;
    enabled: number;
    online: number;
    offline: number;
    degraded: number;
  };
  sslCertificates: {
    total: number;
    active: number;
    expiringSoon: number;
    expired: number;
  };
  pkiCertificates: {
    total: number;
    active: number;
    revoked: number;
    expired: number;
  };
  cas: {
    total: number;
    active: number;
  };
  nodes: {
    total: number;
    online: number;
    offline: number;
    pending: number;
  };
}

export interface HealthOverviewEntry {
  id: string;
  slug: string;
  domainNames: string[];
  type: string;
  enabled: boolean;
  healthStatus: string | null;
  lastHealthCheckAt: Date | null;
}

export interface DashboardStatsOptions {
  showSystem?: boolean;
  allowedCaTypes?: Array<'root' | 'intermediate'>;
  allowedProxyHostIds?: string[];
  allowedSslCertificateIds?: string[];
  allowedPkiCertificateIds?: string[];
  allowedNodeIds?: string[];
}

export class MonitoringService {
  constructor(private readonly db: DrizzleClient) {}

  async getDashboardStats(options: DashboardStatsOptions = {}): Promise<DashboardStats> {
    logger.debug('Fetching dashboard stats');

    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const scopedProxy =
      options.allowedProxyHostIds === undefined
        ? undefined
        : options.allowedProxyHostIds.length === 0
          ? sql`false`
          : inArray(proxyHosts.id, options.allowedProxyHostIds);
    const scopedSsl =
      options.allowedSslCertificateIds === undefined
        ? undefined
        : options.allowedSslCertificateIds.length === 0
          ? sql`false`
          : inArray(sslCertificates.id, options.allowedSslCertificateIds);
    const scopedPki =
      options.allowedPkiCertificateIds === undefined
        ? undefined
        : options.allowedPkiCertificateIds.length === 0
          ? sql`false`
          : inArray(certificates.id, options.allowedPkiCertificateIds);
    const scopedNodes =
      options.allowedNodeIds === undefined
        ? undefined
        : options.allowedNodeIds.length === 0
          ? sql`false`
          : inArray(nodes.id, options.allowedNodeIds);

    const proxyWhere = buildWhere([scopedProxy]);
    const visibleSsl = buildWhere([options.showSystem ? undefined : eq(sslCertificates.isSystem, false), scopedSsl]);
    const visiblePki = buildWhere([
      options.showSystem
        ? undefined
        : sql`${certificates.caId} NOT IN (SELECT id FROM ${certificateAuthorities} WHERE is_system = true)`,
      scopedPki,
    ]);
    const scopedCaTypes =
      options.allowedCaTypes === undefined
        ? undefined
        : options.allowedCaTypes.length === 0
          ? sql`false`
          : inArray(certificateAuthorities.type, options.allowedCaTypes);
    const visibleCa = buildWhere([
      options.showSystem ? undefined : eq(certificateAuthorities.isSystem, false),
      scopedCaTypes,
    ]);
    const nodeWhere = buildWhere([scopedNodes]);

    const [
      // Proxy host counts
      proxyTotal,
      proxyEnabled,
      proxyOnline,
      proxyOffline,
      proxyDegraded,

      // SSL certificate counts
      sslTotal,
      sslActive,
      sslExpiringSoon,
      sslExpired,

      // PKI certificate counts
      pkiTotal,
      pkiActive,
      pkiRevoked,
      pkiExpired,

      // CA counts
      caTotal,
      caActive,

      // Node counts
      nodeTotal,
      nodeOnline,
      nodeOffline,
      nodePending,
    ] = await Promise.all([
      // Proxy hosts
      this.db.select({ value: count() }).from(proxyHosts).where(proxyWhere),
      this.db
        .select({ value: count() })
        .from(proxyHosts)
        .where(proxyWhere ? and(proxyWhere, eq(proxyHosts.enabled, true)) : eq(proxyHosts.enabled, true)),
      this.db
        .select({ value: count() })
        .from(proxyHosts)
        .where(
          proxyWhere ? and(proxyWhere, eq(proxyHosts.healthStatus, 'online')) : eq(proxyHosts.healthStatus, 'online')
        ),
      this.db
        .select({ value: count() })
        .from(proxyHosts)
        .where(
          proxyWhere ? and(proxyWhere, eq(proxyHosts.healthStatus, 'offline')) : eq(proxyHosts.healthStatus, 'offline')
        ),
      this.db
        .select({ value: count() })
        .from(proxyHosts)
        .where(
          proxyWhere
            ? and(proxyWhere, eq(proxyHosts.healthStatus, 'degraded'))
            : eq(proxyHosts.healthStatus, 'degraded')
        ),

      // SSL certificates
      this.db.select({ value: count() }).from(sslCertificates).where(visibleSsl),
      this.db
        .select({ value: count() })
        .from(sslCertificates)
        .where(
          visibleSsl ? and(visibleSsl, eq(sslCertificates.status, 'active')) : eq(sslCertificates.status, 'active')
        ),
      this.db
        .select({ value: count() })
        .from(sslCertificates)
        .where(
          visibleSsl
            ? and(
                visibleSsl,
                eq(sslCertificates.status, 'active'),
                gt(sslCertificates.notAfter, now),
                lt(sslCertificates.notAfter, thirtyDaysFromNow)
              )
            : and(
                eq(sslCertificates.status, 'active'),
                gt(sslCertificates.notAfter, now),
                lt(sslCertificates.notAfter, thirtyDaysFromNow)
              )
        ),
      this.db
        .select({ value: count() })
        .from(sslCertificates)
        .where(
          visibleSsl ? and(visibleSsl, eq(sslCertificates.status, 'expired')) : eq(sslCertificates.status, 'expired')
        ),

      // PKI certificates
      this.db.select({ value: count() }).from(certificates).where(visiblePki),
      this.db
        .select({ value: count() })
        .from(certificates)
        .where(visiblePki ? and(visiblePki, eq(certificates.status, 'active')) : eq(certificates.status, 'active')),
      this.db
        .select({ value: count() })
        .from(certificates)
        .where(visiblePki ? and(visiblePki, eq(certificates.status, 'revoked')) : eq(certificates.status, 'revoked')),
      this.db
        .select({ value: count() })
        .from(certificates)
        .where(visiblePki ? and(visiblePki, eq(certificates.status, 'expired')) : eq(certificates.status, 'expired')),

      // Certificate authorities
      this.db.select({ value: count() }).from(certificateAuthorities).where(visibleCa),
      this.db
        .select({ value: count() })
        .from(certificateAuthorities)
        .where(
          visibleCa
            ? and(visibleCa, eq(certificateAuthorities.status, 'active'))
            : eq(certificateAuthorities.status, 'active')
        ),

      // Nodes
      this.db.select({ value: count() }).from(nodes).where(nodeWhere),
      this.db
        .select({ value: count() })
        .from(nodes)
        .where(nodeWhere ? and(nodeWhere, eq(nodes.status, 'online')) : eq(nodes.status, 'online')),
      this.db
        .select({ value: count() })
        .from(nodes)
        .where(nodeWhere ? and(nodeWhere, eq(nodes.status, 'offline')) : eq(nodes.status, 'offline')),
      this.db
        .select({ value: count() })
        .from(nodes)
        .where(nodeWhere ? and(nodeWhere, eq(nodes.status, 'pending')) : eq(nodes.status, 'pending')),
    ]);

    return {
      proxyHosts: {
        total: Number(proxyTotal[0].value),
        enabled: Number(proxyEnabled[0].value),
        online: Number(proxyOnline[0].value),
        offline: Number(proxyOffline[0].value),
        degraded: Number(proxyDegraded[0].value),
      },
      sslCertificates: {
        total: Number(sslTotal[0].value),
        active: Number(sslActive[0].value),
        expiringSoon: Number(sslExpiringSoon[0].value),
        expired: Number(sslExpired[0].value),
      },
      pkiCertificates: {
        total: Number(pkiTotal[0].value),
        active: Number(pkiActive[0].value),
        revoked: Number(pkiRevoked[0].value),
        expired: Number(pkiExpired[0].value),
      },
      cas: {
        total: Number(caTotal[0].value),
        active: Number(caActive[0].value),
      },
      nodes: {
        total: Number(nodeTotal[0].value),
        online: Number(nodeOnline[0].value),
        offline: Number(nodeOffline[0].value),
        pending: Number(nodePending[0].value),
      },
    };
  }

  async getHealthOverview(options?: { allowedHostIds?: string[] }): Promise<HealthOverviewEntry[]> {
    logger.debug('Fetching health overview');

    if (options?.allowedHostIds?.length === 0) return [];

    const hosts = await this.db
      .select({
        id: proxyHosts.id,
        slug: proxyHosts.slug,
        domainNames: proxyHosts.domainNames,
        type: proxyHosts.type,
        enabled: proxyHosts.enabled,
        healthStatus: proxyHosts.healthStatus,
        lastHealthCheckAt: proxyHosts.lastHealthCheckAt,
      })
      .from(proxyHosts)
      .where(options?.allowedHostIds ? inArray(proxyHosts.id, options.allowedHostIds) : undefined)
      .orderBy(
        // Order: offline first, then degraded, then online, then unknown
        sql`CASE ${proxyHosts.healthStatus}
          WHEN 'offline' THEN 0
          WHEN 'degraded' THEN 1
          WHEN 'online' THEN 2
          WHEN 'unknown' THEN 3
          ELSE 4
        END`
      );

    return hosts;
  }
}
