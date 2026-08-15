import { isIP } from 'node:net';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import type { DnsRecords } from '@/db/schema/domains.js';
import { domains } from '@/db/schema/domains.js';
import { nodes } from '@/db/schema/nodes.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';
import { sslCertificates } from '@/db/schema/ssl-certificates.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CloudflareClient, CloudflareDnsRecordInput } from '@/modules/integrations/cloudflare-client.js';
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { getEffectiveNginxIngressAddress } from '@/modules/nodes/node-service-address.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { computeDnsStatus, resolveDnsRecords } from './dns.utils.js';
import type {
  CreateDomainInput,
  DeleteDomainInput,
  DomainListQuery,
  PreviewDomainInput,
  UpdateDomainInput,
} from './domain.schemas.js';

const logger = createChildLogger('DomainsService');

export interface DomainUsage {
  proxyHosts: Array<{ id: string; slug: string; domainNames: string[]; enabled: boolean; nodeId: string | null }>;
  sslCertificates: Array<{ id: string; domainNames: string[]; status: string; notAfter: Date | null }>;
}

export interface EligibleNginxNode {
  id: string;
  slug: string;
  hostname: string;
  displayName: string | null;
  appearanceColor: string | null;
  effectiveAddress: string;
}

export function selectBackfillNginxNode(
  eligibleNodes: EligibleNginxNode[],
  usedNodeIds: Array<string | null>
): EligibleNginxNode | undefined {
  if (usedNodeIds.some((nodeId) => !nodeId)) return undefined;
  const distinctUsedNodeIds = [...new Set(usedNodeIds)];
  if (distinctUsedNodeIds.length === 0) return eligibleNodes[0];
  if (distinctUsedNodeIds.length !== 1) return undefined;
  return eligibleNodes.find((node) => node.id === distinctUsedNodeIds[0]);
}

type CloudflareAddressRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean | null;
};

type DomainCloudflarePlan = {
  domainName: string;
  nginxNode: EligibleNginxNode;
  targetIps: string[];
  ttl: number;
  proxied: boolean;
  context: {
    connector: { id: string };
    zone: { remoteId: string; name: string };
    settings: { defaultTtl: number; defaultProxied: boolean };
    client: CloudflareClient;
  };
  addressRecords: CloudflareAddressRecord[];
  blockingRecords: CloudflareAddressRecord[];
  currentIps: string[];
  desiredIps: string[];
  currentMatches: boolean;
  desiredRecords: CloudflareDnsRecordInput[];
};

export class DomainsService {
  private eventBus?: EventBusService;
  private integrationsService?: IntegrationsService;
  private nodeRegistry?: NodeRegistryService;
  private ingressReconcileRunning = false;
  private ingressReconcileQueued = false;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
    bus.subscribe('node.service_address.changed', (payload) => {
      this.queueIngressTargetReconciliation((payload as { id?: string })?.id);
    });
    bus.subscribe('node.ingress_addresses.changed', (payload) => {
      this.queueIngressTargetReconciliation((payload as { id?: string })?.id);
    });
  }

  setIntegrationsService(service: IntegrationsService) {
    this.integrationsService = service;
  }

  setNodeRegistryService(service: NodeRegistryService) {
    this.nodeRegistry = service;
  }

  startIngressTargetReconciliation() {
    this.queueIngressTargetReconciliation();
  }

  private emitDomain(id: string, action: string, domain?: string) {
    this.eventBus?.publish('domain.changed', { id, action, domain });
  }

  async listDomains(params: DomainListQuery) {
    const conditions = [];
    if (params.search) {
      conditions.push(ilike(domains.domain, `%${params.search}%`));
    }
    if (params.dnsStatus) {
      conditions.push(eq(domains.dnsStatus, params.dnsStatus));
    }
    const where = buildWhere(conditions);

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(domains)
        .where(where)
        .orderBy(asc(domains.sortOrder), asc(domains.domain), desc(domains.createdAt))
        .limit(params.limit)
        .offset((params.page - 1) * params.limit),
      this.db.select({ total: count() }).from(domains).where(where),
    ]);

    const enriched = await Promise.all(
      rows.map(async (row) => {
        const usage = await this.getUsage(row.domain);
        return {
          ...row,
          sslCertCount: usage.sslCertificates.length,
          proxyHostCount: usage.proxyHosts.length,
        };
      })
    );

    return {
      data: enriched,
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages: Math.ceil(total / params.limit),
      },
    };
  }

  async getDomain(id: string) {
    const [row] = await this.db.select().from(domains).where(eq(domains.id, id)).limit(1);
    if (!row) throw new Error('Domain not found');
    const [usage, nginxNode] = await Promise.all([
      this.getUsage(row.domain),
      row.nginxNodeId ? this.getNginxNodeSummary(row.nginxNodeId) : Promise.resolve(null),
    ]);
    return { ...row, nginxNode, usage };
  }

  async getNginxNodeOptions() {
    const rows = await this.listNginxNodes();
    const eligibleNodes = rows.flatMap((node) => {
      const effectiveAddress = this.getNodeEffectiveIngressAddress(node);
      return effectiveAddress
        ? [
            {
              id: node.id,
              slug: node.slug,
              hostname: node.hostname,
              displayName: node.displayName,
              appearanceColor: node.appearanceColor,
              effectiveAddress,
            },
          ]
        : [];
    });
    const eligibleIds = new Set(eligibleNodes.map((node) => node.id));
    return {
      eligibleNodes,
      unconfiguredNodes: rows
        .filter((node) => !eligibleIds.has(node.id))
        .map((node) => ({
          id: node.id,
          slug: node.slug,
          hostname: node.hostname,
          displayName: node.displayName,
          appearanceColor: node.appearanceColor,
        })),
      totalNginxNodes: rows.length,
      unconfiguredNginxNodes: rows.length - eligibleNodes.length,
    };
  }

  async createDomain(input: CreateDomainInput, userId: string) {
    const plan = await this.prepareCloudflareDomain(input);
    const {
      domainName,
      targetIps,
      ttl,
      proxied,
      context,
      addressRecords,
      blockingRecords,
      currentMatches,
      desiredRecords,
    } = plan;
    const [existingDomain] = await this.db
      .select({ id: domains.id })
      .from(domains)
      .where(eq(domains.domain, domainName))
      .limit(1);
    if (existingDomain) {
      throw new AppError(409, 'DUPLICATE', 'Domain already exists');
    }

    if (blockingRecords.length > 0 && !currentMatches) {
      const conflictingRecords = [...addressRecords, ...blockingRecords];
      throw new AppError(409, 'DOMAIN_DNS_TARGET_MISMATCH', 'Existing Cloudflare DNS record target differs', {
        domain: domainName,
        zoneName: context.zone.name,
        currentRecords: conflictingRecords.map((record) => ({
          id: record.id,
          type: record.type,
          name: record.name,
          content: record.content,
          ttl: record.ttl,
          proxied: record.proxied ?? null,
        })),
        desiredRecords,
        canOverwrite: false,
      });
    }

    let ownership: 'created' | 'matched_existing' | 'overwritten' = 'created';
    let providerRecordIds: string[] = [];

    if (addressRecords.length > 0) {
      if (currentMatches) {
        ownership = 'matched_existing';
        providerRecordIds = addressRecords.map((record) => record.id);
      } else {
        if (!input.overwriteDns) {
          throw new AppError(409, 'DOMAIN_DNS_TARGET_MISMATCH', 'Existing Cloudflare DNS record target differs', {
            domain: domainName,
            zoneName: context.zone.name,
            currentRecords: addressRecords.map((record) => ({
              id: record.id,
              type: record.type,
              name: record.name,
              content: record.content,
              ttl: record.ttl,
              proxied: record.proxied ?? null,
            })),
            desiredRecords,
            canOverwrite: true,
          });
        }
        ownership = 'overwritten';
        for (const record of addressRecords) {
          await context.client.deleteDnsRecord(context.zone.remoteId, record.id);
        }
      }
    }

    if (providerRecordIds.length === 0) {
      const createdRecords = [];
      for (const record of desiredRecords) {
        createdRecords.push(await context.client.createDnsRecord(context.zone.remoteId, record));
      }
      providerRecordIds = createdRecords.map((record) => record.id);
    }

    const dnsRecords = this.dnsRecordsFromTargetIps(targetIps);
    const [row] = await this.db
      .insert(domains)
      .values({
        domain: domainName,
        description: input.description,
        folderId: input.folderId ?? null,
        dnsStatus: 'valid',
        dnsRecords,
        lastDnsCheckAt: new Date(),
        dnsProvider: 'cloudflare',
        dnsOwnership: ownership,
        integrationConnectorId: context.connector.id,
        providerZoneId: context.zone.remoteId,
        providerZoneName: context.zone.name,
        providerRecordIds,
        nginxNodeId: plan.nginxNode.id,
        dnsRecordType: this.recordTypeLabel(targetIps),
        dnsTargetIps: targetIps,
        dnsTtl: ttl,
        dnsProxied: proxied,
        createdById: userId,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'domain.create',
      resourceType: 'domain',
      resourceId: row.id,
      details: {
        domain: row.domain,
        provider: 'cloudflare',
        ownership,
        connectorId: context.connector.id,
        zoneId: context.zone.remoteId,
        zoneName: context.zone.name,
        recordIds: providerRecordIds,
        targetIps,
        nginxNodeId: plan.nginxNode.id,
        ttl,
        proxied,
      },
    });

    this.emitDomain(row.id, 'created', row.domain);

    return row;
  }

  async previewDomain(input: PreviewDomainInput) {
    const plan = await this.prepareCloudflareDomain(input);
    const hasBlockingRecord = plan.blockingRecords.length > 0 && !plan.currentMatches;
    const hasMismatch = plan.addressRecords.length > 0 && !plan.currentMatches;
    const relevantRecords = [...plan.addressRecords, ...plan.blockingRecords];
    return {
      domain: plan.domainName,
      zoneName: plan.context.zone.name,
      connectorId: plan.context.connector.id,
      nginxNode: plan.nginxNode,
      targetIps: plan.targetIps,
      ttl: plan.ttl,
      proxied: plan.proxied,
      desiredRecords: plan.desiredRecords,
      currentRecords: relevantRecords.map((record) => ({
        id: record.id,
        type: record.type,
        name: record.name,
        content: record.content,
        ttl: record.ttl,
        proxied: record.proxied ?? null,
      })),
      status: hasBlockingRecord ? 'blocked' : hasMismatch ? 'mismatch' : plan.currentMatches ? 'matched' : 'ready',
      canOverwrite: hasMismatch && !hasBlockingRecord,
    };
  }

  async updateDomain(id: string, input: UpdateDomainInput, userId: string) {
    const [existing] = await this.db.select().from(domains).where(eq(domains.id, id)).limit(1);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Domain not found');

    if (input.proxied !== undefined && input.proxied !== existing.dnsProxied) {
      if (
        existing.dnsProvider !== 'cloudflare' ||
        !this.integrationsService ||
        !existing.integrationConnectorId ||
        !existing.providerZoneId ||
        existing.providerRecordIds.length === 0
      ) {
        throw new AppError(
          409,
          'CLOUDFLARE_DNS_NOT_CONFIGURED',
          'Cloudflare DNS integration is not configured for this domain'
        );
      }

      const context = await this.integrationsService.getCloudflareDnsContextForRecord(
        existing.integrationConnectorId,
        existing.providerZoneId
      );
      const records = await context.client.listDnsRecords(context.zone.remoteId, existing.domain);
      const recordsById = new Map(records.map((record) => [record.id, record]));

      for (const recordId of existing.providerRecordIds) {
        const record = recordsById.get(recordId);
        if (!record || !['A', 'AAAA', 'TXT'].includes(record.type)) {
          throw new AppError(
            409,
            'CLOUDFLARE_DNS_RECORD_NOT_FOUND',
            'A managed Cloudflare DNS record could not be found'
          );
        }
        await context.client.updateDnsRecord(context.zone.remoteId, record.id, {
          type: record.type as 'A' | 'AAAA' | 'TXT',
          name: record.name,
          content: record.content,
          ttl: record.ttl,
          proxied: input.proxied,
        });
      }
    }

    const [row] = await this.db
      .update(domains)
      .set({
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.proxied !== undefined ? { dnsProxied: input.proxied } : {}),
        updatedAt: new Date(),
      })
      .where(eq(domains.id, id))
      .returning();

    await this.auditService.log({
      userId,
      action: 'domain.update',
      resourceType: 'domain',
      resourceId: id,
      details: { domain: row.domain, proxied: input.proxied },
    });

    this.emitDomain(id, 'updated', row.domain);

    return row;
  }

  async deleteDomain(id: string, userId: string, input: DeleteDomainInput = {}) {
    const [row] = await this.db.select().from(domains).where(eq(domains.id, id)).limit(1);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Domain not found');
    if (row.isSystem) throw new AppError(409, 'SYSTEM_DOMAIN', 'System domains cannot be deleted');

    const usage = await this.getUsage(row.domain);

    if (usage.proxyHosts.length > 0) {
      throw new AppError(409, 'DOMAIN_IN_USE', 'Domain is in use by proxy hosts', {
        proxyHostCount: usage.proxyHosts.length,
        proxyHostIds: usage.proxyHosts.map((h) => h.id),
      });
    }

    const shouldDeleteDns =
      row.dnsProvider === 'cloudflare' &&
      (row.dnsOwnership === 'created' || row.dnsOwnership === 'overwritten' || input.deleteDns === true);

    if (row.dnsProvider === 'cloudflare' && row.dnsOwnership === 'matched_existing' && input.deleteDns === undefined) {
      throw new AppError(
        409,
        'DOMAIN_DNS_DELETE_CHOICE_REQUIRED',
        'Choose whether to delete the matched existing Cloudflare DNS records or only remove the Gateway mapping',
        { domain: row.domain, recordIds: row.providerRecordIds }
      );
    }

    if (shouldDeleteDns) {
      if (!this.integrationsService || !row.integrationConnectorId || !row.providerZoneId) {
        throw new AppError(409, 'CLOUDFLARE_DNS_NOT_CONFIGURED', 'Cloudflare DNS integration is not configured');
      }
      const context = await this.integrationsService.getCloudflareDnsContextForRecord(
        row.integrationConnectorId,
        row.providerZoneId
      );
      for (const recordId of row.providerRecordIds) {
        await context.client.deleteDnsRecord(context.zone.remoteId, recordId);
      }
    }

    await this.db.delete(domains).where(eq(domains.id, id));

    await this.auditService.log({
      userId,
      action: 'domain.delete',
      resourceType: 'domain',
      resourceId: id,
      details: {
        domain: row.domain,
        usedByProxyHosts: usage.proxyHosts.length,
        usedBySslCerts: usage.sslCertificates.length,
        provider: row.dnsProvider,
        ownership: row.dnsOwnership,
        dnsDeleted: shouldDeleteDns,
        recordIds: row.providerRecordIds,
      },
    });

    this.emitDomain(id, 'deleted', row.domain);
  }

  async checkDns(id: string) {
    let [row] = await this.db.select().from(domains).where(eq(domains.id, id)).limit(1);
    if (!row) throw new Error('Domain not found');

    // A manual check retries a durable approved target before falling back to
    // drift repair for the last committed target. It never invents approval
    // from a newly detected node address.
    let reconciliationTarget: string | undefined = row.pendingDnsTargetIp ?? row.dnsTargetIps[0];
    if (row.pendingDnsTargetIp && row.nginxNodeId) {
      const node = await this.getNginxNodeSummary(row.nginxNodeId);
      if (node?.effectiveAddress !== row.pendingDnsTargetIp) reconciliationTarget = undefined;
    }
    if (row.dnsProvider === 'cloudflare' && reconciliationTarget) {
      await this.reconcileDomainTarget(row, reconciliationTarget);
      [row] = await this.db.select().from(domains).where(eq(domains.id, id)).limit(1);
      if (!row) throw new Error('Domain not found');
    }

    const dnsRecords = await resolveDnsRecords(row.domain);
    const dnsStatus = await this.computeDomainDnsStatus(row, dnsRecords);

    const [updated] = await this.db
      .update(domains)
      .set({ dnsStatus, dnsRecords, lastDnsCheckAt: new Date(), updatedAt: new Date() })
      .where(eq(domains.id, id))
      .returning();

    logger.debug('DNS check complete', { domain: row.domain, status: dnsStatus });
    this.emitDomain(id, 'updated', row.domain);
    return updated;
  }

  async checkAllDns() {
    const allDomains = await this.db.select().from(domains);
    if (allDomains.length === 0) return;

    logger.debug(`Running DNS checks for ${allDomains.length} domains`);

    const results = await Promise.allSettled(
      allDomains.map(async (d) => {
        const dnsRecords = await resolveDnsRecords(d.domain);
        const dnsStatus = await this.computeDomainDnsStatus(d, dnsRecords);
        await this.db
          .update(domains)
          .set({ dnsStatus, dnsRecords, lastDnsCheckAt: new Date(), updatedAt: new Date() })
          .where(eq(domains.id, d.id));
        this.emitDomain(d.id, 'updated', d.domain);
        return { domain: d.domain, status: dnsStatus };
      })
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    logger.info(`DNS check complete: ${succeeded} ok, ${failed} failed`);
  }

  async getUsage(domainName: string): Promise<DomainUsage> {
    const normalized = domainName.trim().toLowerCase();
    const base = normalized.startsWith('*.') ? normalized.slice(2) : normalized;
    const proxyDomainNames = [base, `*.${base}`];

    const [hosts, certs] = await Promise.all([
      this.db
        .select({
          id: proxyHosts.id,
          slug: proxyHosts.slug,
          domainNames: proxyHosts.domainNames,
          enabled: proxyHosts.enabled,
          nodeId: proxyHosts.nodeId,
        })
        .from(proxyHosts)
        .where(
          sql`EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(${proxyHosts.domainNames}) AS proxy_domain(value)
            WHERE ${inArray(sql`lower(proxy_domain.value)`, proxyDomainNames)}
          )`
        ),
      this.db
        .select({
          id: sslCertificates.id,
          domainNames: sslCertificates.domainNames,
          status: sslCertificates.status,
          notAfter: sslCertificates.notAfter,
        })
        .from(sslCertificates)
        .where(
          sql`EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(${sslCertificates.domainNames}) AS certificate_domain(value)
            WHERE lower(certificate_domain.value) = ${normalized}
          )`
        ),
    ]);

    return { proxyHosts: hosts, sslCertificates: certs };
  }

  async searchDomains(query: string) {
    return this.db
      .select({ id: domains.id, domain: domains.domain, dnsStatus: domains.dnsStatus })
      .from(domains)
      .where(ilike(domains.domain, `%${query}%`))
      .orderBy(desc(domains.createdAt), asc(domains.domain))
      .limit(100);
  }

  private async listNginxNodes() {
    return this.db
      .select({
        id: nodes.id,
        slug: nodes.slug,
        hostname: nodes.hostname,
        displayName: nodes.displayName,
        appearanceColor: nodes.appearanceColor,
        serviceAddress: nodes.serviceAddress,
        lastHealthReport: nodes.lastHealthReport,
        createdAt: nodes.createdAt,
      })
      .from(nodes)
      .where(eq(nodes.type, 'nginx'))
      .orderBy(asc(nodes.createdAt), asc(nodes.id));
  }

  private getNodeEffectiveIngressAddress(node: {
    id: string;
    serviceAddress: string | null;
    lastHealthReport: (typeof nodes.$inferSelect)['lastHealthReport'];
  }): string | null {
    return getEffectiveNginxIngressAddress({
      serviceAddress: node.serviceAddress,
      lastHealthReport: this.nodeRegistry?.getNode(node.id)?.lastHealthReport ?? node.lastHealthReport,
    });
  }

  private async resolveRequestedNginxNode(nginxNodeId?: string): Promise<EligibleNginxNode> {
    const options = await this.getNginxNodeOptions();
    if (options.totalNginxNodes === 0) {
      throw new AppError(409, 'DOMAIN_NGINX_NODE_MISSING', 'Add an Nginx node before creating a domain');
    }
    if (options.eligibleNodes.length === 0) {
      throw new AppError(
        409,
        'DOMAIN_NGINX_ADDRESS_REQUIRED',
        'Configure a detected public service address in Nginx node Settings before creating a domain'
      );
    }
    if (nginxNodeId) {
      const selected = options.eligibleNodes.find((node) => node.id === nginxNodeId);
      if (!selected) {
        throw new AppError(400, 'DOMAIN_NGINX_NODE_INELIGIBLE', 'Selected Nginx node has no public ingress address');
      }
      return selected;
    }
    if (options.eligibleNodes.length === 1) return options.eligibleNodes[0]!;
    throw new AppError(400, 'DOMAIN_NGINX_NODE_REQUIRED', 'Select an Nginx node for this domain');
  }

  private async getNginxNodeSummary(nodeId: string): Promise<EligibleNginxNode | null> {
    const options = await this.getNginxNodeOptions();
    const eligible = options.eligibleNodes.find((node) => node.id === nodeId);
    if (eligible) return eligible;
    const [row] = await this.db
      .select({
        id: nodes.id,
        slug: nodes.slug,
        hostname: nodes.hostname,
        displayName: nodes.displayName,
        appearanceColor: nodes.appearanceColor,
      })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    return row ? { ...row, effectiveAddress: '' } : null;
  }

  private queueIngressTargetReconciliation(nodeId?: string) {
    if (this.ingressReconcileRunning) {
      this.ingressReconcileQueued = true;
      return;
    }
    this.ingressReconcileRunning = true;
    void this.reconcileIngressTargets(nodeId)
      .catch((error) => {
        logger.error('Domain ingress target reconciliation failed', {
          nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.ingressReconcileRunning = false;
        if (this.ingressReconcileQueued) {
          this.ingressReconcileQueued = false;
          this.queueIngressTargetReconciliation();
        }
      });
  }

  async reconcileIngressTargets(nodeId?: string) {
    await this.backfillNginxNodeAssignments();
    const rows = await this.db
      .select()
      .from(domains)
      .where(nodeId ? eq(domains.nginxNodeId, nodeId) : undefined);
    for (const row of rows) {
      if (!row.nginxNodeId) continue;
      const node = await this.getNginxNodeSummary(row.nginxNodeId);
      if (!node?.effectiveAddress) {
        if (row.dnsStatus !== 'invalid') {
          await this.db
            .update(domains)
            .set({ dnsStatus: 'invalid', updatedAt: new Date() })
            .where(eq(domains.id, row.id));
          this.emitDomain(row.id, 'updated', row.domain);
        }
        continue;
      }
      const effectiveTargetChanged = !this.sameStringSet(row.dnsTargetIps, [node.effectiveAddress]);
      const hasDurableRetargetApproval = row.pendingDnsTargetIp === node.effectiveAddress;
      if (effectiveTargetChanged && !hasDurableRetargetApproval) {
        if (row.dnsStatus !== 'invalid') {
          await this.db
            .update(domains)
            .set({ dnsStatus: 'invalid', updatedAt: new Date() })
            .where(eq(domains.id, row.id));
          this.emitDomain(row.id, 'updated', row.domain);
        }
        continue;
      }
      await this.reconcileDomainTarget(row, node.effectiveAddress);
    }
  }

  private async backfillNginxNodeAssignments() {
    const unassigned = await this.db.select().from(domains).where(isNull(domains.nginxNodeId));
    if (unassigned.length === 0) return;
    const options = await this.getNginxNodeOptions();
    if (options.eligibleNodes.length === 0) return;

    for (const row of unassigned) {
      const usage = await this.getUsage(row.domain);
      const usedNodeIds = usage.proxyHosts.map((host) => host.nodeId);
      const selected = selectBackfillNginxNode(options.eligibleNodes, usedNodeIds);
      if (!selected) {
        logger.warn('Domain Nginx node assignment remains unresolved', {
          domainId: row.id,
          reason: usedNodeIds.some((usedNodeId) => !usedNodeId)
            ? 'proxy_host_node_unassigned'
            : new Set(usedNodeIds).size > 1
              ? 'multiple_proxy_host_nodes'
              : 'proxy_host_node_ineligible',
        });
        continue;
      }

      const pendingDnsTargetIp = row.dnsProvider === 'cloudflare' ? selected.effectiveAddress : null;
      const [assigned] = await this.db
        .update(domains)
        .set({ nginxNodeId: selected.id, pendingDnsTargetIp, updatedAt: new Date() })
        .where(sql`${domains.id} = ${row.id} AND ${domains.nginxNodeId} IS NULL`)
        .returning();
      if (!assigned) continue;
      await this.auditService.log({
        userId: null,
        action: 'domain.nginx_node.assign',
        resourceType: 'domain',
        resourceId: row.id,
        details: { nginxNodeId: selected.id, source: usedNodeIds.length === 0 ? 'first_eligible' : 'proxy_host' },
      });
      if (assigned.dnsProvider === 'cloudflare') {
        await this.reconcileDomainTarget(assigned, selected.effectiveAddress);
      }
    }
  }

  private async reconcileDomainTarget(row: typeof domains.$inferSelect, effectiveAddress: string) {
    if (
      row.dnsProvider !== 'cloudflare' ||
      !this.integrationsService ||
      !row.integrationConnectorId ||
      !row.providerZoneId ||
      row.providerRecordIds.length === 0
    ) {
      if (row.dnsProvider === 'cloudflare') {
        await this.db
          .update(domains)
          .set({ dnsStatus: 'invalid', updatedAt: new Date() })
          .where(eq(domains.id, row.id));
      }
      return;
    }

    try {
      const context = await this.integrationsService.getCloudflareDnsContextForRecord(
        row.integrationConnectorId,
        row.providerZoneId
      );
      const records = (await context.client.listDnsRecords(context.zone.remoteId, row.domain)).filter(
        (record) => record.name.toLowerCase() === row.domain.toLowerCase()
      );
      const recordsById = new Map(records.map((record) => [record.id, record]));
      const trackedRecordIds = new Set(row.providerRecordIds);
      const recoveryComment = `wiolett-gateway:domain:${row.id}`;
      const trackedAddressRecords = row.providerRecordIds.flatMap((id) => {
        const record = recordsById.get(id);
        return record && (record.type === 'A' || record.type === 'AAAA') ? [record] : [];
      });
      const recoveredAddressRecords = records.filter(
        (record) =>
          (record.type === 'A' || record.type === 'AAAA') &&
          record.comment === recoveryComment &&
          !trackedRecordIds.has(record.id)
      );
      const ownedAddressRecords = [...trackedAddressRecords, ...recoveredAddressRecords];
      const untrackedConflicts = records.filter(
        (record) =>
          record.type === 'CNAME' ||
          ((record.type === 'A' || record.type === 'AAAA') &&
            !trackedRecordIds.has(record.id) &&
            record.comment !== recoveryComment)
      );
      if (untrackedConflicts.length > 0) {
        throw new AppError(
          409,
          'CLOUDFLARE_DNS_RECORD_CONFLICT',
          'Untracked Cloudflare address records occupy the managed domain'
        );
      }
      const desiredType = isIP(effectiveAddress) === 6 ? ('AAAA' as const) : ('A' as const);
      if (ownedAddressRecords.length === 0) {
        const created = await context.client.createDnsRecord(context.zone.remoteId, {
          type: desiredType,
          name: row.domain,
          content: effectiveAddress,
          ttl: row.dnsTtl ?? 1,
          proxied: row.dnsProxied ?? false,
          comment: recoveryComment,
        });
        await this.persistReconciledDomainTarget(row, effectiveAddress, desiredType, created.id);
        return;
      }

      const primary = ownedAddressRecords[0]!;
      const desiredTtl = row.dnsTtl ?? primary.ttl;
      const desiredProxied = row.dnsProxied ?? primary.proxied ?? false;
      const primaryMatches =
        primary.type === desiredType &&
        primary.name === row.domain &&
        primary.content === effectiveAddress &&
        primary.ttl === desiredTtl &&
        (primary.proxied ?? false) === desiredProxied;
      const trackedSetMatches = row.providerRecordIds.length === 1 && row.providerRecordIds[0] === primary.id;
      if (!primaryMatches) {
        await context.client.updateDnsRecord(context.zone.remoteId, primary.id, {
          type: desiredType,
          name: row.domain,
          content: effectiveAddress,
          ttl: desiredTtl,
          proxied: desiredProxied,
        });
      }
      for (const record of ownedAddressRecords.slice(1)) {
        await context.client.deleteDnsRecord(context.zone.remoteId, record.id);
      }
      const snapshotMatches =
        trackedSetMatches &&
        row.dnsRecordType === desiredType &&
        this.sameStringSet(row.dnsTargetIps, [effectiveAddress]) &&
        row.dnsStatus === 'valid' &&
        row.pendingDnsTargetIp !== effectiveAddress;
      if (primaryMatches && snapshotMatches) return;
      await this.persistReconciledDomainTarget(row, effectiveAddress, desiredType, primary.id);
    } catch (error) {
      await this.db
        .update(domains)
        .set({ dnsStatus: 'invalid', updatedAt: new Date() })
        .where(this.reconciliationTargetCondition(row.id, effectiveAddress));
      await this.auditService.log({
        userId: null,
        action: 'domain.dns_target.reconcile_failed',
        resourceType: 'domain',
        resourceId: row.id,
        details: { nginxNodeId: row.nginxNodeId, targetIps: [effectiveAddress] },
      });
      logger.error('Failed to reconcile tracked Cloudflare domain target', {
        domainId: row.id,
        nginxNodeId: row.nginxNodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async persistReconciledDomainTarget(
    row: typeof domains.$inferSelect,
    effectiveAddress: string,
    desiredType: 'A' | 'AAAA',
    providerRecordId: string
  ) {
    await this.db
      .update(domains)
      .set({
        providerRecordIds: [providerRecordId],
        dnsRecordType: desiredType,
        dnsTargetIps: [effectiveAddress],
        dnsRecords: this.dnsRecordsFromTargetIps([effectiveAddress]),
        dnsStatus: 'valid',
        pendingDnsTargetIp: null,
        updatedAt: new Date(),
      })
      .where(this.reconciliationTargetCondition(row.id, effectiveAddress));
    await this.auditService.log({
      userId: null,
      action: 'domain.dns_target.reconcile',
      resourceType: 'domain',
      resourceId: row.id,
      details: { nginxNodeId: row.nginxNodeId, targetIps: [effectiveAddress], recordIds: [providerRecordId] },
    });
    this.emitDomain(row.id, 'updated', row.domain);
  }

  private async prepareCloudflareDomain(input: PreviewDomainInput): Promise<DomainCloudflarePlan> {
    if (!this.integrationsService) {
      throw new AppError(409, 'CLOUDFLARE_DNS_NOT_CONFIGURED', 'Cloudflare DNS integration is not configured');
    }
    const domainName = input.domain.toLowerCase();
    const nginxNode = await this.resolveRequestedNginxNode(input.nginxNodeId);
    const targetIps = [nginxNode.effectiveAddress];
    const context = await this.integrationsService.resolveCloudflareDnsContext(domainName);
    const ttl = input.ttl ?? context.settings.defaultTtl;
    const proxied = input.proxied ?? context.settings.defaultProxied;
    const existingRecords = (await context.client.listDnsRecords(context.zone.remoteId, domainName)).filter(
      (record) => record.name === domainName
    ) as CloudflareAddressRecord[];
    const addressRecords = existingRecords.filter((record) => record.type === 'A' || record.type === 'AAAA');
    const blockingRecords = existingRecords.filter((record) => record.type === 'CNAME');
    const currentIps = addressRecords.map((record) => record.content).sort();
    const desiredIps = [...targetIps].sort();
    const currentMatches = currentIps.length > 0 && this.sameStringSet(currentIps, desiredIps);
    const desiredRecords = this.desiredCloudflareRecords(domainName, desiredIps, ttl, proxied);
    return {
      domainName,
      nginxNode,
      targetIps,
      ttl,
      proxied,
      context,
      addressRecords,
      blockingRecords,
      currentIps,
      desiredIps,
      currentMatches,
      desiredRecords,
    };
  }

  private async computeDomainDnsStatus(
    row: typeof domains.$inferSelect,
    resolvedRecords: DnsRecords
  ): Promise<'valid' | 'invalid' | 'pending' | 'unknown'> {
    if (row.dnsProvider === 'cloudflare' && row.nginxNodeId) {
      const node = await this.getNginxNodeSummary(row.nginxNodeId);
      if (!node?.effectiveAddress || !this.sameStringSet(row.dnsTargetIps, [node.effectiveAddress])) {
        return 'invalid';
      }
    }
    if (row.dnsProvider !== 'cloudflare') return computeDnsStatus(resolvedRecords);
    const expectedIps = row.dnsTargetIps;
    if (expectedIps.length === 0) return 'unknown';

    if (this.integrationsService && row.integrationConnectorId && row.providerZoneId) {
      const context = await this.integrationsService.getCloudflareDnsContextForRecord(
        row.integrationConnectorId,
        row.providerZoneId
      );
      const providerRecords = await context.client.listDnsRecords(context.zone.remoteId, row.domain);
      const addressRecords = providerRecords.filter((record) => record.type === 'A' || record.type === 'AAAA');
      const providerIps = addressRecords.map((record) => record.content).sort();
      if (!this.sameStringSet(providerIps, [...expectedIps].sort())) return 'invalid';
      if (addressRecords.some((record) => record.proxied === true)) return 'valid';
    }

    const resolvedIps = [...resolvedRecords.a, ...resolvedRecords.aaaa].sort();
    if (resolvedIps.length === 0) return 'pending';
    return this.sameStringSet(resolvedIps, [...expectedIps].sort()) ? 'valid' : 'pending';
  }

  private desiredCloudflareRecords(domain: string, ips: string[], ttl: number, proxied: boolean) {
    return ips.map((ip) => ({
      type: isIP(ip) === 6 ? ('AAAA' as const) : ('A' as const),
      name: domain,
      content: ip,
      ttl,
      proxied,
    }));
  }

  private dnsRecordsFromTargetIps(ips: string[]): DnsRecords {
    return {
      a: ips.filter((ip) => isIP(ip) === 4),
      aaaa: ips.filter((ip) => isIP(ip) === 6),
      cname: [],
      caa: [],
      mx: [],
      txt: [],
    };
  }

  private sameStringSet(left: string[], right: string[]): boolean {
    if (left.length !== right.length) return false;
    const rightSet = new Set(right);
    return left.every((value) => rightSet.has(value));
  }

  private reconciliationTargetCondition(domainId: string, effectiveAddress: string) {
    return and(
      eq(domains.id, domainId),
      or(
        eq(domains.pendingDnsTargetIp, effectiveAddress),
        and(
          isNull(domains.pendingDnsTargetIp),
          sql`${domains.dnsTargetIps} = ${JSON.stringify([effectiveAddress])}::jsonb`
        )
      )
    );
  }

  private recordTypeLabel(ips: string[]): string {
    const types = new Set(ips.map((ip) => (isIP(ip) === 6 ? 'AAAA' : 'A')));
    return [...types].sort().join('/');
  }
}
