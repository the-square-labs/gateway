import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerDeploymentRoutes,
  dockerDeployments,
  nodes,
  proxyAdditionalSecureLinks,
  proxyHosts,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';

type ProxyHostRow = typeof proxyHosts.$inferSelect;
export type ProxyAdditionalSecureLinkRow = typeof proxyAdditionalSecureLinks.$inferSelect;

export interface CreateProxyAdditionalSecureLinkInput {
  name: string;
  upstreamKind: 'docker_container' | 'docker_deployment';
  forwardScheme: 'http' | 'https';
  dockerNodeId?: string | null;
  dockerContainerName?: string | null;
  dockerDeploymentId?: string | null;
  dockerContainerPort: number;
}

interface BindingDetail {
  linkId: string;
  generation: number;
  port: number;
  targetNetwork?: string;
}

const PROXY_SECURE_LINK_PROBE_ATTEMPTS = 6;
const PROXY_SECURE_LINK_PROBE_RETRY_MS = 500;
const logger = createChildLogger('ProxySecureLinkService');

export class ProxySecureLinkService {
  private eventBus?: EventBusService;
  private readonly targetNodeSyncs = new Map<string, Promise<void>>();
  private readonly sourceNodeSyncs = new Map<string, Promise<void>>();
  private readonly linkOperations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly dispatch: NodeDispatchService,
    private readonly relayPolicy: RelayPolicyService,
    private connectorImage: string
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  async updateConnectorImage(connectorImage: string): Promise<void> {
    if (connectorImage === this.connectorImage) return;
    this.connectorImage = connectorImage;

    try {
      const [hosts, additional] = await Promise.all([
        this.db.query.proxyHosts.findMany({
          where: and(
            ne(proxyHosts.upstreamKind, 'manual'),
            ne(proxyHosts.secureLinkStatus, 'cleanup_pending'),
            ne(proxyHosts.secureLinkGeneration, 0)
          ),
          columns: { dockerNodeId: true },
        }),
        (this.db.query as any).proxyAdditionalSecureLinks
          ? (this.db.query as any).proxyAdditionalSecureLinks.findMany({
              where: inArray(proxyAdditionalSecureLinks.status, ['provisioning', 'active']),
              columns: { dockerNodeId: true },
            })
          : Promise.resolve([]),
      ]);
      const targetNodeIds = new Set<string>();
      for (const host of hosts) {
        if (host.dockerNodeId) targetNodeIds.add(host.dockerNodeId);
      }
      for (const binding of additional as Array<{ dockerNodeId: string }>) {
        targetNodeIds.add(binding.dockerNodeId);
      }

      const nodesToSync = [...targetNodeIds];
      const results = await Promise.allSettled(nodesToSync.map((nodeId) => this.syncTargetNode(nodeId)));
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.warn('Failed to apply the updated Secure Link connector image to a Docker node', {
            nodeId: nodesToSync[index],
            error: result.reason,
          });
        }
      });
    } catch (error) {
      logger.warn('Failed to reconcile Secure Link connectors after the Relay update', { error });
    }
  }

  async getRuntime(linkId: string) {
    return this.relayPolicy.getProxyRouteRuntime(linkId);
  }

  async listAdditional(proxyHostId: string): Promise<ProxyAdditionalSecureLinkRow[]> {
    return this.db.query.proxyAdditionalSecureLinks.findMany({
      where: eq(proxyAdditionalSecureLinks.proxyHostId, proxyHostId),
      orderBy: (binding, { asc }) => [asc(binding.createdAt)],
    });
  }

  async getActiveAdditional(proxyHostId: string): Promise<ProxyAdditionalSecureLinkRow[]> {
    return this.db.query.proxyAdditionalSecureLinks.findMany({
      where: and(
        eq(proxyAdditionalSecureLinks.proxyHostId, proxyHostId),
        eq(proxyAdditionalSecureLinks.status, 'active')
      ),
      orderBy: (binding, { asc }) => [asc(binding.name)],
    });
  }

  async createAdditional(
    host: ProxyHostRow,
    input: CreateProxyAdditionalSecureLinkInput
  ): Promise<ProxyAdditionalSecureLinkRow> {
    if (host.type !== 'proxy' || host.rawConfigEnabled || !host.nodeId) {
      throw new AppError(
        409,
        'ADDITIONAL_SECURE_LINK_UNAVAILABLE',
        'Additional Secure Links require a managed proxy host'
      );
    }
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.name)) {
      throw new AppError(
        400,
        'INVALID_SECURE_LINK_NAME',
        'Binding name must start with a letter and contain only letters, numbers, and underscores'
      );
    }
    if (input.dockerContainerPort < 1 || input.dockerContainerPort > 65535) {
      throw new AppError(400, 'INVALID_DOCKER_PORT', 'Container port must be between 1 and 65535');
    }

    const target = await this.resolveAdditionalTarget(input);
    if (!(await this.nodesSupportSecureLinks([host.nodeId, target.nodeId]))) {
      throw new AppError(
        409,
        'PROXY_SECURE_LINK_UPDATE_REQUIRED',
        'Update both Nginx and Docker daemons before provisioning this binding'
      );
    }
    if (!this.connectorImage) {
      throw new AppError(503, 'SECURE_LINK_CONNECTOR_UNAVAILABLE', 'Secure Link connector image is not configured');
    }
    const existing = await this.db.query.proxyAdditionalSecureLinks.findFirst({
      where: and(eq(proxyAdditionalSecureLinks.proxyHostId, host.id), eq(proxyAdditionalSecureLinks.name, input.name)),
    });
    if (existing) throw new AppError(409, 'SECURE_LINK_NAME_EXISTS', 'A binding with this name already exists');

    const [created] = await this.db
      .insert(proxyAdditionalSecureLinks)
      .values({
        proxyHostId: host.id,
        name: input.name,
        upstreamKind: input.upstreamKind,
        forwardScheme: input.forwardScheme,
        sourceNodeId: host.nodeId,
        dockerNodeId: target.nodeId,
        dockerContainerName: input.upstreamKind === 'docker_container' ? input.dockerContainerName : null,
        dockerDeploymentId: input.upstreamKind === 'docker_deployment' ? input.dockerDeploymentId : null,
        dockerContainerPort: input.dockerContainerPort,
        dockerHostPort: target.targetPort,
        targetNetwork: target.network,
        targetContainer: target.container,
      })
      .returning();

    this.emitAdditionalState(host, created, 'provisioning');
    void this.createAdditionalFromExisting(host, created.id).catch((error) => {
      logger.error('Background additional Secure Link provisioning failed unexpectedly', {
        hostId: host.id,
        bindingId: created.id,
        error,
      });
    });
    return created;
  }

  async retryAdditional(host: ProxyHostRow, bindingId: string): Promise<ProxyAdditionalSecureLinkRow> {
    const binding = await this.requireAdditional(host.id, bindingId);
    await this.db
      .update(proxyAdditionalSecureLinks)
      .set({ status: 'cleanup_pending', updatedAt: new Date() })
      .where(eq(proxyAdditionalSecureLinks.id, binding.id));
    await this.deprovisionAdditionalRuntime(binding);
    await this.db
      .update(proxyAdditionalSecureLinks)
      .set({ generation: binding.generation + 1, status: 'provisioning', lastError: null, updatedAt: new Date() })
      .where(eq(proxyAdditionalSecureLinks.id, binding.id));
    return this.createAdditionalFromExisting(host, binding.id);
  }

  async deleteAdditional(host: ProxyHostRow, bindingId: string): Promise<void> {
    const binding = await this.requireAdditional(host.id, bindingId);
    const variable = `{{additionalSecureLinks.${binding.name}}}`;
    if (host.advancedConfig?.includes(variable)) {
      throw new AppError(
        409,
        'SECURE_LINK_IN_USE',
        `Remove ${variable} from Advanced config before deleting this binding`
      );
    }
    const [pending] = await this.db
      .update(proxyAdditionalSecureLinks)
      .set({ status: 'cleanup_pending', lastError: null, updatedAt: new Date() })
      .where(eq(proxyAdditionalSecureLinks.id, binding.id))
      .returning();
    this.emitAdditionalState(host, pending ?? binding, 'cleanup_pending');
    void this.finishAdditionalDeletion(host, binding).catch((error) => {
      logger.error('Background additional Secure Link cleanup failed unexpectedly', {
        hostId: host.id,
        bindingId: binding.id,
        error,
      });
    });
  }

  async reconcileAdditionalLifecycle(): Promise<boolean> {
    const pending = await this.db.query.proxyAdditionalSecureLinks.findMany({
      where: inArray(proxyAdditionalSecureLinks.status, ['provisioning', 'cleanup_pending']),
    });
    let retryNeeded = false;
    for (const binding of pending) {
      const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, binding.proxyHostId) });
      if (!host) continue;
      try {
        if (binding.status === 'cleanup_pending') {
          await this.finishAdditionalDeletion(host, binding);
        } else {
          await this.createAdditionalFromExisting(host, binding.id);
        }
      } catch (error) {
        logger.debug('Additional Secure Link lifecycle reconciliation is still pending', {
          hostId: binding.proxyHostId,
          bindingId: binding.id,
          error,
        });
        retryNeeded = true;
      }
    }
    return retryNeeded;
  }

  async cleanupAdditionalForHost(host: ProxyHostRow): Promise<void> {
    const bindings = await this.listAdditional(host.id);
    if (bindings.length === 0) return;
    await this.db
      .update(proxyAdditionalSecureLinks)
      .set({ status: 'cleanup_pending', lastError: null, updatedAt: new Date() })
      .where(eq(proxyAdditionalSecureLinks.proxyHostId, host.id));
    for (const binding of bindings) {
      await this.relayPolicy.revokeOwner('proxy_host_secure_link', binding.id);
    }
    const sourceNodes = [...new Set(bindings.map((binding) => binding.sourceNodeId))];
    const targetNodes = [...new Set(bindings.map((binding) => binding.dockerNodeId))];
    await Promise.all([
      ...sourceNodes.map((nodeId) => this.syncSourceNode(nodeId)),
      ...targetNodes.map((nodeId) => this.syncTargetNode(nodeId)),
    ]);
    await this.db.delete(proxyAdditionalSecureLinks).where(eq(proxyAdditionalSecureLinks.proxyHostId, host.id));
  }

  /**
   * Retire relay state when an offline Nginx source is being permanently
   * removed from Gateway. The unavailable source cannot acknowledge a fresh
   * snapshot, so only target nodes are synchronized and their cleanup is best
   * effort after the central grants have been revoked.
   */
  async abandonOfflineSource(host: ProxyHostRow): Promise<void> {
    const bindings = await this.listAdditional(host.id);
    if (bindings.length > 0) {
      await this.db
        .update(proxyAdditionalSecureLinks)
        .set({ status: 'cleanup_pending', lastError: null, updatedAt: new Date() })
        .where(eq(proxyAdditionalSecureLinks.proxyHostId, host.id));
    }
    if (host.secureLinkGeneration > 0) {
      await this.db
        .update(proxyHosts)
        .set({ secureLinkStatus: 'cleanup_pending', secureLinkLastError: null, updatedAt: new Date() })
        .where(eq(proxyHosts.id, host.id));
      await this.relayPolicy.revokeOwner('proxy_host_secure_link', host.id, { allowDeferredSnapshot: true });
    }
    for (const binding of bindings) {
      await this.relayPolicy.revokeOwner('proxy_host_secure_link', binding.id, { allowDeferredSnapshot: true });
    }

    const targetNodes = [
      ...(host.dockerNodeId ? [host.dockerNodeId] : []),
      ...bindings.map((binding) => binding.dockerNodeId),
    ];
    const targetResults = await Promise.allSettled(
      [...new Set(targetNodes)].map((nodeId) => this.syncTargetNode(nodeId))
    );
    for (const result of targetResults) {
      if (result.status === 'rejected') {
        logger.warn('Failed to remove abandoned Secure Link state from a target node', {
          hostId: host.id,
          error: result.reason,
        });
      }
    }
    if (bindings.length > 0) {
      await this.db.delete(proxyAdditionalSecureLinks).where(eq(proxyAdditionalSecureLinks.proxyHostId, host.id));
    }
  }

  async assertAdditionalReferences(proxyHostId: string, snippet: string | null | undefined): Promise<void> {
    const matches = [...(snippet ?? '').matchAll(/\{\{additionalSecureLinks\.([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g)];
    if (matches.length === 0) return;
    const active = await this.getActiveAdditional(proxyHostId);
    const names = new Set(active.map((binding) => binding.name));
    const missing = [...new Set(matches.map((match) => match[1]!).filter((name) => !names.has(name)))];
    if (missing.length > 0) {
      throw new AppError(
        400,
        'INVALID_SECURE_LINK_REFERENCE',
        `Unknown or inactive additional Secure Link: ${missing.join(', ')}`
      );
    }
  }

  private async createAdditionalFromExisting(
    host: ProxyHostRow,
    bindingId: string
  ): Promise<ProxyAdditionalSecureLinkRow> {
    return this.withLinkOperation(bindingId, async () => {
      const binding = await this.requireAdditional(host.id, bindingId);
      if (binding.status !== 'provisioning') return binding;
      try {
        await this.syncTargetNode(binding.dockerNodeId);
        await this.relayPolicy.ensureProxySecureLink(binding.id, binding.sourceNodeId, binding.dockerNodeId);
        await this.syncSourceNode(binding.sourceNodeId);
        await this.probeSecureLink(binding.sourceNodeId, {
          linkId: binding.id,
          scheme: binding.forwardScheme,
          path: '/',
          timeoutSeconds: 10,
        });
        const [active] = await this.db
          .update(proxyAdditionalSecureLinks)
          .set({ status: 'active', lastError: null, updatedAt: new Date() })
          .where(
            and(eq(proxyAdditionalSecureLinks.id, binding.id), eq(proxyAdditionalSecureLinks.status, 'provisioning'))
          )
          .returning();
        if (active) {
          this.emitAdditionalState(host, active, 'active');
          return active;
        }
        return this.requireAdditional(host.id, binding.id);
      } catch (error) {
        await this.relayPolicy.revokeOwner('proxy_host_secure_link', binding.id).catch(() => undefined);
        const [failed] = await this.db
          .update(proxyAdditionalSecureLinks)
          .set({
            status: 'failed',
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: new Date(),
          })
          .where(
            and(eq(proxyAdditionalSecureLinks.id, binding.id), eq(proxyAdditionalSecureLinks.status, 'provisioning'))
          )
          .returning();
        await Promise.allSettled([
          this.syncSourceNode(binding.sourceNodeId),
          this.syncTargetNode(binding.dockerNodeId),
        ]);
        if (failed) {
          this.emitAdditionalState(host, failed, 'failed');
          return failed;
        }
        return this.requireAdditional(host.id, binding.id);
      }
    });
  }

  private async finishAdditionalDeletion(host: ProxyHostRow, binding: ProxyAdditionalSecureLinkRow): Promise<void> {
    return this.withLinkOperation(binding.id, async () => {
      const current = await this.db.query.proxyAdditionalSecureLinks.findFirst({
        where: and(eq(proxyAdditionalSecureLinks.id, binding.id), eq(proxyAdditionalSecureLinks.proxyHostId, host.id)),
      });
      if (!current) return;
      if (current.status !== 'cleanup_pending') return;
      try {
        await this.deprovisionAdditionalRuntime(current);
        await this.db.delete(proxyAdditionalSecureLinks).where(eq(proxyAdditionalSecureLinks.id, current.id));
        this.emitAdditionalState(host, current, 'deleted');
      } catch (error) {
        const [pending] = await this.db
          .update(proxyAdditionalSecureLinks)
          .set({
            status: 'cleanup_pending',
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: new Date(),
          })
          .where(eq(proxyAdditionalSecureLinks.id, current.id))
          .returning();
        this.emitAdditionalState(host, pending ?? current, 'cleanup_failed');
        throw error;
      }
    });
  }

  private async deprovisionAdditionalRuntime(binding: ProxyAdditionalSecureLinkRow): Promise<void> {
    await this.relayPolicy.revokeOwner('proxy_host_secure_link', binding.id);
    await Promise.all([this.syncSourceNode(binding.sourceNodeId), this.syncTargetNode(binding.dockerNodeId)]);
  }

  private async requireAdditional(proxyHostId: string, bindingId: string): Promise<ProxyAdditionalSecureLinkRow> {
    const binding = await this.db.query.proxyAdditionalSecureLinks.findFirst({
      where: and(eq(proxyAdditionalSecureLinks.id, bindingId), eq(proxyAdditionalSecureLinks.proxyHostId, proxyHostId)),
    });
    if (!binding) throw new AppError(404, 'SECURE_LINK_BINDING_NOT_FOUND', 'Additional Secure Link binding not found');
    return binding;
  }

  private emitAdditionalState(host: ProxyHostRow, binding: ProxyAdditionalSecureLinkRow, action: string): void {
    const payload = { id: host.id, bindingId: binding.id, name: binding.name, action };
    this.eventBus?.publish('proxy.secure-link.changed', payload);
    this.eventBus?.publish('proxy.host.changed', payload);
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

  async reconcileSourceNode(nodeId: string): Promise<void> {
    await this.syncSourceNode(nodeId);
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

  private async resolveAdditionalTarget(input: CreateProxyAdditionalSecureLinkInput): Promise<{
    nodeId: string;
    network: string;
    container: string;
    targetPort: number;
  }> {
    if (input.upstreamKind === 'docker_container') {
      if (!input.dockerNodeId || !input.dockerContainerName) {
        throw new AppError(400, 'INVALID_DOCKER_TARGET', 'Docker node and container are required');
      }
      return {
        nodeId: input.dockerNodeId,
        network: '',
        container: input.dockerContainerName,
        targetPort: input.dockerContainerPort,
      };
    }
    if (!input.dockerDeploymentId) {
      throw new AppError(400, 'INVALID_DOCKER_TARGET', 'Docker deployment is required');
    }
    const [deployment] = await this.db
      .select({
        nodeId: dockerDeployments.nodeId,
        networkName: dockerDeployments.networkName,
        routerName: dockerDeployments.routerName,
      })
      .from(dockerDeployments)
      .where(eq(dockerDeployments.id, input.dockerDeploymentId))
      .limit(1);
    if (!deployment) throw new AppError(404, 'DOCKER_DEPLOYMENT_NOT_FOUND', 'Docker deployment not found');
    const routes = await this.db
      .select({ hostPort: dockerDeploymentRoutes.hostPort })
      .from(dockerDeploymentRoutes)
      .where(
        and(
          eq(dockerDeploymentRoutes.deploymentId, input.dockerDeploymentId),
          eq(dockerDeploymentRoutes.containerPort, input.dockerContainerPort)
        )
      );
    if (routes.length !== 1) {
      throw new AppError(409, 'DOCKER_PORT_AMBIGUOUS', 'Deployment application port is unavailable');
    }
    return {
      nodeId: deployment.nodeId,
      network: deployment.networkName,
      container: deployment.routerName,
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
      const additional: ProxyAdditionalSecureLinkRow[] = (this.db.query as any).proxyAdditionalSecureLinks
        ? await (this.db.query as any).proxyAdditionalSecureLinks.findMany({
            where: and(
              eq(proxyAdditionalSecureLinks.dockerNodeId, nodeId),
              inArray(proxyAdditionalSecureLinks.status, ['provisioning', 'active'])
            ),
          })
        : [];
      const targetBindings = [
        ...hosts.map((host) => ({
          linkId: host.id,
          role: 'target' as const,
          generation: host.secureLinkGeneration,
          targetNetwork: host.secureLinkTargetNetwork ?? '',
          targetContainer: host.secureLinkTargetContainer ?? '',
          targetHost: host.secureLinkTargetHost ?? '',
          targetPort: host.dockerHostPort ?? host.dockerContainerPort ?? 0,
          connectorImage: this.connectorImage,
          allowNetworkReselection: host.upstreamKind === 'docker_container',
        })),
        ...additional.map((binding) => ({
          linkId: binding.id,
          role: 'target' as const,
          generation: binding.generation,
          targetNetwork: binding.targetNetwork,
          targetContainer: binding.targetContainer,
          targetHost: '',
          targetPort: binding.dockerHostPort,
          connectorImage: this.connectorImage,
          allowNetworkReselection: binding.upstreamKind === 'docker_container',
        })),
      ];
      const additionalIds = new Set(additional.map((binding: ProxyAdditionalSecureLinkRow) => binding.id));
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
          const applied = additionalIds.has(binding.linkId)
            ? await this.db
                .update(proxyAdditionalSecureLinks)
                .set({ generation: binding.generation, targetNetwork: binding.targetNetwork, updatedAt: new Date() })
                .where(
                  and(
                    eq(proxyAdditionalSecureLinks.id, binding.linkId),
                    eq(proxyAdditionalSecureLinks.generation, original.generation)
                  )
                )
                .returning({ id: proxyAdditionalSecureLinks.id })
            : await this.db
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
        if (additionalIds.has(binding.linkId)) {
          await this.db
            .update(proxyAdditionalSecureLinks)
            .set({
              connectorPort: binding.port,
              ...(binding.targetNetwork ? { targetNetwork: binding.targetNetwork } : {}),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(proxyAdditionalSecureLinks.id, binding.linkId),
                eq(proxyAdditionalSecureLinks.generation, binding.generation)
              )
            );
        } else {
          await this.db
            .update(proxyHosts)
            .set({
              secureLinkConnectorPort: binding.port,
              ...(binding.targetNetwork ? { secureLinkTargetNetwork: binding.targetNetwork } : {}),
            })
            .where(and(eq(proxyHosts.id, binding.linkId), eq(proxyHosts.secureLinkGeneration, binding.generation)));
        }
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
    const additional: ProxyAdditionalSecureLinkRow[] = (this.db.query as any).proxyAdditionalSecureLinks
      ? await (this.db.query as any).proxyAdditionalSecureLinks.findMany({
          where: and(
            eq(proxyAdditionalSecureLinks.sourceNodeId, nodeId),
            inArray(proxyAdditionalSecureLinks.status, ['provisioning', 'active'])
          ),
        })
      : [];
    const result = await this.dispatch.sendProxySecureLinks(nodeId, [
      ...hosts.map((host) => ({
        linkId: host.id,
        role: 'source' as const,
        generation: host.secureLinkGeneration,
        listenerPort: host.secureLinkListenerPort ?? 0,
        sourceConfigManaged: host.secureLinkStatus === 'active' && host.type === 'proxy' && !host.rawConfigEnabled,
        rotateListener: host.id === rotateLinkId,
      })),
      ...additional.map((binding) => ({
        linkId: binding.id,
        role: 'source' as const,
        generation: binding.generation,
        listenerPort: binding.listenerPort ?? 0,
        sourceConfigManaged: false,
        rotateListener: binding.id === rotateLinkId,
      })),
    ]);
    if (!result.success) throw new Error(result.error || 'Nginx daemon rejected secure-link listeners');
    const additionalIds = new Set(additional.map((binding: ProxyAdditionalSecureLinkRow) => binding.id));
    for (const binding of this.parseBindings(result.detail)) {
      if (additionalIds.has(binding.linkId)) {
        await this.db
          .update(proxyAdditionalSecureLinks)
          .set({ listenerPort: binding.port, updatedAt: new Date() })
          .where(
            and(
              eq(proxyAdditionalSecureLinks.id, binding.linkId),
              eq(proxyAdditionalSecureLinks.generation, binding.generation)
            )
          );
      } else {
        await this.db
          .update(proxyHosts)
          .set({ secureLinkListenerPort: binding.port })
          .where(and(eq(proxyHosts.id, binding.linkId), eq(proxyHosts.secureLinkGeneration, binding.generation)));
      }
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
