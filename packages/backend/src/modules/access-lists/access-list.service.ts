import bcrypt from 'bcryptjs';
import { count, desc, eq, ilike, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import type { BasicAuthUser } from '@/db/schema/access-lists.js';
import { accessLists } from '@/db/schema/index.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere, escapeLike } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { NginxTemplateService } from '@/modules/proxy/nginx-template.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NginxCertificateDistributionService } from '@/services/nginx-certificate-distribution.service.js';
import type { NginxConfigGenerator, ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { PaginatedResponse } from '@/types.js';
import type { AccessListQuery, CreateAccessListInput, UpdateAccessListInput } from './access-list.schemas.js';

const logger = createChildLogger('AccessListService');
const BCRYPT_ROUNDS = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AccessListRow = typeof accessLists.$inferSelect;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AccessListService {
  constructor(
    private readonly db: DrizzleClient,
    readonly _configGenerator: NginxConfigGenerator,
    private readonly nginxTemplateService: NginxTemplateService,
    private readonly auditService: AuditService,
    private readonly nodeDispatch: NodeDispatchService,
    private readonly certificateDistribution: NginxCertificateDistributionService
  ) {}

  private eventBus?: EventBusService;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }
  private emitAcl(id: string, action: 'created' | 'updated' | 'deleted') {
    this.eventBus?.publish('access-list.changed', { id, action });
  }

  // -----------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------

  async create(input: CreateAccessListInput, userId: string) {
    // 1. Hash basic auth passwords before storing
    const hashedUsers = input.basicAuthUsers.length > 0 ? await this.hashPasswords(input.basicAuthUsers) : [];

    // 2. Insert into DB
    const [accessList] = await this.db
      .insert(accessLists)
      .values({
        name: input.name,
        description: input.description ?? null,
        ipRules: input.ipRules,
        basicAuthEnabled: input.basicAuthEnabled,
        basicAuthUsers: hashedUsers,
        createdById: userId,
      })
      .returning();

    // 3. Write htpasswd file for nginx if basic auth enabled
    if (input.basicAuthEnabled && hashedUsers.length > 0) {
      await this.writeHtpasswd(accessList.id, hashedUsers);
    }

    // 4. Audit log
    await this.auditService.log({
      userId,
      action: 'access_list.create',
      resourceType: 'access_list',
      resourceId: accessList.id,
      details: { name: accessList.name },
    });

    logger.info('Created access list', { id: accessList.id, name: accessList.name });
    this.emitAcl(accessList.id, 'created');

    return accessList;
  }

  // -----------------------------------------------------------------------
  // Update
  // -----------------------------------------------------------------------

  async update(id: string, input: UpdateAccessListInput, userId: string) {
    // 1. Get existing access list
    const existing = await this.db.query.accessLists.findFirst({
      where: eq(accessLists.id, id),
    });
    if (!existing) throw new AppError(404, 'ACCESS_LIST_NOT_FOUND', 'Access list not found');

    // 2. Hash passwords if basic auth users are being updated
    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (input.name !== undefined) updateData.name = input.name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.ipRules !== undefined) updateData.ipRules = input.ipRules;
    if (input.basicAuthEnabled !== undefined) updateData.basicAuthEnabled = input.basicAuthEnabled;

    if (input.basicAuthUsers !== undefined) {
      const existingBasicAuthUsers = (existing.basicAuthUsers as BasicAuthUser[]) ?? [];
      const hashedUsers: BasicAuthUser[] = [];

      for (const user of input.basicAuthUsers) {
        if (user.password) {
          hashedUsers.push({
            username: user.username,
            passwordHash: await bcrypt.hash(user.password, BCRYPT_ROUNDS),
          });
          continue;
        }

        const existingUser = existingBasicAuthUsers.find((candidate) => candidate.username === user.username);
        if (!existingUser) {
          throw new AppError(
            400,
            'BASIC_AUTH_PASSWORD_REQUIRED',
            `Password required for basic auth user "${user.username}"`
          );
        }
        hashedUsers.push(existingUser);
      }

      updateData.basicAuthUsers = hashedUsers;
    }

    // 3. Update DB
    const [updated] = await this.db.update(accessLists).set(updateData).where(eq(accessLists.id, id)).returning();

    // 4. Regenerate htpasswd file if basic auth changed
    const basicAuthEnabled = updated.basicAuthEnabled;
    const basicAuthUsers = updated.basicAuthUsers as BasicAuthUser[];

    const shouldDeployHtpasswd = basicAuthEnabled && basicAuthUsers.length > 0;
    if (shouldDeployHtpasswd) {
      await this.writeHtpasswd(id, basicAuthUsers);
    }

    // 5. Find all proxy hosts using this access list and regenerate their nginx configs
    const affectedHosts = await this.db.query.proxyHosts.findMany({
      where: eq(proxyHosts.accessListId, id),
    });

    if (affectedHosts.length > 0) {
      logger.info('Regenerating nginx configs for affected proxy hosts', {
        accessListId: id,
        hostCount: affectedHosts.length,
      });

      const updatedAccessListConfig: ProxyHostConfig['accessList'] = {
        id,
        ipRules: updated.ipRules as { type: string; value: string }[],
        basicAuthEnabled: updated.basicAuthEnabled,
      };

      for (const host of affectedHosts) {
        if (!host.enabled) continue;

        const supportsDistribution = await this.certificateDistribution.supportsNode(host.nodeId);
        const preparedTls =
          host.sslEnabled && supportsDistribution ? await this.certificateDistribution.prepareForHost(host) : null;
        const certPaths = preparedTls
          ? preparedTls
          : host.sslEnabled && !supportsDistribution
            ? await this.certificateDistribution.legacyPathsForHost(host)
            : { sslCertPath: null, sslKeyPath: null, sslChainPath: null };

        const config: ProxyHostConfig = {
          id: host.id,
          type: host.type,
          domainNames: host.domainNames,
          enabled: host.enabled,
          forwardHost: host.forwardHost,
          forwardPort: host.forwardPort,
          forwardScheme: host.forwardScheme ?? 'http',
          upstreamIpv6Enabled: host.upstreamIpv6Enabled,
          sslEnabled: host.sslEnabled && !!certPaths.sslCertPath && !!certPaths.sslKeyPath,
          sslForced: host.sslForced,
          http2Support: host.http2Support,
          websocketSupport: host.websocketSupport,
          redirectUrl: host.redirectUrl,
          redirectStatusCode: host.redirectStatusCode ?? 301,
          customHeaders: (host.customHeaders ?? []) as { name: string; value: string }[],
          cacheEnabled: host.cacheEnabled,
          cacheOptions: host.cacheOptions as Record<string, unknown> | null,
          rateLimitEnabled: host.rateLimitEnabled,
          rateLimitOptions: host.rateLimitOptions as Record<string, unknown> | null,
          customRewrites: (host.customRewrites ?? []) as { source: string; destination: string; type: string }[],
          advancedConfig: host.advancedConfig,
          accessList: updatedAccessListConfig,
          sslCertPath: certPaths.sslCertPath,
          sslKeyPath: certPaths.sslKeyPath,
          sslChainPath: certPaths.sslChainPath,
          templateVariables: (host.templateVariables ?? {}) as Record<string, string | number | boolean>,
        };

        const generatedConfig = await this.nginxTemplateService.renderForHost(config, host.nginxTemplateId ?? null);
        if (preparedTls) {
          await this.certificateDistribution.applyHostBundle(
            { id: host.id, nodeId: host.nodeId },
            generatedConfig,
            preparedTls
          );
        } else {
          const nodeId = await this.nodeDispatch.resolveNodeId(host.nodeId);
          const result = await this.nodeDispatch.applyConfig(nodeId, host.id, generatedConfig);
          if (!result.success) throw new Error(result.error || 'Daemon config apply failed');
        }
      }
    }

    // Remove credentials only after every affected host config has stopped
    // referencing the file. Removing first creates an avoidable 403 window if
    // config application is delayed or fails.
    if (!shouldDeployHtpasswd) {
      await this.removeHtpasswd(id);
    }

    // 6. Audit log
    await this.auditService.log({
      userId,
      action: 'access_list.update',
      resourceType: 'access_list',
      resourceId: id,
      details: { changes: Object.keys(input) },
    });

    logger.info('Updated access list', { id });
    this.emitAcl(id, 'updated');

    return updated;
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  async delete(id: string, userId: string) {
    // 1. Get existing access list
    const existing = await this.db.query.accessLists.findFirst({
      where: eq(accessLists.id, id),
    });
    if (!existing) throw new AppError(404, 'ACCESS_LIST_NOT_FOUND', 'Access list not found');

    // 2. Check no proxy hosts reference this access list
    const referencingHosts = await this.db.query.proxyHosts.findMany({
      where: eq(proxyHosts.accessListId, id),
    });

    if (referencingHosts.length > 0) {
      const hostNames = referencingHosts.map((h) => (h.domainNames as string[]).join(', '));
      throw new AppError(
        409,
        'ACCESS_LIST_IN_USE',
        `Cannot delete access list: it is referenced by ${referencingHosts.length} proxy host(s)`,
        { proxyHosts: hostNames }
      );
    }

    // 3. Remove htpasswd file
    await this.removeHtpasswd(id);

    // 4. Delete from DB
    await this.db.delete(accessLists).where(eq(accessLists.id, id));

    // 5. Audit log
    await this.auditService.log({
      userId,
      action: 'access_list.delete',
      resourceType: 'access_list',
      resourceId: id,
      details: { name: existing.name },
    });

    logger.info('Deleted access list', { id, name: existing.name });
    this.emitAcl(id, 'deleted');
  }

  // -----------------------------------------------------------------------
  // Get single
  // -----------------------------------------------------------------------

  async get(id: string) {
    const accessList = await this.db.query.accessLists.findFirst({
      where: eq(accessLists.id, id),
    });
    if (!accessList) throw new AppError(404, 'ACCESS_LIST_NOT_FOUND', 'Access list not found');

    // Count how many proxy hosts reference this access list
    const [{ count: usageCount }] = await this.db
      .select({ count: count() })
      .from(proxyHosts)
      .where(eq(proxyHosts.accessListId, id));

    return {
      ...accessList,
      // Strip password hashes from response, return only usernames
      basicAuthUsers: (accessList.basicAuthUsers as BasicAuthUser[]).map((u) => ({ username: u.username })),
      proxyHostCount: Number(usageCount),
    };
  }

  // -----------------------------------------------------------------------
  // List
  // -----------------------------------------------------------------------

  async list(query: AccessListQuery, options?: { allowedIds?: string[] }): Promise<PaginatedResponse<AccessListRow>> {
    const conditions = [];

    if (options?.allowedIds) {
      if (options.allowedIds.length === 0) {
        return {
          data: [],
          pagination: { page: query.page, limit: query.limit, total: 0, totalPages: 0 },
        };
      }
      conditions.push(inArray(accessLists.id, options.allowedIds));
    }

    if (query.search) {
      conditions.push(ilike(accessLists.name, `%${escapeLike(query.search)}%`));
    }

    const where = buildWhere(conditions);

    const [entries, [{ count: totalCount }]] = await Promise.all([
      this.db.query.accessLists.findMany({
        where: where ? () => where : undefined,
        orderBy: [desc(accessLists.createdAt)],
        limit: query.limit,
        offset: (query.page - 1) * query.limit,
      }),
      this.db.select({ count: count() }).from(accessLists).where(where),
    ]);

    const total = Number(totalCount);

    // Strip password hashes from list responses
    const sanitizedEntries = entries.map((entry) => ({
      ...entry,
      basicAuthUsers: (entry.basicAuthUsers as BasicAuthUser[]).map((u) => ({ username: u.username })),
    }));

    return {
      data: sanitizedEntries as unknown as AccessListRow[],
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  // -----------------------------------------------------------------------
  // Helpers — htpasswd file management
  // -----------------------------------------------------------------------

  /**
   * Write htpasswd file for nginx basic auth.
   * Format: username:$2y$... (bcrypt hash)
   * Writes to: {configPath}/htpasswd/access-list-{id}
   */
  private async writeHtpasswd(accessListId: string, users: BasicAuthUser[]): Promise<void> {
    const content = `${users.map((u) => `${u.username}:${u.passwordHash}`).join('\n')}\n`;

    // Deploy htpasswd to all nodes that have hosts using this access list
    const hostsUsingList = await this.db
      .select({ nodeId: proxyHosts.nodeId })
      .from(proxyHosts)
      .where(eq(proxyHosts.accessListId, accessListId));

    const nodeIds = [...new Set(hostsUsingList.map((h) => h.nodeId).filter(Boolean))] as string[];

    for (const nodeId of nodeIds) {
      const result = await this.nodeDispatch.deployHtpasswd(nodeId, accessListId, content);
      if (!result.success) {
        throw new AppError(
          502,
          'HTPASSWD_DEPLOY_FAILED',
          result.error || `Failed to deploy access list credentials to node ${nodeId}`
        );
      }
    }
    logger.debug('Htpasswd deployed to nodes', { accessListId, nodeCount: nodeIds.length });
  }

  private async removeHtpasswd(accessListId: string): Promise<void> {
    const hostsUsingList = await this.db
      .select({ nodeId: proxyHosts.nodeId })
      .from(proxyHosts)
      .where(eq(proxyHosts.accessListId, accessListId));

    const nodeIds = [...new Set(hostsUsingList.map((h) => h.nodeId).filter(Boolean))] as string[];

    for (const nodeId of nodeIds) {
      try {
        const result = await this.nodeDispatch.removeHtpasswd(nodeId, accessListId);
        if (!result.success) {
          logger.warn('Failed to remove stale htpasswd file from node', {
            accessListId,
            nodeId,
            error: result.error,
          });
        }
      } catch (error) {
        logger.warn('Failed to remove stale htpasswd file from node', { accessListId, nodeId, error });
      }
    }
    logger.debug('Htpasswd removed from nodes', { accessListId });
  }

  // -----------------------------------------------------------------------
  // Helpers — password hashing
  // -----------------------------------------------------------------------

  private async hashPasswords(users: { username: string; password: string }[]): Promise<BasicAuthUser[]> {
    return Promise.all(
      users.map(async (u) => ({
        username: u.username,
        passwordHash: await bcrypt.hash(u.password, BCRYPT_ROUNDS),
      }))
    );
  }
}
