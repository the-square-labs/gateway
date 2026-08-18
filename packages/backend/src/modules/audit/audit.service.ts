import { randomUUID } from 'node:crypto';
import { asc, count as countFn, desc, eq, gte, inArray, isNull, lte, notInArray, or } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  accessLists,
  apiTokens,
  auditLog,
  certificateAuthorities,
  certificates,
  databaseConnectionFolders,
  databaseConnections,
  dockerContainerFolders,
  dockerDeployments,
  dockerRegistries,
  domains,
  nginxTemplates,
  nodeFolders,
  nodes,
  notificationAlertRules,
  notificationWebhooks,
  permissionGroups,
  proxyHostFolders,
  proxyHosts,
  sslCertificates,
  users,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { PaginatedResponse } from '@/types.js';
import { getAuditRequestContext, markAuditEmitted } from './audit-request-context.js';
import type { SiemAuditOutboxService } from './siem-outbox.service.js';

const logger = createChildLogger('AuditService');

export interface AuditEntry {
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

interface AuditLogOptions {
  markRequest?: boolean;
}

export interface AuditLogFilters {
  action?: string;
  actions?: string[];
  resourceType?: string;
  resourceTypes?: string[];
  resourceId?: string;
  userId?: string;
  userIds?: string[];
  excludedActions?: string[];
  excludedResourceTypes?: string[];
  from?: Date;
  to?: Date;
}

const AUDIT_EXPORT_MAX_ENTRIES = 50_000;

interface AuditLogRow {
  id: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  resourceName: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  userName: string | null;
  userEmail: string | null;
}

@injectable()
export class AuditService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly siemOutboxService?: SiemAuditOutboxService
  ) {}
  private eventBus?: import('@/services/event-bus.service.js').EventBusService;

  setEventBus(eventBus: import('@/services/event-bus.service.js').EventBusService): void {
    this.eventBus = eventBus;
  }

  async log(entry: AuditEntry, options: AuditLogOptions = {}): Promise<boolean> {
    try {
      const requestContext = getAuditRequestContext();
      const impersonation = requestContext?.impersonation;
      const actorUserId = impersonation?.actorUserId ?? entry.userId;
      const id = randomUUID();
      const createdAt = new Date();
      const ipAddress = entry.ipAddress ?? requestContext?.ipAddress ?? null;
      const mcpDetails = requestContext?.mcp
        ? {
            source: 'mcp',
            toolName: requestContext.mcp.toolName,
            category: requestContext.mcp.category,
            arguments: requestContext.mcp.arguments,
            tokenId: requestContext.mcp.tokenId,
            tokenPrefix: requestContext.mcp.tokenPrefix,
            authType: requestContext.mcp.authType,
            clientId: requestContext.mcp.clientId,
          }
        : undefined;
      const siemEnabled = this.siemOutboxService ? await this.siemOutboxService.isEnabled() : false;
      const actorEmail = siemEnabled ? await this.getActorEmail(actorUserId) : null;
      const siemEvent =
        siemEnabled && this.siemOutboxService
          ? await this.siemOutboxService.buildEvent({
              auditLogId: id,
              createdAt,
              action: entry.action,
              actorId: actorUserId,
              actorEmail,
              resourceType: entry.resourceType,
              resourceId: entry.resourceId ?? null,
              sourceIp: ipAddress,
            })
          : null;
      const persist = async (writer: Pick<DrizzleClient, 'insert'> & { select?: DrizzleClient['select'] }) => {
        await writer.insert(auditLog).values({
          id,
          userId: actorUserId,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          details:
            mcpDetails || impersonation
              ? {
                  ...entry.details,
                  ...mcpDetails,
                  ...(impersonation
                    ? {
                        impersonatedUserId: impersonation.subjectUserId,
                        impersonatedUserEmail: impersonation.subjectEmail,
                        impersonatedUserName: impersonation.subjectName,
                      }
                    : {}),
                }
              : entry.details,
          ipAddress,
          userAgent: entry.userAgent ?? requestContext?.userAgent,
          createdAt,
        });
        if (siemEvent && this.siemOutboxService) {
          await this.siemOutboxService.enqueue(
            writer as Pick<DrizzleClient, 'select' | 'insert'>,
            id,
            siemEvent,
            createdAt
          );
        }
      };
      const transactionalDb = this.db as DrizzleClient & {
        transaction?: (callback: (tx: Pick<DrizzleClient, 'select' | 'insert'>) => Promise<void>) => Promise<void>;
      };
      if (transactionalDb.transaction) {
        await transactionalDb.transaction((tx) => persist(tx));
      } else {
        await persist(this.db);
      }
      this.eventBus?.publish('audit.changed', {});
      if (options.markRequest ?? true) {
        markAuditEmitted();
      }
      return true;
    } catch (error) {
      logger.error('Failed to write audit log', {
        error,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
      });
      return false;
    }
  }

  private async getActorEmail(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    try {
      const [actor] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
      return actor?.email ?? null;
    } catch (error) {
      // Exporting an optional actor e-mail must never make the local audit
      // record unavailable. The stable actor ID remains in the SIEM event.
      logger.warn('Unable to resolve audit actor email for SIEM export', {
        userId,
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      return null;
    }
  }

  async getAuditLog(
    params: AuditLogFilters & { page: number; limit: number }
  ): Promise<PaginatedResponse<AuditLogRow>> {
    const conditions = [];
    const actions = uniqueDefined([...(params.actions ?? []), params.action]);
    const resourceTypes = uniqueDefined([...(params.resourceTypes ?? []), params.resourceType]);
    const userIds = uniqueDefined([...(params.userIds ?? []), params.userId]);

    if (actions.length === 1) conditions.push(eq(auditLog.action, actions[0]!));
    else if (actions.length > 1) conditions.push(inArray(auditLog.action, actions));
    if (resourceTypes.length === 1) conditions.push(eq(auditLog.resourceType, resourceTypes[0]!));
    else if (resourceTypes.length > 1) conditions.push(inArray(auditLog.resourceType, resourceTypes));
    if (params.resourceId) conditions.push(eq(auditLog.resourceId, params.resourceId));
    if (userIds.length) {
      const concreteUserIds = userIds.filter((id) => id !== 'system');
      const includesSystem = concreteUserIds.length !== userIds.length;
      if (includesSystem && concreteUserIds.length)
        conditions.push(or(isNull(auditLog.userId), inArray(auditLog.userId, concreteUserIds)));
      else if (includesSystem) conditions.push(isNull(auditLog.userId));
      else if (concreteUserIds.length === 1) conditions.push(eq(auditLog.userId, concreteUserIds[0]!));
      else conditions.push(inArray(auditLog.userId, concreteUserIds));
    }
    if (params.excludedActions?.length) conditions.push(notInArray(auditLog.action, params.excludedActions));
    if (params.excludedResourceTypes?.length)
      conditions.push(notInArray(auditLog.resourceType, params.excludedResourceTypes));
    if (params.from) conditions.push(gte(auditLog.createdAt, params.from));
    if (params.to) conditions.push(lte(auditLog.createdAt, params.to));

    const where = buildWhere(conditions);

    const [entries, [{ count: totalCount }]] = await Promise.all([
      this.db
        .select({
          id: auditLog.id,
          userId: auditLog.userId,
          action: auditLog.action,
          resourceType: auditLog.resourceType,
          resourceId: auditLog.resourceId,
          details: auditLog.details,
          ipAddress: auditLog.ipAddress,
          userAgent: auditLog.userAgent,
          createdAt: auditLog.createdAt,
          userName: users.name,
          userEmail: users.email,
        })
        .from(auditLog)
        .leftJoin(users, eq(auditLog.userId, users.id))
        .where(where)
        .orderBy(desc(auditLog.createdAt))
        .limit(params.limit)
        .offset((params.page - 1) * params.limit),
      this.db.select({ count: countFn() }).from(auditLog).where(where),
    ]);

    const resourceNames = await this.resolveResourceNames(entries);
    const data = entries.map((entry) => ({
      ...entry,
      resourceName:
        getResourceNameFromDetails(entry.details) ??
        resourceNames.get(resourceKey(entry.resourceType, entry.resourceId)) ??
        null,
    }));
    const total = Number(totalCount);

    return {
      data,
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages: Math.ceil(total / params.limit),
      },
    };
  }

  async getAuditExport(filters: AuditLogFilters): Promise<AuditLogRow[]> {
    const result = await this.getAuditLog({
      ...filters,
      page: 1,
      limit: AUDIT_EXPORT_MAX_ENTRIES + 1,
    });
    if (result.pagination.total > AUDIT_EXPORT_MAX_ENTRIES) {
      throw new AppError(
        413,
        'AUDIT_EXPORT_TOO_LARGE',
        `Audit export exceeds ${AUDIT_EXPORT_MAX_ENTRIES} entries; narrow the filters or date range`
      );
    }
    return result.data;
  }

  async getAuditUsers(): Promise<Array<{ userId: string | null; userName: string | null; userEmail: string | null }>> {
    return this.db
      .selectDistinct({
        userId: auditLog.userId,
        userName: users.name,
        userEmail: users.email,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.userId, users.id))
      .orderBy(asc(users.name), asc(users.email), asc(auditLog.userId));
  }

  private async resolveResourceNames(
    entries: Array<{ resourceType: string; resourceId: string | null }>
  ): Promise<Map<string, string>> {
    const idsByType = new Map<string, Set<string>>();
    for (const entry of entries) {
      if (!entry.resourceId) continue;
      const ids = idsByType.get(entry.resourceType) ?? new Set<string>();
      ids.add(entry.resourceId);
      idsByType.set(entry.resourceType, ids);
    }

    const names = new Map<string, string>();
    const ids = (type: string) => [...(idsByType.get(type) ?? [])];

    const add = (type: string, id: string | null | undefined, name: string | null | undefined) => {
      if (id && name) names.set(resourceKey(type, id), name);
    };

    const nodeIds = ids('node');
    if (nodeIds.length) {
      const rows = await this.db
        .select({ id: nodes.id, displayName: nodes.displayName, hostname: nodes.hostname })
        .from(nodes)
        .where(inArray(nodes.id, nodeIds));
      for (const row of rows) add('node', row.id, row.displayName || row.hostname);
    }

    const nodeFolderIds = ids('node_folder');
    if (nodeFolderIds.length) {
      const rows = await this.db
        .select({ id: nodeFolders.id, name: nodeFolders.name })
        .from(nodeFolders)
        .where(inArray(nodeFolders.id, nodeFolderIds));
      for (const row of rows) add('node_folder', row.id, row.name);
    }

    const dockerFolderIds = ids('docker_folder');
    if (dockerFolderIds.length) {
      const rows = await this.db
        .select({ id: dockerContainerFolders.id, name: dockerContainerFolders.name })
        .from(dockerContainerFolders)
        .where(inArray(dockerContainerFolders.id, dockerFolderIds));
      for (const row of rows) add('docker_folder', row.id, row.name);
    }

    const proxyHostIds = ids('proxy_host');
    if (proxyHostIds.length) {
      const rows = await this.db
        .select({ id: proxyHosts.id, domainNames: proxyHosts.domainNames })
        .from(proxyHosts)
        .where(inArray(proxyHosts.id, proxyHostIds));
      for (const row of rows) add('proxy_host', row.id, row.domainNames?.join(', '));
    }

    const proxyFolderIds = ids('proxy_host_folder');
    if (proxyFolderIds.length) {
      const rows = await this.db
        .select({ id: proxyHostFolders.id, name: proxyHostFolders.name })
        .from(proxyHostFolders)
        .where(inArray(proxyHostFolders.id, proxyFolderIds));
      for (const row of rows) add('proxy_host_folder', row.id, row.name);
    }

    const caIds = ids('ca');
    if (caIds.length) {
      const rows = await this.db
        .select({ id: certificateAuthorities.id, commonName: certificateAuthorities.commonName })
        .from(certificateAuthorities)
        .where(inArray(certificateAuthorities.id, caIds));
      for (const row of rows) add('ca', row.id, row.commonName);
    }

    const certificateIds = ids('certificate');
    if (certificateIds.length) {
      const rows = await this.db
        .select({ id: certificates.id, commonName: certificates.commonName })
        .from(certificates)
        .where(inArray(certificates.id, certificateIds));
      for (const row of rows) add('certificate', row.id, row.commonName);
    }

    const sslIds = ids('ssl_certificate');
    if (sslIds.length) {
      const rows = await this.db
        .select({ id: sslCertificates.id, name: sslCertificates.name })
        .from(sslCertificates)
        .where(inArray(sslCertificates.id, sslIds));
      for (const row of rows) add('ssl_certificate', row.id, row.name);
    }

    const domainIds = ids('domain');
    if (domainIds.length) {
      const rows = await this.db
        .select({ id: domains.id, domain: domains.domain })
        .from(domains)
        .where(inArray(domains.id, domainIds));
      for (const row of rows) add('domain', row.id, row.domain);
    }

    const databaseIds = ids('database');
    if (databaseIds.length) {
      const rows = await this.db
        .select({ id: databaseConnections.id, name: databaseConnections.name })
        .from(databaseConnections)
        .where(inArray(databaseConnections.id, databaseIds));
      for (const row of rows) add('database', row.id, row.name);
    }

    const databaseFolderIds = ids('database_connection_folder');
    if (databaseFolderIds.length) {
      const rows = await this.db
        .select({ id: databaseConnectionFolders.id, name: databaseConnectionFolders.name })
        .from(databaseConnectionFolders)
        .where(inArray(databaseConnectionFolders.id, databaseFolderIds));
      for (const row of rows) add('database_connection_folder', row.id, row.name);
    }

    const accessListIds = ids('access_list');
    if (accessListIds.length) {
      const rows = await this.db
        .select({ id: accessLists.id, name: accessLists.name })
        .from(accessLists)
        .where(inArray(accessLists.id, accessListIds));
      for (const row of rows) add('access_list', row.id, row.name);
    }

    const registryIds = ids('docker-registry');
    if (registryIds.length) {
      const rows = await this.db
        .select({ id: dockerRegistries.id, name: dockerRegistries.name })
        .from(dockerRegistries)
        .where(inArray(dockerRegistries.id, registryIds));
      for (const row of rows) add('docker-registry', row.id, row.name);
    }

    const deploymentIds = ids('docker-deployment');
    if (deploymentIds.length) {
      const rows = await this.db
        .select({ id: dockerDeployments.id, name: dockerDeployments.name })
        .from(dockerDeployments)
        .where(inArray(dockerDeployments.id, deploymentIds));
      for (const row of rows) add('docker-deployment', row.id, row.name);
    }

    const templateIds = ids('nginx_template');
    if (templateIds.length) {
      const rows = await this.db
        .select({ id: nginxTemplates.id, name: nginxTemplates.name })
        .from(nginxTemplates)
        .where(inArray(nginxTemplates.id, templateIds));
      for (const row of rows) add('nginx_template', row.id, row.name);
    }

    const tokenIds = ids('api-token');
    if (tokenIds.length) {
      const rows = await this.db
        .select({ id: apiTokens.id, name: apiTokens.name })
        .from(apiTokens)
        .where(inArray(apiTokens.id, tokenIds));
      for (const row of rows) add('api-token', row.id, row.name);
    }

    const groupIds = ids('permission_group');
    if (groupIds.length) {
      const rows = await this.db
        .select({ id: permissionGroups.id, name: permissionGroups.name })
        .from(permissionGroups)
        .where(inArray(permissionGroups.id, groupIds));
      for (const row of rows) add('permission_group', row.id, row.name);
    }

    const webhookIds = ids('notification_webhook');
    if (webhookIds.length) {
      const rows = await this.db
        .select({ id: notificationWebhooks.id, name: notificationWebhooks.name })
        .from(notificationWebhooks)
        .where(inArray(notificationWebhooks.id, webhookIds));
      for (const row of rows) add('notification_webhook', row.id, row.name);
    }

    const ruleIds = ids('notification_alert_rule');
    if (ruleIds.length) {
      const rows = await this.db
        .select({ id: notificationAlertRules.id, name: notificationAlertRules.name })
        .from(notificationAlertRules)
        .where(inArray(notificationAlertRules.id, ruleIds));
      for (const row of rows) add('notification_alert_rule', row.id, row.name);
    }

    const userIds = ids('user');
    if (userIds.length) {
      const rows = await this.db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, userIds));
      for (const row of rows) add('user', row.id, row.name || row.email);
    }

    return names;
  }
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value))];
}

function resourceKey(type: string, id: string | null | undefined): string {
  return `${type}:${id ?? ''}`;
}

function getResourceNameFromDetails(details: Record<string, unknown> | null): string | null {
  if (!details) return null;
  for (const key of [
    'newName',
    'name',
    'displayName',
    'hostname',
    'commonName',
    'cn',
    'domain',
    'containerName',
    'imageRef',
    'key',
  ]) {
    const value = details[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  for (const key of ['domainNames', 'domains']) {
    const value = details[key];
    if (Array.isArray(value)) {
      const names = value.filter((item): item is string => typeof item === 'string' && !!item.trim());
      if (names.length) return names.join(', ');
    }
  }
  return null;
}
