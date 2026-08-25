import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  managedDatabaseInstances,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayEndpoints,
  relayGrantSigningKeys,
  relayInstances,
  relayPolicyState,
  relayPools,
  relayRoutes,
} from '@/db/schema/index.js';
import {
  RELAY_MAX_FRAME_BYTES,
  type RelayControlClient,
  type RelayPolicySnapshot,
} from '@/grpc/relay-control.client.js';
import { encodeRelayV1Message } from '@/grpc/relay-proto.js';
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
import { RelayPolicySigningKeyService } from './relay-policy-signing-key.service.js';
import { effectiveRelayMaxConcurrentSessions } from './relay-session-limits.js';

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
const INTERNAL_REGISTRY_ID = 'gateway-internal-registry';
const INTERNAL_REGISTRY_CERTIFICATE_ID = 'local:gateway-internal-registry';
const REGISTRY_ROUTE_OWNER_KINDS = ['registry_secure_link', 'registry_ingress'] as const;
type RegistryRouteOwnerKind = (typeof REGISTRY_ROUTE_OWNER_KINDS)[number];

function relayRoutePolicy(ownerKind: string): {
  disableIdleTimeout: boolean;
  trafficClass: 'proxy' | 'database' | 'registry';
} {
  if ((REGISTRY_ROUTE_OWNER_KINDS as readonly string[]).includes(ownerKind)) {
    return { disableIdleTimeout: true, trafficClass: 'registry' };
  }
  if (ownerKind === 'proxy_host_secure_link') {
    return { disableIdleTimeout: true, trafficClass: 'proxy' };
  }
  return { disableIdleTimeout: false, trafficClass: 'database' };
}

export class RelayPolicyService {
  private dispatch?: Pick<
    NodeDispatchService,
    'sendRelayGrantBundle' | 'sendRelayPolicy' | 'setRelayDrain' | 'probeRelayCandidate'
  >;
  private lastGrantRefreshAt = 0;
  private lastGrantRefreshRevision = 0;
  private readonly grantIssuer: RelayGrantIssuerService;
  private readonly grantKeys: RelayGrantKeyService;
  private readonly policyKeys: RelayPolicySigningKeyService;
  private relaySettingsSync: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: DrizzleClient,
    cryptoService: CryptoService,
    private readonly settings: GeneralSettingsService,
    private readonly relay: RelayControlClient
  ) {
    this.grantIssuer = new RelayGrantIssuerService(db, cryptoService, settings);
    this.grantKeys = new RelayGrantKeyService(db, cryptoService);
    this.policyKeys = new RelayPolicySigningKeyService(db, cryptoService);
  }

  setNodeDispatch(
    dispatch: Pick<
      NodeDispatchService,
      'sendRelayGrantBundle' | 'sendRelayPolicy' | 'setRelayDrain' | 'probeRelayCandidate'
    >
  ): void {
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
    await this.policyKeys.ensureInitialized();
    await this.reconcileInternalRegistryEndpoint();
    await reconcileManagedDatabaseRelayPolicy(this.db);
    await this.syncSnapshot().catch((error) => {
      logger.warn('Initial relay policy sync deferred until relay is reachable', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async getPolicyEnrollmentTrust() {
    return this.policyKeys.getEnrollmentTrust();
  }

  async syncRemoteInstancePolicy(nodeId: string): Promise<number> {
    if (!this.dispatch) throw new Error('Relay node dispatch is not configured');
    const [instance] = await this.db
      .select({ id: relayInstances.id })
      .from(relayInstances)
      .where(and(eq(relayInstances.nodeId, nodeId), eq(relayInstances.kind, 'remote')))
      .limit(1);
    if (!instance) throw new Error('Remote relay instance is unavailable');
    const snapshot = await this.buildInstanceSnapshot(instance.id);
    const result = await this.dispatch.sendRelayPolicy(
      nodeId,
      snapshot.encodedRequest,
      String(snapshot.revision),
      String(snapshot.expiresAtUnix)
    );
    if (!result.success) throw new Error(result.error || 'Remote relay rejected policy snapshot');
    return snapshot.revision;
  }

  async setRemoteInstanceDrain(nodeId: string, enabled: boolean, forceDisconnect = false): Promise<void> {
    if (!this.dispatch) throw new Error('Relay node dispatch is not configured');
    const result = await this.dispatch.setRelayDrain(nodeId, enabled, forceDisconnect);
    if (!result.success) throw new Error(result.error || 'Remote relay drain command failed');
  }

  async probeRelayCandidate(
    nodeId: string,
    input: Parameters<NodeDispatchService['probeRelayCandidate']>[1]
  ): Promise<void> {
    if (!this.dispatch) throw new Error('Relay node dispatch is not configured');
    const result = await this.dispatch.probeRelayCandidate(nodeId, input);
    if (!result.success) throw new Error(result.error || 'Relay candidate probe failed');
  }

  async syncSnapshot(): Promise<number> {
    const health = await this.relay.getHealth?.().catch(() => null);
    if (health?.poolId === 'system' && health.capabilities?.includes('relay_pool_v1')) {
      const [local] = await this.db
        .select({ id: relayInstances.id })
        .from(relayInstances)
        .where(and(eq(relayInstances.poolId, 'system'), eq(relayInstances.kind, 'local')))
        .limit(1);
      if (!local || health.relayInstanceId !== local.id) {
        throw new Error('Local Relay Pool identity does not match persisted instance identity');
      }
      const trust = await this.policyKeys.getEnrollmentTrust();
      await this.relay.bootstrapPolicyTrust(trust.keyId, trust.publicKey, trust.fingerprint);
      const signed = await this.buildInstanceSnapshot(local.id);
      const response = await this.relay.applyEncodedSnapshot(signed.encodedRequest);
      const applied = Number(response.appliedRevision);
      if (!Number.isSafeInteger(applied) || applied !== signed.revision) {
        throw new Error(`Relay acknowledged revision ${response.appliedRevision}, expected ${signed.revision}`);
      }
      this.grantIssuer.acknowledgeRevision(applied);
      return applied;
    }
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
    const grantRotated = await this.grantKeys.rotateIfDue(
      now,
      () => this.syncSnapshot(),
      () => this.refreshAllNodeGrantsIfDue(true)
    );
    const pendingPolicyKey = await this.policyKeys.beginRotationIfDue(now);
    if (pendingPolicyKey) await this.syncAllRemoteInstancePolicies();
    const policyChanged = await this.finalizePolicySigningKeyRotation(now);
    return grantRotated || Boolean(pendingPolicyKey) || policyChanged;
  }

  async finalizePolicySigningKeyRotation(now = new Date()): Promise<boolean> {
    const promoted = await this.policyKeys.promoteAcknowledgedPending(now);
    const retired = await this.policyKeys.retireExpiredVerificationKeys(now);
    if (promoted || retired) await this.syncAllRemoteInstancePolicies();
    return promoted || retired;
  }

  private async syncAllRemoteInstancePolicies(): Promise<void> {
    const instances = await this.db
      .select({ nodeId: relayInstances.nodeId })
      .from(relayInstances)
      .where(
        and(
          eq(relayInstances.poolId, 'system'),
          eq(relayInstances.kind, 'remote'),
          inArray(relayInstances.state, ['synchronizing', 'ready', 'draining'])
        )
      );
    const results = await Promise.allSettled(
      instances.flatMap(({ nodeId }) => (nodeId ? [this.syncRemoteInstancePolicy(nodeId)] : []))
    );
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
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
    await this.ensureLegacyCompatibleAssignment(endpoint.id);
    await this.syncSnapshot();
    return endpoint.id;
  }

  async ensureInternalRegistryEndpoint(): Promise<string> {
    const endpointId = await this.reconcileInternalRegistryEndpoint();
    await this.syncSnapshot();
    return endpointId;
  }

  async ensureInternalRegistryRoute(
    bindingId: string,
    sourceNodeId: string,
    ownerKind: RegistryRouteOwnerKind = 'registry_secure_link'
  ): Promise<string> {
    if (!(REGISTRY_ROUTE_OWNER_KINDS as readonly string[]).includes(ownerKind)) {
      throw new Error('Unsupported registry relay route owner kind');
    }
    const endpointId = await this.reconcileInternalRegistryEndpoint();
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
    const routeId = await this.ensureRoute(
      ownerKind,
      bindingId,
      'daemon',
      sourceNodeId,
      source.certificateFingerprint,
      endpointId
    );
    await this.syncSnapshot();
    await this.syncNodeGrants(sourceNodeId);
    return routeId;
  }

  async getInternalRegistryRouteRuntime(bindingId: string, ownerKind: RegistryRouteOwnerKind = 'registry_secure_link') {
    const [route] = await this.db
      .select({ id: relayRoutes.id })
      .from(relayRoutes)
      .where(and(eq(relayRoutes.ownerKind, ownerKind), eq(relayRoutes.ownerId, bindingId)))
      .limit(1);
    if (!route) return null;
    return this.relay.getRouteRuntime(route.id);
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
    await this.ensureLegacyCompatibleAssignment(endpointId);
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
    const assignment = await this.grantIssuer.issueGatewayConnectAssignment(routeId, appCertificateFingerprint);
    const activeCandidates = assignment.candidates.filter(({ assignmentState }) => assignmentState === 'active');
    let lastError: unknown;
    for (const candidate of activeCandidates) {
      try {
        return candidate.local
          ? await this.relay.openTunnel(candidate.grant)
          : await this.relay.openCandidateTunnel(candidate);
      } catch (error) {
        lastError = error;
      }
    }
    if (!activeCandidates.length) return this.relay.openTunnel(assignment.grant);
    throw lastError instanceof Error ? lastError : new Error('Relay pool is unavailable');
  }

  async probeGatewayRelayCandidate(
    routeId: string,
    appCertificateFingerprint: string,
    relayInstanceId: string,
    assignmentGeneration: string
  ): Promise<void> {
    const assignment = await this.grantIssuer.issueGatewayConnectAssignment(routeId, appCertificateFingerprint);
    const candidate = assignment.candidates.find(
      (item) => item.relayInstanceId === relayInstanceId && item.assignmentGeneration === assignmentGeneration
    );
    if (!candidate) throw new Error('Gateway relay candidate grant is unavailable');
    if (candidate.local) {
      const tunnel = await this.relay.openTunnel(candidate.grant);
      tunnel.destroy();
      return;
    }
    await this.relay.probeCandidate(candidate);
  }

  async revokeOwner(
    ownerKind:
      | 'managed_database_binding'
      | 'managed_database_gateway'
      | 'managed_database'
      | 'proxy_host_secure_link'
      | RegistryRouteOwnerKind
      | 'internal_registry',
    ownerId: string,
    options: { allowDeferredSnapshot?: boolean } = {}
  ): Promise<void> {
    const [ownedRoutes, ownedEndpoints] = await Promise.all([
      this.db
        .select({ nodeId: relayRoutes.sourceId, sourceKind: relayRoutes.sourceKind })
        .from(relayRoutes)
        .where(and(eq(relayRoutes.ownerKind, ownerKind), eq(relayRoutes.ownerId, ownerId))),
      ownerKind === 'managed_database' || ownerKind === 'proxy_host_secure_link' || ownerKind === 'internal_registry'
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
        ownerKind === 'managed_database' || ownerKind === 'proxy_host_secure_link' || ownerKind === 'internal_registry'
          ? await tx
              .delete(relayEndpoints)
              .where(and(eq(relayEndpoints.ownerKind, ownerKind), eq(relayEndpoints.ownerId, ownerId)))
              .returning({ id: relayEndpoints.id })
          : [];
      if (routes.length || endpoints.length) await bumpRelayPolicyRevision(tx);
    });
    try {
      await this.syncSnapshot();
    } catch (error) {
      if (!options.allowDeferredSnapshot) throw error;
      logger.warn('Relay owner revocation persisted; runtime snapshot update deferred', {
        ownerKind,
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

  private async reconcileInternalRegistryEndpoint(): Promise<string> {
    const endpoint = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-internal-registry-relay-endpoint'))`);
      const [current] = await tx
        .select()
        .from(relayEndpoints)
        .where(and(eq(relayEndpoints.ownerKind, 'internal_registry'), eq(relayEndpoints.ownerId, INTERNAL_REGISTRY_ID)))
        .limit(1);
      if (!current) {
        const [created] = await tx
          .insert(relayEndpoints)
          .values({
            ownerKind: 'internal_registry',
            ownerId: INTERNAL_REGISTRY_ID,
            subjectKind: 'local_service',
            subjectId: INTERNAL_REGISTRY_ID,
            certificateSha256: INTERNAL_REGISTRY_CERTIFICATE_ID,
            maxConcurrentSessions: 128,
          })
          .returning({ id: relayEndpoints.id });
        await bumpRelayPolicyRevision(tx);
        return created.id;
      }
      if (
        current.subjectKind !== 'local_service' ||
        current.subjectId !== INTERNAL_REGISTRY_ID ||
        current.certificateSha256 !== INTERNAL_REGISTRY_CERTIFICATE_ID
      ) {
        throw new Error('Internal registry Relay endpoint ownership or target identity was modified');
      }
      if (current.status !== 'active') {
        await tx
          .update(relayEndpoints)
          .set({ status: 'active', generation: current.generation + 1, updatedAt: new Date() })
          .where(eq(relayEndpoints.id, current.id));
        await bumpRelayPolicyRevision(tx);
      }
      return current.id;
    });
    await this.ensureLegacyCompatibleAssignment(endpoint);
    return endpoint;
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
            maxConcurrentSessions: effectiveRelayMaxConcurrentSessions(endpoint),
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
              maxConcurrentSessions: effectiveRelayMaxConcurrentSessions(route),
              maxFrameBytes: route.maxFrameBytes,
              ...relayRoutePolicy(route.ownerKind),
            })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' }
    );
  }

  private async ensureLegacyCompatibleAssignment(endpointId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`relay-endpoint-assignment:${endpointId}`}))`);
      const [existing] = await tx
        .select({ id: relayEndpointAssignmentGenerations.id })
        .from(relayEndpointAssignmentGenerations)
        .where(
          and(
            eq(relayEndpointAssignmentGenerations.endpointId, endpointId),
            eq(relayEndpointAssignmentGenerations.state, 'active')
          )
        )
        .limit(1);
      if (existing) return;
      const [local] = await tx
        .select({ id: relayInstances.id })
        .from(relayInstances)
        .where(and(eq(relayInstances.poolId, 'system'), eq(relayInstances.kind, 'local')))
        .limit(1);
      if (!local) throw new Error('Local relay instance is unavailable');
      const [generation] = await tx
        .insert(relayEndpointAssignmentGenerations)
        .values({ endpointId, generation: 1, state: 'active', desiredRedundancy: 1, activatedAt: new Date() })
        .returning({ id: relayEndpointAssignmentGenerations.id });
      await tx.insert(relayEndpointAssignments).values({
        assignmentGenerationId: generation.id,
        relayInstanceId: local.id,
        role: 'active',
        targetRegistrationState: 'ready',
        targetRegisteredAt: new Date(),
      });
    });
  }

  private async buildInstanceSnapshot(instanceId: string): Promise<{
    encodedRequest: Buffer;
    revision: number;
    expiresAtUnix: number;
  }> {
    const relaySettings = (await this.settings.getConfig()).relay;
    const publishedPolicyKeys = await this.policyKeys.listPublishedKeys();
    const issuedAt = new Date();
    const expiresAtUnix = Math.floor((issuedAt.getTime() + 15 * 60 * 1000) / 1000);
    const projection = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-remote-policy-revision'))`);
      const [[instance], [state], grantKeys] = await Promise.all([
        tx.select().from(relayInstances).where(eq(relayInstances.id, instanceId)).limit(1),
        tx.select().from(relayPolicyState).where(eq(relayPolicyState.id, 'current')).limit(1),
        tx
          .select()
          .from(relayGrantSigningKeys)
          .where(inArray(relayGrantSigningKeys.status, ['pending', 'active', 'verification_only'])),
      ]);
      if (!instance || !state) throw new Error('Relay instance or policy state is unavailable');

      // The assignment query above cannot reference the separately selected
      // instance alias portably across Drizzle drivers, so constrain it here
      // through an explicit second query with the concrete instance id.
      const selectedAssignments = await tx
        .select({
          endpointId: relayEndpointAssignmentGenerations.endpointId,
          assignmentGeneration: relayEndpointAssignmentGenerations.generation,
          generationState: relayEndpointAssignmentGenerations.state,
        })
        .from(relayEndpointAssignments)
        .innerJoin(
          relayEndpointAssignmentGenerations,
          eq(relayEndpointAssignments.assignmentGenerationId, relayEndpointAssignmentGenerations.id)
        )
        .where(
          and(
            eq(relayEndpointAssignments.relayInstanceId, instance.id),
            inArray(relayEndpointAssignmentGenerations.state, ['active', 'staging', 'draining'])
          )
        );
      const endpointIds = [...new Set(selectedAssignments.map(({ endpointId }) => endpointId))];
      const endpoints = endpointIds.length
        ? await tx.select().from(relayEndpoints).where(inArray(relayEndpoints.id, endpointIds))
        : [];
      const routes = endpointIds.length
        ? await tx.select().from(relayRoutes).where(inArray(relayRoutes.targetEndpointId, endpointIds))
        : [];
      const [poolRevision] = await tx
        .update(relayPools)
        .set({ desiredPolicyRevision: sql`${relayPools.desiredPolicyRevision} + 1`, updatedAt: issuedAt })
        .where(eq(relayPools.id, instance.poolId))
        .returning({ revision: relayPools.desiredPolicyRevision });
      if (!poolRevision) throw new Error('Relay pool is unavailable');
      return { instance, state, grantKeys, selectedAssignments, endpoints, routes, revision: poolRevision.revision };
    });

    const endpointById = new Map(projection.endpoints.map((endpoint) => [endpoint.id, endpoint]));
    const payload = encodeRelayV1Message('PolicyEnvelopePayload', {
      schemaVersion: 2,
      gatewayInstanceId: projection.state.gatewayInstanceId,
      poolId: projection.instance.poolId,
      relayInstanceId: projection.instance.id,
      revision: String(projection.revision),
      issuedAtUnix: String(Math.floor(issuedAt.getTime() / 1000)),
      expiresAtUnix: String(expiresAtUnix),
      grantPublicKeys: projection.grantKeys.map((key) => ({
        keyId: key.keyId,
        publicKey: Buffer.from(key.publicKey, 'base64'),
      })),
      endpoints: projection.selectedAssignments.flatMap((assignment) => {
        const endpoint = endpointById.get(assignment.endpointId);
        if (!endpoint) return [];
        return [
          {
            endpointId: endpoint.id,
            generation: String(endpoint.generation),
            subjectKind: endpoint.subjectKind,
            subjectId: endpoint.subjectId,
            certificateSha256: endpoint.certificateSha256,
            maxConcurrentSessions: effectiveRelayMaxConcurrentSessions(endpoint),
            poolId: projection.instance.poolId,
            relayInstanceId: projection.instance.id,
            assignmentGeneration: String(assignment.assignmentGeneration),
          },
        ];
      }),
      routes: projection.selectedAssignments.flatMap((assignment) =>
        projection.routes
          .filter(({ targetEndpointId }) => targetEndpointId === assignment.endpointId)
          .map((route) => ({
            routeId: route.id,
            generation: String(route.generation),
            sourceKind: route.sourceKind,
            sourceId: route.sourceId,
            sourceCertificateSha256: route.sourceCertificateSha256,
            targetEndpointId: route.targetEndpointId,
            maxConcurrentSessions: effectiveRelayMaxConcurrentSessions(route),
            maxFrameBytes: route.maxFrameBytes,
            ...relayRoutePolicy(route.ownerKind),
            assignmentGeneration: String(assignment.assignmentGeneration),
          }))
      ),
      admissionPolicy: {
        enabled: relaySettings.adaptiveAdmissionEnabled,
        proxyTargetPressurePercent: relaySettings.proxyTargetPressurePercent,
        databaseReservePercent: relaySettings.databaseReservePercent,
        hardPressurePercent: relaySettings.hardPressurePercent,
      },
      capabilities: ['relay_pool_v1'],
      policySigningKeys: publishedPolicyKeys.map((key) => ({
        keyId: key.keyId,
        publicKey: key.publicKey,
        publicKeyFingerprint: key.fingerprint,
        status: key.status === 'pending' ? 'active' : key.status,
        validFromUnix: String(key.activatedAt ? Math.floor(key.activatedAt.getTime() / 1000) : 0),
        verifyUntilUnix: String(key.verifyUntil ? Math.floor(key.verifyUntil.getTime() / 1000) : 0),
      })),
    });
    const signed = await this.policyKeys.signPayload(payload);
    return {
      encodedRequest: encodeRelayV1Message('ApplySnapshotRequest', {
        signedEnvelope: { signingKeyId: signed.signingKeyId, payload, signature: signed.signature },
      }),
      revision: projection.revision,
      expiresAtUnix,
    };
  }

  private async updateManagedDatabaseStatus(managedDatabaseId: string, databaseStatus: string): Promise<void> {
    const changed = await updateManagedDatabaseRelayStatus(this.db, managedDatabaseId, databaseStatus);
    if (!changed) return;
    await this.syncSnapshot();
    await this.refreshAllNodeGrantsIfDue(true).catch(() => undefined);
  }
}
