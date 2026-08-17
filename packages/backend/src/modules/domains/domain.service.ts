import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
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
import { getEffectiveNginxIngressAddresses } from '@/modules/nodes/node-service-address.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import { getRegisteredDomainCandidates } from '@/modules/proxy/proxy-domain-node.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { type DnsAddressResolution, probeDnsRecords } from './dns.utils.js';
import type {
  CreateDomainInput,
  DeleteDomainInput,
  DomainIngressMigrationInput,
  DomainListQuery,
  PreviewDomainInput,
  ResolveCloudflareMigrationInput,
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
  effectiveAddresses?: string[];
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

type DomainExternalPlan = {
  domainName: string;
  nginxNode: EligibleNginxNode;
  targetIps: string[];
  queryName: string;
  dnsRecords: DnsRecords;
  status: 'valid' | 'invalid' | 'pending' | 'unknown';
};

export class DomainsService {
  private eventBus?: EventBusService;
  private integrationsService?: IntegrationsService;
  private nodeRegistry?: NodeRegistryService;
  private proxyService?: ProxyService;
  private ingressReconcileRunning = false;
  private ingressReconcileQueued = false;
  private cloudflareMigrationRunning = false;
  private cloudflareMigrationQueued = false;

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
    bus.subscribe('integration.connector.changed', (payload) => {
      const event = payload as { provider?: string; action?: string } | undefined;
      if (
        event?.provider === 'cloudflare' &&
        ['created', 'updated', 'token-rotated', 'tested', 'synced', 'deleted'].includes(event.action ?? '')
      ) {
        this.queueCloudflareMigration();
      }
    });
  }

  setIntegrationsService(service: IntegrationsService) {
    this.integrationsService = service;
  }

  setNodeRegistryService(service: NodeRegistryService) {
    this.nodeRegistry = service;
  }

  setProxyService(service: ProxyService) {
    this.proxyService = service;
  }

  startIngressTargetReconciliation() {
    this.queueIngressTargetReconciliation();
  }

  startCloudflareMigration() {
    this.queueCloudflareMigration();
  }

  private emitDomain(id: string, action: string, domain?: string) {
    this.eventBus?.publish('domain.changed', { id, action, domain });
  }

  async listDomains(params: DomainListQuery, options?: { allowedIds?: string[] }) {
    const conditions = [];
    if (options?.allowedIds) {
      conditions.push(inArray(domains.id, options.allowedIds));
    }
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

  async previewIngressMigration(id: string, input: DomainIngressMigrationInput) {
    const impact = await this.buildIngressMigrationImpact(id, input.targetNodeId);
    const preview = this.serializeIngressMigrationImpact(impact, impact.pending ? 'waiting_dns' : 'ready');
    if (impact.pending) return preview;
    const targetStatuses = new Map<string, 'valid' | 'invalid' | 'pending' | 'unknown'>();
    for (const domain of impact.domains.filter((candidate) => candidate.dnsProvider !== 'cloudflare')) {
      const probe = await probeDnsRecords(domain.domain);
      targetStatuses.set(
        domain.id,
        this.externalDnsStatus(
          probe.addressResolution,
          probe.records,
          this.getAllowedIngressAddresses(impact.targetNode)
        )
      );
    }
    return {
      ...preview,
      domains: preview.domains.map((domain) => ({
        ...domain,
        dnsStatus: targetStatuses.get(domain.id) ?? domain.dnsStatus,
      })),
    };
  }

  async migrateIngress(id: string, input: DomainIngressMigrationInput, userId: string) {
    if (!this.proxyService) {
      throw new AppError(503, 'PROXY_SERVICE_UNAVAILABLE', 'Proxy host migration is unavailable');
    }

    const impact = await this.buildIngressMigrationImpact(id, input.targetNodeId);
    if (impact.pending) return this.completeIngressMigration(impact, userId);

    if (impact.proxyHosts.some((host) => host.upstreamKind !== 'manual')) {
      for (const domain of impact.domains.filter((candidate) => candidate.dnsProvider !== 'cloudflare')) {
        const probe = await probeDnsRecords(domain.domain);
        const status = this.externalDnsStatus(
          probe.addressResolution,
          probe.records,
          this.getAllowedIngressAddresses(impact.targetNode)
        );
        if (status !== 'valid') {
          throw new AppError(
            409,
            'DOMAIN_INGRESS_EXTERNAL_DNS_NOT_READY',
            'External DNS must point to the target before moving a Docker-backed proxy host',
            {
              domain: domain.domain,
              targetIps: this.getAllowedIngressAddresses(impact.targetNode),
              dnsRecords: probe.records,
              status,
            }
          );
        }
      }
    }

    const migrationId = randomUUID();
    const domainIds = impact.domains.map((domain) => domain.id);
    const proxyHostIds = impact.proxyHosts.map((host) => host.id);
    const movedHostIds: string[] = [];

    await this.db
      .update(domains)
      .set({
        ingressMigrationId: migrationId,
        ingressMigrationSourceNodeId: impact.sourceNode.id,
        ingressMigrationStatus: 'preparing',
        ingressMigrationError: null,
        ingressMigrationProxyHostIds: proxyHostIds,
        ingressMigrationStartedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(domains.id, domainIds));

    try {
      for (const host of impact.proxyHosts) {
        if (host.nodeId === impact.targetNode.id) continue;
        await this.proxyService.updateProxyHost(host.id, { nodeId: impact.targetNode.id }, userId, {
          skipDomainNodeValidation: true,
          preserveFormerNodeConfig: true,
          allowSystemNodeMove: true,
        });
        movedHostIds.push(host.id);
      }

      await this.db
        .update(domains)
        .set({
          nginxNodeId: impact.targetNode.id,
          dnsStatus: 'pending',
          pendingDnsTargetIp: sql`CASE WHEN ${domains.dnsProvider} = 'cloudflare' THEN ${impact.targetNode.effectiveAddress} ELSE NULL END`,
          ingressMigrationStatus: 'waiting_dns',
          updatedAt: new Date(),
        })
        .where(inArray(domains.id, domainIds));

      const migratedRows = await this.db.select().from(domains).where(inArray(domains.id, domainIds));
      for (const row of migratedRows) {
        if (row.dnsProvider === 'cloudflare') {
          await this.reconcileDomainTarget(row, impact.targetNode.effectiveAddress);
        } else {
          await this.refreshExternalMigrationDns(row);
        }
      }

      const pendingImpact = await this.buildIngressMigrationImpact(id, input.targetNodeId);
      return this.completeIngressMigration(pendingImpact, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ingress migration failed';
      logger.error('Domain ingress migration failed; rolling back', {
        domainId: id,
        sourceNodeId: impact.sourceNode.id,
        targetNodeId: impact.targetNode.id,
        error: message,
      });
      await this.rollbackIngressMigration(impact, movedHostIds, userId, message);
      if (error instanceof AppError) throw error;
      throw new AppError(500, 'DOMAIN_INGRESS_MIGRATION_FAILED', message);
    }
  }

  async getNginxNodeOptions() {
    const rows = await this.listNginxNodes();
    const eligibleNodes = rows.flatMap((node) => {
      const effectiveAddresses = this.getNodeEffectiveIngressAddresses(node);
      const effectiveAddress = effectiveAddresses[0];
      return effectiveAddress
        ? [
            {
              id: node.id,
              slug: node.slug,
              hostname: node.hostname,
              displayName: node.displayName,
              appearanceColor: node.appearanceColor,
              effectiveAddress,
              effectiveAddresses,
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
    if (input.dnsProvider === 'external') return this.createExternalDomain(input, userId);

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
    if (input.dnsProvider === 'external') {
      const plan = await this.prepareExternalDomain(input);
      return {
        dnsProvider: 'external' as const,
        domain: plan.domainName,
        nginxNode: plan.nginxNode,
        targetIps: plan.targetIps,
        queryName: plan.queryName,
        dnsRecords: plan.dnsRecords,
        status: plan.status,
      };
    }

    const plan = await this.prepareCloudflareDomain(input);
    const hasBlockingRecord = plan.blockingRecords.length > 0 && !plan.currentMatches;
    const hasMismatch = plan.addressRecords.length > 0 && !plan.currentMatches;
    const relevantRecords = [...plan.addressRecords, ...plan.blockingRecords];
    return {
      dnsProvider: 'cloudflare' as const,
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

  private async createExternalDomain(input: CreateDomainInput, userId: string) {
    const domainName = input.domain.toLowerCase();
    const [existingDomain] = await this.db
      .select({ id: domains.id })
      .from(domains)
      .where(eq(domains.domain, domainName))
      .limit(1);
    if (existingDomain) throw new AppError(409, 'DUPLICATE', 'Domain already exists');

    const plan = await this.prepareExternalDomain(input);
    if (plan.status !== 'valid') {
      throw new AppError(
        409,
        'DOMAIN_DNS_NOT_READY',
        plan.status === 'invalid'
          ? 'Domain DNS does not match the selected Nginx ingress'
          : plan.status === 'unknown'
            ? 'Domain DNS could not be resolved'
            : 'Domain DNS does not have an address record yet',
        {
          domain: plan.domainName,
          queryName: plan.queryName,
          status: plan.status,
          targetIps: plan.targetIps,
          dnsRecords: plan.dnsRecords,
        }
      );
    }

    const [row] = await this.db
      .insert(domains)
      .values({
        domain: plan.domainName,
        description: input.description,
        folderId: input.folderId ?? null,
        dnsStatus: plan.status,
        dnsRecords: plan.dnsRecords,
        lastDnsCheckAt: new Date(),
        dnsProvider: 'legacy',
        dnsOwnership: 'legacy',
        nginxNodeId: plan.nginxNode.id,
        dnsRecordType: this.recordTypeLabel(plan.targetIps),
        dnsTargetIps: plan.targetIps,
        dnsTtl: null,
        dnsProxied: null,
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
        provider: 'external',
        targetIps: plan.targetIps,
        queryName: plan.queryName,
        nginxNodeId: plan.nginxNode.id,
      },
    });
    this.emitDomain(row.id, 'created', row.domain);
    return row;
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
    let reconciliationTarget: string | string[] | undefined = row.pendingDnsTargetIp ?? row.dnsTargetIps;
    if (row.pendingDnsTargetIp && row.nginxNodeId) {
      const node = await this.getNginxNodeSummary(row.nginxNodeId);
      if (!node || !this.getAllowedIngressAddresses(node).includes(row.pendingDnsTargetIp)) {
        reconciliationTarget = undefined;
      }
    }
    if (
      row.dnsProvider === 'cloudflare' &&
      reconciliationTarget &&
      (typeof reconciliationTarget === 'string' || reconciliationTarget.length > 0)
    ) {
      await this.reconcileDomainTarget(row, reconciliationTarget);
      [row] = await this.db.select().from(domains).where(eq(domains.id, id)).limit(1);
      if (!row) throw new Error('Domain not found');
    }

    const probe = await probeDnsRecords(row.domain);
    const dnsRecords = probe.records;
    const dnsStatus = await this.computeDomainDnsStatus(row, dnsRecords, probe.addressResolution);
    const targetUpdate = await this.externalTargetSnapshotUpdate(row, dnsStatus, dnsRecords);

    const [updated] = await this.db
      .update(domains)
      .set({ dnsStatus, dnsRecords, ...targetUpdate, lastDnsCheckAt: new Date(), updatedAt: new Date() })
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
        const probe = await probeDnsRecords(d.domain);
        const dnsRecords = probe.records;
        const dnsStatus = await this.computeDomainDnsStatus(d, dnsRecords, probe.addressResolution);
        const targetUpdate = await this.externalTargetSnapshotUpdate(d, dnsStatus, dnsRecords);
        await this.db
          .update(domains)
          .set({ dnsStatus, dnsRecords, ...targetUpdate, lastDnsCheckAt: new Date(), updatedAt: new Date() })
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

  private async buildIngressMigrationImpact(id: string, targetNodeId: string) {
    const [root] = await this.db.select().from(domains).where(eq(domains.id, id)).limit(1);
    if (!root) throw new AppError(404, 'NOT_FOUND', 'Domain not found');
    const targetNode = await this.resolveRequestedNginxNode(targetNodeId);

    if (root.ingressMigrationId) {
      if (root.nginxNodeId !== targetNode.id) {
        throw new AppError(
          409,
          'DOMAIN_INGRESS_MIGRATION_STATE_INVALID',
          'Stored ingress migration state is incomplete'
        );
      }
      const sourceNode = root.ingressMigrationSourceNodeId
        ? await this.getNginxNodeSummary(root.ingressMigrationSourceNodeId)
        : null;
      const migrationDomains = await this.db
        .select()
        .from(domains)
        .where(eq(domains.ingressMigrationId, root.ingressMigrationId));
      const hostIds = root.ingressMigrationProxyHostIds ?? [];
      const migrationHosts = hostIds.length
        ? await this.db
            .select({
              id: proxyHosts.id,
              slug: proxyHosts.slug,
              domainNames: proxyHosts.domainNames,
              enabled: proxyHosts.enabled,
              nodeId: proxyHosts.nodeId,
              upstreamKind: proxyHosts.upstreamKind,
            })
            .from(proxyHosts)
            .where(inArray(proxyHosts.id, hostIds))
        : [];
      return {
        root,
        sourceNode: sourceNode ?? {
          id: '',
          slug: '',
          hostname: 'Deleted node',
          displayName: 'Deleted node',
          appearanceColor: null,
          effectiveAddress: '',
          effectiveAddresses: [],
        },
        targetNode,
        domains: migrationDomains,
        proxyHosts: migrationHosts,
        pending: true,
        migrationId: root.ingressMigrationId,
      };
    }

    if (!root.nginxNodeId) {
      throw new AppError(409, 'DOMAIN_INGRESS_UNASSIGNED', 'Domain has no assigned Nginx node');
    }
    if (root.nginxNodeId === targetNode.id) {
      throw new AppError(409, 'DOMAIN_INGRESS_ALREADY_ASSIGNED', 'Domain already uses the selected Nginx node');
    }

    const [allDomains, allHosts] = await Promise.all([
      this.db.select().from(domains),
      this.db
        .select({
          id: proxyHosts.id,
          slug: proxyHosts.slug,
          domainNames: proxyHosts.domainNames,
          enabled: proxyHosts.enabled,
          nodeId: proxyHosts.nodeId,
          upstreamKind: proxyHosts.upstreamKind,
        })
        .from(proxyHosts),
    ]);
    const domainsByName = new Map(allDomains.map((domain) => [domain.domain.toLowerCase(), domain]));
    const domainIds = new Set([root.id]);
    const hostIds = new Set<string>();

    let changed = true;
    while (changed) {
      changed = false;
      const registeredNames = new Set(
        allDomains
          .filter((domain) => domainIds.has(domain.id))
          .flatMap((domain) => getRegisteredDomainCandidates([domain.domain]))
      );
      for (const host of allHosts) {
        if (hostIds.has(host.id)) continue;
        if (host.domainNames.some((name) => registeredNames.has(name.trim().toLowerCase()))) {
          hostIds.add(host.id);
          changed = true;
        }
      }
      for (const host of allHosts.filter((candidate) => hostIds.has(candidate.id))) {
        for (const candidate of getRegisteredDomainCandidates(host.domainNames)) {
          const registered = domainsByName.get(candidate);
          if (registered && !domainIds.has(registered.id)) {
            domainIds.add(registered.id);
            changed = true;
          }
        }
      }
    }

    const migrationDomains = allDomains.filter((domain) => domainIds.has(domain.id));
    const migrationHosts = allHosts.filter((host) => hostIds.has(host.id));
    const sourceNodeId = root.nginxNodeId;
    const inconsistentDomain = migrationDomains.find((domain) => domain.nginxNodeId !== sourceNodeId);
    if (inconsistentDomain) {
      throw new AppError(
        409,
        'DOMAIN_INGRESS_GROUP_SPLIT',
        'A related registered domain is assigned to a different Nginx node',
        { domain: inconsistentDomain.domain }
      );
    }
    const inconsistentHost = migrationHosts.find((host) => host.nodeId !== sourceNodeId);
    if (inconsistentHost) {
      throw new AppError(
        409,
        'DOMAIN_INGRESS_HOST_SPLIT',
        'A related proxy host is assigned to a different Nginx node',
        { proxyHostId: inconsistentHost.id }
      );
    }
    const sourceNode = await this.getNginxNodeSummary(sourceNodeId);
    if (!sourceNode) throw new AppError(409, 'DOMAIN_INGRESS_SOURCE_MISSING', 'Source Nginx node no longer exists');

    return {
      root,
      sourceNode,
      targetNode,
      domains: migrationDomains,
      proxyHosts: migrationHosts,
      pending: false,
      migrationId: null,
    };
  }

  private serializeIngressMigrationImpact(
    impact: Awaited<ReturnType<DomainsService['buildIngressMigrationImpact']>>,
    status: 'ready' | 'waiting_dns' | 'cleanup_pending' | 'completed'
  ) {
    return {
      status,
      sourceNode: impact.sourceNode,
      targetNode: impact.targetNode,
      domains: impact.domains.map((domain) => ({
        id: domain.id,
        domain: domain.domain,
        dnsProvider: domain.dnsProvider === 'cloudflare' ? ('cloudflare' as const) : ('external' as const),
        dnsStatus: domain.dnsStatus,
      })),
      proxyHosts: impact.proxyHosts.map((host) => ({
        id: host.id,
        slug: host.slug,
        domainNames: host.domainNames,
        enabled: host.enabled,
      })),
      targetIps: this.getAllowedIngressAddresses(impact.targetNode),
      requiresExternalDnsBeforeMove: impact.proxyHosts.some((host) => host.upstreamKind !== 'manual'),
    };
  }

  private async refreshExternalMigrationDns(row: typeof domains.$inferSelect) {
    const probe = await probeDnsRecords(row.domain);
    const dnsStatus = await this.computeDomainDnsStatus(row, probe.records, probe.addressResolution);
    const targetUpdate = await this.externalTargetSnapshotUpdate(row, dnsStatus, probe.records);
    const [updated] = await this.db
      .update(domains)
      .set({
        dnsStatus,
        dnsRecords: probe.records,
        ...targetUpdate,
        lastDnsCheckAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(domains.id, row.id))
      .returning();
    return updated;
  }

  private async completeIngressMigration(
    impact: Awaited<ReturnType<DomainsService['buildIngressMigrationImpact']>>,
    userId: string
  ) {
    if (!this.proxyService || !impact.migrationId) {
      throw new AppError(409, 'DOMAIN_INGRESS_MIGRATION_NOT_PENDING', 'No ingress migration is waiting to complete');
    }

    const refreshed = [];
    for (const row of impact.domains) {
      if (row.dnsProvider === 'cloudflare') {
        if (row.pendingDnsTargetIp) await this.reconcileDomainTarget(row, impact.targetNode.effectiveAddress);
        const [current] = await this.db.select().from(domains).where(eq(domains.id, row.id)).limit(1);
        if (current) refreshed.push(current);
      } else {
        refreshed.push(await this.refreshExternalMigrationDns(row));
      }
    }

    if (refreshed.some((domain) => domain.dnsStatus !== 'valid')) {
      await this.db
        .update(domains)
        .set({ ingressMigrationStatus: 'waiting_dns', ingressMigrationError: null, updatedAt: new Date() })
        .where(eq(domains.ingressMigrationId, impact.migrationId));
      return this.serializeIngressMigrationImpact({ ...impact, domains: refreshed }, 'waiting_dns');
    }

    let cleanupPending = false;
    for (const host of impact.proxyHosts) {
      if (!impact.sourceNode.id) continue;
      try {
        const cleanup = await this.proxyService.cleanupMigratedHostSource(host.id, impact.sourceNode.id);
        cleanupPending ||= cleanup.orphanedConfigPossible;
      } catch (error) {
        cleanupPending = true;
        logger.warn('Ingress migration source cleanup will retry', {
          migrationId: impact.migrationId,
          proxyHostId: host.id,
          sourceNodeId: impact.sourceNode.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (cleanupPending) {
      await this.db
        .update(domains)
        .set({ ingressMigrationStatus: 'cleanup_pending', updatedAt: new Date() })
        .where(eq(domains.ingressMigrationId, impact.migrationId));
      return this.serializeIngressMigrationImpact({ ...impact, domains: refreshed }, 'cleanup_pending');
    }

    await this.db
      .update(domains)
      .set({
        ingressMigrationId: null,
        ingressMigrationSourceNodeId: null,
        ingressMigrationStatus: null,
        ingressMigrationError: null,
        ingressMigrationProxyHostIds: null,
        ingressMigrationStartedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(domains.ingressMigrationId, impact.migrationId));

    await this.auditService.log({
      userId,
      action: 'domain.ingress_migrate',
      resourceType: 'domain',
      resourceId: impact.root.id,
      details: {
        sourceNodeId: impact.sourceNode.id,
        targetNodeId: impact.targetNode.id,
        domainIds: impact.domains.map((domain) => domain.id),
        proxyHostIds: impact.proxyHosts.map((host) => host.id),
      },
    });
    for (const domain of impact.domains) this.emitDomain(domain.id, 'ingress_migrated', domain.domain);
    return this.serializeIngressMigrationImpact({ ...impact, domains: refreshed }, 'completed');
  }

  private async rollbackIngressMigration(
    impact: Awaited<ReturnType<DomainsService['buildIngressMigrationImpact']>>,
    movedHostIds: string[],
    userId: string,
    message: string
  ) {
    const domainIds = impact.domains.map((domain) => domain.id);
    try {
      await this.db
        .update(domains)
        .set({
          nginxNodeId: impact.sourceNode.id,
          ingressMigrationStatus: 'rolling_back',
          ingressMigrationError: message,
          updatedAt: new Date(),
        })
        .where(inArray(domains.id, domainIds));

      for (const hostId of movedHostIds.reverse()) {
        await this.proxyService?.updateProxyHost(hostId, { nodeId: impact.sourceNode.id }, userId, {
          skipDomainNodeValidation: true,
          allowSystemNodeMove: true,
        });
      }

      const restoredRows = await this.db.select().from(domains).where(inArray(domains.id, domainIds));
      for (const row of restoredRows) {
        if (row.dnsProvider !== 'cloudflare') continue;
        const original = impact.domains.find((domain) => domain.id === row.id);
        const sourceAddress = original?.dnsTargetIps[0] || impact.sourceNode.effectiveAddress;
        if (!sourceAddress) continue;
        const [prepared] = await this.db
          .update(domains)
          .set({ pendingDnsTargetIp: sourceAddress, updatedAt: new Date() })
          .where(eq(domains.id, row.id))
          .returning();
        await this.reconcileDomainTarget(prepared, sourceAddress);
      }

      await this.db
        .update(domains)
        .set({
          ingressMigrationId: null,
          ingressMigrationSourceNodeId: null,
          ingressMigrationStatus: null,
          ingressMigrationError: null,
          ingressMigrationProxyHostIds: null,
          ingressMigrationStartedAt: null,
          updatedAt: new Date(),
        })
        .where(inArray(domains.id, domainIds));
    } catch (rollbackError) {
      logger.error('Domain ingress migration rollback failed', {
        domainId: impact.root.id,
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
      await this.db
        .update(domains)
        .set({ ingressMigrationStatus: 'failed', ingressMigrationError: message, updatedAt: new Date() })
        .where(inArray(domains.id, domainIds));
    }
  }

  async searchDomains(query: string, options?: { allowedIds?: string[] }) {
    const conditions = [ilike(domains.domain, `%${query}%`)];
    if (options?.allowedIds) conditions.push(inArray(domains.id, options.allowedIds));
    return this.db
      .select({
        id: domains.id,
        domain: domains.domain,
        dnsStatus: domains.dnsStatus,
        dnsProvider: domains.dnsProvider,
        nginxNodeId: domains.nginxNodeId,
      })
      .from(domains)
      .where(and(...conditions))
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
        secondaryServiceAddress: nodes.secondaryServiceAddress,
        lastHealthReport: nodes.lastHealthReport,
        createdAt: nodes.createdAt,
      })
      .from(nodes)
      .where(eq(nodes.type, 'nginx'))
      .orderBy(asc(nodes.createdAt), asc(nodes.id));
  }

  private getNodeEffectiveIngressAddresses(node: {
    id: string;
    serviceAddress: string | null;
    secondaryServiceAddress: string | null;
    lastHealthReport: (typeof nodes.$inferSelect)['lastHealthReport'];
  }): string[] {
    return getEffectiveNginxIngressAddresses({
      serviceAddress: node.serviceAddress,
      secondaryServiceAddress: node.secondaryServiceAddress,
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
    return row ? { ...row, effectiveAddress: '', effectiveAddresses: [] } : null;
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

  private queueCloudflareMigration() {
    if (this.cloudflareMigrationRunning) {
      this.cloudflareMigrationQueued = true;
      return;
    }
    this.cloudflareMigrationRunning = true;
    void this.migrateExternalDomainsToCloudflare()
      .catch((error) => {
        logger.error('External Domain Cloudflare migration failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.cloudflareMigrationRunning = false;
        if (this.cloudflareMigrationQueued) {
          this.cloudflareMigrationQueued = false;
          this.queueCloudflareMigration();
        }
      });
  }

  async migrateExternalDomainsToCloudflare() {
    if (!this.integrationsService) return;
    if (!(await this.integrationsService.hasEnabledCloudflareConnector())) {
      await this.clearExternalCloudflareMigrationStatuses();
      return;
    }
    await this.backfillNginxNodeAssignments();
    const externalDomains = await this.db.select().from(domains).where(eq(domains.dnsProvider, 'legacy'));
    for (const row of externalDomains) {
      if (row.cloudflareMigrationStatus === 'ignored') continue;
      await this.migrateExternalDomainToCloudflare(row);
    }
  }

  async resolveCloudflareMigration(id: string, input: ResolveCloudflareMigrationInput, userId: string) {
    const [row] = await this.db.select().from(domains).where(eq(domains.id, id)).limit(1);
    if (!row) throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found');
    if (row.dnsProvider !== 'legacy') {
      throw new AppError(409, 'DOMAIN_ALREADY_CLOUDFLARE_MANAGED', 'Domain is already managed by Cloudflare');
    }

    if (input.action === 'keep_external') {
      const checkedAt = new Date();
      await this.setCloudflareMigrationStatus(row, 'ignored', checkedAt);
      await this.auditService.log({
        userId,
        action: 'domain.cloudflare_migration.keep_external',
        resourceType: 'domain',
        resourceId: row.id,
        details: { domain: row.domain },
      });
      return this.getDomain(id);
    }

    if (input.action === 'retry') {
      await this.migrateExternalDomainToCloudflare(row);
      return this.getDomain(id);
    }

    if (!this.integrationsService) {
      throw new AppError(409, 'CLOUDFLARE_DNS_NOT_CONFIGURED', 'Cloudflare DNS integration is not configured');
    }
    const nginxNode = await this.resolveRequestedNginxNode(input.nginxNodeId);
    const context = await this.integrationsService.resolveCloudflareDnsContext(row.domain);
    const providerRecords = (await context.client.listDnsRecords(context.zone.remoteId, row.domain)).filter(
      (record) => record.name.toLowerCase() === row.domain.toLowerCase()
    );
    const addressRecords = providerRecords.filter((record) => record.type === 'A' || record.type === 'AAAA');
    if (providerRecords.some((record) => record.type === 'CNAME')) {
      throw new AppError(
        409,
        'CLOUDFLARE_DNS_RECORD_CONFLICT',
        'Remove the existing CNAME before Gateway can update this domain'
      );
    }

    const primary = addressRecords[0];
    const ttl = primary?.ttl ?? row.dnsTtl ?? context.settings.defaultTtl;
    const proxied = primary?.proxied ?? row.dnsProxied ?? context.settings.defaultProxied;
    const existingIps = addressRecords.map((record) => record.content).sort();
    const existingMatches = this.isNonEmptySubset(existingIps, this.getAllowedIngressAddresses(nginxNode));
    const desiredType = isIP(nginxNode.effectiveAddress) === 6 ? ('AAAA' as const) : ('A' as const);
    let providerRecordIds: string[];
    let targetIps: string[];
    let ownership: 'matched_existing' | 'overwritten' | 'created';

    if (existingMatches) {
      providerRecordIds = addressRecords.map((record) => record.id);
      targetIps = existingIps;
      ownership = 'matched_existing';
    } else if (primary) {
      const updated = await context.client.updateDnsRecord(context.zone.remoteId, primary.id, {
        type: desiredType,
        name: row.domain,
        content: nginxNode.effectiveAddress,
        ttl,
        proxied,
      });
      providerRecordIds = [updated.id];
      targetIps = [nginxNode.effectiveAddress];
      ownership = 'overwritten';
      for (const extra of addressRecords.slice(1)) {
        await context.client.deleteDnsRecord(context.zone.remoteId, extra.id);
      }
    } else {
      const created = await context.client.createDnsRecord(context.zone.remoteId, {
        type: desiredType,
        name: row.domain,
        content: nginxNode.effectiveAddress,
        ttl,
        proxied,
        comment: `wiolett-gateway:domain:${row.id}`,
      });
      providerRecordIds = [created.id];
      targetIps = [nginxNode.effectiveAddress];
      ownership = 'created';
    }

    const checkedAt = new Date();
    const [migrated] = await this.db
      .update(domains)
      .set({
        dnsProvider: 'cloudflare',
        dnsOwnership: ownership,
        integrationConnectorId: context.connector.id,
        providerZoneId: context.zone.remoteId,
        providerZoneName: context.zone.name,
        providerRecordIds,
        dnsRecordType: this.recordTypeLabel(targetIps),
        dnsTargetIps: targetIps,
        dnsRecords: this.dnsRecordsFromTargetIps(targetIps),
        dnsTtl: ttl,
        dnsProxied: proxied,
        nginxNodeId: nginxNode.id,
        pendingDnsTargetIp: null,
        cloudflareMigrationStatus: 'migrated',
        cloudflareMigrationCheckedAt: checkedAt,
        dnsStatus: 'valid',
        updatedAt: checkedAt,
      })
      .where(and(eq(domains.id, row.id), eq(domains.dnsProvider, 'legacy')))
      .returning();
    if (!migrated) {
      throw new AppError(409, 'DOMAIN_MIGRATION_STATE_CHANGED', 'Domain migration state changed; reload and retry');
    }
    await this.auditService.log({
      userId,
      action: 'domain.cloudflare_migration.resolve_conflict',
      resourceType: 'domain',
      resourceId: row.id,
      details: {
        domain: row.domain,
        nginxNodeId: nginxNode.id,
        targetIps,
        recordIds: providerRecordIds,
        ownership,
      },
    });
    this.emitDomain(row.id, 'updated', row.domain);
    return this.getDomain(id);
  }

  private async clearExternalCloudflareMigrationStatuses() {
    const resettableMigration = and(
      eq(domains.dnsProvider, 'legacy'),
      isNotNull(domains.cloudflareMigrationStatus),
      sql`${domains.cloudflareMigrationStatus} <> 'ignored'`
    );
    const staleDomains = await this.db
      .select({ id: domains.id, domain: domains.domain })
      .from(domains)
      .where(resettableMigration);
    if (staleDomains.length === 0) return;

    await this.db
      .update(domains)
      .set({ cloudflareMigrationStatus: null, cloudflareMigrationCheckedAt: null, updatedAt: new Date() })
      .where(resettableMigration);
    for (const domain of staleDomains) this.emitDomain(domain.id, 'updated', domain.domain);
  }

  private async migrateExternalDomainToCloudflare(row: typeof domains.$inferSelect) {
    const checkedAt = new Date();
    await this.setCloudflareMigrationStatus(row, 'pending', checkedAt);
    if (!row.nginxNodeId) {
      await this.setCloudflareMigrationStatus(row, 'ingress_unavailable', checkedAt);
      return;
    }
    const node = await this.getNginxNodeSummary(row.nginxNodeId);
    if (!node?.effectiveAddress) {
      await this.setCloudflareMigrationStatus(row, 'ingress_unavailable', checkedAt);
      return;
    }

    try {
      const context = await this.integrationsService!.resolveCloudflareDnsContext(row.domain);
      const providerRecords = (await context.client.listDnsRecords(context.zone.remoteId, row.domain)).filter(
        (record) => record.name.toLowerCase() === row.domain.toLowerCase()
      );
      const addressRecords = providerRecords.filter((record) => record.type === 'A' || record.type === 'AAAA');
      const blockingRecords = providerRecords.filter((record) => record.type === 'CNAME');
      const providerIps = addressRecords.map((record) => record.content).sort();
      if (blockingRecords.length > 0 || !this.isNonEmptySubset(providerIps, this.getAllowedIngressAddresses(node))) {
        await this.setCloudflareMigrationStatus(row, 'dns_conflict', checkedAt);
        return;
      }
      const targetIps = providerIps;

      const primaryRecord = addressRecords[0]!;
      const [migrated] = await this.db
        .update(domains)
        .set({
          dnsProvider: 'cloudflare',
          dnsOwnership: 'matched_existing',
          integrationConnectorId: context.connector.id,
          providerZoneId: context.zone.remoteId,
          providerZoneName: context.zone.name,
          providerRecordIds: addressRecords.map((record) => record.id),
          dnsRecordType: this.recordTypeLabel(targetIps),
          dnsTargetIps: targetIps,
          dnsTtl: primaryRecord.ttl,
          dnsProxied: primaryRecord.proxied ?? false,
          pendingDnsTargetIp: null,
          cloudflareMigrationStatus: 'migrated',
          cloudflareMigrationCheckedAt: checkedAt,
          dnsStatus: 'valid',
          updatedAt: new Date(),
        })
        .where(and(eq(domains.id, row.id), eq(domains.dnsProvider, 'legacy')))
        .returning();
      if (!migrated) return;
      await this.auditService.log({
        userId: null,
        action: 'domain.cloudflare_migration.migrate',
        resourceType: 'domain',
        resourceId: row.id,
        details: {
          domain: row.domain,
          connectorId: context.connector.id,
          zoneId: context.zone.remoteId,
          recordIds: addressRecords.map((record) => record.id),
          targetIps,
        },
      });
      this.emitDomain(row.id, 'updated', row.domain);
    } catch (error) {
      const code = error instanceof AppError ? error.code : undefined;
      await this.setCloudflareMigrationStatus(
        row,
        code === 'CLOUDFLARE_ZONE_NOT_FOUND'
          ? 'zone_unavailable'
          : code === 'CLOUDFLARE_ZONE_AMBIGUOUS'
            ? 'zone_ambiguous'
            : 'error',
        checkedAt
      );
    }
  }

  private async setCloudflareMigrationStatus(
    row: typeof domains.$inferSelect,
    status: NonNullable<typeof domains.$inferInsert.cloudflareMigrationStatus>,
    checkedAt: Date
  ) {
    await this.db
      .update(domains)
      .set({ cloudflareMigrationStatus: status, cloudflareMigrationCheckedAt: checkedAt, updatedAt: new Date() })
      .where(and(eq(domains.id, row.id), eq(domains.dnsProvider, 'legacy')));
    if (status !== 'pending') this.emitDomain(row.id, 'updated', row.domain);
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
      if (!node?.effectiveAddress || this.getAllowedIngressAddresses(node).length === 0) {
        if (row.dnsStatus !== 'invalid') {
          await this.db
            .update(domains)
            .set({ dnsStatus: 'invalid', updatedAt: new Date() })
            .where(eq(domains.id, row.id));
          this.emitDomain(row.id, 'updated', row.domain);
        }
        continue;
      }
      if (row.dnsProvider !== 'cloudflare') {
        const probe = await probeDnsRecords(row.domain);
        const dnsStatus = this.externalDnsStatus(
          probe.addressResolution,
          probe.records,
          this.getAllowedIngressAddresses(node)
        );
        const targetUpdate = await this.externalTargetSnapshotUpdate(row, dnsStatus, probe.records);
        await this.db
          .update(domains)
          .set({
            dnsStatus,
            dnsRecords: probe.records,
            ...targetUpdate,
            lastDnsCheckAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(domains.id, row.id));
        this.emitDomain(row.id, 'updated', row.domain);
        continue;
      }
      const effectiveTargetChanged = !this.isNonEmptySubset(row.dnsTargetIps, this.getAllowedIngressAddresses(node));
      const hasDurableRetargetApproval = row.pendingDnsTargetIp === node.effectiveAddress;
      let reconciliationRow = row;
      if (effectiveTargetChanged && !hasDurableRetargetApproval) {
        const [approved] = await this.db
          .update(domains)
          .set({ pendingDnsTargetIp: node.effectiveAddress, updatedAt: new Date() })
          .where(
            and(eq(domains.id, row.id), eq(domains.nginxNodeId, row.nginxNodeId), eq(domains.dnsProvider, 'cloudflare'))
          )
          .returning();
        if (!approved) continue;
        reconciliationRow = approved;
      }
      await this.reconcileDomainTarget(
        reconciliationRow,
        effectiveTargetChanged ? node.effectiveAddress : row.dnsTargetIps
      );
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

  private async reconcileDomainTarget(row: typeof domains.$inferSelect, target: string | string[]) {
    const targetIps = Array.from(new Set(Array.isArray(target) ? target : [target]));
    const primaryTarget = targetIps[0];
    if (!primaryTarget) return;
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
      const firstOwned = ownedAddressRecords[0];
      const desiredTtl = row.dnsTtl ?? firstOwned?.ttl ?? 1;
      const desiredProxied = row.dnsProxied ?? firstOwned?.proxied ?? false;
      const unusedOwned = [...ownedAddressRecords];
      const providerRecordIds: string[] = [];
      let providerChanged = false;
      for (const targetIp of targetIps) {
        const desiredType = isIP(targetIp) === 6 ? ('AAAA' as const) : ('A' as const);
        let recordIndex = unusedOwned.findIndex((record) => record.type === desiredType && record.content === targetIp);
        if (recordIndex < 0 && unusedOwned.length > 0) recordIndex = 0;
        const record = recordIndex >= 0 ? unusedOwned.splice(recordIndex, 1)[0] : undefined;
        if (!record) {
          const created = await context.client.createDnsRecord(context.zone.remoteId, {
            type: desiredType,
            name: row.domain,
            content: targetIp,
            ttl: desiredTtl,
            proxied: desiredProxied,
            comment: recoveryComment,
          });
          providerRecordIds.push(created.id);
          providerChanged = true;
          continue;
        }
        const matches =
          record.type === desiredType &&
          record.name === row.domain &&
          record.content === targetIp &&
          record.ttl === desiredTtl &&
          (record.proxied ?? false) === desiredProxied;
        if (!matches) {
          await context.client.updateDnsRecord(context.zone.remoteId, record.id, {
            type: desiredType,
            name: row.domain,
            content: targetIp,
            ttl: desiredTtl,
            proxied: desiredProxied,
          });
          providerChanged = true;
        }
        providerRecordIds.push(record.id);
      }
      for (const record of unusedOwned) {
        await context.client.deleteDnsRecord(context.zone.remoteId, record.id);
        providerChanged = true;
      }
      const snapshotMatches =
        this.sameStringSet(row.providerRecordIds, providerRecordIds) &&
        row.dnsRecordType === this.recordTypeLabel(targetIps) &&
        this.sameStringSet(row.dnsTargetIps, targetIps) &&
        row.dnsStatus === 'valid' &&
        row.pendingDnsTargetIp === null;
      if (!providerChanged && snapshotMatches) return;
      await this.persistReconciledDomainTarget(row, targetIps, providerRecordIds);
    } catch (error) {
      await this.db
        .update(domains)
        .set({ dnsStatus: 'invalid', updatedAt: new Date() })
        .where(this.reconciliationTargetCondition(row.id, targetIps));
      await this.auditService.log({
        userId: null,
        action: 'domain.dns_target.reconcile_failed',
        resourceType: 'domain',
        resourceId: row.id,
        details: { nginxNodeId: row.nginxNodeId, targetIps },
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
    targetIps: string[],
    providerRecordIds: string[]
  ) {
    await this.db
      .update(domains)
      .set({
        providerRecordIds,
        dnsRecordType: this.recordTypeLabel(targetIps),
        dnsTargetIps: targetIps,
        dnsRecords: this.dnsRecordsFromTargetIps(targetIps),
        dnsStatus: 'valid',
        pendingDnsTargetIp: null,
        updatedAt: new Date(),
      })
      .where(this.reconciliationTargetCondition(row.id, targetIps));
    await this.auditService.log({
      userId: null,
      action: 'domain.dns_target.reconcile',
      resourceType: 'domain',
      resourceId: row.id,
      details: { nginxNodeId: row.nginxNodeId, targetIps, recordIds: providerRecordIds },
    });
    this.emitDomain(row.id, 'updated', row.domain);
  }

  private async prepareCloudflareDomain(input: PreviewDomainInput): Promise<DomainCloudflarePlan> {
    if (!this.integrationsService) {
      throw new AppError(409, 'CLOUDFLARE_DNS_NOT_CONFIGURED', 'Cloudflare DNS integration is not configured');
    }
    const domainName = input.domain.toLowerCase();
    const nginxNode = await this.resolveRequestedNginxNode(input.nginxNodeId);
    const primaryTargetIps = [nginxNode.effectiveAddress];
    const context = await this.integrationsService.resolveCloudflareDnsContext(domainName);
    const ttl = input.ttl ?? context.settings.defaultTtl;
    const proxied = input.proxied ?? context.settings.defaultProxied;
    const existingRecords = (await context.client.listDnsRecords(context.zone.remoteId, domainName)).filter(
      (record) => record.name === domainName
    ) as CloudflareAddressRecord[];
    const addressRecords = existingRecords.filter((record) => record.type === 'A' || record.type === 'AAAA');
    const blockingRecords = existingRecords.filter((record) => record.type === 'CNAME');
    const currentIps = addressRecords.map((record) => record.content).sort();
    const currentMatches = this.isNonEmptySubset(currentIps, this.getAllowedIngressAddresses(nginxNode));
    const targetIps = currentMatches ? currentIps : primaryTargetIps;
    const desiredIps = [...targetIps].sort();
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

  private async prepareExternalDomain(input: PreviewDomainInput): Promise<DomainExternalPlan> {
    const domainName = input.domain.toLowerCase();
    const nginxNode = await this.resolveRequestedNginxNode(input.nginxNodeId);
    const probe = await probeDnsRecords(domainName);
    const status = this.externalDnsStatus(
      probe.addressResolution,
      probe.records,
      this.getAllowedIngressAddresses(nginxNode)
    );
    const resolvedIps = [...probe.records.a, ...probe.records.aaaa].sort();
    const targetIps = status === 'valid' ? resolvedIps : this.getAllowedIngressAddresses(nginxNode);
    return {
      domainName,
      nginxNode,
      targetIps,
      queryName: probe.queryName,
      dnsRecords: probe.records,
      status,
    };
  }

  private externalDnsStatus(
    addressResolution: DnsAddressResolution,
    records: DnsRecords,
    allowedIps: string[]
  ): 'valid' | 'invalid' | 'pending' | 'unknown' {
    if (addressResolution === 'error') return 'unknown';
    const resolvedIps = [...records.a, ...records.aaaa].sort();
    if (resolvedIps.length === 0) return 'pending';
    return this.isNonEmptySubset(resolvedIps, allowedIps) ? 'valid' : 'invalid';
  }

  private async computeDomainDnsStatus(
    row: typeof domains.$inferSelect,
    resolvedRecords: DnsRecords,
    addressResolution: DnsAddressResolution = 'resolved'
  ): Promise<'valid' | 'invalid' | 'pending' | 'unknown'> {
    if (row.dnsProvider === 'cloudflare' && row.nginxNodeId) {
      const node = await this.getNginxNodeSummary(row.nginxNodeId);
      if (!node?.effectiveAddress || !this.isNonEmptySubset(row.dnsTargetIps, this.getAllowedIngressAddresses(node))) {
        return 'invalid';
      }
    }
    if (row.dnsProvider !== 'cloudflare') {
      if (!row.nginxNodeId) return 'unknown';
      const node = await this.getNginxNodeSummary(row.nginxNodeId);
      if (!node?.effectiveAddress) return 'invalid';
      return this.externalDnsStatus(addressResolution, resolvedRecords, this.getAllowedIngressAddresses(node));
    }
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

  private async externalTargetSnapshotUpdate(
    row: typeof domains.$inferSelect,
    dnsStatus: 'valid' | 'invalid' | 'pending' | 'unknown',
    resolvedRecords: DnsRecords
  ): Promise<Partial<typeof domains.$inferInsert>> {
    if (row.dnsProvider === 'cloudflare' || dnsStatus !== 'valid' || !row.nginxNodeId) return {};
    const node = await this.getNginxNodeSummary(row.nginxNodeId);
    if (!node?.effectiveAddress) return {};
    const resolvedIps = [...resolvedRecords.a, ...resolvedRecords.aaaa].sort();
    if (!this.isNonEmptySubset(resolvedIps, this.getAllowedIngressAddresses(node))) return {};
    if (this.sameStringSet(row.dnsTargetIps, resolvedIps)) return {};
    return {
      dnsTargetIps: resolvedIps,
      dnsRecordType: this.recordTypeLabel(resolvedIps),
      pendingDnsTargetIp: null,
    };
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

  private isNonEmptySubset(values: string[], allowedValues: string[]): boolean {
    if (values.length === 0) return false;
    const allowed = new Set(allowedValues);
    return values.every((value) => allowed.has(value));
  }

  private getAllowedIngressAddresses(node: Pick<EligibleNginxNode, 'effectiveAddress' | 'effectiveAddresses'>) {
    return node.effectiveAddresses?.length
      ? node.effectiveAddresses
      : node.effectiveAddress
        ? [node.effectiveAddress]
        : [];
  }

  private reconciliationTargetCondition(domainId: string, targetIps: string[]) {
    const primaryTarget = targetIps[0];
    return and(
      eq(domains.id, domainId),
      or(
        ...(primaryTarget ? [eq(domains.pendingDnsTargetIp, primaryTarget)] : []),
        and(isNull(domains.pendingDnsTargetIp), sql`${domains.dnsTargetIps} = ${JSON.stringify(targetIps)}::jsonb`)
      )
    );
  }

  private recordTypeLabel(ips: string[]): string {
    const types = new Set(ips.map((ip) => (isIP(ip) === 6 ? 'AAAA' : 'A')));
    return [...types].sort().join('/');
  }
}
