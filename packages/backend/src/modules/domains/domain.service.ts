import { isIP } from 'node:net';
import { asc, count, desc, eq, ilike, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import type { DnsRecords } from '@/db/schema/domains.js';
import { domains } from '@/db/schema/domains.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';
import { sslCertificates } from '@/db/schema/ssl-certificates.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CloudflareClient, CloudflareDnsRecordInput } from '@/modules/integrations/cloudflare-client.js';
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { computeDnsStatus, getPublicIPs, resolveDnsRecords } from './dns.utils.js';
import type {
  CreateDomainInput,
  DeleteDomainInput,
  DomainListQuery,
  PreviewDomainInput,
  UpdateDomainInput,
} from './domain.schemas.js';

const logger = createChildLogger('DomainsService');

export interface DomainUsage {
  proxyHosts: Array<{ id: string; slug: string; domainNames: string[]; enabled: boolean }>;
  sslCertificates: Array<{ id: string; domainNames: string[]; status: string; notAfter: Date | null }>;
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
  targetIps: string[];
  ttl: number;
  proxied: boolean;
  context: {
    connector: { id: string };
    zone: { remoteId: string; name: string };
    settings: { defaultTtl: number; defaultProxied: boolean };
    client: CloudflareClient;
  };
  existingRecords: CloudflareAddressRecord[];
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
  private generalSettingsService?: GeneralSettingsService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  setIntegrationsService(service: IntegrationsService) {
    this.integrationsService = service;
  }

  setGeneralSettingsService(service: GeneralSettingsService) {
    this.generalSettingsService = service;
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
    const usage = await this.getUsage(row.domain);
    return { ...row, usage };
  }

  async createDomain(input: CreateDomainInput, userId: string) {
    const plan = await this.prepareCloudflareDomain(input);
    const {
      domainName,
      targetIps,
      ttl,
      proxied,
      context,
      existingRecords,
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
      throw new AppError(409, 'DOMAIN_DNS_TARGET_MISMATCH', 'Existing Cloudflare DNS record target differs', {
        domain: domainName,
        zoneName: context.zone.name,
        currentRecords: existingRecords.map((record) => ({
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
    return {
      domain: plan.domainName,
      zoneName: plan.context.zone.name,
      connectorId: plan.context.connector.id,
      targetIps: plan.targetIps,
      ttl: plan.ttl,
      proxied: plan.proxied,
      desiredRecords: plan.desiredRecords,
      currentRecords: plan.existingRecords.map((record) => ({
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
    const [row] = await this.db.select().from(domains).where(eq(domains.id, id)).limit(1);
    if (!row) throw new Error('Domain not found');

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
    const jsonContains = sql`${JSON.stringify([domainName])}::jsonb`;
    const wildcardContains = sql`${JSON.stringify([`*.${domainName}`])}::jsonb`;

    const [hosts, certs] = await Promise.all([
      this.db
        .select({
          id: proxyHosts.id,
          slug: proxyHosts.slug,
          domainNames: proxyHosts.domainNames,
          enabled: proxyHosts.enabled,
        })
        .from(proxyHosts)
        .where(sql`${proxyHosts.domainNames} @> ${jsonContains} OR ${proxyHosts.domainNames} @> ${wildcardContains}`),
      this.db
        .select({
          id: sslCertificates.id,
          domainNames: sslCertificates.domainNames,
          status: sslCertificates.status,
          notAfter: sslCertificates.notAfter,
        })
        .from(sslCertificates)
        .where(sql`${sslCertificates.domainNames} @> ${jsonContains}`),
    ]);

    return { proxyHosts: hosts, sslCertificates: certs };
  }

  async searchDomains(query: string) {
    return this.db
      .select({ id: domains.id, domain: domains.domain, dnsStatus: domains.dnsStatus })
      .from(domains)
      .where(ilike(domains.domain, `%${query}%`))
      .orderBy(domains.domain)
      .limit(10);
  }

  private async getGatewayDnsTargetIps(): Promise<string[]> {
    const configured = (await this.generalSettingsService?.getGatewayEndpointSettings())?.gatewayPublicIps ?? [];
    const targetIps = configured.length > 0 ? configured : [...getPublicIPs().ipv4, ...getPublicIPs().ipv6];
    const unique = [...new Set(targetIps)];
    if (unique.length === 0) {
      throw new AppError(
        409,
        'GATEWAY_PUBLIC_IP_UNAVAILABLE',
        'Gateway public IP(s) are not configured and automatic public IP detection has no value'
      );
    }
    return unique;
  }

  private async prepareCloudflareDomain(input: PreviewDomainInput): Promise<DomainCloudflarePlan> {
    if (!this.integrationsService) {
      throw new AppError(409, 'CLOUDFLARE_DNS_NOT_CONFIGURED', 'Cloudflare DNS integration is not configured');
    }
    const domainName = input.domain.toLowerCase();
    const targetIps = await this.getGatewayDnsTargetIps();
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
      targetIps,
      ttl,
      proxied,
      context,
      existingRecords,
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
    if (row.dnsProvider !== 'cloudflare') return computeDnsStatus(resolvedRecords);
    const expectedIps = row.dnsTargetIps.length > 0 ? row.dnsTargetIps : await this.getGatewayDnsTargetIps();
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

  private recordTypeLabel(ips: string[]): string {
    const types = new Set(ips.map((ip) => (isIP(ip) === 6 ? 'AAAA' : 'A')));
    return [...types].sort().join('/');
  }
}
