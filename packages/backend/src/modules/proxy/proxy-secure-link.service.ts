import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerDeploymentRoutes, dockerDeployments, nodes, proxyHosts } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';

type ProxyHostRow = typeof proxyHosts.$inferSelect;

interface BindingDetail {
  linkId: string;
  generation: number;
  port: number;
  targetNetwork?: string;
}

const PROXY_SECURE_LINK_PROBE_ATTEMPTS = 6;
const PROXY_SECURE_LINK_PROBE_RETRY_MS = 500;

export class ProxySecureLinkService {
  private eventBus?: EventBusService;
  private readonly targetNodeSyncs = new Map<string, Promise<void>>();
  private readonly sourceNodeSyncs = new Map<string, Promise<void>>();
  private readonly linkOperations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly dispatch: NodeDispatchService,
    private readonly relayPolicy: RelayPolicyService,
    private readonly connectorImage: string
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  async getRuntime(linkId: string) {
    return this.relayPolicy.getProxyRouteRuntime(linkId);
  }

  async prepare(
    host: ProxyHostRow,
    requireCapabilities: boolean,
    force = false,
    phase: 'provisioning' | 'reconciliation' = 'provisioning'
  ): Promise<ProxyHostRow> {
    try {
      const result = await this.withLinkOperation(host.id, async () => {
        // Reconciliation can be queued from both daemon reconnect and the
        // background sweep. Refresh only after acquiring the per-link lock so
        // a queued operation cannot restart a cutover from its stale snapshot.
        const lockedHost =
          phase === 'reconciliation'
            ? ((await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, host.id) })) ?? host)
            : host;
        return this.prepareLocked(lockedHost, requireCapabilities, force);
      });
      this.emitLinkState(result, phase, result.secureLinkLastError ? 'failed' : 'ready', result.secureLinkLastError);
      return result;
    } catch (error) {
      this.emitLinkState(host, phase, 'failed', error);
      throw error;
    }
  }

  private async prepareLocked(host: ProxyHostRow, requireCapabilities: boolean, force: boolean): Promise<ProxyHostRow> {
    if (host.type !== 'proxy' || host.upstreamKind === 'manual' || !host.nodeId) return host;
    const target = await this.resolveTarget(host);
    const supported = await this.nodesSupportSecureLinks([host.nodeId, target.nodeId]);
    if (!supported) {
      if (requireCapabilities) {
        throw new AppError(
          409,
          'PROXY_SECURE_LINK_UPDATE_REQUIRED',
          'Update both Nginx and Docker daemons before creating this Docker proxy link'
        );
      }
      return host;
    }
    if (!this.connectorImage) {
      throw new AppError(503, 'SECURE_LINK_CONNECTOR_UNAVAILABLE', 'Secure Link connector image is not configured');
    }

    const changed =
      host.dockerNodeId !== target.nodeId ||
      host.secureLinkTargetNetwork !== target.network ||
      host.secureLinkTargetContainer !== target.container ||
      host.secureLinkTargetHost !== null ||
      host.dockerContainerPort !== target.applicationPort ||
      host.dockerHostPort !== target.targetPort;
    const cutoverCommitted = host.secureLinkMigratedAt != null;
    // Another caller may already have prepared and probed this exact generation
    // and be between prepare() and commitCutover(). Keep that durable hand-off
    // intact instead of reverting it to provisioning from a second reconciler.
    if (!cutoverCommitted && host.secureLinkStatus === 'cutover_ready' && !changed) return host;
    const activeUpdate = cutoverCommitted && (changed || host.secureLinkStatus === 'updating');
    if (cutoverCommitted && host.secureLinkStatus === 'active' && !changed) {
      if (!force) return host;
      try {
        await this.syncTargetNode(target.nodeId);
        await this.relayPolicy.ensureProxySecureLink(host.id, host.nodeId, target.nodeId);
        await this.syncSourceNode(host.nodeId);
        const probe = await this.probeSecureLink(host.nodeId, {
          linkId: host.id,
          scheme: host.forwardScheme ?? 'http',
          path: host.healthCheckUrl || '/',
          timeoutSeconds: 10,
        });
        if (!probe.httpStatus) throw new Error(probe.error || 'Secure Link end-to-end probe failed');
        const [refreshed] = await this.db
          .update(proxyHosts)
          .set({ secureLinkLastError: null, updatedAt: new Date() })
          .where(and(eq(proxyHosts.id, host.id), eq(proxyHosts.secureLinkGeneration, host.secureLinkGeneration)))
          .returning();
        return refreshed ?? host;
      } catch (error) {
        await this.markCutoverError(host.id, error);
        throw error;
      }
    }
    const generation =
      host.secureLinkGeneration < 1
        ? 1
        : changed || host.secureLinkStatus === 'cleanup_pending'
          ? host.secureLinkGeneration + 1
          : host.secureLinkGeneration;
    await this.db
      .update(proxyHosts)
      .set({
        dockerNodeId: target.nodeId,
        dockerHostPort: target.targetPort,
        dockerProtocol: 'tcp',
        secureLinkGeneration: generation,
        secureLinkStatus: activeUpdate ? 'updating' : 'provisioning',
        secureLinkLastError: null,
        secureLinkTargetNetwork: target.network,
        secureLinkTargetContainer: target.container,
        secureLinkTargetHost: null,
        updatedAt: new Date(),
      })
      .where(eq(proxyHosts.id, host.id));

    try {
      if (activeUpdate) {
        // Close the production path before mutating the in-place target binding.
        // The replacement source listener is intentionally unreachable from the
        // currently loaded Nginx config until probe and atomic config cutover.
        await this.relayPolicy.revokeOwner('proxy_host_secure_link', host.id);
        await this.syncSourceNode(host.nodeId, host.id);
      }
      await this.syncTargetNode(target.nodeId);
      await this.relayPolicy.ensureProxySecureLink(host.id, host.nodeId, target.nodeId);
      if (!activeUpdate) await this.syncSourceNode(host.nodeId);
      const probe = await this.probeSecureLink(host.nodeId, {
        linkId: host.id,
        scheme: host.forwardScheme ?? 'http',
        path: host.healthCheckUrl || '/',
        timeoutSeconds: 10,
      });
      if (!probe.httpStatus) throw new Error(probe.error || 'Secure Link end-to-end probe failed');
      await this.db
        .update(proxyHosts)
        .set({ secureLinkStatus: 'cutover_ready', secureLinkLastError: null, updatedAt: new Date() })
        .where(and(eq(proxyHosts.id, host.id), eq(proxyHosts.secureLinkGeneration, generation)));
      const refreshed = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, host.id) });
      if (!refreshed?.secureLinkListenerPort) {
        throw new Error('Nginx daemon did not return a secure-link listener port');
      }
      return refreshed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!cutoverCommitted) {
        await this.relayPolicy.revokeOwner('proxy_host_secure_link', host.id).catch(() => undefined);
      }
      await this.db
        .update(proxyHosts)
        .set({
          secureLinkStatus: cutoverCommitted ? (activeUpdate ? 'updating' : 'provisioning') : 'legacy',
          ...(cutoverCommitted
            ? {}
            : {
                forwardHost: host.forwardHost,
                forwardPort: host.forwardPort,
                dockerNodeId: host.dockerNodeId,
                dockerHostPort: host.dockerHostPort,
                dockerProtocol: host.dockerProtocol,
                secureLinkGeneration: 0,
                secureLinkTargetNetwork: host.secureLinkTargetNetwork,
                secureLinkTargetContainer: host.secureLinkTargetContainer,
                secureLinkTargetHost: host.secureLinkTargetHost,
                secureLinkListenerPort: host.secureLinkListenerPort,
                secureLinkConnectorPort: host.secureLinkConnectorPort,
              }),
          secureLinkLastError: message,
          updatedAt: new Date(),
        })
        .where(eq(proxyHosts.id, host.id));
      if (!cutoverCommitted) {
        await Promise.allSettled([this.syncSourceNode(host.nodeId), this.syncTargetNode(target.nodeId)]);
      }
      if (requireCapabilities || cutoverCommitted) throw error;
      const restored = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, host.id) });
      return restored ?? host;
    }
  }

  async activate(hostId: string): Promise<void> {
    await this.db
      .update(proxyHosts)
      .set({
        secureLinkStatus: 'active',
        secureLinkLastError: null,
        updatedAt: new Date(),
      })
      .where(eq(proxyHosts.id, hostId));
  }

  async commitCutover(hostId: string): Promise<void> {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, hostId) });
    if (!host || host.secureLinkGeneration < 1) throw new Error('Secure Link is not prepared for cutover');
    if (host.secureLinkMigratedAt) return;
    await this.db
      .update(proxyHosts)
      .set({ secureLinkMigratedAt: new Date(), updatedAt: new Date() })
      .where(eq(proxyHosts.id, hostId));
  }

  async markCutoverError(hostId: string, error: unknown): Promise<void> {
    await this.db
      .update(proxyHosts)
      .set({ secureLinkLastError: error instanceof Error ? error.message : String(error), updatedAt: new Date() })
      .where(eq(proxyHosts.id, hostId));
  }

  async cleanup(host: ProxyHostRow): Promise<void> {
    await this.withLinkOperation(host.id, () => this.cleanupLocked(host));
  }

  private async cleanupLocked(host: ProxyHostRow): Promise<void> {
    if (host.secureLinkGeneration < 1) return;
    const before = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, host.id) });
    if (!before || before.secureLinkGeneration > host.secureLinkGeneration) return;
    const cleanupGeneration = before.secureLinkGeneration;
    await this.db
      .update(proxyHosts)
      .set({
        // A Docker-to-manual update clears the public Docker reference before
        // teardown. Retain the former node only while cleanup is pending so a
        // retry after failure or Gateway restart can still remove its binding.
        dockerNodeId: host.dockerNodeId,
        secureLinkStatus: 'cleanup_pending',
        secureLinkLastError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(proxyHosts.id, host.id), eq(proxyHosts.secureLinkGeneration, cleanupGeneration)));
    try {
      await this.relayPolicy.revokeOwner('proxy_host_secure_link', host.id);
      await Promise.all([
        host.nodeId ? this.syncSourceNode(host.nodeId) : Promise.resolve(),
        host.dockerNodeId ? this.syncTargetNode(host.dockerNodeId) : Promise.resolve(),
      ]);
      const current = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, host.id) });
      await this.db
        .update(proxyHosts)
        .set({
          ...(current?.upstreamKind === 'manual' ? { dockerNodeId: null } : {}),
          ...(current?.upstreamKind === 'manual' || current?.type === 'raw' || current?.rawConfigEnabled
            ? { secureLinkMigratedAt: null }
            : {}),
          secureLinkGeneration: 0,
          secureLinkStatus: 'legacy',
          secureLinkLastError: null,
          secureLinkListenerPort: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(proxyHosts.id, host.id),
            eq(proxyHosts.secureLinkGeneration, cleanupGeneration),
            eq(proxyHosts.secureLinkStatus, 'cleanup_pending')
          )
        );
    } catch (error) {
      await this.db
        .update(proxyHosts)
        .set({
          secureLinkStatus: 'cleanup_pending',
          secureLinkLastError: error instanceof Error ? error.message : String(error),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(proxyHosts.id, host.id),
            eq(proxyHosts.secureLinkGeneration, cleanupGeneration),
            eq(proxyHosts.secureLinkStatus, 'cleanup_pending')
          )
        );
      throw error;
    }
  }

  async reconcileExisting(host: ProxyHostRow): Promise<ProxyHostRow> {
    return this.prepare(host, false, true, 'reconciliation');
  }

  async reconcileTargetNode(nodeId: string): Promise<void> {
    await this.syncTargetNode(nodeId);
  }

  private async withLinkOperation<T>(linkId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.linkOperations.get(linkId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.linkOperations.set(linkId, current);
    try {
      return await current;
    } finally {
      if (this.linkOperations.get(linkId) === current) this.linkOperations.delete(linkId);
    }
  }

  private emitLinkState(
    host: ProxyHostRow,
    phase: 'provisioning' | 'reconciliation',
    state: 'ready' | 'failed',
    error?: unknown
  ): void {
    const payload = {
      id: host.id,
      domain: host.domainNames?.[0] ?? host.id,
      phase,
      state,
      failureCode: state === 'failed' ? this.failureCode(error) : null,
    };
    this.eventBus?.publish('proxy.secure-link.changed', payload);
    // Proxy host cache consumers use this established resource channel.
    this.eventBus?.publish('proxy.host.changed', { ...payload, action: 'secure_link_changed' });
  }

  private failureCode(error: unknown): string {
    if (error instanceof AppError) return error.code;
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (/timeout|timed out/i.test(message)) return 'timeout';
    if (/offline|unavailable|disconnect/i.test(message)) return 'node_unavailable';
    if (/probe|status|response/i.test(message)) return 'probe_failed';
    return 'secure_link_failed';
  }

  private async nodesSupportSecureLinks(nodeIds: string[]): Promise<boolean> {
    const unique = [...new Set(nodeIds)];
    const rows = await this.db
      .select({ id: nodes.id, capabilities: nodes.capabilities })
      .from(nodes)
      .where(inArray(nodes.id, unique));
    if (rows.length !== unique.length) return false;
    return rows.every((row) => {
      const reported = (row.capabilities as Record<string, unknown> | null)?.capabilities;
      return Array.isArray(reported) && reported.includes('proxy_secure_links_v1');
    });
  }

  private async resolveTarget(host: ProxyHostRow): Promise<{
    nodeId: string;
    network: string;
    container: string;
    applicationPort: number;
    targetPort: number;
  }> {
    if (!host.dockerContainerPort) throw new AppError(400, 'INVALID_DOCKER_PORT', 'Container port is required');
    if (host.upstreamKind === 'docker_container') {
      if (!host.dockerNodeId || !host.dockerContainerName) {
        throw new AppError(400, 'INVALID_DOCKER_TARGET', 'Docker node and container are required');
      }
      return {
        nodeId: host.dockerNodeId,
        network: host.secureLinkTargetNetwork ?? '',
        container: host.dockerContainerName,
        applicationPort: host.dockerContainerPort,
        targetPort: host.dockerContainerPort,
      };
    }
    if (!host.dockerDeploymentId) throw new AppError(400, 'INVALID_DOCKER_TARGET', 'Docker deployment is required');
    const [deployment] = await this.db
      .select({
        nodeId: dockerDeployments.nodeId,
        networkName: dockerDeployments.networkName,
        routerName: dockerDeployments.routerName,
      })
      .from(dockerDeployments)
      .where(eq(dockerDeployments.id, host.dockerDeploymentId))
      .limit(1);
    if (!deployment) throw new AppError(404, 'DOCKER_DEPLOYMENT_NOT_FOUND', 'Docker deployment not found');
    const routes = await this.db
      .select({ hostPort: dockerDeploymentRoutes.hostPort })
      .from(dockerDeploymentRoutes)
      .where(
        and(
          eq(dockerDeploymentRoutes.deploymentId, host.dockerDeploymentId),
          eq(dockerDeploymentRoutes.containerPort, host.dockerContainerPort)
        )
      );
    if (routes.length !== 1)
      throw new AppError(409, 'DOCKER_PORT_AMBIGUOUS', 'Deployment application port is unavailable');
    return {
      nodeId: deployment.nodeId,
      network: deployment.networkName,
      container: deployment.routerName,
      applicationPort: host.dockerContainerPort,
      targetPort: routes[0]!.hostPort,
    };
  }

  private async syncTargetNode(nodeId: string): Promise<void> {
    const previous = this.targetNodeSyncs.get(nodeId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.syncTargetNodeLocked(nodeId));
    this.targetNodeSyncs.set(nodeId, current);
    try {
      await current;
    } finally {
      if (this.targetNodeSyncs.get(nodeId) === current) this.targetNodeSyncs.delete(nodeId);
    }
  }

  private async syncTargetNodeLocked(nodeId: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const hosts = await this.db.query.proxyHosts.findMany({
        where: and(
          eq(proxyHosts.dockerNodeId, nodeId),
          ne(proxyHosts.upstreamKind, 'manual'),
          ne(proxyHosts.secureLinkStatus, 'cleanup_pending'),
          ne(proxyHosts.secureLinkGeneration, 0)
        ),
      });
      const targetBindings = hosts.map((host) => ({
        linkId: host.id,
        role: 'target' as const,
        generation: host.secureLinkGeneration,
        targetNetwork: host.secureLinkTargetNetwork ?? '',
        targetContainer: host.secureLinkTargetContainer ?? '',
        targetHost: host.secureLinkTargetHost ?? '',
        targetPort: host.dockerHostPort ?? host.dockerContainerPort ?? 0,
        connectorImage: this.connectorImage,
        allowNetworkReselection: host.upstreamKind === 'docker_container',
      }));
      let result = await this.dispatch.sendProxySecureLinks(nodeId, targetBindings);
      if (!result.success) throw new Error(result.error || 'Docker daemon rejected secure-link bindings');
      let statuses = this.parseBindings(result.detail);
      const statusByLink = new Map(statuses.map((binding) => [binding.linkId, binding]));
      let networkChanged = false;
      const reconciledBindings = targetBindings.map((binding) => {
        const status = statusByLink.get(binding.linkId);
        if (!status?.targetNetwork || status.targetNetwork === binding.targetNetwork) return binding;
        networkChanged = true;
        return {
          ...binding,
          generation: binding.generation + 1,
          targetNetwork: status.targetNetwork,
        };
      });
      if (networkChanged) {
        let desiredStateChanged = false;
        for (const binding of reconciledBindings) {
          const original = targetBindings.find((candidate) => candidate.linkId === binding.linkId);
          if (!original || original.targetNetwork === binding.targetNetwork) continue;
          const applied = await this.db
            .update(proxyHosts)
            .set({
              secureLinkGeneration: binding.generation,
              secureLinkTargetNetwork: binding.targetNetwork,
              updatedAt: new Date(),
            })
            .where(and(eq(proxyHosts.id, binding.linkId), eq(proxyHosts.secureLinkGeneration, original.generation)))
            .returning({ id: proxyHosts.id });
          if (applied.length === 0) {
            desiredStateChanged = true;
            break;
          }
        }
        if (desiredStateChanged) {
          if (attempt === 0) continue;
          throw new Error('Proxy secure-link desired state changed during network reconciliation');
        }
        result = await this.dispatch.sendProxySecureLinks(nodeId, reconciledBindings);
        if (!result.success) throw new Error(result.error || 'Docker daemon rejected reconciled secure-link bindings');
        statuses = this.parseBindings(result.detail);
      }
      for (const binding of statuses) {
        await this.db
          .update(proxyHosts)
          .set({
            secureLinkConnectorPort: binding.port,
            ...(binding.targetNetwork ? { secureLinkTargetNetwork: binding.targetNetwork } : {}),
          })
          .where(and(eq(proxyHosts.id, binding.linkId), eq(proxyHosts.secureLinkGeneration, binding.generation)));
      }
      return;
    }
  }

  private async syncSourceNode(nodeId: string, rotateLinkId?: string): Promise<void> {
    const previous = this.sourceNodeSyncs.get(nodeId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.syncSourceNodeLocked(nodeId, rotateLinkId));
    this.sourceNodeSyncs.set(nodeId, current);
    try {
      await current;
    } finally {
      if (this.sourceNodeSyncs.get(nodeId) === current) this.sourceNodeSyncs.delete(nodeId);
    }
  }

  private async syncSourceNodeLocked(nodeId: string, rotateLinkId?: string): Promise<void> {
    const hosts = await this.db.query.proxyHosts.findMany({
      where: and(
        eq(proxyHosts.nodeId, nodeId),
        ne(proxyHosts.upstreamKind, 'manual'),
        ne(proxyHosts.secureLinkStatus, 'cleanup_pending'),
        ne(proxyHosts.secureLinkGeneration, 0)
      ),
    });
    const result = await this.dispatch.sendProxySecureLinks(
      nodeId,
      hosts.map((host) => ({
        linkId: host.id,
        role: 'source' as const,
        generation: host.secureLinkGeneration,
        listenerPort: host.secureLinkListenerPort ?? 0,
        sourceConfigManaged: host.secureLinkStatus === 'active' && host.type === 'proxy' && !host.rawConfigEnabled,
        rotateListener: host.id === rotateLinkId,
      }))
    );
    if (!result.success) throw new Error(result.error || 'Nginx daemon rejected secure-link listeners');
    for (const binding of this.parseBindings(result.detail)) {
      await this.db
        .update(proxyHosts)
        .set({ secureLinkListenerPort: binding.port })
        .where(and(eq(proxyHosts.id, binding.linkId), eq(proxyHosts.secureLinkGeneration, binding.generation)));
    }
  }

  private parseBindings(detail: string | undefined): BindingDetail[] {
    if (!detail) return [];
    const decoded = JSON.parse(detail) as { bindings?: BindingDetail[] };
    return Array.isArray(decoded.bindings) ? decoded.bindings : [];
  }

  private async probeSecureLink(
    nodeId: string,
    input: Parameters<NodeDispatchService['probeProxySecureLink']>[1]
  ): Promise<Awaited<ReturnType<NodeDispatchService['probeProxySecureLink']>>> {
    let lastError: unknown = new Error('Secure Link end-to-end probe failed');
    for (let attempt = 0; attempt < PROXY_SECURE_LINK_PROBE_ATTEMPTS; attempt++) {
      try {
        const result = await this.dispatch.probeProxySecureLink(nodeId, input);
        if (result.httpStatus) return result;
        lastError = new Error(result.error || 'Secure Link end-to-end probe failed');
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < PROXY_SECURE_LINK_PROBE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, PROXY_SECURE_LINK_PROBE_RETRY_MS));
      }
    }
    throw lastError;
  }
}
