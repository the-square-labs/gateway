import { isIP } from 'node:net';
import bcrypt from 'bcryptjs';
import { and, asc, count, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import {
  dockerDeployments,
  domains,
  managedDatabaseInstances,
  nodes,
  proxyHosts,
  relayAssignmentSourceProbes,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayInstances,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { type LicenseQuotaService, requireConfiguredLicenseQuota } from '@/modules/license/license-quota.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
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
import {
  getConfiguredNodeServiceAddresses,
  getEffectiveNginxIngressAddress,
  getEffectiveNginxIngressAddresses,
  getEffectiveServiceAddressForNode,
  getReportedPublicNodeAddresses,
  isPubliclyRoutableIp,
} from './node-service-address.js';
import {
  createNodeFileOperationContext,
  isNonEmptyAddressSubset,
  orderedAddressesEqual,
  stripNodeHealthHistory,
} from './node-service-helpers.js';
import type {
  CreateNodeInput,
  NodeListQuery,
  UpdateNodeInput,
  UpdateNodeServiceCreationLockInput,
} from './nodes.schemas.js';

const logger = createChildLogger('NodesService');

export class NodesService {
  private daemonUpdateService?: DaemonUpdateService;
  private generalSettingsService?: GeneralSettingsService;
  private proxyService?: ProxyService;
  private systemCertificateLifecycle?: SystemCertificateLifecycleService;
  private licenseQuota?: LicenseQuotaService;
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
  setProxyService(service: ProxyService) {
    this.proxyService = service;
  }
  setSystemCertificateLifecycleService(service: SystemCertificateLifecycleService) {
    this.systemCertificateLifecycle = service;
  }
  setLicenseQuotaService(service: LicenseQuotaService) {
    this.licenseQuota = service;
  }
  private emitNode(id: string, action: 'created' | 'updated' | 'deleted', extra: Record<string, unknown> = {}) {
    this.eventBus?.publish('node.changed', { id, action, ...extra });
  }

  private nodeFileOperationContext() {
    return createNodeFileOperationContext(this.nodeDispatch, this.auditService, this.eventBus);
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
        serviceAddresses: nodes.serviceAddresses,
        serviceAddress: nodes.serviceAddress,
        secondaryServiceAddress: nodes.secondaryServiceAddress,
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
        publicServiceAddresses: row.type === 'nginx' ? getReportedPublicNodeAddresses(row) : undefined,
        effectiveServiceAddress: getEffectiveServiceAddressForNode(row),
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
      publicServiceAddresses:
        node.type === 'nginx'
          ? getReportedPublicNodeAddresses({
              lastHealthReport: connectedNode?.lastHealthReport ?? node.lastHealthReport,
            })
          : undefined,
      effectiveServiceAddress: getEffectiveServiceAddressForNode({
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
      publicServiceAddresses:
        node.type === 'nginx'
          ? getReportedPublicNodeAddresses({
              lastHealthReport: connectedNode?.lastHealthReport ?? node.lastHealthReport,
            })
          : undefined,
      effectiveServiceAddress: getEffectiveServiceAddressForNode({
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

    const createNode = (executor: DrizzleExecutor) =>
      writeWithAllocatedSlug({
        source: input.displayName?.trim() || input.hostname,
        fallback: 'node',
        reserved: ['file', 'console'],
        constraint: 'nodes_slug_unique',
        write: async (slug) => {
          const [created] = await executor
            .insert(nodes)
            .values({
              type: input.type,
              hostname: input.hostname,
              displayName: input.displayName,
              slug,
              enrollmentTokenSelector: enrollmentToken.selector,
              enrollmentTokenHash: tokenHash,
              status: 'pending',
              serviceAddresses: input.type === 'relay' ? input.serviceAddresses : [],
            })
            .returning();
          return created;
        },
      });
    const node = await requireConfiguredLicenseQuota(this.licenseQuota).run(
      'managedNodes',
      async (tx) => {
        const [result] = await tx.select({ count: count() }).from(nodes);
        return Number(result?.count ?? 0);
      },
      createNode
    );

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

    const legacyAddressUpdateRequested =
      input.serviceAddress !== undefined || input.secondaryServiceAddress !== undefined;
    const serviceAddressesUpdateRequested = input.serviceAddresses !== undefined || legacyAddressUpdateRequested;
    const currentServiceAddresses = getConfiguredNodeServiceAddresses(existing);
    const nextServiceAddresses =
      input.serviceAddresses !== undefined
        ? input.serviceAddresses
        : legacyAddressUpdateRequested
          ? [
              input.serviceAddress === undefined ? existing.serviceAddress : input.serviceAddress,
              input.secondaryServiceAddress === undefined
                ? existing.secondaryServiceAddress
                : input.secondaryServiceAddress,
              ...currentServiceAddresses.slice(2),
            ].filter((address): address is string => !!address)
          : currentServiceAddresses;

    if (new Set(nextServiceAddresses).size !== nextServiceAddresses.length) {
      throw new AppError(400, 'DUPLICATE_NGINX_SERVICE_ADDRESSES', 'Node service addresses must be different');
    }
    if (
      existing.type === 'nginx' &&
      input.serviceAddresses === undefined &&
      input.secondaryServiceAddress &&
      input.secondaryServiceAddress ===
        getEffectiveNginxIngressAddress({
          serviceAddress: input.serviceAddress === undefined ? existing.serviceAddress : input.serviceAddress,
          lastHealthReport: this.registry.getNode(id)?.lastHealthReport ?? existing.lastHealthReport,
        })
    ) {
      throw new AppError(
        400,
        'DUPLICATE_NGINX_SERVICE_ADDRESSES',
        'Primary and secondary Nginx service addresses must be different'
      );
    }

    if (existing.type === 'nginx' && serviceAddressesUpdateRequested) {
      const invalidAddress = nextServiceAddresses.find((address) => !isPubliclyRoutableIp(address));
      if (invalidAddress) {
        throw new AppError(
          400,
          'INVALID_NGINX_SERVICE_ADDRESS',
          'Every Nginx service address must be a publicly routable IP address',
          { address: invalidAddress }
        );
      }
    }

    if (input.secondaryServiceAddress !== undefined && existing.type !== 'nginx') {
      throw new AppError(
        400,
        'INVALID_SECONDARY_SERVICE_ADDRESS_NODE',
        'Secondary service address is only supported for Nginx nodes'
      );
    }
    let shouldReconcileAssignedDomains = false;
    let approvedDnsTarget: string | null | undefined;
    const ingressAddressChanged =
      existing.type === 'nginx' &&
      serviceAddressesUpdateRequested &&
      !orderedAddressesEqual(currentServiceAddresses, nextServiceAddresses);
    if (existing.type === 'nginx' && ingressAddressChanged) {
      const liveHealthReport = this.registry.getNode(id)?.lastHealthReport ?? existing.lastHealthReport;
      const previousAddresses = getEffectiveNginxIngressAddresses({
        serviceAddresses: currentServiceAddresses,
        serviceAddress: existing.serviceAddress,
        secondaryServiceAddress: existing.secondaryServiceAddress,
        lastHealthReport: liveHealthReport,
      });
      const nextAddresses = getEffectiveNginxIngressAddresses({
        serviceAddresses: nextServiceAddresses,
        lastHealthReport: liveHealthReport,
      });
      const affectedDomains = await this.db
        .select({ id: domains.id, dnsTargetIps: domains.dnsTargetIps })
        .from(domains)
        .where(eq(domains.nginxNodeId, id));
      const domainsWithChangedTarget = affectedDomains.filter(
        (domain) => !isNonEmptyAddressSubset(domain.dnsTargetIps, nextAddresses)
      );
      if (domainsWithChangedTarget.length > 0) {
        if (!input.confirmDomainDnsUpdate) {
          throw new AppError(
            409,
            'NODE_SERVICE_ADDRESS_DOMAINS_AFFECTED',
            'Changing this address will update tracked DNS targets for assigned domains',
            {
              domainCount: domainsWithChangedTarget.length,
              previousAddress: previousAddresses[0] ?? null,
              nextAddress: nextAddresses[0] ?? null,
              previousAddresses,
              nextAddresses,
            }
          );
        }
        shouldReconcileAssignedDomains = true;
        approvedDnsTarget = nextAddresses[0] ?? null;
      }
    }

    const updateData = {
      displayName: input.displayName === undefined ? existing.displayName : input.displayName,
      appearanceColor: input.appearanceColor === undefined ? existing.appearanceColor : input.appearanceColor,
      serviceAddresses: serviceAddressesUpdateRequested ? nextServiceAddresses : existing.serviceAddresses,
      serviceAddress: serviceAddressesUpdateRequested ? (nextServiceAddresses[0] ?? null) : existing.serviceAddress,
      secondaryServiceAddress: serviceAddressesUpdateRequested
        ? (nextServiceAddresses[1] ?? null)
        : existing.secondaryServiceAddress,
      metadata:
        input.builderSettings === undefined
          ? existing.metadata
          : {
              ...((existing.metadata ?? {}) as Record<string, unknown>),
              builderSettings: input.builderSettings,
            },
      updatedAt: new Date(),
    };
    const updateNode = async (slug?: string) => {
      const write = async (db: DrizzleExecutor) => {
        const [updated] = await db
          .update(nodes)
          .set({ ...updateData, ...(slug === undefined ? {} : { slug }) })
          .where(eq(nodes.id, id))
          .returning();
        if (shouldReconcileAssignedDomains && approvedDnsTarget !== undefined) {
          await db
            .update(domains)
            .set({ pendingDnsTargetIp: approvedDnsTarget, updatedAt: new Date() })
            .where(eq(domains.nginxNodeId, id));
        }
        return updated;
      };
      return shouldReconcileAssignedDomains ? this.db.transaction(write) : write(this.db);
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
        ...(serviceAddressesUpdateRequested ? { serviceAddresses: nextServiceAddresses } : {}),
        ...(input.builderSettings !== undefined ? { builderSettings: input.builderSettings } : {}),
      },
    });
    const slugChange = updated.slug === existing.slug ? {} : { oldSlug: existing.slug, slug: updated.slug };
    this.emitNode(id, 'updated', slugChange);
    if (updated.slug !== existing.slug) {
      this.eventBus?.publish('node.slug.changed', { id, oldSlug: existing.slug, slug: updated.slug });
    }
    if (ingressAddressChanged || shouldReconcileAssignedDomains) {
      this.eventBus?.publish('node.service_address.changed', {
        id,
        serviceAddresses: updated.serviceAddresses,
        serviceAddress: updated.serviceAddress,
        secondaryServiceAddress: updated.secondaryServiceAddress,
        effectiveServiceAddress: getEffectiveServiceAddressForNode(updated),
        reconcileAssignedDomains: shouldReconcileAssignedDomains,
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

  async remove(id: string, userId: string, options: { cascadeOfflineProxyHosts?: boolean } = {}) {
    if (this.daemonUpdateService && (await this.daemonUpdateService.isNodeUpdateInProgress(id))) {
      throw new AppError(409, 'NODE_UPDATING', 'Node daemon update is in progress');
    }

    const [node] = await this.db.select().from(nodes).where(eq(nodes.id, id)).limit(1);

    if (!node) {
      throw new AppError(404, 'NOT_FOUND', 'Node not found');
    }

    let relayInstance: typeof relayInstances.$inferSelect | undefined;
    if (node.type === 'relay') {
      [relayInstance] = await this.db.select().from(relayInstances).where(eq(relayInstances.nodeId, id)).limit(1);
      if (relayInstance) {
        const activeAssignments = await this.db
          .select({ id: relayEndpointAssignments.id })
          .from(relayEndpointAssignments)
          .innerJoin(
            relayEndpointAssignmentGenerations,
            eq(relayEndpointAssignments.assignmentGenerationId, relayEndpointAssignmentGenerations.id)
          )
          .where(
            and(
              eq(relayEndpointAssignments.relayInstanceId, relayInstance.id),
              inArray(relayEndpointAssignmentGenerations.state, ['active', 'staging', 'draining'])
            )
          );
        if (activeAssignments.length) {
          throw new AppError(
            409,
            'RELAY_INSTANCE_ASSIGNED',
            'Rebalance relay endpoints away from this instance before removal'
          );
        }
        const disconnectedOfflineRelay = node.status === 'offline' && !this.registry.getNode(id);
        const pendingRelayEnrollment = node.status === 'pending' && !node.certificateSerial;
        if (
          !pendingRelayEnrollment &&
          !disconnectedOfflineRelay &&
          !['draining', 'offline', 'error'].includes(relayInstance.state)
        ) {
          throw new AppError(409, 'RELAY_INSTANCE_NOT_DRAINED', 'Drain the relay instance before removal');
        }
        if ((relayInstance.health?.activeTunnels ?? 0) > 0) {
          throw new AppError(409, 'RELAY_INSTANCE_HAS_ACTIVE_TUNNELS', 'Relay instance still has active tunnels');
        }
      }
    }

    const assignedHosts = await this.db.select({ id: proxyHosts.id }).from(proxyHosts).where(eq(proxyHosts.nodeId, id));
    const cascadeOfflineProxyHosts = options.cascadeOfflineProxyHosts === true;
    if (assignedHosts.length > 0) {
      if (!cascadeOfflineProxyHosts) {
        const offlineNginxNode = node.type === 'nginx' && !this.registry.getNode(id);
        throw new AppError(
          offlineNginxNode ? 409 : 400,
          offlineNginxNode ? 'OFFLINE_NGINX_NODE_HAS_HOSTS' : 'NODE_HAS_HOSTS',
          offlineNginxNode
            ? `Offline Nginx node has ${assignedHosts.length} assigned proxy host(s). Confirm cascade removal to continue.`
            : `Cannot delete node with ${assignedHosts.length} assigned proxy host(s). Reassign or delete them first.`,
          { proxyHostCount: assignedHosts.length }
        );
      }
      if (node.type !== 'nginx') {
        throw new AppError(
          409,
          'PROXY_HOST_CASCADE_NOT_ALLOWED',
          'Proxy hosts can only be cascaded with an offline Nginx node'
        );
      }
      if (this.registry.getNode(id)) {
        throw new AppError(409, 'NODE_CONNECTED', 'Disconnect the Nginx node before cascading its proxy hosts');
      }
      if (!this.proxyService) {
        throw new AppError(503, 'PROXY_SERVICE_UNAVAILABLE', 'Proxy host cleanup is unavailable');
      }
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

    const assignedDomains = await this.db.select({ id: domains.id }).from(domains).where(eq(domains.nginxNodeId, id));
    if (assignedDomains.length > 0) {
      throw new AppError(409, 'NODE_HAS_DOMAINS', 'Cannot delete a node with assigned domains. Reassign them first.', {
        domainCount: assignedDomains.length,
      });
    }

    if (assignedHosts.length > 0) {
      const proxyService = this.proxyService;
      if (!proxyService) {
        throw new AppError(503, 'PROXY_SERVICE_UNAVAILABLE', 'Proxy host cleanup is unavailable');
      }
      for (const host of assignedHosts) {
        await proxyService.deleteProxyHost(host.id, userId, { abandonOfflineNode: true });
      }
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
        if (relayInstance) {
          await this.systemCertificateLifecycle.retireOwner(
            { type: 'relay_node_server', id: relayInstance.id },
            'cessationOfOperation',
            tx
          );
        }
      }
      if (relayInstance) {
        await tx
          .delete(relayAssignmentSourceProbes)
          .where(eq(relayAssignmentSourceProbes.relayInstanceId, relayInstance.id));
        await tx.delete(relayEndpointAssignments).where(eq(relayEndpointAssignments.relayInstanceId, relayInstance.id));
        await tx.delete(relayInstances).where(eq(relayInstances.id, relayInstance.id));
      }
      await tx.delete(nodes).where(eq(nodes.id, id));
    });
    await this.systemCertificateLifecycle?.retryPendingCRLs();

    await this.auditService.log({
      userId,
      action: 'node.remove',
      resourceType: 'node',
      resourceId: id,
      details: { hostname: node.hostname, cascadedProxyHostCount: cascadeOfflineProxyHosts ? assignedHosts.length : 0 },
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
