import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  managedDatabaseInstances,
  relayEndpoints,
  relayGrantSigningKeys,
  relayPolicyState,
  relayRoutes,
} from '@/db/schema/index.js';
import {
  RELAY_MAX_FRAME_BYTES,
  type RelayControlClient,
  type RelayPolicySnapshot,
} from '@/grpc/relay-control.client.js';
import { createChildLogger } from '@/lib/logger.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CryptoService } from './crypto.service.js';
import type { EventBusService } from './event-bus.service.js';
import type { NodeDispatchService } from './node-dispatch.service.js';
import { type RelayGrantBundle, RelayGrantIssuerService } from './relay-grant-issuer.service.js';
import { RelayGrantKeyService } from './relay-grant-key.service.js';
import {
  backfillRelayNodeFingerprints,
  bumpRelayPolicyRevision,
  reconcileManagedDatabaseRelayPolicy,
  updateManagedDatabaseRelayStatus,
} from './relay-policy-reconciler.js';

export type { RelayGrantAssignment, RelayGrantBundle, RelayGrantClaims } from './relay-grant-issuer.service.js';

export interface ProxyRouteRuntime {
  routeId: string;
  activeStreams: number;
  openedTotal: string;
  completedTotal: string;
  failedTotal: string;
  throttledTotal: string;
  sourceToTargetBytes: string;
  targetToSourceBytes: string;
  setupLatencyP95Ms: number;
  averageDurationMs: number;
  lastActivityAt: string | null;
  metricsSince: string;
}

const logger = createChildLogger('RelayPolicyService');

export class RelayPolicyService {
  private dispatch?: Pick<NodeDispatchService, 'sendRelayGrantBundle'>;
  private lastGrantRefreshAt = 0;
  private lastGrantRefreshRevision = 0;
  private readonly grantIssuer: RelayGrantIssuerService;
  private readonly grantKeys: RelayGrantKeyService;
  private relaySettingsSync: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: DrizzleClient,
    cryptoService: CryptoService,
    private readonly settings: GeneralSettingsService,
    private readonly relay: RelayControlClient
  ) {
    this.grantIssuer = new RelayGrantIssuerService(db, cryptoService, settings);
    this.grantKeys = new RelayGrantKeyService(db, cryptoService);
  }

  setNodeDispatch(dispatch: Pick<NodeDispatchService, 'sendRelayGrantBundle'>): void {
    this.dispatch = dispatch;
  }

  setEventBus(events: EventBusService): void {
    events.subscribe('system.config.changed', (payload) => {
      if ((payload as { relayChanged?: unknown } | null)?.relayChanged !== true) return;
      this.relaySettingsSync = this.relaySettingsSync
        .then(async () => {
          await this.db.transaction((tx) => bumpRelayPolicyRevision(tx));
          await this.syncSnapshot();
          await this.refreshAllNodeGrantsIfDue(true);
        })
        .catch((error) => {
          logger.warn('Relay runtime settings distribution will be retried', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
    events.subscribe('node.changed', (payload) => {
      const event = payload as { id?: unknown; action?: unknown } | null;
      if (event?.action !== 'deleted' || typeof event.id !== 'string') return;
      void this.revokeNode(event.id).catch((error) => {
        logger.warn('Relay policy node revocation will be retried by snapshot reconciliation', {
          nodeId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    events.subscribe('database.changed', (payload) => {
      const event = payload as {
        resourceKind?: unknown;
        managedDatabaseId?: unknown;
        action?: unknown;
        status?: unknown;
      } | null;
      if (event?.resourceKind !== 'managed_database' || typeof event.managedDatabaseId !== 'string') return;
      const operation =
        event.action === 'deleted'
          ? this.revokeOwner('managed_database', event.managedDatabaseId)
          : typeof event.status === 'string'
            ? this.updateManagedDatabaseStatus(event.managedDatabaseId, event.status)
            : null;
      if (!operation) return;
      void operation.catch((error) => {
        logger.warn('Relay policy managed database cleanup will be retried by snapshot reconciliation', {
          managedDatabaseId: event.managedDatabaseId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  async ensureInitialized(): Promise<void> {
    await backfillRelayNodeFingerprints(this.db);
    await this.grantKeys.ensureInitialized();
    await reconcileManagedDatabaseRelayPolicy(this.db);
    await this.syncSnapshot().catch((error) => {
      logger.warn('Initial relay policy sync deferred until relay is reachable', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async syncSnapshot(): Promise<number> {
    const snapshot = await this.buildSnapshot();
    const response = await this.relay.applySnapshot(snapshot);
    const applied = Number(response.appliedRevision);
    if (!Number.isSafeInteger(applied) || applied !== Number(snapshot.revision)) {
      throw new Error(`Relay acknowledged revision ${response.appliedRevision}, expected ${snapshot.revision}`);
    }
    this.grantIssuer.acknowledgeRevision(applied);
    return applied;
  }

  async reconcileAndSync(): Promise<number> {
    await backfillRelayNodeFingerprints(this.db);
    await reconcileManagedDatabaseRelayPolicy(this.db);
    const revision = await this.syncSnapshot();
    await this.refreshAllNodeGrantsIfDue().catch((error) => {
      logger.warn('Relay policy reconciled but some daemon grant bundles remain pending', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return revision;
  }

  async rotateIfDue(now = new Date()): Promise<boolean> {
    return this.grantKeys.rotateIfDue(
      now,
      () => this.syncSnapshot(),
      () => this.refreshAllNodeGrantsIfDue(true)
    );
  }

  async ensureManagedDatabaseEndpoint(managedDatabaseId: string, nodeId: string): Promise<string> {
    const [database] = await this.db
      .select({ nodeId: managedDatabaseInstances.nodeId, status: managedDatabaseInstances.status })
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.id, managedDatabaseId))
      .limit(1);
    if (!database || database.nodeId !== nodeId || (database.status !== 'ready' && database.status !== 'updating')) {
      throw new Error('Managed database relay endpoint is unavailable');
    }
    const node = await this.grantIssuer.requireNodeIdentity(nodeId);
    const endpoint = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(relayEndpoints)
        .where(and(eq(relayEndpoints.ownerKind, 'managed_database'), eq(relayEndpoints.ownerId, managedDatabaseId)))
        .limit(1);
      if (!current) {
        const [created] = await tx
          .insert(relayEndpoints)
          .values({
            ownerKind: 'managed_database',
            ownerId: managedDatabaseId,
            subjectKind: 'daemon',
            subjectId: nodeId,
            certificateSha256: node.certificateFingerprint,
          })
          .returning({ id: relayEndpoints.id });
        await bumpRelayPolicyRevision(tx);
        return { id: created.id, active: true };
      }
      if (current.subjectId !== nodeId || current.certificateSha256 !== node.certificateFingerprint) {
        await tx
          .update(relayEndpoints)
          .set({
            subjectId: nodeId,
            certificateSha256: node.certificateFingerprint,
            generation: current.generation + 1,
            updatedAt: new Date(),
          })
          .where(eq(relayEndpoints.id, current.id));
        await bumpRelayPolicyRevision(tx);
      }
      return { id: current.id, active: current.status === 'active' };
    });
    if (!endpoint.active) throw new Error('Managed database relay endpoint is awaiting lifecycle reconciliation');
    await this.syncSnapshot();
    return endpoint.id;
  }

  async ensureBindingRoute(
    bindingId: string,
    managedDatabaseId: string,
    sourceNodeId: string,
    targetNodeId: string
  ): Promise<string> {
    const endpointId = await this.ensureManagedDatabaseEndpoint(managedDatabaseId, targetNodeId);
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
    const routeId = await this.ensureRoute(
      'managed_database_binding',
      bindingId,
      'daemon',
      sourceNodeId,
      source.certificateFingerprint,
      endpointId
    );
    await this.syncSnapshot();
    await Promise.all([this.syncNodeGrants(sourceNodeId), this.syncNodeGrants(targetNodeId)]);
    return routeId;
  }

  async ensureProxySecureLink(linkId: string, sourceNodeId: string, targetNodeId: string): Promise<string> {
    const target = await this.grantIssuer.requireNodeIdentity(targetNodeId);
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
    const endpointId = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(relayEndpoints)
        .where(and(eq(relayEndpoints.ownerKind, 'proxy_host_secure_link'), eq(relayEndpoints.ownerId, linkId)))
        .limit(1);
      if (!current) {
        const [created] = await tx
          .insert(relayEndpoints)
          .values({
            ownerKind: 'proxy_host_secure_link',
            ownerId: linkId,
            subjectKind: 'daemon',
            subjectId: targetNodeId,
            certificateSha256: target.certificateFingerprint,
          })
          .returning({ id: relayEndpoints.id });
        await bumpRelayPolicyRevision(tx);
        return created.id;
      }
      if (current.subjectId !== targetNodeId || current.certificateSha256 !== target.certificateFingerprint) {
        await tx
          .update(relayEndpoints)
          .set({
            subjectId: targetNodeId,
            certificateSha256: target.certificateFingerprint,
            generation: current.generation + 1,
            status: 'active',
            updatedAt: new Date(),
          })
          .where(eq(relayEndpoints.id, current.id));
        await bumpRelayPolicyRevision(tx);
      }
      return current.id;
    });
    const routeId = await this.ensureRoute(
      'proxy_host_secure_link',
      linkId,
      'daemon',
      sourceNodeId,
      source.certificateFingerprint,
      endpointId
    );
    await this.syncSnapshot();
    await Promise.all([this.syncNodeGrants(sourceNodeId), this.syncNodeGrants(targetNodeId)]);
    return routeId;
  }

  async getProxyRouteRuntime(linkId: string): Promise<ProxyRouteRuntime | null> {
    const [route] = await this.db
      .select({ id: relayRoutes.id })
      .from(relayRoutes)
      .where(and(eq(relayRoutes.ownerKind, 'proxy_host_secure_link'), eq(relayRoutes.ownerId, linkId)))
      .limit(1);
    if (!route) return null;

    const runtime = await this.relay.getRouteRuntime(route.id);
    const lastActivityMillis = Number(runtime.lastActivityUnixMilliseconds || 0);
    const metricsSinceMillis = Number(runtime.metricsSinceUnixMilliseconds || 0);
    return {
      routeId: runtime.routeId,
      activeStreams: Number(runtime.activeTunnels || 0),
      openedTotal: runtime.openedTotal,
      completedTotal: runtime.completedTotal,
      failedTotal: runtime.failedTotal,
      throttledTotal: runtime.throttledTotal,
      sourceToTargetBytes: runtime.sourceToTargetBytes,
      targetToSourceBytes: runtime.targetToSourceBytes,
      setupLatencyP95Ms: Number(runtime.setupLatencyP95Microseconds || 0) / 1000,
      averageDurationMs: Number(runtime.averageDurationMilliseconds || 0),
      lastActivityAt: lastActivityMillis > 0 ? new Date(lastActivityMillis).toISOString() : null,
      metricsSince: new Date(metricsSinceMillis > 0 ? metricsSinceMillis : Date.now()).toISOString(),
    };
  }

  async ensureGatewayRoute(
    managedDatabaseId: string,
    targetNodeId: string,
    appCertificateFingerprint: string
  ): Promise<string> {
    const endpointId = await this.ensureManagedDatabaseEndpoint(managedDatabaseId, targetNodeId);
    const state = await this.grantIssuer.requireState();
    const routeId = await this.ensureRoute(
      'managed_database_gateway',
      managedDatabaseId,
      'gateway',
      state.gatewayInstanceId,
      appCertificateFingerprint,
      endpointId
    );
    await this.syncSnapshot();
    await this.syncNodeGrants(targetNodeId);
    return routeId;
  }

  async openGatewayTunnel(managedDatabaseId: string, appCertificateFingerprint: string) {
    const [database] = await this.db
      .select({ nodeId: managedDatabaseInstances.nodeId, status: managedDatabaseInstances.status })
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.id, managedDatabaseId))
      .limit(1);
    if (!database || (database.status !== 'ready' && database.status !== 'updating')) {
      throw new Error('Managed database is unavailable');
    }
    const routeId = await this.ensureGatewayRoute(managedDatabaseId, database.nodeId, appCertificateFingerprint);
    return this.relay.openTunnel(await this.grantIssuer.issueGatewayConnectGrant(routeId, appCertificateFingerprint));
  }

  async revokeOwner(
    ownerKind: 'managed_database_binding' | 'managed_database_gateway' | 'managed_database' | 'proxy_host_secure_link',
    ownerId: string
  ): Promise<void> {
    const [ownedRoutes, ownedEndpoints] = await Promise.all([
      this.db
        .select({ nodeId: relayRoutes.sourceId, sourceKind: relayRoutes.sourceKind })
        .from(relayRoutes)
        .where(and(eq(relayRoutes.ownerKind, ownerKind), eq(relayRoutes.ownerId, ownerId))),
      ownerKind === 'managed_database' || ownerKind === 'proxy_host_secure_link'
        ? this.db
            .select({ nodeId: relayEndpoints.subjectId })
            .from(relayEndpoints)
            .where(and(eq(relayEndpoints.ownerKind, ownerKind), eq(relayEndpoints.ownerId, ownerId)))
        : Promise.resolve([]),
    ]);
    await this.db.transaction(async (tx) => {
      const routes = await tx
        .delete(relayRoutes)
        .where(and(eq(relayRoutes.ownerKind, ownerKind), eq(relayRoutes.ownerId, ownerId)))
        .returning({ id: relayRoutes.id });
      const endpoints =
        ownerKind === 'managed_database' || ownerKind === 'proxy_host_secure_link'
          ? await tx
              .delete(relayEndpoints)
              .where(and(eq(relayEndpoints.ownerKind, ownerKind), eq(relayEndpoints.ownerId, ownerId)))
              .returning({ id: relayEndpoints.id })
          : [];
      if (routes.length || endpoints.length) await bumpRelayPolicyRevision(tx);
    });
    await this.syncSnapshot();
    const affectedNodes = [
      ...new Set([
        ...(await this.grantIssuer.policyNodeIds()),
        ...ownedEndpoints.map(({ nodeId }) => nodeId),
        ...ownedRoutes.filter(({ sourceKind }) => sourceKind === 'daemon').map(({ nodeId }) => nodeId),
      ]),
    ];
    await Promise.allSettled(affectedNodes.map((nodeId) => this.syncNodeGrants(nodeId)));
  }

  async refreshNodeIdentity(nodeId: string, certificateSha256: string): Promise<void> {
    const changed = await this.db.transaction(async (tx) => {
      const endpoints = await tx.select().from(relayEndpoints).where(eq(relayEndpoints.subjectId, nodeId));
      const routes = await tx.select().from(relayRoutes).where(eq(relayRoutes.sourceId, nodeId));
      for (const endpoint of endpoints)
        await tx
          .update(relayEndpoints)
          .set({ certificateSha256, generation: endpoint.generation + 1, updatedAt: new Date() })
          .where(eq(relayEndpoints.id, endpoint.id));
      for (const route of routes)
        await tx
          .update(relayRoutes)
          .set({ sourceCertificateSha256: certificateSha256, generation: route.generation + 1, updatedAt: new Date() })
          .where(eq(relayRoutes.id, route.id));
      if (endpoints.length || routes.length) await bumpRelayPolicyRevision(tx);
      return endpoints.length > 0 || routes.length > 0;
    });
    if (!changed) return;
    await this.syncSnapshot();
    await this.syncNodeGrants(nodeId);
  }

  async revokeNode(nodeId: string): Promise<void> {
    const endpointRows = await this.db
      .select({ id: relayEndpoints.id })
      .from(relayEndpoints)
      .where(eq(relayEndpoints.subjectId, nodeId));
    const endpointIds = endpointRows.map(({ id }) => id);
    const affectedRoutes = endpointIds.length
      ? await this.db
          .select({ nodeId: relayRoutes.sourceId, sourceKind: relayRoutes.sourceKind })
          .from(relayRoutes)
          .where(inArray(relayRoutes.targetEndpointId, endpointIds))
      : [];
    await this.db.transaction(async (tx) => {
      const routes = await tx
        .delete(relayRoutes)
        .where(eq(relayRoutes.sourceId, nodeId))
        .returning({ id: relayRoutes.id });
      const endpoints = await tx
        .delete(relayEndpoints)
        .where(eq(relayEndpoints.subjectId, nodeId))
        .returning({ id: relayEndpoints.id });
      if (routes.length || endpoints.length) await bumpRelayPolicyRevision(tx);
    });
    await this.syncSnapshot();
    await Promise.allSettled(
      affectedRoutes
        .filter(({ sourceKind }) => sourceKind === 'daemon')
        .map(({ nodeId: affectedNodeId }) => this.syncNodeGrants(affectedNodeId))
    );
  }

  async syncNodeGrants(nodeId: string): Promise<void> {
    if (!this.dispatch) return;
    const result = await this.dispatch.sendRelayGrantBundle(nodeId, await this.getNodeGrantBundle(nodeId));
    if (!result.success) throw new Error(result.error || `Daemon ${nodeId} rejected relay grants`);
  }

  async refreshAllNodeGrantsIfDue(force = false): Promise<void> {
    const revision = Number((await this.grantIssuer.requireState()).revision);
    const ttlHours = (await this.settings.getConfig()).relayGrantTtlHours;
    const intervalMs = (ttlHours * 60 * 60 * 1000) / 4;
    if (!force && revision === this.lastGrantRefreshRevision && Date.now() - this.lastGrantRefreshAt < intervalMs)
      return;
    const nodeIds = await this.grantIssuer.policyNodeIds();
    const results = await Promise.allSettled(nodeIds.map((nodeId) => this.syncNodeGrants(nodeId)));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new Error(`Failed to refresh relay grants for ${failures.length} daemon(s)`);
    this.lastGrantRefreshAt = Date.now();
    this.lastGrantRefreshRevision = revision;
  }

  async getNodeGrantBundle(nodeId: string): Promise<RelayGrantBundle> {
    const [bundle, config] = await Promise.all([
      this.grantIssuer.getNodeGrantBundle(nodeId),
      this.settings.getConfig(),
    ]);
    return { ...bundle, dataLanes: config.relay.dataLanes, readChunkBytes: config.relay.readChunkBytes };
  }

  async issueGatewayConnectGrant(routeId: string, appCertificateFingerprint: string) {
    return this.grantIssuer.issueGatewayConnectGrant(routeId, appCertificateFingerprint);
  }

  private async ensureRoute(
    ownerKind: string,
    ownerId: string,
    sourceKind: string,
    sourceId: string,
    sourceCertificateSha256: string,
    targetEndpointId: string
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(relayRoutes)
        .where(and(eq(relayRoutes.ownerKind, ownerKind), eq(relayRoutes.ownerId, ownerId)))
        .limit(1);
      if (!current) {
        const [created] = await tx
          .insert(relayRoutes)
          .values({
            ownerKind,
            ownerId,
            sourceKind,
            sourceId,
            sourceCertificateSha256,
            targetEndpointId,
            maxFrameBytes: RELAY_MAX_FRAME_BYTES,
          })
          .returning({ id: relayRoutes.id });
        await bumpRelayPolicyRevision(tx);
        return created.id;
      }
      if (
        current.sourceId !== sourceId ||
        current.sourceCertificateSha256 !== sourceCertificateSha256 ||
        current.targetEndpointId !== targetEndpointId
      ) {
        await tx
          .update(relayRoutes)
          .set({
            sourceKind,
            sourceId,
            sourceCertificateSha256,
            targetEndpointId,
            generation: current.generation + 1,
            updatedAt: new Date(),
          })
          .where(eq(relayRoutes.id, current.id));
        await bumpRelayPolicyRevision(tx);
      }
      return current.id;
    });
  }

  private async buildSnapshot(): Promise<RelayPolicySnapshot> {
    const relaySettings = (await this.settings.getConfig()).relay;
    return this.db.transaction(
      async (tx) => {
        const [[state], keys, endpoints, routes] = await Promise.all([
          tx.select().from(relayPolicyState).where(eq(relayPolicyState.id, 'current')).limit(1),
          tx
            .select()
            .from(relayGrantSigningKeys)
            .where(inArray(relayGrantSigningKeys.status, ['pending', 'active', 'verification_only'])),
          tx.select().from(relayEndpoints),
          tx.select().from(relayRoutes),
        ]);
        if (!state) throw new Error('Relay policy state is not initialized');
        keys.sort((left, right) => left.keyId.localeCompare(right.keyId));
        endpoints.sort((left, right) => left.id.localeCompare(right.id));
        routes.sort((left, right) => left.id.localeCompare(right.id));
        const activeEndpoints = endpoints.filter(({ status }) => status === 'active');
        const activeEndpointIds = new Set(activeEndpoints.map(({ id }) => id));
        return {
          revision: String(state.revision),
          gatewayInstanceId: state.gatewayInstanceId,
          admissionPolicy: {
            enabled: relaySettings.adaptiveAdmissionEnabled,
            proxyTargetPressurePercent: relaySettings.proxyTargetPressurePercent,
            databaseReservePercent: relaySettings.databaseReservePercent,
            hardPressurePercent: relaySettings.hardPressurePercent,
          },
          publicKeys: keys.map((key) => ({ keyId: key.keyId, publicKey: Buffer.from(key.publicKey, 'base64') })),
          endpoints: activeEndpoints.map((endpoint) => ({
            endpointId: endpoint.id,
            generation: String(endpoint.generation),
            subjectKind: endpoint.subjectKind,
            subjectId: endpoint.subjectId,
            certificateSha256: endpoint.certificateSha256,
            maxConcurrentSessions: endpoint.maxConcurrentSessions,
          })),
          routes: routes
            .filter(({ targetEndpointId }) => activeEndpointIds.has(targetEndpointId))
            .map((route) => ({
              routeId: route.id,
              generation: String(route.generation),
              sourceKind: route.sourceKind,
              sourceId: route.sourceId,
              sourceCertificateSha256: route.sourceCertificateSha256,
              targetEndpointId: route.targetEndpointId,
              maxConcurrentSessions: route.maxConcurrentSessions,
              maxFrameBytes: route.maxFrameBytes,
              disableIdleTimeout: route.ownerKind === 'proxy_host_secure_link',
              trafficClass: route.ownerKind === 'proxy_host_secure_link' ? ('proxy' as const) : ('database' as const),
            })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' }
    );
  }

  private async updateManagedDatabaseStatus(managedDatabaseId: string, databaseStatus: string): Promise<void> {
    const changed = await updateManagedDatabaseRelayStatus(this.db, managedDatabaseId, databaseStatus);
    if (!changed) return;
    await this.syncSnapshot();
    await this.refreshAllNodeGrantsIfDue(true).catch(() => undefined);
  }
}
