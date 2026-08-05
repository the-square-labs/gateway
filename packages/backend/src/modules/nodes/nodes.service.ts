import { isIP } from 'node:net';
import bcrypt from 'bcryptjs';
import { asc, count, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerDeployments, managedDatabaseInstances, nodes, proxyHosts } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { DaemonUpdateService } from '@/services/daemon-update.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { GrpcIdentityService } from '@/services/grpc-identity.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type { SystemCertificateLifecycleService } from '@/services/system-certificate-lifecycle.service.js';
import { createNodeEnrollmentToken } from './node-enrollment-token.js';
import {
  abortNodeFileUpload,
  appendNodeFileUploadChunk,
  completeNodeFileUpload,
  createNodeDirectory,
  createNodeFile,
  deleteNodeFile,
  initNodeFileUpload,
  listNodeFiles,
  moveNodeFile,
  readNodeFile,
  writeNodeFile,
} from './node-file-operations.js';
import { getEffectiveNodeServiceAddress } from './node-service-address.js';
import type {
  CreateNodeInput,
  NodeListQuery,
  UpdateNodeInput,
  UpdateNodeServiceCreationLockInput,
} from './nodes.schemas.js';

const logger = createChildLogger('NodesService');

function stripNodeHealthHistory<T extends { healthHistory?: unknown }>(node: T): Omit<T, 'healthHistory'> {
  const { healthHistory: _healthHistory, ...rest } = node;
  return rest;
}

export class NodesService {
  private daemonUpdateService?: DaemonUpdateService;
  private generalSettingsService?: GeneralSettingsService;
  private systemCertificateLifecycle?: SystemCertificateLifecycleService;
  private grpcPort = 9443;

  constructor(
    private db: DrizzleClient,
    private auditService: AuditService,
    private registry: NodeRegistryService,
    private grpcIdentityService: GrpcIdentityService,
    private nodeDispatch: NodeDispatchService
  ) {}

  private eventBus?: EventBusService;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }
  setDaemonUpdateService(service: DaemonUpdateService) {
    this.daemonUpdateService = service;
  }
  setGeneralSettingsService(service: GeneralSettingsService, grpcPort: number) {
    this.generalSettingsService = service;
    this.grpcPort = grpcPort;
  }
  setSystemCertificateLifecycleService(service: SystemCertificateLifecycleService) {
    this.systemCertificateLifecycle = service;
  }
  private emitNode(id: string, action: 'created' | 'updated' | 'deleted', extra: Record<string, unknown> = {}) {
    this.eventBus?.publish('node.changed', { id, action, ...extra });
  }

  private nodeFileOperationContext() {
    return {
      nodeDispatch: this.nodeDispatch,
      auditService: this.auditService,
      eventBus: this.eventBus,
      parseResult: (result: { success: boolean; error?: string; detail?: string }) => this.parseResult(result),
    };
  }

  private parseResult(result: { success: boolean; error?: string; detail?: string }) {
    if (!result.success) {
      throw new AppError(502, 'DISPATCH_ERROR', result.error || 'Command failed on daemon');
    }
    try {
      return result.detail ? JSON.parse(result.detail) : null;
    } catch {
      return result.detail;
    }
  }

  private async validateConnectedNode(id: string) {
    const [node] = await this.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, id)).limit(1);
    if (!node) {
      throw new AppError(404, 'NOT_FOUND', 'Node not found');
    }
    if (!this.registry.getNode(id)) {
      throw new AppError(502, 'NODE_OFFLINE', 'Node is offline');
    }
  }

  async list(query: NodeListQuery, options?: { allowedIds?: string[] }) {
    const conditions: SQL[] = [];

    if (options?.allowedIds) {
      if (options.allowedIds.length === 0) {
        return {
          data: [],
          total: 0,
          page: query.page,
          limit: query.limit,
          totalPages: 0,
        };
      }
      conditions.push(inArray(nodes.id, options.allowedIds));
    }

    if (query.search) {
      conditions.push(ilike(nodes.hostname, `%${query.search}%`));
    }
    if (query.type) {
      conditions.push(eq(nodes.type, query.type));
    }
    if (query.status) {
      conditions.push(eq(nodes.status, query.status));
    }

    const where = buildWhere(conditions);

    const [totalResult] = await this.db.select({ count: count() }).from(nodes).where(where);
    const total = totalResult?.count ?? 0;

    const offset = (query.page - 1) * query.limit;
    const rows = await this.db
      .select({
        id: nodes.id,
        type: nodes.type,
        hostname: nodes.hostname,
        displayName: nodes.displayName,
        slug: nodes.slug,
        appearanceColor: nodes.appearanceColor,
        serviceAddress: nodes.serviceAddress,
        status: nodes.status,
        serviceCreationLocked: nodes.serviceCreationLocked,
        daemonVersion: nodes.daemonVersion,
        osInfo: nodes.osInfo,
        configVersionHash: nodes.configVersionHash,
        capabilities: nodes.capabilities,
        lastSeenAt: nodes.lastSeenAt,
        lastHealthReport: nodes.lastHealthReport,
        lastStatsReport: nodes.lastStatsReport,
        metadata: nodes.metadata,
        folderId: nodes.folderId,
        sortOrder: nodes.sortOrder,
        createdAt: nodes.createdAt,
        updatedAt: nodes.updatedAt,
      })
      .from(nodes)
      .where(where)
      .orderBy(asc(nodes.sortOrder), asc(nodes.createdAt))
      .limit(query.limit)
      .offset(offset);

    // Enrich with live connection status. The registry is authoritative for
    // command availability; DB status can lag until stale-node cleanup runs.
    const enriched = rows.map((row) => {
      const isConnected = !!this.registry.getNode(row.id);
      return {
        ...row,
        effectiveServiceAddress: getEffectiveNodeServiceAddress(row),
        status: row.status === 'online' && !isConnected ? 'offline' : row.status,
        isConnected,
      };
    });

    return {
      data: enriched,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async get(id: string) {
    const [node] = await this.db.select().from(nodes).where(eq(nodes.id, id)).limit(1);

    if (!node) {
      throw new AppError(404, 'NOT_FOUND', 'Node not found');
    }

    const connectedNode = this.registry.getNode(id);
    const isConnected = !!connectedNode;

    return {
      ...stripNodeHealthHistory(node),
      effectiveServiceAddress: getEffectiveNodeServiceAddress({
        ...node,
        lastHealthReport: connectedNode?.lastHealthReport ?? node.lastHealthReport,
      }),
      status: node.status === 'online' && !isConnected ? 'offline' : node.status,
      isConnected,
      liveHealthReport: connectedNode?.lastHealthReport ?? null,
      liveStatsReport: connectedNode?.lastStatsReport ?? null,
    };
  }

  async getBySlug(slug: string) {
    const [node] = await this.db.select().from(nodes).where(eq(nodes.slug, slug)).limit(1);

    if (!node) {
      throw new AppError(404, 'NOT_FOUND', 'Node not found');
    }

    const connectedNode = this.registry.getNode(node.id);
    const isConnected = !!connectedNode;

    return {
      ...stripNodeHealthHistory(node),
      effectiveServiceAddress: getEffectiveNodeServiceAddress({
        ...node,
        lastHealthReport: connectedNode?.lastHealthReport ?? node.lastHealthReport,
      }),
      status: node.status === 'online' && !isConnected ? 'offline' : node.status,
      isConnected,
      liveHealthReport: connectedNode?.lastHealthReport ?? null,
      liveStatsReport: connectedNode?.lastStatsReport ?? null,
    };
  }

  async getHealthHistory(id: string) {
    const [node] = await this.db
      .select({ healthHistory: nodes.healthHistory })
      .from(nodes)
      .where(eq(nodes.id, id))
      .limit(1);

    if (!node) {
      throw new AppError(404, 'NOT_FOUND', 'Node not found');
    }

    return node.healthHistory ?? [];
  }

  async create(input: CreateNodeInput, userId: string) {
    // Generate enrollment token
    const enrollmentToken = createNodeEnrollmentToken();
    const tokenHash = await bcrypt.hash(enrollmentToken.token, 10);

    const node = await writeWithAllocatedSlug({
      source: input.displayName?.trim() || input.hostname,
      fallback: 'node',
      reserved: ['file', 'console'],
      constraint: 'nodes_slug_unique',
      write: async (slug) => {
        const [created] = await this.db
          .insert(nodes)
          .values({
            type: input.type,
            hostname: input.hostname,
            displayName: input.displayName,
            slug,
            enrollmentTokenSelector: enrollmentToken.selector,
            enrollmentTokenHash: tokenHash,
            status: 'pending',
          })
          .returning();
        return created;
      },
    });

    await this.auditService.log({
      userId,
      action: 'node.create',
      resourceType: 'node',
      resourceId: node.id,
      details: { hostname: input.hostname, type: input.type },
    });

    logger.info('Node created', { nodeId: node.id, hostname: input.hostname });
    this.emitNode(node.id, 'created');

    return {
      node,
      enrollmentToken: enrollmentToken.token, // Shown once only
      gatewayCertSha256: await this.grpcIdentityService.getGatewayCertSha256(),
      gatewayEnrollmentTargets: await this.getGatewayEnrollmentTargets(),
    };
  }

  async update(id: string, input: UpdateNodeInput, userId: string) {
    if (this.daemonUpdateService && (await this.daemonUpdateService.isNodeUpdateInProgress(id))) {
      throw new AppError(409, 'NODE_UPDATING', 'Node daemon update is in progress');
    }

    const [existing] = await this.db.select().from(nodes).where(eq(nodes.id, id)).limit(1);

    if (!existing) {
      throw new AppError(404, 'NOT_FOUND', 'Node not found');
    }

    const updateData = {
      displayName: input.displayName === undefined ? existing.displayName : input.displayName,
      appearanceColor: input.appearanceColor === undefined ? existing.appearanceColor : input.appearanceColor,
      serviceAddress: input.serviceAddress === undefined ? existing.serviceAddress : input.serviceAddress,
      updatedAt: new Date(),
    };
    const updateNode = async (slug?: string) => {
      const [updated] = await this.db
        .update(nodes)
        .set({ ...updateData, ...(slug === undefined ? {} : { slug }) })
        .where(eq(nodes.id, id))
        .returning();
      return updated;
    };
    const displayNameChanged = input.displayName !== undefined && input.displayName !== existing.displayName;
    const updated = !displayNameChanged
      ? await updateNode()
      : await writeWithAllocatedSlug({
          source: input.displayName?.trim() || existing.hostname,
          fallback: 'node',
          reserved: ['file', 'console'],
          constraint: 'nodes_slug_unique',
          write: updateNode,
        });

    await this.auditService.log({
      userId,
      action: 'node.update',
      resourceType: 'node',
      resourceId: id,
      details: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.appearanceColor !== undefined ? { appearanceColor: input.appearanceColor } : {}),
        ...(input.serviceAddress !== undefined ? { serviceAddress: input.serviceAddress } : {}),
      },
    });
    const slugChange = updated.slug === existing.slug ? {} : { oldSlug: existing.slug, slug: updated.slug };
    this.emitNode(id, 'updated', slugChange);
    if (updated.slug !== existing.slug) {
      this.eventBus?.publish('node.slug.changed', { id, oldSlug: existing.slug, slug: updated.slug });
    }
    if (input.serviceAddress !== undefined && input.serviceAddress !== existing.serviceAddress) {
      this.eventBus?.publish('node.service_address.changed', {
        id,
        serviceAddress: updated.serviceAddress,
        effectiveServiceAddress: getEffectiveNodeServiceAddress(updated),
      });
    }

    return updated;
  }

  async updateServiceCreationLock(id: string, input: UpdateNodeServiceCreationLockInput, userId: string) {
    const [existing] = await this.db.select().from(nodes).where(eq(nodes.id, id)).limit(1);

    if (!existing) {
      throw new AppError(404, 'NOT_FOUND', 'Node not found');
    }
    if (existing.type !== 'nginx' && existing.type !== 'docker') {
      throw new AppError(
        400,
        'NODE_LOCK_UNSUPPORTED',
        'Only nginx and Docker nodes can be locked for service creation'
      );
    }

    await this.db
      .update(nodes)
      .set({
        serviceCreationLocked: input.serviceCreationLocked,
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, id));

    await this.auditService.log({
      userId,
      action: 'node.service_creation_lock',
      resourceType: 'node',
      resourceId: id,
      details: { serviceCreationLocked: input.serviceCreationLocked },
    });
    this.emitNode(id, 'updated');

    return this.get(id);
  }

  async remove(id: string, userId: string) {
    if (this.daemonUpdateService && (await this.daemonUpdateService.isNodeUpdateInProgress(id))) {
      throw new AppError(409, 'NODE_UPDATING', 'Node daemon update is in progress');
    }

    const [node] = await this.db.select().from(nodes).where(eq(nodes.id, id)).limit(1);

    if (!node) {
      throw new AppError(404, 'NOT_FOUND', 'Node not found');
    }

    // Check if any proxy hosts are assigned to this node
    const [hostCount] = await this.db.select({ count: count() }).from(proxyHosts).where(eq(proxyHosts.nodeId, id));

    if (hostCount && hostCount.count > 0) {
      throw new AppError(
        400,
        'NODE_HAS_HOSTS',
        `Cannot delete node with ${hostCount.count} assigned proxy host(s). Reassign or delete them first.`
      );
    }

    const [upstreamCount] = await this.db
      .select({ count: count() })
      .from(proxyHosts)
      .leftJoin(dockerDeployments, eq(proxyHosts.dockerDeploymentId, dockerDeployments.id))
      .where(or(eq(proxyHosts.dockerNodeId, id), eq(dockerDeployments.nodeId, id)));
    if (upstreamCount && upstreamCount.count > 0) {
      throw new AppError(
        409,
        'NODE_HAS_PROXY_UPSTREAMS',
        `Cannot delete node with ${upstreamCount.count} linked proxy upstream(s). Change or delete them first.`
      );
    }

    const [managedDatabaseCount] = await this.db
      .select({ count: count() })
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.nodeId, id));
    if (managedDatabaseCount && managedDatabaseCount.count > 0) {
      throw new AppError(
        409,
        'NODE_HAS_MANAGED_DATABASES',
        `Cannot delete node with ${managedDatabaseCount.count} managed database(s). Reassign or delete them first.`
      );
    }

    // Close gRPC stream if connected
    const connectedNode = this.registry.getNode(id);
    if (connectedNode) {
      connectedNode.commandStream.end();
      await this.registry.deregister(id);
    }

    // Retire certificates and delete their owner in one transaction: a failed
    // owner deletion cannot leave a still-active node with a revoked leaf.
    await this.db.transaction(async (tx) => {
      if (this.systemCertificateLifecycle) {
        await this.systemCertificateLifecycle.retireOwner({ type: 'node', id }, 'cessationOfOperation', tx);
      }
      await tx.delete(nodes).where(eq(nodes.id, id));
    });
    await this.systemCertificateLifecycle?.retryPendingCRLs();

    await this.auditService.log({
      userId,
      action: 'node.remove',
      resourceType: 'node',
      resourceId: id,
      details: { hostname: node.hostname },
    });

    logger.info('Node removed', { nodeId: id, hostname: node.hostname });
    this.emitNode(id, 'deleted');
  }

  async listFiles(nodeId: string, path: string) {
    await this.validateConnectedNode(nodeId);
    return listNodeFiles(this.nodeFileOperationContext(), nodeId, path);
  }

  async readFile(nodeId: string, path: string) {
    await this.validateConnectedNode(nodeId);
    return readNodeFile(this.nodeFileOperationContext(), nodeId, path);
  }

  async writeFile(nodeId: string, path: string, content: string | Buffer, userId: string) {
    await this.validateConnectedNode(nodeId);
    await writeNodeFile(this.nodeFileOperationContext(), nodeId, path, content, userId);
  }

  async createFile(nodeId: string, path: string, content: string | Buffer | undefined, userId: string) {
    await this.validateConnectedNode(nodeId);
    await createNodeFile(this.nodeFileOperationContext(), nodeId, path, content, userId);
  }

  async initFileUpload(nodeId: string, path: string, totalBytes: number, userId: string) {
    await this.validateConnectedNode(nodeId);
    return initNodeFileUpload(this.nodeFileOperationContext(), nodeId, path, totalBytes, userId);
  }

  async appendFileUploadChunk(nodeId: string, uploadId: string, offset: number, content: Buffer) {
    await this.validateConnectedNode(nodeId);
    return appendNodeFileUploadChunk(this.nodeFileOperationContext(), nodeId, uploadId, offset, content);
  }

  async completeFileUpload(nodeId: string, uploadId: string, path: string, totalBytes: number) {
    await this.validateConnectedNode(nodeId);
    await completeNodeFileUpload(this.nodeFileOperationContext(), nodeId, uploadId, path, totalBytes);
  }

  async abortFileUpload(nodeId: string, uploadId: string) {
    await this.validateConnectedNode(nodeId);
    await abortNodeFileUpload(this.nodeFileOperationContext(), nodeId, uploadId);
  }

  async createDirectory(nodeId: string, path: string, userId: string) {
    await this.validateConnectedNode(nodeId);
    await createNodeDirectory(this.nodeFileOperationContext(), nodeId, path, userId);
  }

  async deleteFile(nodeId: string, path: string, userId: string) {
    await this.validateConnectedNode(nodeId);
    await deleteNodeFile(this.nodeFileOperationContext(), nodeId, path, userId);
  }

  async moveFile(nodeId: string, fromPath: string, toPath: string, userId: string) {
    await this.validateConnectedNode(nodeId);
    await moveNodeFile(this.nodeFileOperationContext(), nodeId, fromPath, toPath, userId);
  }

  private async getGatewayEnrollmentTargets() {
    const settings = await this.generalSettingsService?.getGatewayEndpointSettings();
    const publicTarget = this.formatGrpcTarget(settings?.gatewayGrpcPublicTarget ?? null);
    const localTarget = this.formatGrpcTarget(settings?.gatewayGrpcLocalIp ?? null);
    return {
      public: { label: 'Public node', gateway: publicTarget },
      ...(localTarget ? { local: { label: 'Local node', gateway: localTarget } } : {}),
    };
  }

  private formatGrpcTarget(value: string | null): string | null {
    if (!value) return null;
    if (/^\[[^\]]+]:\d+$/.test(value) || /^[^:]+:\d+$/.test(value)) return value;
    if (/^\[[^\]]+]$/.test(value)) return `${value}:${this.grpcPort}`;
    if (isIP(value) === 6) return `[${value}]:${this.grpcPort}`;
    return `${value}:${this.grpcPort}`;
  }
}
