import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  databaseConnections,
  dockerComposeProjects,
  dockerDeployments,
  dockerHealthChecks,
  nginxTemplates,
  nodes,
  pageDeployments,
  pageProjects,
  pageTags,
  proxyHosts,
  settings,
  sslCertificates,
  statusPageIncidents,
  statusPageIncidentUpdates,
  statusPageServices,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { type LicensePolicyService, requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type {
  CreateStatusPageIncidentInput,
  CreateStatusPageIncidentUpdateInput,
  CreateStatusPageServiceInput,
  StatusPageSettingsInput,
  UpdateStatusPageIncidentInput,
  UpdateStatusPageServiceInput,
} from './status-page.schemas.js';

const logger = createChildLogger('StatusPageService');
const CONFIG_KEY = 'status-page:config';
const PUBLIC_HEALTH_HISTORY_WINDOW_MS = 192 * 5 * 60 * 1000;

export type StatusPageServiceStatus = 'operational' | 'degraded' | 'outage' | 'unknown' | 'maintenance';
export type StatusPageOverallStatus = 'operational' | 'degraded' | 'outage' | 'maintenance';

export interface StatusPageConfig {
  enabled: boolean;
  title: string;
  description: string;
  domain: string;
  nodeId: string | null;
  sslCertificateId: string | null;
  proxyTemplateId: string | null;
  upstreamUrl: string | null;
  proxyHostId: string | null;
  publicIncidentLimit: number;
  recentIncidentDays: number;
  autoDegradedEnabled: boolean;
  autoOutageEnabled: boolean;
  autoDegradedSeverity: 'info' | 'warning' | 'critical';
  autoOutageSeverity: 'info' | 'warning' | 'critical';
  autoCreateThresholdSeconds: number;
  autoResolveThresholdSeconds: number;
}

export interface PublicStatusPageDto {
  title: string;
  description: string;
  hideExternalBranding: boolean;
  generatedAt: string;
  overallStatus: StatusPageOverallStatus;
  services: Array<{
    id: string;
    name: string;
    description: string | null;
    group: string | null;
    status: StatusPageServiceStatus;
    healthHistory: Array<{ ts: string; status: StatusPageServiceStatus; slow?: boolean }>;
  }>;
  incidents: Array<{
    id: string;
    title: string;
    message: string;
    severity: 'info' | 'warning' | 'critical';
    status: 'active' | 'resolved';
    type: 'automatic' | 'manual';
    startedAt: string;
    resolvedAt: string | null;
    affectedServiceIds: string[];
    updates: Array<{
      id: string;
      status: 'update' | 'investigating' | 'identified' | 'monitoring' | 'resolved';
      message: string;
      createdAt: string;
    }>;
  }>;
}

type StatusPageServiceRow = typeof statusPageServices.$inferSelect;

const DEFAULT_CONFIG: StatusPageConfig = {
  enabled: false,
  title: 'System Status',
  description: '',
  domain: '',
  nodeId: null,
  sslCertificateId: null,
  proxyTemplateId: null,
  upstreamUrl: null,
  proxyHostId: null,
  publicIncidentLimit: 25,
  recentIncidentDays: 14,
  autoDegradedEnabled: true,
  autoOutageEnabled: true,
  autoDegradedSeverity: 'warning',
  autoOutageSeverity: 'critical',
  autoCreateThresholdSeconds: 600,
  autoResolveThresholdSeconds: 60,
};

function normalizeHost(host: string | undefined): string {
  const value = (host ?? '').trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end).replace(/\.+$/, '') : '';
  }
  return (value.split(':')[0] ?? '').replace(/\.+$/, '');
}

function mapStatus(status: string | null | undefined): StatusPageServiceStatus {
  if (status === 'maintenance') return 'maintenance';
  if (status === 'online') return 'operational';
  if (status === 'degraded' || status === 'recovering') return 'degraded';
  if (status === 'offline' || status === 'error') return 'outage';
  return 'unknown';
}

function effectiveNodeStatus(
  status: string | null | undefined,
  history: Array<{ ts?: string; status?: string }> | null | undefined
): string {
  if (status !== 'online' || !history?.length) return status ?? 'unknown';
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  const recent = history.filter((entry) => entry.ts && new Date(entry.ts).getTime() >= fiveMinutesAgo);
  if (recent.some((entry) => entry.status === 'offline' || entry.status === 'degraded')) return 'degraded';
  return 'online';
}

function computeOverall(statuses: StatusPageServiceStatus[]): StatusPageOverallStatus {
  if (statuses.some((status) => status === 'outage')) return 'outage';
  if (statuses.some((status) => status === 'degraded' || status === 'unknown')) return 'degraded';
  if (statuses.some((status) => status === 'maintenance')) return 'maintenance';
  return 'operational';
}

function certCoversDomain(certDomains: string[], domain: string): boolean {
  const normalized = domain.toLowerCase();
  return certDomains.some((candidate) => {
    const certDomain = candidate.toLowerCase();
    if (certDomain === normalized) return true;
    if (!certDomain.startsWith('*.')) return false;
    const suffix = certDomain.slice(2);
    return normalized.endsWith(`.${suffix}`) && normalized.split('.').length === suffix.split('.').length + 1;
  });
}

function sanitizeHistory(
  history: Array<{ ts?: string; status?: string; slow?: boolean }> | null | undefined,
  currentStatus: string | null | undefined
) {
  const cutoff = Date.now() - PUBLIC_HEALTH_HISTORY_WINDOW_MS;
  const entries = (history ?? [])
    .filter((entry): entry is { ts: string; status: string; slow?: boolean } => !!entry.ts && !!entry.status)
    .filter((entry) => new Date(entry.ts).getTime() >= cutoff)
    .map((entry) => ({
      ts: entry.ts,
      status: mapStatus(entry.status),
      ...(entry.slow ? { slow: true } : {}),
    }));
  if (entries.length === 0 && currentStatus && currentStatus !== 'maintenance') {
    entries.push({ ts: new Date().toISOString(), status: mapStatus(currentStatus) });
  }
  return entries;
}

export class StatusPageService {
  private eventBus?: EventBusService;
  private licensePolicy?: LicensePolicyService;
  private frozen = false;
  private frozenHost: string | null = null;
  private lastPublicDto: PublicStatusPageDto | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly proxyService: ProxyService,
    private readonly auditService: AuditService,
    private readonly generalSettings?: GeneralSettingsService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  private emit(action: string, id?: string) {
    this.eventBus?.publish('status-page.changed', { action, id });
  }

  async getConfig(): Promise<StatusPageConfig> {
    const row = await this.db.query.settings.findFirst({
      where: eq(settings.key, CONFIG_KEY),
    });
    return { ...DEFAULT_CONFIG, ...((row?.value as Partial<StatusPageConfig> | undefined) ?? {}) };
  }

  async primePublicHost(): Promise<void> {
    const config = await this.getConfig();
    this.frozenHost = config.enabled && config.domain ? normalizeHost(config.domain) : null;
  }

  isCachedStatusHost(hostHeader: string | undefined): boolean {
    return this.frozenHost !== null && normalizeHost(hostHeader) === this.frozenHost;
  }

  async isStatusHost(hostHeader: string | undefined): Promise<boolean> {
    if (this.frozen) return this.isCachedStatusHost(hostHeader);
    const config = await this.getConfig();
    const configuredHost = config.enabled && config.domain ? normalizeHost(config.domain) : null;
    this.frozenHost = configuredHost;
    return configuredHost !== null && normalizeHost(hostHeader) === configuredHost;
  }

  async updateSettings(
    input: StatusPageSettingsInput,
    userId: string,
    actorScopes: string[] = []
  ): Promise<StatusPageConfig> {
    const previous = await this.getConfig();
    const next: StatusPageConfig = {
      ...previous,
      ...input,
      domain: input.domain !== undefined ? input.domain.trim().toLowerCase() : previous.domain,
      nodeId: input.nodeId === undefined ? previous.nodeId : input.nodeId,
      sslCertificateId: input.sslCertificateId === undefined ? previous.sslCertificateId : input.sslCertificateId,
      proxyTemplateId: input.proxyTemplateId === undefined ? previous.proxyTemplateId : input.proxyTemplateId,
      upstreamUrl:
        input.upstreamUrl === undefined ? previous.upstreamUrl : input.upstreamUrl ? input.upstreamUrl.trim() : null,
    };

    const upstreamChanged = input.upstreamUrl !== undefined && next.upstreamUrl !== previous.upstreamUrl;
    const enablingCustomUpstream = !previous.enabled && next.enabled && Boolean(next.upstreamUrl);
    if ((upstreamChanged || enablingCustomUpstream) && !actorScopes.includes('proxy:raw:write')) {
      throw new AppError(403, 'FORBIDDEN', 'Configuring a custom status page upstream requires proxy:raw:write scope');
    }

    if (!previous.enabled && next.enabled) {
      // LICENSE ENFORCEMENT: Only enabling a new status page requires Personal; existing pages remain manageable.
      await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('status-pages');
    }

    if (next.proxyTemplateId) {
      await this.validateProxyTemplate(next.proxyTemplateId);
    }

    if (previous.enabled && next.enabled && input.nodeId !== undefined && input.nodeId !== previous.nodeId) {
      throw new AppError(
        400,
        'STATUS_PAGE_NODE_CHANGE_REQUIRES_DISABLE',
        'Disable the status page before moving it to another nginx node'
      );
    }

    if (next.enabled) {
      await this.validateEnabledConfig(next);
      const systemHost = await this.proxyService.upsertStatusPageSystemHost(
        {
          domain: next.domain,
          nodeId: next.nodeId!,
          sslCertificateId: next.sslCertificateId,
          nginxTemplateId: next.proxyTemplateId,
          upstreamUrl: next.upstreamUrl,
        },
        userId
      );
      next.proxyHostId = systemHost.id;
    } else if (previous.enabled) {
      await this.proxyService.disableStatusPageSystemHost(userId);
      next.proxyHostId = null;
    }

    await this.db
      .insert(settings)
      .values({ key: CONFIG_KEY, value: next, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } });
    this.frozenHost = next.enabled && next.domain ? normalizeHost(next.domain) : null;

    if (input.autoCreateThresholdSeconds !== undefined || input.autoResolveThresholdSeconds !== undefined) {
      const thresholdUpdate: Partial<typeof statusPageServices.$inferInsert> = { updatedAt: new Date() };
      if (input.autoCreateThresholdSeconds !== undefined) {
        thresholdUpdate.createThresholdSeconds = input.autoCreateThresholdSeconds;
      }
      if (input.autoResolveThresholdSeconds !== undefined) {
        thresholdUpdate.resolveThresholdSeconds = input.autoResolveThresholdSeconds;
      }
      await this.db.update(statusPageServices).set(thresholdUpdate).where(sql`true`);
    }

    await this.auditService.log({
      userId,
      action: 'status_page.settings_update',
      resourceType: 'status_page',
      details: {
        enabled: next.enabled,
        domain: next.domain,
        nodeId: next.nodeId,
        proxyTemplateId: next.proxyTemplateId,
        upstreamUrl: next.upstreamUrl,
        autoCreateThresholdSeconds: next.autoCreateThresholdSeconds,
        autoResolveThresholdSeconds: next.autoResolveThresholdSeconds,
      },
    });
    this.emit('settings_updated');
    return next;
  }

  async listProxyTemplates() {
    return this.db
      .select({
        id: nginxTemplates.id,
        name: nginxTemplates.name,
      })
      .from(nginxTemplates)
      .where(eq(nginxTemplates.type, 'proxy'))
      .orderBy(asc(nginxTemplates.name));
  }

  private async validateEnabledConfig(config: StatusPageConfig): Promise<void> {
    if (!config.domain) throw new AppError(400, 'STATUS_PAGE_DOMAIN_REQUIRED', 'Domain is required');
    if (!config.nodeId) throw new AppError(400, 'STATUS_PAGE_NODE_REQUIRED', 'An online nginx node is required');

    const node = await this.db.query.nodes.findFirst({
      where: and(eq(nodes.id, config.nodeId), eq(nodes.type, 'nginx'), eq(nodes.status, 'online')),
    });
    if (!node) {
      throw new AppError(400, 'STATUS_PAGE_NODE_OFFLINE', 'Status page requires an online nginx node');
    }

    if (config.sslCertificateId) {
      const cert = await this.db.query.sslCertificates.findFirst({
        where: eq(sslCertificates.id, config.sslCertificateId),
      });
      if (!cert || cert.status !== 'active') {
        throw new AppError(400, 'STATUS_PAGE_CERT_INVALID', 'Selected SSL certificate must be active');
      }
      if (!certCoversDomain(cert.domainNames ?? [], config.domain)) {
        throw new AppError(
          400,
          'STATUS_PAGE_CERT_DOMAIN_MISMATCH',
          'Selected SSL certificate does not cover the domain'
        );
      }
    }
  }

  private async validateProxyTemplate(templateId: string): Promise<void> {
    const template = await this.db.query.nginxTemplates.findFirst({
      where: eq(nginxTemplates.id, templateId),
    });
    if (!template) {
      throw new AppError(400, 'STATUS_PAGE_TEMPLATE_INVALID', 'Selected proxy template was not found');
    }
    if (template.type !== 'proxy') {
      throw new AppError(400, 'STATUS_PAGE_TEMPLATE_INVALID', 'Selected proxy template must be a proxy template');
    }
  }

  async listServices() {
    const rows = await this.db.query.statusPageServices.findMany({
      orderBy: [
        asc(statusPageServices.sortOrder),
        asc(statusPageServices.publicGroup),
        asc(statusPageServices.publicName),
      ],
    });
    const sources = await this.resolveSources(rows);
    return rows.map((row) => ({
      ...row,
      source: sources.get(row.id) ?? null,
      currentStatus: sources.get(row.id)?.status ?? 'unknown',
      broken: !sources.has(row.id),
    }));
  }

  async createService(input: CreateStatusPageServiceInput, userId: string) {
    // LICENSE ENFORCEMENT: Shared REST/AI creation must remain behind the Personal entitlement.
    await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('status-pages');
    await this.validateServiceSource(input.sourceType, input.sourceId);
    const config = await this.getConfig();
    const lastService = await this.db.query.statusPageServices.findFirst({
      columns: { sortOrder: true },
      orderBy: [desc(statusPageServices.sortOrder)],
    });
    const [row] = await this.db
      .insert(statusPageServices)
      .values({
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        publicName: input.publicName,
        publicDescription: input.publicDescription ?? null,
        publicGroup: input.publicGroup ?? null,
        sortOrder: input.sortOrder ?? (lastService?.sortOrder ?? -1) + 1,
        enabled: input.enabled ?? true,
        createThresholdSeconds: input.createThresholdSeconds ?? config.autoCreateThresholdSeconds,
        resolveThresholdSeconds: input.resolveThresholdSeconds ?? config.autoResolveThresholdSeconds,
        createdById: userId,
        updatedById: userId,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'status_page.service_create',
      resourceType: 'status_page_service',
      resourceId: row.id,
      details: { sourceType: row.sourceType, sourceId: row.sourceId },
    });
    this.emit('service_created', row.id);
    return row;
  }

  async updateService(id: string, input: UpdateStatusPageServiceInput, userId: string) {
    const existing = await this.db.query.statusPageServices.findFirst({ where: eq(statusPageServices.id, id) });
    if (!existing) throw new AppError(404, 'STATUS_PAGE_SERVICE_NOT_FOUND', 'Status page service not found');

    const [row] = await this.db
      .update(statusPageServices)
      .set({
        ...input,
        publicDescription: input.publicDescription === undefined ? undefined : (input.publicDescription ?? null),
        publicGroup: input.publicGroup === undefined ? undefined : (input.publicGroup ?? null),
        updatedById: userId,
        updatedAt: new Date(),
      })
      .where(eq(statusPageServices.id, id))
      .returning();

    await this.auditService.log({
      userId,
      action: 'status_page.service_update',
      resourceType: 'status_page_service',
      resourceId: id,
      details: { changes: Object.keys(input) },
    });
    this.emit('service_updated', id);
    return row;
  }

  async reorderServices(serviceIds: string[], userId: string) {
    const rows = await this.db.query.statusPageServices.findMany({ columns: { id: true } });
    const existingIds = new Set(rows.map((row) => row.id));
    if (rows.length !== serviceIds.length || serviceIds.some((id) => !existingIds.has(id))) {
      throw new AppError(400, 'STATUS_PAGE_REORDER_INVALID', 'Reorder payload must contain every exposed service once');
    }

    await this.db.transaction(async (tx) => {
      for (const [sortOrder, id] of serviceIds.entries()) {
        await tx
          .update(statusPageServices)
          .set({ sortOrder, updatedById: userId, updatedAt: new Date() })
          .where(eq(statusPageServices.id, id));
      }
    });
    await this.auditService.log({
      userId,
      action: 'status_page.services_reorder',
      resourceType: 'status_page',
      details: { serviceIds },
    });
    this.emit('services_reordered');
    return this.listServices();
  }

  async deleteService(id: string, userId: string): Promise<void> {
    const [existing] = await this.db
      .select({ id: statusPageServices.id })
      .from(statusPageServices)
      .where(eq(statusPageServices.id, id))
      .limit(1);
    if (!existing) throw new AppError(404, 'STATUS_PAGE_SERVICE_NOT_FOUND', 'Status page service not found');

    await this.db.delete(statusPageServices).where(eq(statusPageServices.id, id));
    await this.auditService.log({
      userId,
      action: 'status_page.service_delete',
      resourceType: 'status_page_service',
      resourceId: id,
    });
    this.emit('service_deleted', id);
  }

  private async validateServiceSource(sourceType: string, sourceId: string): Promise<void> {
    if (sourceType === 'node') {
      const node = await this.db.query.nodes.findFirst({ where: eq(nodes.id, sourceId) });
      if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
      return;
    }
    if (sourceType === 'proxy_host') {
      const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, sourceId) });
      if (!host || host.isSystem) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
      if (!host.healthCheckEnabled) {
        throw new AppError(
          400,
          'PROXY_HOST_HEALTH_CHECK_REQUIRED',
          'Exposed proxy hosts must have health checks enabled'
        );
      }
      return;
    }
    if (sourceType === 'docker_container') {
      const check = await this.db.query.dockerHealthChecks.findFirst({ where: eq(dockerHealthChecks.id, sourceId) });
      if (!check || check.target !== 'container') {
        throw new AppError(404, 'DOCKER_HEALTH_CHECK_NOT_FOUND', 'Docker container health check not found');
      }
      if (!check.enabled) {
        throw new AppError(400, 'DOCKER_HEALTH_CHECK_REQUIRED', 'Docker container health checks must be enabled');
      }
      return;
    }
    if (sourceType === 'docker_deployment') {
      const deployment = await this.db.query.dockerDeployments.findFirst({ where: eq(dockerDeployments.id, sourceId) });
      if (!deployment) throw new AppError(404, 'DOCKER_DEPLOYMENT_NOT_FOUND', 'Docker deployment not found');
      const check = await this.db.query.dockerHealthChecks.findFirst({
        where: and(eq(dockerHealthChecks.target, 'deployment'), eq(dockerHealthChecks.deploymentId, sourceId)),
      });
      if (!check?.enabled) {
        throw new AppError(400, 'DOCKER_HEALTH_CHECK_REQUIRED', 'Docker deployment health checks must be enabled');
      }
      return;
    }
    if (sourceType === 'docker_compose_project') {
      const project = await this.db.query.dockerComposeProjects.findFirst({
        where: eq(dockerComposeProjects.id, sourceId),
      });
      if (!project) throw new AppError(404, 'DOCKER_COMPOSE_PROJECT_NOT_FOUND', 'Docker Compose Project not found');
      return;
    }
    if (sourceType === 'pages_project') {
      const project = await this.db.query.pageProjects.findFirst({ where: eq(pageProjects.id, sourceId) });
      if (!project) throw new AppError(404, 'PAGE_PROJECT_NOT_FOUND', 'Page Project not found');
      return;
    }
    const database = await this.db.query.databaseConnections.findFirst({ where: eq(databaseConnections.id, sourceId) });
    if (!database) throw new AppError(404, 'DATABASE_NOT_FOUND', 'Database not found');
  }

  async listIncidents(query: { status?: 'active' | 'resolved' | 'all'; limit?: number; offset?: number }) {
    const conditions = [];
    if (query.status && query.status !== 'all') conditions.push(eq(statusPageIncidents.status, query.status));
    const incidents = await this.db.query.statusPageIncidents.findMany({
      where: conditions.length ? and(...conditions) : undefined,
      orderBy: [desc(statusPageIncidents.startedAt)],
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return this.attachIncidentUpdates(incidents);
  }

  async createManualIncident(input: CreateStatusPageIncidentInput, userId: string) {
    await this.assertServiceIds(input.affectedServiceIds);
    const [row] = await this.db
      .insert(statusPageIncidents)
      .values({
        title: input.title,
        message: input.message,
        severity: input.severity,
        type: 'manual',
        autoManaged: false,
        affectedServiceIds: input.affectedServiceIds,
        startedAt: input.startedAt ? new Date(input.startedAt) : new Date(),
        createdById: userId,
        updatedById: userId,
      })
      .returning();
    await this.auditService.log({
      userId,
      action: 'status_page.incident_create',
      resourceType: 'status_page_incident',
      resourceId: row.id,
      details: { severity: row.severity, affectedServiceIds: row.affectedServiceIds },
    });
    await this.addIncidentUpdate(row.id, {
      message: row.message,
      status: 'update',
      userId,
    });
    this.emit('incident_created', row.id);
    return { ...row, updates: await this.getIncidentUpdates(row.id) };
  }

  async updateIncident(id: string, input: UpdateStatusPageIncidentInput, userId: string) {
    const existing = await this.db.query.statusPageIncidents.findFirst({ where: eq(statusPageIncidents.id, id) });
    if (!existing) throw new AppError(404, 'STATUS_PAGE_INCIDENT_NOT_FOUND', 'Status page incident not found');
    if (input.affectedServiceIds) await this.assertServiceIds(input.affectedServiceIds);

    const resolvedAt = input.status === 'resolved' && existing.status !== 'resolved' ? new Date() : undefined;
    const [row] = await this.db
      .update(statusPageIncidents)
      .set({
        ...input,
        resolvedAt,
        resolvedById: resolvedAt ? userId : undefined,
        updatedById: userId,
        updatedAt: new Date(),
      })
      .where(eq(statusPageIncidents.id, id))
      .returning();
    await this.auditService.log({
      userId,
      action: 'status_page.incident_update',
      resourceType: 'status_page_incident',
      resourceId: id,
      details: { changes: Object.keys(input) },
    });
    if (resolvedAt) {
      await this.addIncidentUpdate(id, {
        message: 'Incident resolved.',
        status: 'resolved',
        userId,
      });
    }
    this.emit('incident_updated', id);
    return { ...row, updates: await this.getIncidentUpdates(id) };
  }

  async deleteIncident(id: string, userId: string): Promise<void> {
    const existing = await this.db.query.statusPageIncidents.findFirst({ where: eq(statusPageIncidents.id, id) });
    if (!existing) throw new AppError(404, 'STATUS_PAGE_INCIDENT_NOT_FOUND', 'Status page incident not found');
    if (existing.status !== 'resolved') {
      throw new AppError(400, 'STATUS_PAGE_INCIDENT_ACTIVE', 'Only resolved incidents can be deleted');
    }

    await this.db.delete(statusPageIncidents).where(eq(statusPageIncidents.id, id));
    await this.auditService.log({
      userId,
      action: 'status_page.incident_delete',
      resourceType: 'status_page_incident',
      resourceId: id,
      details: { severity: existing.severity, type: existing.type },
    });
    this.emit('incident_deleted', id);
  }

  async resolveIncident(id: string, userId: string) {
    return this.updateIncident(id, { status: 'resolved', autoManaged: false }, userId);
  }

  async promoteIncident(id: string, userId: string) {
    return this.updateIncident(id, { autoManaged: false }, userId);
  }

  async createIncidentUpdate(id: string, input: CreateStatusPageIncidentUpdateInput, userId: string) {
    const incident = await this.db.query.statusPageIncidents.findFirst({ where: eq(statusPageIncidents.id, id) });
    if (!incident) throw new AppError(404, 'STATUS_PAGE_INCIDENT_NOT_FOUND', 'Status page incident not found');

    const update = await this.addIncidentUpdate(id, {
      message: input.message,
      status: input.status,
      userId,
    });
    await this.db
      .update(statusPageIncidents)
      .set({ updatedById: userId, updatedAt: new Date() })
      .where(eq(statusPageIncidents.id, id));
    await this.auditService.log({
      userId,
      action: 'status_page.incident_update_create',
      resourceType: 'status_page_incident',
      resourceId: id,
      details: { status: input.status },
    });
    this.emit('incident_update_created', id);
    return update;
  }

  private async addIncidentUpdate(
    incidentId: string,
    input: {
      message: string;
      status: 'update' | 'investigating' | 'identified' | 'monitoring' | 'resolved';
      userId: string | null;
    }
  ) {
    const [row] = await this.db
      .insert(statusPageIncidentUpdates)
      .values({
        incidentId,
        message: input.message,
        status: input.status,
        createdById: input.userId,
      })
      .returning();
    return row;
  }

  private async getIncidentUpdates(incidentId: string) {
    return this.db.query.statusPageIncidentUpdates.findMany({
      where: eq(statusPageIncidentUpdates.incidentId, incidentId),
      orderBy: [asc(statusPageIncidentUpdates.createdAt)],
    });
  }

  private async attachIncidentUpdates<T extends { id: string }>(incidents: T[]) {
    if (incidents.length === 0) return incidents.map((incident) => ({ ...incident, updates: [] }));
    const updates = await this.db.query.statusPageIncidentUpdates.findMany({
      where: inArray(
        statusPageIncidentUpdates.incidentId,
        incidents.map((incident) => incident.id)
      ),
      orderBy: [asc(statusPageIncidentUpdates.createdAt)],
    });
    const byIncident = new Map<string, typeof updates>();
    for (const update of updates) {
      byIncident.set(update.incidentId, [...(byIncident.get(update.incidentId) ?? []), update]);
    }
    return incidents.map((incident) => ({ ...incident, updates: byIncident.get(incident.id) ?? [] }));
  }

  private async assertServiceIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await this.db
      .select({ id: statusPageServices.id })
      .from(statusPageServices)
      .where(inArray(statusPageServices.id, ids));
    if (rows.length !== new Set(ids).size) {
      throw new AppError(400, 'STATUS_PAGE_SERVICE_INVALID', 'One or more affected services do not exist');
    }
  }

  async getPublicDto(): Promise<PublicStatusPageDto | null> {
    if (this.frozen) return this.lastPublicDto;
    const config = await this.getConfig();
    if (!config.enabled) return null;
    const dto = await this.buildSafeDto(config);
    this.lastPublicDto = dto;
    this.frozenHost = config.domain ? normalizeHost(config.domain) : null;
    return dto;
  }

  async freezePublicSnapshot(): Promise<void> {
    if (this.frozen) return;
    try {
      const config = await this.getConfig();
      this.frozenHost = config.enabled && config.domain ? normalizeHost(config.domain) : null;
      this.lastPublicDto = config.enabled ? await this.buildSafeDto(config) : null;
    } catch (error) {
      logger.warn('Failed to refresh public status snapshot before shutdown; using last successful snapshot', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.frozen = true;
    }
  }

  async getPreviewDto(): Promise<PublicStatusPageDto> {
    return this.buildSafeDto(await this.getConfig());
  }

  private async buildSafeDto(config: StatusPageConfig): Promise<PublicStatusPageDto> {
    const rows = await this.db.query.statusPageServices.findMany({
      where: eq(statusPageServices.enabled, true),
      orderBy: [
        asc(statusPageServices.publicGroup),
        asc(statusPageServices.sortOrder),
        asc(statusPageServices.publicName),
      ],
    });
    const sources = await this.resolveSources(rows);
    const services = rows.map((row) => {
      const source = sources.get(row.id);
      const status = mapStatus(source?.rawStatus);
      return {
        id: row.id,
        name: row.publicName,
        description: row.publicDescription,
        group: row.publicGroup,
        status,
        healthHistory: sanitizeHistory(source?.history, source?.rawStatus),
      };
    });

    const publicServiceIds = new Set(services.map((service) => service.id));
    const incidentRows = await this.db.query.statusPageIncidents.findMany({
      where: sql`${statusPageIncidents.status} = 'active' OR ${statusPageIncidents.resolvedAt} > now() - (${config.recentIncidentDays} * interval '1 day')`,
      orderBy: [desc(statusPageIncidents.startedAt)],
      limit: config.publicIncidentLimit,
    });
    const incidents = await this.attachIncidentUpdates(incidentRows);
    const publicIncidents = incidents.flatMap((incident) => {
      const affectedServiceIds = (incident.affectedServiceIds ?? []).filter((id) => publicServiceIds.has(id));
      if ((incident.affectedServiceIds ?? []).length > 0 && affectedServiceIds.length === 0) return [];
      return [{ ...incident, affectedServiceIds }];
    });

    return {
      title: config.title,
      description: config.description,
      hideExternalBranding: (await this.generalSettings?.getConfig())?.hideExternalBranding ?? false,
      generatedAt: new Date().toISOString(),
      overallStatus: computeOverall(services.map((service) => service.status)),
      services,
      incidents: publicIncidents.map((incident) => ({
        id: incident.id,
        title: incident.title,
        message: incident.message,
        severity: incident.severity,
        status: incident.status,
        type: incident.type,
        startedAt: incident.startedAt.toISOString(),
        resolvedAt: incident.resolvedAt?.toISOString() ?? null,
        affectedServiceIds: incident.affectedServiceIds,
        updates: incident.updates.map((update) => ({
          id: update.id,
          status: update.status,
          message: update.message,
          createdAt: update.createdAt.toISOString(),
        })),
      })),
    };
  }

  async resolveSources(rows: StatusPageServiceRow[]) {
    const result = new Map<
      string,
      {
        label: string;
        status: StatusPageServiceStatus;
        rawStatus: string;
        history: Array<{ ts?: string; status?: string; slow?: boolean }>;
      }
    >();

    const nodeIds = rows.filter((row) => row.sourceType === 'node').map((row) => row.sourceId);
    const proxyIds = rows.filter((row) => row.sourceType === 'proxy_host').map((row) => row.sourceId);
    const databaseIds = rows.filter((row) => row.sourceType === 'database').map((row) => row.sourceId);
    const dockerContainerCheckIds = rows
      .filter((row) => row.sourceType === 'docker_container')
      .map((row) => row.sourceId);
    const dockerDeploymentIds = rows.filter((row) => row.sourceType === 'docker_deployment').map((row) => row.sourceId);
    const dockerComposeProjectIds = rows
      .filter((row) => row.sourceType === 'docker_compose_project')
      .map((row) => row.sourceId);
    const pageProjectIds = rows.filter((row) => row.sourceType === 'pages_project').map((row) => row.sourceId);

    const [
      nodeRows,
      proxyRows,
      databaseRows,
      dockerContainerChecks,
      dockerDeploymentsRows,
      dockerDeploymentChecks,
      dockerComposeRows,
      pageProjectRows,
      pageLatestTags,
    ] = await Promise.all([
      nodeIds.length
        ? this.db.select().from(nodes).where(inArray(nodes.id, nodeIds))
        : Promise.resolve([] as Array<typeof nodes.$inferSelect>),
      proxyIds.length
        ? this.db
            .select()
            .from(proxyHosts)
            .where(and(inArray(proxyHosts.id, proxyIds), eq(proxyHosts.isSystem, false)))
        : Promise.resolve([] as Array<typeof proxyHosts.$inferSelect>),
      databaseIds.length
        ? this.db.select().from(databaseConnections).where(inArray(databaseConnections.id, databaseIds))
        : Promise.resolve([] as Array<typeof databaseConnections.$inferSelect>),
      dockerContainerCheckIds.length
        ? this.db.select().from(dockerHealthChecks).where(inArray(dockerHealthChecks.id, dockerContainerCheckIds))
        : Promise.resolve([] as Array<typeof dockerHealthChecks.$inferSelect>),
      dockerDeploymentIds.length
        ? this.db.select().from(dockerDeployments).where(inArray(dockerDeployments.id, dockerDeploymentIds))
        : Promise.resolve([] as Array<typeof dockerDeployments.$inferSelect>),
      dockerDeploymentIds.length
        ? this.db
            .select()
            .from(dockerHealthChecks)
            .where(
              and(
                eq(dockerHealthChecks.target, 'deployment'),
                inArray(dockerHealthChecks.deploymentId, dockerDeploymentIds)
              )
            )
        : Promise.resolve([] as Array<typeof dockerHealthChecks.$inferSelect>),
      dockerComposeProjectIds.length
        ? this.db.select().from(dockerComposeProjects).where(inArray(dockerComposeProjects.id, dockerComposeProjectIds))
        : Promise.resolve([] as Array<typeof dockerComposeProjects.$inferSelect>),
      pageProjectIds.length
        ? this.db.select().from(pageProjects).where(inArray(pageProjects.id, pageProjectIds))
        : Promise.resolve([] as Array<typeof pageProjects.$inferSelect>),
      pageProjectIds.length
        ? this.db
            .select()
            .from(pageTags)
            .where(and(inArray(pageTags.projectId, pageProjectIds), eq(pageTags.name, 'latest')))
        : Promise.resolve([] as Array<typeof pageTags.$inferSelect>),
    ]);
    const pageDeploymentIds = pageLatestTags.flatMap((tag) => (tag.deploymentId ? [tag.deploymentId] : []));
    const pageDeploymentRows = pageDeploymentIds.length
      ? await this.db.select().from(pageDeployments).where(inArray(pageDeployments.id, pageDeploymentIds))
      : [];

    const byNode = new Map(nodeRows.map((row) => [row.id, row]));
    const byProxy = new Map(proxyRows.map((row) => [row.id, row]));
    const byDatabase = new Map(databaseRows.map((row) => [row.id, row]));
    const byDockerContainerCheck = new Map(dockerContainerChecks.map((row) => [row.id, row]));
    const byDockerDeployment = new Map(dockerDeploymentsRows.map((row) => [row.id, row]));
    const byDockerDeploymentCheck = new Map(
      dockerDeploymentChecks.flatMap((row) => (row.deploymentId ? [[row.deploymentId, row] as const] : []))
    );
    const byDockerComposeProject = new Map(dockerComposeRows.map((row) => [row.id, row]));
    const byPageProject = new Map(pageProjectRows.map((row) => [row.id, row]));
    const latestTagByPageProject = new Map(pageLatestTags.map((row) => [row.projectId, row]));
    const byPageDeployment = new Map(pageDeploymentRows.map((row) => [row.id, row]));

    for (const row of rows) {
      if (row.sourceType === 'node') {
        const source = byNode.get(row.sourceId);
        if (!source) continue;
        const rawStatus = effectiveNodeStatus(source.status, source.healthHistory ?? []);
        result.set(row.id, {
          label: source.displayName || source.hostname,
          rawStatus,
          status: mapStatus(rawStatus),
          history: source.healthHistory ?? [],
        });
      } else if (row.sourceType === 'proxy_host') {
        const source = byProxy.get(row.sourceId);
        if (!source) continue;
        const rawStatus = source.maintenanceEnabled ? 'maintenance' : (source.healthStatus ?? 'unknown');
        result.set(row.id, {
          label: source.domainNames?.[0] ?? source.id,
          rawStatus,
          status: mapStatus(rawStatus),
          history: source.healthHistory ?? [],
        });
      } else if (row.sourceType === 'database') {
        const source = byDatabase.get(row.sourceId);
        if (!source) continue;
        result.set(row.id, {
          label: source.name,
          rawStatus: source.healthStatus,
          status: mapStatus(source.healthStatus),
          history: source.healthHistory ?? [],
        });
      } else if (row.sourceType === 'docker_container') {
        const source = byDockerContainerCheck.get(row.sourceId);
        if (!source) continue;
        result.set(row.id, {
          label: source.containerName ?? source.id,
          rawStatus: source.healthStatus,
          status: mapStatus(source.healthStatus),
          history: source.healthHistory ?? [],
        });
      } else if (row.sourceType === 'docker_deployment') {
        const deployment = byDockerDeployment.get(row.sourceId);
        const source = byDockerDeploymentCheck.get(row.sourceId);
        if (!deployment || !source) continue;
        result.set(row.id, {
          label: deployment.name,
          rawStatus: source.healthStatus,
          status: mapStatus(source.healthStatus),
          history: source.healthHistory ?? [],
        });
      } else if (row.sourceType === 'docker_compose_project') {
        const source = byDockerComposeProject.get(row.sourceId);
        if (!source) continue;
        const rawStatus =
          source.availability === 'unavailable' || source.status === 'failed' || source.status === 'missing'
            ? 'offline'
            : source.status === 'running'
              ? 'online'
              : source.status === 'degraded'
                ? 'degraded'
                : source.status === 'stopped'
                  ? 'maintenance'
                  : 'recovering';
        result.set(row.id, {
          label: source.name,
          rawStatus,
          status: mapStatus(rawStatus),
          history: [],
        });
      } else if (row.sourceType === 'pages_project') {
        const source = byPageProject.get(row.sourceId);
        if (!source) continue;
        const latestTag = latestTagByPageProject.get(source.id);
        const deployment = latestTag?.deploymentId ? byPageDeployment.get(latestTag.deploymentId) : null;
        const rawStatus =
          source.migrationStatus === 'failed'
            ? 'error'
            : source.migrationStatus
              ? 'maintenance'
              : deployment?.status === 'ready'
                ? 'online'
                : deployment?.status === 'failed' || deployment?.status === 'deleted'
                  ? 'offline'
                  : deployment
                    ? 'maintenance'
                    : 'unknown';
        result.set(row.id, {
          label: source.name,
          rawStatus,
          status: mapStatus(rawStatus),
          history: [],
        });
      }
    }

    return result;
  }

  async createAutomaticIncident(service: StatusPageServiceRow, status: StatusPageServiceStatus): Promise<void> {
    const existing = await this.findActiveAutomaticIncident(service.id);
    if (existing) return;
    const config = await this.getConfig();
    if (status === 'degraded' && !config.autoDegradedEnabled) return;
    if (status === 'outage' && !config.autoOutageEnabled) return;
    const [row] = await this.db
      .insert(statusPageIncidents)
      .values({
        title: `${service.publicName} is ${status === 'outage' ? 'unavailable' : 'degraded'}`,
        message:
          status === 'outage'
            ? `${service.publicName} is currently unreachable.`
            : `${service.publicName} is currently degraded.`,
        severity: status === 'outage' ? config.autoOutageSeverity : config.autoDegradedSeverity,
        status: 'active',
        type: 'automatic',
        autoManaged: true,
        affectedServiceIds: [service.id],
        createdById: null,
      })
      .returning();
    logger.info('Created automatic status page incident', { incidentId: row.id, serviceId: service.id });
    await this.addIncidentUpdate(row.id, {
      message: row.message,
      status: 'update',
      userId: null,
    });
    this.emit('incident_created', row.id);
  }

  async autoResolveIncident(serviceId: string): Promise<void> {
    const existing = await this.findActiveAutomaticIncident(serviceId);
    if (!existing?.autoManaged) return;
    await this.db
      .update(statusPageIncidents)
      .set({ status: 'resolved', resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(statusPageIncidents.id, existing.id));
    await this.addIncidentUpdate(existing.id, {
      message: 'Incident automatically resolved.',
      status: 'resolved',
      userId: null,
    });
    logger.info('Auto-resolved status page incident', { incidentId: existing.id, serviceId });
    this.emit('incident_resolved', existing.id);
  }

  private async findActiveAutomaticIncident(serviceId: string) {
    return this.db.query.statusPageIncidents.findFirst({
      where: and(
        eq(statusPageIncidents.status, 'active'),
        eq(statusPageIncidents.type, 'automatic'),
        sql`${statusPageIncidents.affectedServiceIds} @> ${JSON.stringify([serviceId])}::jsonb`
      ),
    });
  }
}
