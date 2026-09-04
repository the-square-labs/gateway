import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  dockerDeploymentRoutes,
  proxyAdditionalRoutes,
  proxyAdditionalSecureLinks,
  proxyHosts,
} from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { ProxySecureLinkService } from '@/modules/proxy/proxy-secure-link.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type {
  DockerAvailabilityDependencyProjector,
  DockerAvailabilityPreparedDependencies,
} from './docker-availability.adapters.js';
import type {
  DockerAvailabilityAdapterContext,
  DockerAvailabilityAdapterPreflight,
  DockerAvailabilityCandidateNode,
  DockerAvailabilityPlacementResult,
  DockerAvailabilityResolvedResource,
} from './docker-availability.types.js';

const EMPTY: DockerAvailabilityPreparedDependencies = { environment: {}, networkNames: [], extraHosts: {} };

export class DockerAvailabilityIngressProjector implements DockerAvailabilityDependencyProjector {
  constructor(
    private readonly db: DrizzleClient,
    private readonly nodes: NodeRegistryService,
    private readonly docker: DockerManagementService,
    private readonly secureLinks: ProxySecureLinkService,
    private readonly proxy: ProxyService
  ) {}

  async preflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    scopes: string[]
  ): Promise<DockerAvailabilityAdapterPreflight> {
    const [primaryHosts, routes, links] = await Promise.all([
      this.hosts(resource),
      this.routes(resource),
      this.links(resource),
    ]);
    const indirectHostIds = [...new Set([...routes, ...links].map((item) => item.proxyHostId))];
    const indirectHosts = indirectHostIds.length
      ? await this.db.query.proxyHosts.findMany({ where: inArray(proxyHosts.id, indirectHostIds) })
      : [];
    const hosts = [...new Map([...primaryHosts, ...indirectHosts].map((host) => [host.id, host])).values()];
    const blockers: DockerAvailabilityAdapterPreflight['blockers'] = [];
    for (const host of hosts) {
      if (!hasScope(scopes, `proxy:edit:${host.id}`)) {
        blockers.push({
          code: 'AVAILABILITY_INGRESS_PERMISSION_REQUIRED',
          message: 'Proxy Host edit permission is required before Availability can manage its placement members',
          resource: host.id,
        });
        continue;
      }
      if (host.type !== 'proxy' || host.rawConfigEnabled || !host.nodeId) {
        blockers.push({
          code: 'AVAILABILITY_INGRESS_UNMANAGED',
          message: 'Linked ingress must use a managed Proxy Host before Availability can be enabled',
          resource: host.id,
        });
        continue;
      }
      if (!this.nodes.hasCapability(host.nodeId, 'nginx_secure_link_socket_only_v1')) {
        blockers.push({
          code: 'AVAILABILITY_INGRESS_CAPABILITY_UNAVAILABLE',
          message: 'The Proxy Host node cannot balance placement Secure Link sockets',
          nodeId: host.nodeId,
          resource: host.id,
        });
      }
    }
    for (const node of candidateNodes) {
      if (hosts.length > 0 && node.compatible && !this.nodes.hasCapability(node.id, 'proxy_secure_links_v1')) {
        blockers.push({
          code: 'AVAILABILITY_TARGET_LINK_CAPABILITY_UNAVAILABLE',
          message: 'Docker node cannot host placement Secure Link targets',
          nodeId: node.id,
        });
      }
    }
    return { blockers, warnings: [] };
  }

  async prepare(): Promise<DockerAvailabilityPreparedDependencies> {
    return EMPTY;
  }

  async reconcileHost(hostId: string): Promise<boolean> {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, hostId) });
    if (!host?.enabled || host.type !== 'proxy' || host.rawConfigEnabled || !host.nodeId) return false;

    const policyWhere =
      host.upstreamKind === 'docker_deployment' && host.dockerDeploymentId
        ? and(
            eq(dockerAvailabilityPolicies.resourceKind, 'deployment'),
            eq(dockerAvailabilityPolicies.deploymentId, host.dockerDeploymentId)
          )
        : host.upstreamKind === 'docker_container' && host.dockerComposeProjectId
          ? and(
              eq(dockerAvailabilityPolicies.resourceKind, 'compose'),
              eq(dockerAvailabilityPolicies.composeProjectId, host.dockerComposeProjectId)
            )
          : host.upstreamKind === 'docker_container' && host.dockerNodeId && host.dockerContainerName
            ? and(
                eq(dockerAvailabilityPolicies.resourceKind, 'container'),
                eq(dockerAvailabilityPolicies.sourceNodeId, host.dockerNodeId),
                eq(dockerAvailabilityPolicies.containerName, host.dockerContainerName)
              )
            : undefined;
    if (!policyWhere) return false;
    let policy = await this.db.query.dockerAvailabilityPolicies.findFirst({
      where: and(policyWhere, inArray(dockerAvailabilityPolicies.mode, ['replicated', 'failover'])),
    });
    if (!policy) {
      const members = await this.db.query.proxyAdditionalSecureLinks.findMany({
        where: and(
          eq(proxyAdditionalSecureLinks.proxyHostId, host.id),
          eq(proxyAdditionalSecureLinks.purpose, 'availability_member')
        ),
      });
      const placementIds = members
        .filter((member) => member.availabilityOwnerKey === `proxy-host:${host.id}` && member.referenceId)
        .map((member) => member.referenceId!);
      if (placementIds.length > 0) {
        const placement = await this.db.query.dockerAvailabilityPlacements.findFirst({
          where: inArray(dockerAvailabilityPlacements.id, placementIds),
        });
        if (placement) {
          policy = await this.db.query.dockerAvailabilityPolicies.findFirst({
            where: and(
              eq(dockerAvailabilityPolicies.id, placement.policyId),
              inArray(dockerAvailabilityPolicies.mode, ['replicated', 'failover'])
            ),
          });
        }
      }
    }
    if (!policy) return false;

    let logicalHost = host;
    if (
      policy.resourceKind === 'container' &&
      policy.sourceNodeId &&
      policy.containerName &&
      (host.dockerNodeId !== policy.sourceNodeId || host.dockerContainerName !== policy.containerName)
    ) {
      const [updated] = await this.db
        .update(proxyHosts)
        .set({
          dockerNodeId: policy.sourceNodeId,
          dockerContainerName: policy.containerName,
          updatedAt: new Date(),
        })
        .where(eq(proxyHosts.id, host.id))
        .returning();
      logicalHost = updated ?? host;
    }

    const placements = await this.db.query.dockerAvailabilityPlacements.findMany({
      where: and(
        eq(dockerAvailabilityPlacements.policyId, policy.id),
        eq(dockerAvailabilityPlacements.serving, true),
        eq(dockerAvailabilityPlacements.actualState, 'serving')
      ),
    });
    const existingMembers = await this.secureLinks.getActiveAvailabilityMembers(
      logicalHost.id,
      `proxy-host:${logicalHost.id}`
    );
    const existingPlacementIds = new Set(existingMembers.map((member) => member.referenceId));
    const reference =
      policy.resourceKind === 'container'
        ? { type: 'container' as const, nodeId: policy.sourceNodeId!, containerName: policy.containerName! }
        : policy.resourceKind === 'deployment'
          ? { type: 'deployment' as const, deploymentId: policy.deploymentId! }
          : { type: 'compose' as const, composeProjectId: policy.composeProjectId! };
    const resource: DockerAvailabilityResolvedResource = {
      kind: policy.resourceKind,
      reference,
      resourceId: policy.deploymentId ?? policy.composeProjectId ?? policy.containerName!,
      displayName: policy.displayName,
      currentNodeId: policy.sourceNodeId ?? policy.originNodeId ?? '',
      viewScope: policy.resourceKind === 'compose' ? 'docker:compose:view' : 'docker:containers:view',
      manageScope: policy.resourceKind === 'compose' ? 'docker:compose:manage' : 'docker:containers:manage',
      specFingerprint: policy.specFingerprint,
      portableSpec: policy.portableSpec,
      imageReference: policy.imageReference ?? undefined,
      composeRevisionId: policy.composeRevisionId ?? undefined,
      running: policy.shouldRun,
      authoritativeSnapshot: true,
    };
    for (const placement of placements) {
      if (existingPlacementIds.has(placement.id)) continue;
      await this.activate(
        {
          policyId: policy.id,
          placementId: placement.id,
          operationId: `ingress-backfill:${logicalHost.id}`,
          nodeId: placement.nodeId,
          generation: placement.generation,
          idempotencyKey: `ingress-backfill:${logicalHost.id}:${placement.id}`,
          resource,
        },
        {
          acknowledgedGeneration: placement.generation,
          actualState: 'serving',
          serving: true,
          dependencyState: placement.dependencyState,
          applicationHealth: placement.applicationHealth,
          runtimeIdentity: placement.runtimeIdentity,
          imageReference: placement.imageReference ?? undefined,
          composeRevisionId: placement.composeRevisionId ?? undefined,
        }
      );
    }
    if (logicalHost.secureLinkGeneration > 0) {
      await this.secureLinks.cleanup(logicalHost);
      await this.proxy.reconcileAdditionalRouteHost(logicalHost.id);
    }
    return true;
  }

  async activate(context: DockerAvailabilityAdapterContext, result: DockerAvailabilityPlacementResult): Promise<void> {
    const hosts = await this.hosts(context.resource, context.policyId);
    for (const host of hosts) {
      if (!host.nodeId || host.type !== 'proxy' || host.rawConfigEnabled) continue;
      const target = await this.target(context, result, host);
      await this.secureLinks.ensureAvailabilityMember(host, {
        placementId: context.placementId,
        ingressOwnerKey: `proxy-host:${host.id}`,
        dockerNodeId: context.nodeId,
        upstreamKind: host.upstreamKind as 'docker_container' | 'docker_deployment',
        forwardScheme: host.forwardScheme ?? 'http',
        dockerContainerName: target.containerName,
        dockerComposeProjectId: host.dockerComposeProjectId,
        dockerComposeServiceName: host.dockerComposeServiceName,
        dockerDeploymentId: host.dockerDeploymentId,
        dockerContainerPort: host.dockerContainerPort ?? target.targetPort,
        dockerHostPort: target.targetPort,
        targetNetwork: target.network,
        targetContainer: target.containerName,
      });
      await this.proxy.reconcileAdditionalRouteHost(host.id);
      if (host.secureLinkGeneration > 0) {
        await this.secureLinks.cleanup(host);
        await this.proxy.reconcileAdditionalRouteHost(host.id);
      }
    }
    const routes = await this.routes(context.resource);
    for (const route of routes) {
      const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, route.proxyHostId) });
      if (!host?.nodeId || host.type !== 'proxy' || host.rawConfigEnabled) continue;
      const target = await this.target(context, result, {
        dockerComposeServiceName: route.dockerComposeServiceName,
        dockerContainerPort: route.dockerContainerPort,
        dockerHostPort: route.dockerHostPort,
      });
      await this.secureLinks.ensureAvailabilityMember(host, {
        placementId: context.placementId,
        ingressOwnerKey: `additional-route:${route.id}`,
        dockerNodeId: context.nodeId,
        upstreamKind: route.targetKind as 'docker_container' | 'docker_deployment',
        forwardScheme: route.forwardScheme,
        dockerContainerName: target.containerName,
        dockerComposeProjectId: route.dockerComposeProjectId,
        dockerComposeServiceName: route.dockerComposeServiceName,
        dockerDeploymentId: route.dockerDeploymentId,
        dockerContainerPort: route.dockerContainerPort ?? target.targetPort,
        dockerHostPort: target.targetPort,
        targetNetwork: target.network,
        targetContainer: target.containerName,
      });
      await this.proxy.reconcileAdditionalRouteHost(host.id);
    }
    const links = await this.links(context.resource);
    for (const link of links) {
      const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, link.proxyHostId) });
      if (!host?.nodeId || host.type !== 'proxy' || host.rawConfigEnabled) continue;
      const target = await this.target(context, result, link);
      await this.secureLinks.ensureAvailabilityMember(host, {
        placementId: context.placementId,
        ingressOwnerKey: `additional-secure-link:${link.id}`,
        dockerNodeId: context.nodeId,
        upstreamKind: link.upstreamKind as 'docker_container' | 'docker_deployment',
        forwardScheme: link.forwardScheme,
        dockerContainerName: target.containerName,
        dockerComposeProjectId: link.dockerComposeProjectId,
        dockerComposeServiceName: link.dockerComposeServiceName,
        dockerDeploymentId: link.dockerDeploymentId,
        dockerContainerPort: link.dockerContainerPort,
        dockerHostPort: target.targetPort,
        targetNetwork: target.network,
        targetContainer: target.containerName,
      });
      await this.proxy.reconcileAdditionalRouteHost(host.id);
    }
  }

  async deactivate(context: DockerAvailabilityAdapterContext): Promise<void> {
    const hosts = await this.hosts(context.resource, context.policyId);
    for (const host of hosts) {
      await this.secureLinks.deleteAvailabilityMember(host, context.placementId, `proxy-host:${host.id}`, () =>
        this.reconcileHostAndDrain(host.id)
      );
    }
    const routes = await this.routes(context.resource);
    for (const route of routes) {
      const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, route.proxyHostId) });
      if (!host) continue;
      await this.secureLinks.deleteAvailabilityMember(host, context.placementId, `additional-route:${route.id}`, () =>
        this.reconcileHostAndDrain(host.id)
      );
    }
    const links = await this.links(context.resource);
    for (const link of links) {
      const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, link.proxyHostId) });
      if (!host) continue;
      await this.secureLinks.deleteAvailabilityMember(
        host,
        context.placementId,
        `additional-secure-link:${link.id}`,
        () => this.reconcileHostAndDrain(host.id)
      );
    }
  }

  async deactivateUnavailable(context: DockerAvailabilityAdapterContext): Promise<void> {
    await this.deactivate(context);
  }

  async cleanup(context: DockerAvailabilityAdapterContext): Promise<void> {
    await this.deactivate(context);
  }

  async prepareFinalAdoption(context: DockerAvailabilityAdapterContext): Promise<void> {
    const hosts = await this.hosts(context.resource, context.policyId);
    for (const host of hosts) {
      let singleHost = host;
      const updates: Partial<typeof proxyHosts.$inferInsert> = {};
      if (host.dockerNodeId !== context.nodeId) updates.dockerNodeId = context.nodeId;
      if (context.resource.kind === 'compose') {
        const target = await this.target(
          context,
          {
            runtimeIdentity: { projectName: context.resource.displayName },
          } as unknown as DockerAvailabilityPlacementResult,
          host
        );
        updates.dockerContainerName = target.containerName;
        updates.dockerHostPort = target.targetPort;
        updates.secureLinkTargetNetwork = target.network;
        updates.secureLinkTargetContainer = target.containerName;
      }
      if (Object.keys(updates).length > 0) {
        const [updated] = await this.db
          .update(proxyHosts)
          .set({ ...updates, updatedAt: new Date() })
          .where(eq(proxyHosts.id, host.id))
          .returning();
        singleHost = updated ?? host;
      }
      const deadline = Date.now() + 20_000;
      while (true) {
        try {
          await this.secureLinks.reconcileExisting(singleHost);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (Date.now() >= deadline || !/target container is unavailable|container.*not found/i.test(message)) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      if (context.resource.kind === 'container') {
        // Keep the serving Availability member routed while the newly
        // reconciled canonical socket settles on the source daemon. Without
        // this window an immediate Nginx cutover can briefly race listener
        // replacement even though the direct Secure Link probe succeeded.
        await new Promise((resolve) => setTimeout(resolve, 2_500));
      }
    }
  }

  async finalizeAdoption(context: DockerAvailabilityAdapterContext): Promise<void> {
    const adoptedResource =
      context.resource.kind === 'container' ? { ...context.resource, currentNodeId: context.nodeId } : context.resource;
    const hosts = await this.hosts(adoptedResource, context.policyId);
    for (const host of hosts) {
      let singleHost = host;
      if (host.dockerNodeId !== context.nodeId) {
        const [updated] = await this.db
          .update(proxyHosts)
          .set({ dockerNodeId: context.nodeId, updatedAt: new Date() })
          .where(eq(proxyHosts.id, host.id))
          .returning();
        singleHost = updated ?? host;
      }
      const prepared = await this.secureLinks.reconcileExisting(singleHost);
      await this.proxy.reconcileAdditionalRouteHost(host.id);
      await this.secureLinks.deleteAvailabilityMember(prepared, context.placementId, `proxy-host:${host.id}`, () =>
        this.reconcileHostAndDrain(host.id)
      );
    }
    const routes = await this.routes(adoptedResource);
    for (const route of routes) {
      const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, route.proxyHostId) });
      if (!host) continue;
      await this.secureLinks.deleteAvailabilityMember(host, context.placementId, `additional-route:${route.id}`, () =>
        this.reconcileHostAndDrain(host.id)
      );
    }
    const links = await this.links(adoptedResource);
    for (const link of links) {
      const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, link.proxyHostId) });
      if (!host) continue;
      await this.secureLinks.deleteAvailabilityMember(
        host,
        context.placementId,
        `additional-secure-link:${link.id}`,
        () => this.reconcileHostAndDrain(host.id)
      );
    }
  }

  private async reconcileHostAndDrain(hostId: string): Promise<void> {
    await this.proxy.reconcileAdditionalRouteHost(hostId);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  private async hosts(resource: DockerAvailabilityResolvedResource, policyId?: string) {
    const reference =
      resource.kind === 'container'
        ? and(
            eq(proxyHosts.upstreamKind, 'docker_container'),
            eq(proxyHosts.dockerNodeId, resource.currentNodeId),
            eq(proxyHosts.dockerContainerName, resource.displayName),
            isNull(proxyHosts.dockerComposeProjectId)
          )
        : resource.kind === 'deployment'
          ? and(
              eq(proxyHosts.upstreamKind, 'docker_deployment'),
              eq(proxyHosts.dockerDeploymentId, resource.resourceId)
            )
          : and(
              eq(proxyHosts.upstreamKind, 'docker_container'),
              eq(proxyHosts.dockerComposeProjectId, resource.resourceId)
            );
    const direct = await this.db.query.proxyHosts.findMany({
      where: and(eq(proxyHosts.enabled, true), or(reference)),
    });
    if (resource.kind !== 'container' || !policyId) return direct;
    const placements = await this.db.query.dockerAvailabilityPlacements.findMany({
      where: eq(dockerAvailabilityPlacements.policyId, policyId),
    });
    const placementIds = placements.map((placement) => placement.id);
    if (placementIds.length === 0) return direct;
    const members = await this.db.query.proxyAdditionalSecureLinks.findMany({
      where: and(
        eq(proxyAdditionalSecureLinks.purpose, 'availability_member'),
        inArray(proxyAdditionalSecureLinks.referenceId, placementIds)
      ),
    });
    const linkedHostIds = members
      .filter(
        (member) =>
          member.availabilityOwnerKey === `proxy-host:${member.proxyHostId}` &&
          !direct.some((host) => host.id === member.proxyHostId)
      )
      .map((member) => member.proxyHostId);
    if (linkedHostIds.length === 0) return direct;
    const linked = await this.db.query.proxyHosts.findMany({
      where: and(eq(proxyHosts.enabled, true), inArray(proxyHosts.id, linkedHostIds)),
    });
    return [...direct, ...linked];
  }

  private routes(resource: DockerAvailabilityResolvedResource) {
    const reference =
      resource.kind === 'container'
        ? and(
            eq(proxyAdditionalRoutes.targetKind, 'docker_container'),
            eq(proxyAdditionalRoutes.dockerNodeId, resource.currentNodeId),
            eq(proxyAdditionalRoutes.dockerContainerName, resource.displayName),
            isNull(proxyAdditionalRoutes.dockerComposeProjectId)
          )
        : resource.kind === 'deployment'
          ? and(
              eq(proxyAdditionalRoutes.targetKind, 'docker_deployment'),
              eq(proxyAdditionalRoutes.dockerDeploymentId, resource.resourceId)
            )
          : and(
              eq(proxyAdditionalRoutes.targetKind, 'docker_container'),
              eq(proxyAdditionalRoutes.dockerComposeProjectId, resource.resourceId)
            );
    return this.db.query.proxyAdditionalRoutes.findMany({
      where: and(eq(proxyAdditionalRoutes.enabled, true), or(reference)),
    });
  }

  private links(resource: DockerAvailabilityResolvedResource) {
    const reference =
      resource.kind === 'container'
        ? and(
            eq(proxyAdditionalSecureLinks.upstreamKind, 'docker_container'),
            eq(proxyAdditionalSecureLinks.dockerNodeId, resource.currentNodeId),
            eq(proxyAdditionalSecureLinks.dockerContainerName, resource.displayName),
            isNull(proxyAdditionalSecureLinks.dockerComposeProjectId)
          )
        : resource.kind === 'deployment'
          ? and(
              eq(proxyAdditionalSecureLinks.upstreamKind, 'docker_deployment'),
              eq(proxyAdditionalSecureLinks.dockerDeploymentId, resource.resourceId)
            )
          : and(
              eq(proxyAdditionalSecureLinks.upstreamKind, 'docker_container'),
              eq(proxyAdditionalSecureLinks.dockerComposeProjectId, resource.resourceId)
            );
    return this.db.query.proxyAdditionalSecureLinks.findMany({
      where: and(
        eq(proxyAdditionalSecureLinks.purpose, 'user_managed'),
        eq(proxyAdditionalSecureLinks.status, 'active'),
        or(reference)
      ),
    });
  }

  private async target(
    context: DockerAvailabilityAdapterContext,
    result: DockerAvailabilityPlacementResult,
    host: {
      dockerComposeServiceName: string | null;
      dockerContainerPort: number | null;
      dockerHostPort: number | null;
    }
  ): Promise<{ containerName: string; network: string; targetPort: number }> {
    if (context.resource.kind === 'container') {
      const target = {
        containerName: String(result.runtimeIdentity?.containerName ?? context.resource.displayName),
        network: '',
        targetPort: host.dockerContainerPort ?? 0,
      };
      return this.assertTarget(target);
    }
    if (context.resource.kind === 'deployment') {
      const [route] = await this.db
        .select()
        .from(dockerDeploymentRoutes)
        .where(
          and(
            eq(dockerDeploymentRoutes.deploymentId, context.resource.resourceId),
            eq(dockerDeploymentRoutes.containerPort, host.dockerContainerPort ?? 0)
          )
        )
        .limit(1);
      const target = {
        containerName: String(result.runtimeIdentity?.routerName ?? ''),
        network: String(result.runtimeIdentity?.networkName ?? ''),
        targetPort: route?.hostPort ?? host.dockerHostPort ?? host.dockerContainerPort ?? 0,
      };
      return this.assertTarget(target);
    }
    const containers = await this.docker.listContainers(context.nodeId);
    const serviceName = host.dockerComposeServiceName ?? '';
    const projectName = String(result.runtimeIdentity?.projectName ?? context.resource.displayName);
    const container = containers.find((candidate: any) => {
      const labels = candidate.Labels ?? candidate.labels ?? {};
      return (
        labels['com.docker.compose.project'] === projectName && labels['com.docker.compose.service'] === serviceName
      );
    });
    return this.assertTarget({
      containerName: String(container?.Names?.[0] ?? container?.Name ?? container?.name ?? '').replace(/^\/+/, ''),
      network: '',
      targetPort: host.dockerContainerPort ?? 0,
    });
  }

  private assertTarget(target: { containerName: string; network: string; targetPort: number }) {
    if (!target.containerName || target.targetPort < 1 || target.targetPort > 65535) {
      throw new AppError(
        409,
        'AVAILABILITY_INGRESS_TARGET_NOT_READY',
        'A placement ingress target could not be resolved',
        { retryable: true }
      );
    }
    return target;
  }
}
