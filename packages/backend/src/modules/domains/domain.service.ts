import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { domains } from '@/db/schema/domains.js';
import { pageWildcardProfiles } from '@/db/schema/pages.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';
import { sslCertificates } from '@/db/schema/ssl-certificates.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import { getRegisteredDomainCandidates } from '@/modules/proxy/proxy-domain-node.js';
import { probeDnsRecords } from './dns.utils.js';
import type {
  CreateDomainInput,
  DeleteDomainInput,
  DomainIngressMigrationInput,
  DomainListQuery,
  PreviewDomainInput,
  UpdateDomainInput,
} from './domain.schemas.js';
import { DomainsServiceRuntime } from './domain.service.runtime.js';
import { type DomainUsage, logger } from './domain.service.shared.js';

export * from './domain.service.shared.js';

export class DomainsService extends DomainsServiceRuntime {
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
            'External DNS must point to the target before moving a managed Route',
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
          allowPagesNodeMove: host.upstreamKind === 'pages',
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

      await this.pageProfileService?.migrateDomainIngress(domainIds, impact.targetNode.id, userId);

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

  protected async createExternalDomain(input: CreateDomainInput, userId: string) {
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

    const [pagesProfile] = await this.db
      .select({ id: pageWildcardProfiles.id })
      .from(pageWildcardProfiles)
      .where(and(eq(pageWildcardProfiles.domainId, id), eq(pageWildcardProfiles.enabled, true)))
      .limit(1);
    if (pagesProfile) {
      throw new AppError(409, 'DOMAIN_IN_USE', 'Domain is in use by the Pages wildcard profile', {
        pagesProfileId: pagesProfile.id,
      });
    }

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
    const providerRecords = await this.getManagedCloudflareDnsRecords(row);
    const dnsRecords = this.dnsRecordsForSnapshot(row, probe.records, providerRecords);
    const dnsStatus = await this.computeDomainDnsStatus(row, probe.records, probe.addressResolution, providerRecords);
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
        const providerRecords = await this.getManagedCloudflareDnsRecords(d);
        const dnsRecords = this.dnsRecordsForSnapshot(d, probe.records, providerRecords);
        const dnsStatus = await this.computeDomainDnsStatus(d, probe.records, probe.addressResolution, providerRecords);
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

  protected async buildIngressMigrationImpact(id: string, targetNodeId: string) {
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

  protected serializeIngressMigrationImpact(
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

  protected async refreshExternalMigrationDns(row: typeof domains.$inferSelect) {
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

  protected async completeIngressMigration(
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
    try {
      await this.pageProfileService?.cleanupMigratedSource(
        impact.domains.map((domain) => domain.id),
        impact.sourceNode.id
      );
    } catch (error) {
      // Target delivery is already live and Gateway retains the canonical artifact.
      // An unavailable source can therefore be cleaned after it reconnects.
      cleanupPending = true;
      logger.warn('Pages preview source cleanup was deferred', {
        migrationId: impact.migrationId,
        sourceNodeId: impact.sourceNode.id,
        error: error instanceof Error ? error.message : String(error),
      });
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

  protected async rollbackIngressMigration(
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
          allowPagesNodeMove: true,
        });
      }

      await this.pageProfileService?.migrateDomainIngress(domainIds, impact.sourceNode.id, userId);

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
}
