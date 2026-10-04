import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  managedDatabaseInstances,
  nodes,
  proxyAdditionalSecureLinks,
  proxyHosts,
  relayAssignmentSourceProbes,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayEndpoints,
  relayInstances,
  relayPoolUpdateRuns,
  relayPoolUpdateSteps,
  relayRoutes,
} from '@/db/schema/index.js';
import { sameTimestamp } from '@/db/timestamp-equality.js';
import { logger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { AVAILABILITY_LEASE_CAPABILITY } from '@/modules/docker/availability/lease/lease-constants.js';
import { createNodeEnrollmentToken, nodeEnrollmentTokenExpiresAt } from '@/modules/nodes/node-enrollment-token.js';
import type { GeneralSettingsService, RelayAssignmentSpread } from '@/modules/settings/general-settings.service.js';
import type { EventBusService } from './event-bus.service.js';
import type { RelayCertificateRenewalService, RelayCertificateStatus } from './relay-certificate-renewal.service.js';
import type { RelayPolicyService, RelayPolicyTrustStatus } from './relay-policy.service.js';
import { bumpRelayPolicyRevision } from './relay-policy-reconciler.js';
import {
  isGatedProbeRefusal,
  isRetryableDispatchError,
  isTransientRelayPoolError,
  relayPoolErrorMessage,
} from './relay-pool-errors.js';
import { describeRelayRevocation } from './relay-revocation-fence.js';
import { loadRelayRouteHistories, RelayRevocationFenceService } from './relay-revocation-fence.service.js';
import {
  chooseByRendezvous,
  chooseRelayAssignments,
  type EndpointLatencyPath,
  includeRemoteRelay,
  type PlannedRelayAssignment,
  type RelayAssignmentRole,
  samePlannedAssignments,
} from './relay-topology.js';
import type { RelayTopologyService } from './relay-topology.service.js';

type RelayInstanceRow = typeof relayInstances.$inferSelect;

/** A pool condition that leaves the pool healthy but needs an operator's attention. */
export interface RelayPoolWarning {
  code: 'gateway_host_only';
  endpointId: string;
  ownerKind: string;
  ownerId: string;
  nodeId: string | null;
  message: string;
}
const AUTO_REBALANCE_SETTLE_MS = 30_000;
const AUTO_REBALANCE_RETRY_MS = 5 * 60_000;
/**
 * A workload a transient condition deferred is retried after this long, doubling while the condition lasts, up to
 * the failure cooldown. A deferral is not a failure: see relay-pool-errors.
 */
const TRANSIENT_RETRY_MS = 30_000;
const STAGING_RECOVERY_MS = 2 * 60_000;
/**
 * Candidate probes in flight per daemon. A daemon runs four asynchronous commands at a time and refuses every
 * further one as busy; a batch that probed dozens of workloads at once took all of them (rc.20 B-17), failing its
 * own probes and every other command sent to that daemon meanwhile.
 */
const PROBES_PER_NODE = 2;
/** Pauses before probing again when the daemon did not run the probe (busy, or not connected). */
const PROBE_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000];
const DEFERRED_NOTE = 'Deferred by a transient condition and retried automatically';
/** The outcome of one candidate probe; see RelayPoolService.runProbe. */
type ProbeResult = { ready: true } | { ready: false; error: string; transient: boolean };
/**
 * A generation rolled back before it was ever active (see deferStaging). Every generation that was active has an
 * activation time, and only a drained active generation retires otherwise.
 */
const deferredGeneration = sql`(${relayEndpointAssignmentGenerations.state} = 'retired' and ${relayEndpointAssignmentGenerations.activatedAt} is null)`;
const MANUAL_DRAIN_TIMEOUT_MS = 10 * 60_000;
/** Supervisors report every 5 s; a remote relay silent this long is offline. */
const REMOTE_HEARTBEAT_TIMEOUT_MS = 90_000;
const UPDATE_DRAIN_RELEASE_INTERVAL_MS = 30_000;
const EVACUATION_RETRY_MS = 30_000;
/** Update runs that may still hold a relay drained, and the step states in which they do. */
const UNFINISHED_UPDATE_RUN_STATES = [
  'preflight',
  'draining',
  'updating',
  'verifying',
  'paused',
  'rolling_back',
] as const;
const IN_FLIGHT_UPDATE_STEP_STATES = ['draining', 'updating', 'verifying', 'rolling_back'] as const;
/**
 * Update run states that leave automatic placement running. A paused run waits for an operator
 * for as long as it takes; freezing placement for the whole pool meanwhile would leave workloads
 * on a relay that fails in the meantime.
 */
const PLACEMENT_RUNS_DURING_RUN_STATES: readonly string[] = ['complete', 'failed', 'paused'];

function poolBlockers(instances: RelayInstanceRow[]): string[] {
  return instances.flatMap((instance) =>
    instance.capabilities?.features?.includes('relay_pool_v1')
      ? []
      : [`${instance.displayName}: Relay Pool capability is unavailable; update or repair this relay`]
  );
}

function isEnrolledRelayInstance(instance: RelayInstanceRow): boolean {
  return instance.kind === 'local' || Boolean(instance.certificateIdentity && instance.certificateFingerprint);
}

function effectiveCount(spread: RelayAssignmentSpread, readyCount: number): number {
  return Math.min(readyCount, spread.mode === 'all' ? readyCount : spread.count);
}

/**
 * The sources a staged generation probes: one per (source kind, source id), however many routes that source has to
 * the endpoint. A daemon reaches one endpoint through several routes (two bindings of the same managed database, a
 * Secure Link and a binding); probing it once per relay is what the unique key of the probe table allows (M-3).
 */
export function sourcesToProbe<T extends { sourceKind: string; sourceId: string }>(routes: T[]): T[] {
  const sources = new Map<string, T>();
  for (const route of routes) {
    const key = `${route.sourceKind}\u0000${route.sourceId}`;
    if (!sources.has(key)) sources.set(key, route);
  }
  return [...sources.values()];
}

/**
 * Places one endpoint. A path with a daemon that lacks Relay Pool support runs on legacy grants,
 * which only the local relay serves: such workloads stay there until every participant is updated.
 *
 * An Availability member (serving or dormant standby) goes on every ready relay that runs the lease
 * protocol (D7): at a takeover the successor is then already registered wherever traffic may arrive,
 * and a single surviving relay carries it (stand run c). Every other endpoint keeps its configured
 * redundancy but includes a relay that is not co-located with Gateway whenever one is ready, so the
 * data plane survives the loss of the Gateway host.
 */
export function planRelays(
  endpointId: string,
  instances: RelayInstanceRow[],
  desiredCount: number,
  localOnly: boolean,
  path: EndpointLatencyPath | undefined,
  reference: ReadonlyArray<{ relayInstanceId: string; role: string }>,
  availabilityMember = false,
  /** Set when the endpoint's node reaches no relay off the Gateway host (see includeRemoteRelay). */
  notes?: { gatewayHostOnly?: boolean }
): PlannedRelayAssignment[] {
  if (localOnly) {
    return instances
      .filter(({ kind, state }) => kind === 'local' && state === 'ready')
      .map((instance) => ({ instance, role: 'active' }));
  }
  if (availabilityMember) {
    const leaseRelays = instances.filter(
      (instance) =>
        instance.state === 'ready' && instance.capabilities?.features?.includes(AVAILABILITY_LEASE_CAPABILITY)
    );
    if (leaseRelays.length) {
      return chooseRelayAssignments(endpointId, leaseRelays, leaseRelays.length, path, reference);
    }
  }
  const placed = includeRemoteRelay(
    endpointId,
    chooseRelayAssignments(endpointId, instances, desiredCount, path, reference),
    instances,
    path,
    reference
  );
  if (notes) notes.gatewayHostOnly = placed.gatewayHostOnly;
  return placed.planned;
}

export class RelayPoolService {
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private reconciliationFlight: Promise<void> | null = null;
  private rebalanceFlight = false;
  private readonly preparingGenerations = new Set<string>();
  /** The drain action running per relay instance; see withDrainAction. */
  private readonly drainActions = new Map<string, Promise<unknown>>();
  private readonly nextEvacuationAt = new Map<string, number>();
  private stablePlan: { key: string; since: number } | null = null;
  private retryAfter = 0;
  private readonly startedAt = Date.now();
  /** Workloads a transient condition deferred, and when to try them again; see deferStaging. */
  private readonly deferrals = new Map<string, { count: number; retryAt: number }>();
  /** Probe commands in flight per daemon, and the probes waiting for a slot; see withProbeSlot. */
  private readonly probeSlots = new Map<string, { active: number; waiting: Array<() => void> }>();
  private probeRetryDelaysMs = PROBE_RETRY_DELAYS_MS;
  private readonly revocations: Pick<RelayRevocationFenceService, 'evaluate'>;
  private nextUpdateDrainReleaseAt = 0;
  private certificateRenewal?: Pick<
    RelayCertificateRenewalService,
    'renewDueIfScheduled' | 'describeCertificates' | 'renewInstanceCertificate'
  >;
  private topology?: Pick<RelayTopologyService, 'endpointPaths'>;
  /** The roles last planned per endpoint; see planEndpoint. */
  private readonly plannedRoles = new Map<string, Array<{ relayInstanceId: string; role: string }>>();
  constructor(
    private readonly db: DrizzleClient,
    private readonly policy: RelayPolicyService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly settings: GeneralSettingsService
  ) {
    this.revocations = new RelayRevocationFenceService(db);
  }

  startReconciliation(): void {
    if (this.reconciliationTimer) return;
    this.reconciliationTimer = setInterval(() => {
      // A pass still running reports its own outcome. Joining it would log one failure once per tick
      // it outlasted: a two-minute rebalance repeated the same warning 22 times (rc.20 B-17).
      if (this.reconciliationFlight) return;
      void this.reconcile().catch((error) => {
        const message = relayPoolErrorMessage(error);
        // The next pass retries it; the condition itself (a restarting relay, an unreachable node) is reported
        // where it lives.
        if (isTransientRelayPoolError(error)) logger.debug('Relay pool reconciliation deferred', { error: message });
        else logger.warn('Relay pool reconciliation failed', { error: message });
      });
    }, 5_000);
    this.reconciliationTimer.unref();
  }

  stopReconciliation(): void {
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    this.reconciliationTimer = null;
  }

  reconcile(): Promise<void> {
    if (this.reconciliationFlight) return this.reconciliationFlight;
    const flight = this.reconcileOnce().finally(() => {
      if (this.reconciliationFlight === flight) this.reconciliationFlight = null;
    });
    this.reconciliationFlight = flight;
    return flight;
  }

  setCertificateRenewal(
    renewal: Pick<
      RelayCertificateRenewalService,
      'renewDueIfScheduled' | 'describeCertificates' | 'renewInstanceCertificate'
    >
  ): void {
    this.certificateRenewal = renewal;
  }

  /** Enables placement by measured network distance; without it relays are placed by hash. */
  setTopology(topology: Pick<RelayTopologyService, 'endpointPaths'>): void {
    this.topology = topology;
  }

  /**
   * Plans one endpoint against the roles last planned for it, falling back to its active roles,
   * and remembers the result. Relays inside the primary hysteresis band then keep the planned role
   * from one reconciliation to the next, so jittery round trips never change the plan key and an
   * endpoint's first latency placement settles like any other.
   */
  private planEndpoint(
    endpointId: string,
    instances: RelayInstanceRow[],
    desiredCount: number,
    localOnly: boolean,
    path: EndpointLatencyPath | undefined,
    active: Array<{ relayInstanceId: string; role: string }>,
    availabilityMember = false,
    notes?: { gatewayHostOnly?: boolean }
  ): PlannedRelayAssignment[] {
    const reference = this.plannedRoles.get(endpointId) ?? active;
    const planned = planRelays(
      endpointId,
      instances,
      desiredCount,
      localOnly,
      path,
      reference,
      availabilityMember,
      notes
    );
    this.plannedRoles.set(
      endpointId,
      planned.map(({ instance, role }) => ({ relayInstanceId: instance.id, role }))
    );
    return planned;
  }

  /**
   * The first assignment of a new endpoint when it need not start in the legacy shape (the local relay alone): an
   * Availability member whose path runs Relay Pool daemons goes on every ready lease relay right away, exactly as the
   * rebalance plan places it, so no staged move follows and no takeover in its first minute finds it on the local
   * relay only (D7). Null keeps the legacy first assignment: other endpoints, paths with a daemon that lacks Relay
   * Pool support (legacy grants only the local relay serves), and pools without a ready lease relay.
   */
  async planInitialAssignment(
    endpointId: string
  ): Promise<Array<{ relayInstanceId: string; role: RelayAssignmentRole }> | null> {
    const [endpoint] = await this.db.select().from(relayEndpoints).where(eq(relayEndpoints.id, endpointId)).limit(1);
    if (!endpoint || endpoint.ownerKind !== 'proxy_host_secure_link') return null;
    if (!(await this.availabilityMemberEndpointIds([endpoint])).has(endpoint.id)) return null;
    if ((await this.poolIncapableEndpoints([endpoint.id])).has(endpoint.id)) return null;
    const instances = (await this.db.select().from(relayInstances).where(eq(relayInstances.poolId, 'system'))).filter(
      isEnrolledRelayInstance
    );
    const leaseRelays = instances.filter(
      (instance) =>
        instance.state === 'ready' && instance.capabilities?.features?.includes(AVAILABILITY_LEASE_CAPABILITY)
    );
    if (!leaseRelays.length) return null;
    const path = (await this.latencyPaths([endpoint])).get(endpoint.id);
    const planned = this.planEndpoint(endpoint.id, instances, leaseRelays.length, false, path, [], true);
    if (!planned.length) return null;
    return planned.map(({ instance, role }) => ({ relayInstanceId: instance.id, role }));
  }

  /** The endpoints of Availability member Secure Links (serving and dormant alike), placed on every lease relay. */
  private async availabilityMemberEndpointIds(
    endpoints: Array<Pick<typeof relayEndpoints.$inferSelect, 'id' | 'ownerKind' | 'ownerId'>>
  ): Promise<Set<string>> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const byLink = new Map(
      endpoints
        .filter(({ ownerKind, ownerId }) => ownerKind === 'proxy_host_secure_link' && uuid.test(ownerId))
        .map(({ id, ownerId }) => [ownerId, id])
    );
    if (!byLink.size) return new Set();
    const members = await this.db
      .select({ id: proxyAdditionalSecureLinks.id })
      .from(proxyAdditionalSecureLinks)
      .where(
        and(
          eq(proxyAdditionalSecureLinks.purpose, 'availability_member'),
          inArray(proxyAdditionalSecureLinks.id, [...byLink.keys()])
        )
      );
    return new Set(members.flatMap(({ id }) => (byLink.has(id) ? [byLink.get(id)!] : [])));
  }

  /**
   * Links that stay on the Gateway host's relay because their node reaches no relay off it (includeRemoteRelay).
   * Moving them would only fail the move's probes and keep the pool degraded; they keep working through the local
   * relay, and the pool status names them so an operator can open the network path.
   */
  private async gatewayHostOnlyWarnings(
    endpoints: Array<
      Pick<typeof relayEndpoints.$inferSelect, 'id' | 'ownerKind' | 'ownerId' | 'subjectKind' | 'subjectId'>
    >,
    instances: RelayInstanceRow[],
    paths: Map<string, EndpointLatencyPath>
  ): Promise<RelayPoolWarning[]> {
    if (!endpoints.length) return [];
    const nodeIds = [
      ...new Set(endpoints.filter(({ subjectKind }) => subjectKind === 'daemon').map((e) => e.subjectId)),
    ];
    const names = new Map(
      nodeIds.length
        ? (
            await this.db
              .select({ id: nodes.id, name: nodes.displayName, hostname: nodes.hostname })
              .from(nodes)
              .where(inArray(nodes.id, nodeIds))
          ).map(({ id, name, hostname }) => [id, name || hostname || id])
        : []
    );
    const remoteIds = instances.filter(({ kind, state }) => kind !== 'local' && state === 'ready').map(({ id }) => id);
    return endpoints.map((endpoint) => {
      const node = names.get(endpoint.subjectId) ?? endpoint.subjectId;
      const targetReaches = remoteIds.some((id) => paths.get(endpoint.id)?.endpoint?.has(id));
      const where = targetReaches ? `an ingress node of this link (target node ${node})` : node;
      return {
        code: 'gateway_host_only' as const,
        endpointId: endpoint.id,
        ownerKind: endpoint.ownerKind,
        ownerId: endpoint.ownerId,
        nodeId: endpoint.subjectKind === 'daemon' ? endpoint.subjectId : null,
        message: `No relay off the Gateway host is reachable from ${where}: traffic of this link depends on the Gateway host.`,
      };
    });
  }

  /** Latency is advisory: a failure to read it places endpoints as if nothing was measured. */
  private async latencyPaths(
    endpoints: Array<Pick<typeof relayEndpoints.$inferSelect, 'id' | 'subjectKind' | 'subjectId'>>
  ): Promise<Map<string, EndpointLatencyPath>> {
    if (!this.topology) return new Map();
    try {
      return await this.topology.endpointPaths(endpoints);
    } catch (error) {
      logger.warn('Relay latency data is unavailable; placing relays without it', { error: String(error) });
      return new Map();
    }
  }

  /** Renews one remote relay's certificate now. */
  async renewInstanceCertificate(instanceId: string, userId: string) {
    if (!this.certificateRenewal)
      throw new AppError(409, 'RELAY_CERTIFICATE_RENEWAL_UNAVAILABLE', 'Relay certificate renewal is not configured');
    return this.certificateRenewal.renewInstanceCertificate(instanceId, userId);
  }

  private async reconcileOnce(): Promise<void> {
    // Renewals wait on relay supervisors; they run beside the reconciler, never inside it.
    void this.certificateRenewal
      ?.renewDueIfScheduled()
      .catch((error) => logger.warn('Relay certificate renewal check failed', { error: String(error) }));
    await this.fenceSilentRemoteInstances();
    await this.enforceRevocationDeadlines().catch((error) =>
      logger.warn('Relay revocation deadline check failed', { error: String(error) })
    );
    await this.reconcileManualDrains();
    await this.releaseOrphanedUpdateDrains().catch((error) =>
      logger.warn('Relay update drain release deferred', { error: String(error) })
    );
    await this.retireDrainedGenerations();
    if (this.rebalanceFlight) return;
    const snapshot = await this.getSnapshot();
    const now = Date.now();
    if (snapshot.automaticRebalancePaused || snapshot.blockers.length) {
      this.stablePlan = null;
      if (snapshot.automaticRebalancePaused) await this.evacuateDrainingInstances(snapshot.instances);
      return;
    }
    if (snapshot.staging.length) {
      const abandoned = snapshot.staging.filter(
        (generation) => now - generation.updatedAt.getTime() >= STAGING_RECOVERY_MS
      );
      if (abandoned.length) {
        // Do not replay a partially acknowledged generation: stale acknowledgements
        // must never activate it ahead of the next full set of probes. An interrupted
        // preparation (a Gateway restart) proved nothing about the placement either, so
        // it is rolled back as not attempted rather than failed.
        await this.deferStaging(
          abandoned.map(({ id }) => id),
          new Error('Rebalance preparation was interrupted; a fresh verified attempt is required')
        );
      }
      return;
    }
    if (!snapshot.rebalanceAvailable) {
      this.stablePlan = null;
      return;
    }
    if (this.stablePlan?.key !== snapshot.rebalancePlanKey) {
      this.stablePlan = { key: snapshot.rebalancePlanKey, since: now };
      return;
    }
    const failedAt = new Map(snapshot.failures.map((failure) => [failure.endpointId, failure.updatedAt.getTime()]));
    const endpointIds = snapshot.rebalanceEndpointIds.filter(
      (id) => now >= (failedAt.get(id) ?? 0) + AUTO_REBALANCE_RETRY_MS && now >= (this.deferrals.get(id)?.retryAt ?? 0)
    );
    if (now - this.stablePlan.since < AUTO_REBALANCE_SETTLE_MS || now < this.retryAfter || !endpointIds.length) return;
    // Set the guard before any await, including failures before a generation can
    // be persisted. A broken dependency must not produce a five-second storm.
    this.retryAfter = now + AUTO_REBALANCE_RETRY_MS;
    try {
      await this.stageRebalance(undefined, { allowNoop: true, automatic: true, endpointIds });
    } catch (error) {
      // The local relay restarting, say: try again soon rather than after the failure cooldown.
      if (isTransientRelayPoolError(error)) this.retryAfter = Date.now() + TRANSIENT_RETRY_MS;
      throw error;
    }
    // Persisted failed generations carry their own cooldown. Successful/no-op
    // runs must not delay a subsequent independent topology change for minutes.
    this.retryAfter = 0;
    this.stablePlan = null;
  }

  async reconcileManualDrains(): Promise<void> {
    const instances = await this.db
      .select()
      .from(relayInstances)
      .where(and(eq(relayInstances.poolId, 'system'), isNotNull(relayInstances.manualDrainStartedAt)));
    for (const candidate of instances) {
      if (this.drainActions.has(candidate.id)) continue;
      await this.withDrainAction(candidate.id, async () => {
        // A resume may have completed while another member was being processed.
        const [instance] = await this.db
          .select()
          .from(relayInstances)
          .where(eq(relayInstances.id, candidate.id))
          .limit(1);
        if (!instance) return;
        if (!instance.nodeId || instance.kind !== 'remote' || !instance.manualDrainStartedAt) return;
        // A relay that is not connected gets the drain once it reconnects and reports admitting again.
        if (!this.policy.isRemoteInstanceConnected(instance.nodeId)) return;
        const expired = Date.now() - instance.manualDrainStartedAt.getTime() >= MANUAL_DRAIN_TIMEOUT_MS;
        // Reassert admission after a worker restart; an acknowledged forced drain
        // need not repeat unless the worker resumed admission or reports live streams.
        const resumed = instance.health?.admissionState !== 'draining';
        const force = expired && (!instance.drainForcedAt || (instance.health?.activeTunnels ?? 0) > 0 || resumed);
        if (!force && !resumed) return;
        try {
          await this.policy.setRemoteInstanceDrain(instance.nodeId, true, force);
          if (force)
            await this.db
              .update(relayInstances)
              .set({ drainForcedAt: new Date() })
              .where(
                and(
                  eq(relayInstances.id, instance.id),
                  // Written with now(): microseconds the Date read back does not carry.
                  sameTimestamp(relayInstances.manualDrainStartedAt, instance.manualDrainStartedAt)
                )
              );
        } catch (error) {
          logger.warn('Relay manual drain enforcement deferred', { instanceId: instance.id, error: String(error) });
        }
      });
    }
  }

  /**
   * A remote relay that stopped reporting is offline, whatever its last report said. The control
   * stream's close hook marks it offline only in the process that held the stream, so a relay
   * that died while Gateway restarted would stay ready forever: placement kept choosing it, its
   * drained generations never retired and it could not be removed. Reconnecting relays get the
   * same grace after a Gateway start before they are judged.
   */
  async fenceSilentRemoteInstances(now = new Date()): Promise<number> {
    if (now.getTime() - this.startedAt < REMOTE_HEARTBEAT_TIMEOUT_MS) return 0;
    const cutoff = new Date(now.getTime() - REMOTE_HEARTBEAT_TIMEOUT_MS);
    const fenced = await this.db
      .update(relayInstances)
      .set({ state: 'offline', updatedAt: now })
      .where(
        and(
          eq(relayInstances.poolId, 'system'),
          eq(relayInstances.kind, 'remote'),
          inArray(relayInstances.state, ['synchronizing', 'ready', 'draining']),
          sql`coalesce(${relayInstances.lastSeenAt}, ${relayInstances.updatedAt}) < ${cutoff}`
        )
      )
      .returning({ id: relayInstances.id });
    if (fenced.length) {
      logger.warn('Marked remote relays that stopped reporting offline', { instanceIds: fenced.map(({ id }) => id) });
      this.events.publish('system.relay.health.changed', { poolId: 'system', action: 'instances_offline' });
    }
    return fenced.length;
  }

  /**
   * A relay that has not applied a revoking policy within the deadline may still admit the
   * revoked routes for as long as its policy lease lasts. Daemons then keep sources away from it
   * for those routes and endpoints refuse them through it; its other routes keep working. The
   * state clears when the relay applies the revoking revision.
   */
  async enforceRevocationDeadlines(now = new Date()): Promise<void> {
    const outcome = await this.revocations.evaluate(now, this.startedAt);
    for (const transition of outcome.transitions) {
      if (transition.stale) {
        logger.warn('Relay missed a route revocation; daemons refuse the revoked routes through it', transition);
      } else {
        logger.info('Relay applied the route revocations it had missed', transition);
      }
      this.events.publish('system.relay.health.changed', {
        poolId: transition.poolId,
        instanceId: transition.instanceId,
        instanceName: transition.displayName,
        action: 'revocation_fence',
        revocationStale: transition.stale,
        staleRoutes: transition.staleRoutes,
      });
    }
    if (!outcome.nodeIds.length) return;
    const results = await Promise.allSettled(outcome.nodeIds.map((nodeId) => this.policy.syncNodeGrants(nodeId)));
    results.forEach((result, index) => {
      if (result.status === 'rejected')
        logger.warn('Relay revocation fence delivery deferred to the next grant refresh', {
          nodeId: outcome.nodeIds[index],
          error: String(result.reason),
        });
    });
  }

  /**
   * Resumes remote relays an update run drained and no longer owns. The run's own release is an
   * in-process retry that ends after a while or with the process; a relay left draining by a
   * failed or abandoned run would then stay out of service. Only update runs drain without an
   * operator's drain mark, and a relay held by an unfinished run, paused ones included, stays.
   */
  async releaseOrphanedUpdateDrains(now = Date.now()): Promise<number> {
    if (now < this.nextUpdateDrainReleaseAt) return 0;
    this.nextUpdateDrainReleaseAt = now + UPDATE_DRAIN_RELEASE_INTERVAL_MS;
    const drained = await this.db
      .select({ id: relayInstances.id })
      .from(relayInstances)
      .where(
        and(
          eq(relayInstances.poolId, 'system'),
          eq(relayInstances.kind, 'remote'),
          eq(relayInstances.state, 'draining'),
          isNull(relayInstances.manualDrainStartedAt),
          isNotNull(relayInstances.nodeId)
        )
      );
    let released = 0;
    for (const { id } of drained) {
      if (this.drainActions.has(id)) continue;
      try {
        // Decided under the drain lock: a retried update run may be taking this relay right now.
        const resumed = await this.withDrainAction(id, async () => {
          if (await this.isHeldByUnfinishedUpdate(id)) return false;
          const [instance] = await this.db
            .select({ state: relayInstances.state, manualDrainStartedAt: relayInstances.manualDrainStartedAt })
            .from(relayInstances)
            .where(eq(relayInstances.id, id))
            .limit(1);
          if (instance?.state !== 'draining' || instance.manualDrainStartedAt) return false;
          await this.setInstanceDrain(id, null, false, false);
          return true;
        });
        if (!resumed) continue;
        released += 1;
        logger.info('Resumed a relay left drained by a finished Relay Pool update', { instanceId: id });
      } catch (error) {
        logger.warn('Could not resume a relay left drained by a Relay Pool update yet', {
          instanceId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return released;
  }

  /**
   * While an update pauses automatic placement, keeps moving workloads off drained relays. The
   * evacuation that starts with a drain can find another placement running, or fail for want of
   * capacity; without a retry the drained relay would keep its workloads for the whole update.
   */
  private async evacuateDrainingInstances(
    instances: Array<{ id: string; kind: string; state: string; activeAssignments: number }>
  ): Promise<void> {
    const now = Date.now();
    for (const instance of instances) {
      if (instance.kind !== 'remote' || instance.state !== 'draining' || instance.activeAssignments === 0) continue;
      if (now < (this.nextEvacuationAt.get(instance.id) ?? 0)) continue;
      this.nextEvacuationAt.set(instance.id, now + EVACUATION_RETRY_MS);
      try {
        await this.evacuateInstance(instance.id);
      } catch (error) {
        logger.warn('Moving workloads off a drained relay failed; it is retried', {
          instanceId: instance.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** An update run that has not finished, paused ones included, holds this relay drained. */
  private async isHeldByUnfinishedUpdate(instanceId: string): Promise<boolean> {
    const [held] = await this.db
      .select({ id: relayPoolUpdateSteps.id })
      .from(relayPoolUpdateSteps)
      .innerJoin(relayPoolUpdateRuns, eq(relayPoolUpdateSteps.runId, relayPoolUpdateRuns.id))
      .where(
        and(
          eq(relayPoolUpdateSteps.relayInstanceId, instanceId),
          inArray(relayPoolUpdateSteps.state, [...IN_FLIGHT_UPDATE_STEP_STATES]),
          inArray(relayPoolUpdateRuns.state, [...UNFINISHED_UPDATE_RUN_STATES])
        )
      )
      .limit(1);
    return Boolean(held);
  }

  /**
   * Issues a single-use token that re-enrolls an enrolled remote relay. Running the relay
   * installer with it on the host makes the supervisor enroll again: the relay keeps its instance
   * and assignments, receives new certificates, moves its pinned policy trust aside and pins the
   * active signing key. That is the supported recovery for a relay whose trust holds only keys
   * Gateway no longer has, and for expired relay certificates. Authorization comes from the
   * token, which an administrator hands to the host out of band; the current identity keeps
   * working until the token is used, and an unused token expires.
   */
  async issueRelayReenrollment(instanceId: string, userId: string) {
    const [instance] = await this.db.select().from(relayInstances).where(eq(relayInstances.id, instanceId)).limit(1);
    if (!instance) throw new AppError(404, 'RELAY_INSTANCE_NOT_FOUND', 'Relay instance not found');
    if (instance.kind !== 'remote' || !instance.nodeId) {
      throw new AppError(
        409,
        'RELAY_REENROLLMENT_UNSUPPORTED',
        'Only an enrolled remote relay can be re-enrolled; Gateway recovers the local relay automatically'
      );
    }
    const token = createNodeEnrollmentToken();
    const tokenHash = await bcrypt.hash(token.token, 10);
    const expiresAt = nodeEnrollmentTokenExpiresAt();
    const [node] = await this.db
      .update(nodes)
      .set({
        enrollmentTokenSelector: token.selector,
        enrollmentTokenHash: tokenHash,
        enrollmentTokenExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nodes.id, instance.nodeId),
          eq(nodes.type, 'relay'),
          ne(nodes.status, 'pending'),
          isNotNull(nodes.certificateSerial)
        )
      )
      .returning({ id: nodes.id });
    if (!node) {
      throw new AppError(
        409,
        'RELAY_NOT_ENROLLED',
        'This relay has not completed its first enrollment; use its regular enrollment token'
      );
    }
    await this.audit.log({
      userId,
      action: 'relay.instance.reenrollment_token.issue',
      resourceType: 'relay_instance',
      resourceId: instance.id,
      details: { nodeId: instance.nodeId, expiresAt: expiresAt.toISOString() },
    });
    return {
      instanceId: instance.id,
      nodeId: instance.nodeId,
      displayName: instance.displayName,
      enrollmentToken: token.token,
      enrollmentTokenExpiresAt: expiresAt.toISOString(),
      advertiseAddress: instance.advertisedAddresses[0] ?? null,
      servicePort: instance.servicePort,
      relayVersion: await this.poolRelayVersion(instance.poolId),
    };
  }

  /** The relay release a new relay node installs, so it joins the pool on the release the pool runs. */
  currentRelayVersion(): Promise<string | null> {
    return this.poolRelayVersion('system');
  }

  /**
   * The relay release the pool runs, read from its local relay, which every Relay Pool update
   * moves too. The re-enrollment installer pins it: left to resolve "latest", it may install a
   * release older than the pool (on a prerelease channel) whose supervisor ignores the token.
   */
  private async poolRelayVersion(poolId: string): Promise<string | null> {
    try {
      const [local] = await this.db
        .select({ buildVersion: relayInstances.buildVersion })
        .from(relayInstances)
        .where(and(eq(relayInstances.poolId, poolId), eq(relayInstances.kind, 'local')))
        .limit(1);
      const version = local?.buildVersion ?? '';
      return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version) ? version : null;
    } catch {
      return null;
    }
  }

  /**
   * Runs one drain action per relay at a time. An operator gets a conflict while another action
   * runs; an update run waits its turn instead, so a concurrent cleanup cannot fail its drain.
   */
  private async withDrainAction<T>(
    instanceId: string,
    action: () => Promise<T>,
    options: { wait?: boolean } = {}
  ): Promise<T> {
    for (;;) {
      const running = this.drainActions.get(instanceId);
      if (!running) break;
      if (!options.wait) throw new AppError(409, 'RELAY_DRAIN_IN_PROGRESS', 'A relay drain action is already running');
      await running.catch(() => undefined);
    }
    const current = action();
    this.drainActions.set(instanceId, current);
    try {
      return await current;
    } finally {
      if (this.drainActions.get(instanceId) === current) this.drainActions.delete(instanceId);
    }
  }

  async retireDrainedGenerations(): Promise<number> {
    const generations = await this.db
      .select()
      .from(relayEndpointAssignmentGenerations)
      .where(eq(relayEndpointAssignmentGenerations.state, 'draining'));
    let retired = 0;
    let released = 0;
    for (const generation of generations) {
      const assignments = await this.db
        .select({
          id: relayEndpointAssignments.id,
          state: relayInstances.state,
          lastSeenAt: relayInstances.lastSeenAt,
          policyExpiresAt: relayInstances.policyExpiresAt,
          health: relayInstances.health,
        })
        .from(relayEndpointAssignments)
        .innerJoin(relayInstances, eq(relayEndpointAssignments.relayInstanceId, relayInstances.id))
        .where(eq(relayEndpointAssignments.assignmentGenerationId, generation.id));
      const isIdle = ({ health, lastSeenAt }: (typeof assignments)[number]) => {
        if (!generation.drainStartedAt || !lastSeenAt || lastSeenAt < generation.drainStartedAt) return false;
        if (!Array.isArray(health?.assignmentTunnels)) return false;
        return !health.assignmentTunnels.some(
          (count) =>
            count.endpointId === generation.endpointId &&
            count.assignmentGeneration === generation.generation &&
            count.activeTunnels > 0
        );
      };
      // An offline member with an expired signed policy is fenced even without
      // a final heartbeat. Only old generations with a completed handover qualify.
      const isFencedOffline = (row: (typeof assignments)[number]) =>
        row.state === 'offline' &&
        row.policyExpiresAt &&
        row.policyExpiresAt.getTime() <= Date.now() &&
        (!row.lastSeenAt || row.lastSeenAt.getTime() <= Date.now() - 90_000);
      const fullyObservedAndIdle = assignments.every((row) => isIdle(row) || isFencedOffline(row));
      if (!fullyObservedAndIdle) {
        // A live tunnel on another relay must not pin an idle, drained member.
        // Only touch old generations and require an observation after handover.
        for (const assignment of assignments.filter(
          (row) =>
            row.state === 'draining' &&
            isIdle(row) &&
            row.lastSeenAt &&
            generation.drainStartedAt &&
            row.lastSeenAt >= generation.drainStartedAt
        )) {
          released += await this.db.transaction(async (tx) => {
            const removed = await tx
              .delete(relayEndpointAssignments)
              .where(
                and(
                  eq(relayEndpointAssignments.id, assignment.id),
                  sql`exists (select 1 from ${relayEndpointAssignmentGenerations} where ${relayEndpointAssignmentGenerations.id} = ${generation.id} and ${relayEndpointAssignmentGenerations.state} = 'draining')`,
                  sql`exists (select 1 from ${relayInstances} where ${relayInstances.id} = ${relayEndpointAssignments.relayInstanceId} and ${relayInstances.state} = 'draining' and ${relayInstances.lastSeenAt} = ${assignment.lastSeenAt})`
                )
              )
              .returning({ id: relayEndpointAssignments.id });
            if (removed.length) await bumpRelayPolicyRevision(tx);
            return removed.length;
          });
        }
        continue;
      }
      const result = await this.db.transaction(async (tx) => {
        // Health may have changed after the optimistic read. Re-read under row
        // locks and keep reports/assignment cleanup serialized with retirement.
        const currentAssignments = await tx
          .select({
            id: relayEndpointAssignments.id,
            state: relayInstances.state,
            lastSeenAt: relayInstances.lastSeenAt,
            policyExpiresAt: relayInstances.policyExpiresAt,
            health: relayInstances.health,
          })
          .from(relayEndpointAssignments)
          .innerJoin(relayInstances, eq(relayEndpointAssignments.relayInstanceId, relayInstances.id))
          .where(eq(relayEndpointAssignments.assignmentGenerationId, generation.id))
          .orderBy(relayInstances.id, relayEndpointAssignments.id)
          .for('update');
        if (!currentAssignments.every((row) => isIdle(row) || isFencedOffline(row))) return [];
        const changed = await tx
          .update(relayEndpointAssignmentGenerations)
          .set({ state: 'retired', retiredAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(relayEndpointAssignmentGenerations.id, generation.id),
              eq(relayEndpointAssignmentGenerations.state, 'draining')
            )
          )
          .returning({ id: relayEndpointAssignmentGenerations.id });
        if (changed.length) await bumpRelayPolicyRevision(tx);
        return changed;
      });
      retired += result.length;
    }
    if (retired > 0 || released > 0) {
      await this.policy.reconcileAndSync();
      this.events.publish('system.relay.health.changed', { poolId: 'system', action: 'generations_retired' });
    }
    return retired;
  }

  async getSnapshot() {
    const [persistedInstances, endpoints, generations, assignments, generalSettings, latestGenerations] =
      await Promise.all([
        this.db.select().from(relayInstances).where(eq(relayInstances.poolId, 'system')),
        this.db.select().from(relayEndpoints).where(eq(relayEndpoints.status, 'active')),
        this.db
          .select()
          .from(relayEndpointAssignmentGenerations)
          .where(inArray(relayEndpointAssignmentGenerations.state, ['active', 'staging', 'draining'])),
        this.db.select().from(relayEndpointAssignments),
        this.settings.getConfig(),
        // The latest attempt per endpoint, deferred ones aside: a transient condition proves nothing about the
        // placement, so it neither clears a failure before it nor counts as one (see deferStaging).
        this.db
          .selectDistinctOn([relayEndpointAssignmentGenerations.endpointId])
          .from(relayEndpointAssignmentGenerations)
          .where(sql`not ${deferredGeneration}`)
          .orderBy(relayEndpointAssignmentGenerations.endpointId, desc(relayEndpointAssignmentGenerations.generation)),
      ]);
    const instances = persistedInstances.filter(isEnrolledRelayInstance);
    const effectiveSpreads = await this.resolveEffectiveSpreads(endpoints, generalSettings.relay.assignmentSpread);
    const assignmentsByGeneration = new Map<string, typeof assignments>();
    for (const assignment of assignments) {
      const current = assignmentsByGeneration.get(assignment.assignmentGenerationId) ?? [];
      current.push(assignment);
      assignmentsByGeneration.set(assignment.assignmentGenerationId, current);
    }
    const activeByEndpoint = new Map(
      generations.filter(({ state }) => state === 'active').map((generation) => [generation.endpointId, generation])
    );
    const stagingByEndpoint = new Map(
      generations.filter(({ state }) => state === 'staging').map((generation) => [generation.endpointId, generation])
    );
    const [latestUpdateRun] = await this.db
      .select()
      .from(relayPoolUpdateRuns)
      .where(eq(relayPoolUpdateRuns.poolId, 'system'))
      .orderBy(desc(relayPoolUpdateRuns.startedAt))
      .limit(1);
    const updateRun = latestUpdateRun?.state === 'complete' ? undefined : latestUpdateRun;
    const updateSteps = updateRun
      ? await this.db
          .select()
          .from(relayPoolUpdateSteps)
          .where(eq(relayPoolUpdateSteps.runId, updateRun.id))
          .orderBy(relayPoolUpdateSteps.sequence)
      : [];
    const updateStepByInstance = new Map(updateSteps.map((step) => [step.relayInstanceId, step]));
    const attempts = await this.getRecentAttempts();
    const readyFaultDomains = new Set(
      instances.filter(({ state }) => state === 'ready').map(({ faultDomainId }) => faultDomainId)
    );
    const localOnly = await this.poolIncapableEndpoints(
      endpoints.filter(({ ownerKind }) => ownerKind !== 'internal_registry').map(({ id }) => id)
    );
    const latencyPaths = await this.latencyPaths(endpoints);
    const members = await this.availabilityMemberEndpointIds(endpoints);
    const activeEndpointIds = new Set(endpoints.map(({ id }) => id));
    for (const endpointId of this.plannedRoles.keys()) {
      if (!activeEndpointIds.has(endpointId)) this.plannedRoles.delete(endpointId);
    }
    for (const endpointId of this.deferrals.keys()) {
      if (!activeEndpointIds.has(endpointId)) this.deferrals.delete(endpointId);
    }
    const gatewayHostOnly: Array<(typeof endpoints)[number]> = [];
    const rebalancePlan =
      readyFaultDomains.size === 0
        ? []
        : endpoints.flatMap((endpoint) => {
            if (endpoint.ownerKind === 'internal_registry') return [];
            const spread = effectiveSpreads.get(endpoint.id) ?? generalSettings.relay.assignmentSpread;
            const active = activeByEndpoint.get(endpoint.id);
            const current = active ? (assignmentsByGeneration.get(active.id) ?? []) : [];
            const notes: { gatewayHostOnly?: boolean } = {};
            const planned = this.planEndpoint(
              endpoint.id,
              instances,
              effectiveCount(spread, readyFaultDomains.size),
              localOnly.has(endpoint.id),
              latencyPaths.get(endpoint.id),
              current,
              members.has(endpoint.id),
              notes
            );
            if (notes.gatewayHostOnly) gatewayHostOnly.push(endpoint);
            const selectedIds = planned.map(({ instance }) => instance.id);
            if (!selectedIds.length) return [];
            if (active && samePlannedAssignments(current, planned)) return [];
            const participants = new Set(selectedIds);
            for (const retained of generations.filter(
              (generation) => generation.endpointId === endpoint.id && ['active', 'draining'].includes(generation.state)
            )) {
              for (const assignment of assignmentsByGeneration.get(retained.id) ?? [])
                participants.add(assignment.relayInstanceId);
            }
            return [
              {
                endpointId: endpoint.id,
                instanceIds: selectedIds.sort(),
                primaryIds: planned
                  .filter(({ role }) => role === 'primary')
                  .map(({ instance }) => instance.id)
                  .sort(),
                blockers: poolBlockers(instances.filter(({ id }) => participants.has(id))),
              },
            ];
          });
    const eligiblePlan = rebalancePlan.filter(({ blockers }) => !blockers.length);
    const rebalanceAvailable = eligiblePlan.length > 0;
    // A blocked workload must not disable the action for unrelated eligible ones.
    const blockers =
      readyFaultDomains.size === 0 && endpoints.some(({ ownerKind }) => ownerKind !== 'internal_registry')
        ? ['No ready relay is available to receive assignments; resume or add a relay before evacuation']
        : rebalanceAvailable
          ? []
          : [...new Set(rebalancePlan.flatMap(({ blockers }) => blockers))];
    const rebalancePlanKey = createHash('sha256')
      .update(JSON.stringify(eligiblePlan.sort((a, b) => a.endpointId.localeCompare(b.endpointId))))
      .digest('hex');
    const endpointIds = new Set(endpoints.map(({ id }) => id));
    const failures = latestGenerations.filter(
      (generation) => generation.state === 'failed' && endpointIds.has(generation.endpointId)
    );
    const failuresByEndpoint = new Map(failures.map((failure) => [failure.endpointId, failure]));
    const nextAutomaticRetry = eligiblePlan.length
      ? Math.min(
          ...eligiblePlan.map(({ endpointId }) => {
            const failure = failuresByEndpoint.get(endpointId);
            return failure ? failure.updatedAt.getTime() + AUTO_REBALANCE_RETRY_MS : 0;
          })
        )
      : 0;
    const automaticRebalancePaused = Boolean(updateRun && !PLACEMENT_RUNS_DURING_RUN_STATES.includes(updateRun.state));
    // Trust status is advisory: a failure to assess it must not take the pool status down.
    const policyTrust = await Promise.resolve()
      .then(() => this.policy.describePolicyTrust(instances))
      .catch(() => new Map<string, RelayPolicyTrustStatus>());
    let certificates = new Map<string, RelayCertificateStatus>();
    try {
      certificates = this.certificateRenewal?.describeCertificates(instances) ?? certificates;
    } catch {
      // Advisory, like the trust status.
    }
    const activeTunnels = instances.reduce((sum, instance) => sum + (instance.health?.activeTunnels ?? 0), 0);
    const registeredEndpoints = instances.reduce(
      (sum, instance) => sum + (instance.health?.registeredEndpoints ?? 0),
      0
    );
    const worstPressure = Math.max(0, ...instances.map((instance) => instance.health?.pressurePercent ?? 0));
    const unavailable =
      instances.length === 0 || instances.every(({ state }) => !['ready', 'draining'].includes(state));
    // Advisory, like the trust and certificate status.
    const routeHistories = await loadRelayRouteHistories(this.db).catch(() => new Map());
    const revocations = new Map(instances.map(({ id }) => [id, describeRelayRevocation(routeHistories.get(id))]));
    const degraded =
      !unavailable &&
      (instances.some(({ state }) => ['offline', 'error'].includes(state)) ||
        [...revocations.values()].some((revocation) => revocation?.state === 'stale'));
    const warnings = await this.gatewayHostOnlyWarnings(gatewayHostOnly, instances, latencyPaths).catch(() => []);
    return {
      poolId: 'system',
      state: unavailable
        ? 'unavailable'
        : generations.some(({ state }) => state === 'staging')
          ? 'rebalancing'
          : degraded ||
              failures.some(({ endpointId }) => rebalancePlan.some((entry) => entry.endpointId === endpointId)) ||
              blockers.length > 0
            ? 'degraded'
            : rebalanceAvailable
              ? 'rebalance_available'
              : 'healthy',
      rebalanceAvailable,
      /** Advisory: the pool stays healthy, but these links depend on the Gateway host. */
      warnings,
      rebalanceEndpointIds: eligiblePlan.map(({ endpointId }) => endpointId),
      rebalancePlanKey,
      blockers,
      failures,
      attempts,
      automaticRebalancePaused,
      automaticRebalanceRetryAt: nextAutomaticRetry > Date.now() ? new Date(nextAutomaticRetry) : null,
      activeTunnels,
      registeredEndpoints,
      worstPressurePercent: worstPressure,
      endpointCount: endpoints.length,
      instances: instances.map((instance) => {
        let activeAssignments = 0;
        for (const generation of activeByEndpoint.values()) {
          for (const assignment of assignmentsByGeneration.get(generation.id) ?? []) {
            if (assignment.relayInstanceId !== instance.id) continue;
            activeAssignments += 1;
          }
        }
        return {
          ...instance,
          activeAssignments,
          retainedAssignments: generations.reduce(
            (count, generation) =>
              count +
              (assignmentsByGeneration.get(generation.id) ?? []).filter(
                (assignment) => assignment.relayInstanceId === instance.id
              ).length,
            0
          ),
          updateStep: updateStepByInstance.get(instance.id) ?? null,
          policyTrust: policyTrust.get(instance.id) ?? null,
          certificate: certificates.get(instance.id) ?? null,
          /** Revoked routes this relay has not applied; `stale` once past the deadline. */
          revocation: revocations.get(instance.id) ?? null,
        };
      }),
      staging: [...stagingByEndpoint.values()],
      update: updateRun
        ? { state: updateRun.state, targetVersion: updateRun.targetArtifact.version, error: updateRun.terminalError }
        : null,
    };
  }

  private getRecentAttempts() {
    return this.db
      .select({
        id: relayEndpointAssignmentGenerations.id,
        endpointId: relayEndpointAssignmentGenerations.endpointId,
        generation: relayEndpointAssignmentGenerations.generation,
        state: relayEndpointAssignmentGenerations.state,
        activationError: relayEndpointAssignmentGenerations.activationError,
        createdAt: relayEndpointAssignmentGenerations.createdAt,
        updatedAt: relayEndpointAssignmentGenerations.updatedAt,
        workload: sql<string>`coalesce(${proxyHosts.domainNames}->>0, ${managedDatabaseInstances.name}, ${relayEndpoints.ownerKind} || ' · ' || ${relayEndpoints.ownerId})`,
      })
      .from(relayEndpointAssignmentGenerations)
      .innerJoin(relayEndpoints, eq(relayEndpoints.id, relayEndpointAssignmentGenerations.endpointId))
      .leftJoin(
        proxyAdditionalSecureLinks,
        and(
          eq(relayEndpoints.ownerKind, 'proxy_host_secure_link'),
          sql`${proxyAdditionalSecureLinks.id}::text = ${relayEndpoints.ownerId}`
        )
      )
      .leftJoin(
        proxyHosts,
        and(
          eq(relayEndpoints.ownerKind, 'proxy_host_secure_link'),
          sql`(${proxyHosts.id}::text = ${relayEndpoints.ownerId} or ${proxyHosts.id} = ${proxyAdditionalSecureLinks.proxyHostId})`
        )
      )
      .leftJoin(
        managedDatabaseInstances,
        and(
          eq(relayEndpoints.ownerKind, 'managed_database'),
          sql`${managedDatabaseInstances.id}::text = ${relayEndpoints.ownerId}`
        )
      )
      .orderBy(desc(relayEndpointAssignmentGenerations.createdAt), desc(relayEndpointAssignmentGenerations.id))
      .limit(20);
  }

  private async resolveEffectiveSpreads(
    endpoints: Array<Pick<typeof relayEndpoints.$inferSelect, 'id' | 'ownerKind' | 'ownerId'>>,
    globalSpread: RelayAssignmentSpread
  ): Promise<Map<string, RelayAssignmentSpread>> {
    const result = new Map(endpoints.map(({ id }) => [id, globalSpread]));
    const proxyOwnerIds = endpoints
      .filter(({ ownerKind }) => ownerKind === 'proxy_host_secure_link')
      .map(({ ownerId }) => ownerId);
    if (!proxyOwnerIds.length) return result;

    const [directHosts, additionalLinks] = await Promise.all([
      this.db
        .select({
          ownerId: proxyHosts.id,
          mode: proxyHosts.relaySpreadMode,
          count: proxyHosts.relaySpreadCount,
        })
        .from(proxyHosts)
        .where(inArray(proxyHosts.id, proxyOwnerIds)),
      this.db
        .select({
          ownerId: proxyAdditionalSecureLinks.id,
          mode: proxyHosts.relaySpreadMode,
          count: proxyHosts.relaySpreadCount,
        })
        .from(proxyAdditionalSecureLinks)
        .innerJoin(proxyHosts, eq(proxyAdditionalSecureLinks.proxyHostId, proxyHosts.id))
        .where(inArray(proxyAdditionalSecureLinks.id, proxyOwnerIds)),
    ]);
    const byOwner = new Map([...directHosts, ...additionalLinks].map((row) => [row.ownerId, row]));
    for (const endpoint of endpoints) {
      if (endpoint.ownerKind !== 'proxy_host_secure_link') continue;
      const override = byOwner.get(endpoint.ownerId);
      if (!override || override.mode === 'inherit') continue;
      result.set(
        endpoint.id,
        override.mode === 'all'
          ? { mode: 'all' }
          : {
              mode: 'fixed',
              count: override.count ?? (globalSpread.mode === 'fixed' ? globalSpread.count : 2),
            }
      );
    }
    return result;
  }

  async refreshRemotePolicies(): Promise<void> {
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
    await Promise.allSettled(
      instances.flatMap(({ nodeId }) => (nodeId ? [this.policy.syncRemoteInstancePolicy(nodeId)] : []))
    );
    await this.policy.finalizePolicySigningKeyRotation();
  }

  async ensureLegacyCompatibleAssignment(endpointId: string): Promise<void> {
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
        .select()
        .from(relayInstances)
        .where(and(eq(relayInstances.poolId, 'system'), eq(relayInstances.kind, 'local')))
        .limit(1);
      if (!local) throw new Error('Local relay instance is unavailable');
      const [generation] = await tx
        .insert(relayEndpointAssignmentGenerations)
        .values({ endpointId, generation: 1, state: 'active', desiredRedundancy: 1, activatedAt: new Date() })
        .returning();
      await tx.insert(relayEndpointAssignments).values({
        assignmentGenerationId: generation.id,
        relayInstanceId: local.id,
        role: 'active',
        targetRegistrationState: 'ready',
        targetRegisteredAt: new Date(),
      });
    });
  }

  async stageRebalance(
    userId?: string,
    options: { endpointIds?: string[]; allowNoop?: boolean; automatic?: boolean; evacuation?: boolean } = {}
  ) {
    if (this.rebalanceFlight)
      throw new AppError(409, 'RELAY_REBALANCE_IN_PROGRESS', 'Relay rebalance is already running');
    this.rebalanceFlight = true;
    try {
      return await this.stageRebalanceOnce(userId, options);
    } finally {
      this.rebalanceFlight = false;
    }
  }

  private async stageRebalanceOnce(
    userId: string | undefined,
    options: { endpointIds?: string[]; allowNoop?: boolean; automatic?: boolean; evacuation?: boolean }
  ) {
    // Synchronize local live capabilities before selecting candidates. This also
    // recovers the persisted legacy capability row after a compatible relay upgrade.
    await this.policy.syncSnapshot();
    const endpointFilter = options.endpointIds?.length
      ? inArray(relayEndpoints.id, options.endpointIds)
      : eq(relayEndpoints.status, 'active');
    const endpoints = await this.db
      .select()
      .from(relayEndpoints)
      .where(and(eq(relayEndpoints.status, 'active'), endpointFilter));
    const globalSpread = (await this.settings.getConfig()).relay.assignmentSpread;
    const effectiveSpreads = await this.resolveEffectiveSpreads(endpoints, globalSpread);
    const localOnly = await this.poolIncapableEndpoints(endpoints.map(({ id }) => id));
    const latencyPaths = await this.latencyPaths(endpoints);
    const members = await this.availabilityMemberEndpointIds(endpoints);
    const staged = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-pool-rebalance'))`);
      // An update run pauses automatic placement, but never the evacuation of a relay it drains:
      // otherwise that relay's workloads have no relay accepting new connections for the whole
      // drain, update and verification window.
      if (options.automatic && !options.evacuation) {
        const [update] = await tx
          .select()
          .from(relayPoolUpdateRuns)
          .where(eq(relayPoolUpdateRuns.poolId, 'system'))
          .orderBy(desc(relayPoolUpdateRuns.startedAt))
          .limit(1);
        if (update && !PLACEMENT_RUNS_DURING_RUN_STATES.includes(update.state)) return [];
      }
      const candidates = await tx.select().from(relayInstances).where(eq(relayInstances.poolId, 'system'));
      const readyInstances = candidates.filter(
        (instance) => instance.state === 'ready' && isEnrolledRelayInstance(instance)
      );
      const readyFaultDomains = new Set(readyInstances.map(({ faultDomainId }) => faultDomainId)).size;
      if (readyFaultDomains < 1) {
        throw new AppError(409, 'RELAY_CAPACITY_UNAVAILABLE', 'At least one ready physical relay host is required');
      }
      const created: Array<{
        id: string;
        endpointId: string;
        generation: number;
        instanceIds: string[];
        state: 'staging' | 'failed';
      }> = [];
      let alreadyStaging = false;
      for (const endpoint of endpoints) {
        if (endpoint.ownerKind === 'internal_registry') continue;
        const [staging] = await tx
          .select({ id: relayEndpointAssignmentGenerations.id })
          .from(relayEndpointAssignmentGenerations)
          .where(
            and(
              eq(relayEndpointAssignmentGenerations.endpointId, endpoint.id),
              eq(relayEndpointAssignmentGenerations.state, 'staging')
            )
          )
          .limit(1);
        if (staging) {
          alreadyStaging = true;
          continue;
        }
        const retained = await tx
          .select()
          .from(relayEndpointAssignmentGenerations)
          .where(
            and(
              eq(relayEndpointAssignmentGenerations.endpointId, endpoint.id),
              inArray(relayEndpointAssignmentGenerations.state, ['active', 'draining'])
            )
          );
        const active = retained.find(({ state }) => state === 'active');
        const retainedAssignments = retained.length
          ? await tx
              .select()
              .from(relayEndpointAssignments)
              .where(
                inArray(
                  relayEndpointAssignments.assignmentGenerationId,
                  retained.map(({ id }) => id)
                )
              )
          : [];
        const activeAssignments = retainedAssignments.filter(
          ({ assignmentGenerationId }) => assignmentGenerationId === active?.id
        );
        const spread = effectiveSpreads.get(endpoint.id) ?? globalSpread;
        const planned = this.planEndpoint(
          endpoint.id,
          readyInstances,
          effectiveCount(spread, readyFaultDomains),
          localOnly.has(endpoint.id),
          latencyPaths.get(endpoint.id),
          activeAssignments,
          members.has(endpoint.id)
        );
        const selectedIds = planned.map(({ instance }) => instance.id);
        if (!selectedIds.length || samePlannedAssignments(activeAssignments, planned)) continue;
        const participantIds = new Set([
          ...selectedIds,
          ...retainedAssignments.map(({ relayInstanceId }) => relayInstanceId),
        ]);
        const blockers = poolBlockers(candidates.filter(({ id }) => participantIds.has(id)));
        const [latest] = await tx
          .select({ generation: relayEndpointAssignmentGenerations.generation })
          .from(relayEndpointAssignmentGenerations)
          .where(eq(relayEndpointAssignmentGenerations.endpointId, endpoint.id))
          .orderBy(desc(relayEndpointAssignmentGenerations.generation))
          .limit(1);
        const generationNumber = (latest?.generation ?? 0) + 1;
        const [generation] = await tx
          .insert(relayEndpointAssignmentGenerations)
          .values({
            endpointId: endpoint.id,
            generation: generationNumber,
            state: blockers.length ? 'failed' : 'staging',
            activationError: blockers.length ? blockers.join('; ').slice(0, 1000) : null,
            desiredRedundancy: selectedIds.length,
          })
          .returning();
        created.push({
          id: generation.id,
          endpointId: endpoint.id,
          generation: generationNumber,
          instanceIds: selectedIds,
          state: blockers.length ? 'failed' : 'staging',
        });
        if (blockers.length) continue;
        await tx.insert(relayEndpointAssignments).values(
          planned.map(({ instance, role }) => ({
            assignmentGenerationId: generation.id,
            relayInstanceId: instance.id,
            role,
          }))
        );
        const routes = await tx.select().from(relayRoutes).where(eq(relayRoutes.targetEndpointId, endpoint.id));
        const sources = sourcesToProbe(routes);
        if (sources.length) {
          await tx.insert(relayAssignmentSourceProbes).values(
            sources.flatMap((source) =>
              selectedIds.map((relayInstanceId) => ({
                assignmentGenerationId: generation.id,
                relayInstanceId,
                sourceKind: source.sourceKind,
                sourceId: source.sourceId,
                certificateFingerprint: source.sourceCertificateSha256,
              }))
            )
          );
        }
      }
      if (!created.length && alreadyStaging && !options.allowNoop) {
        throw new AppError(409, 'RELAY_REBALANCE_IN_PROGRESS', 'Relay assignments are still being verified');
      }
      return created;
    });
    if (!staged.length) {
      if (options.allowNoop) return [];
      throw new AppError(409, 'RELAY_REBALANCE_NOT_NEEDED', 'Relay assignments are already balanced');
    }
    // Both local and remote Relays must authorize the staged generation before
    // endpoint/source probes receive grants for it. Remote snapshots are sent
    // below through daemon control; apply the local snapshot explicitly first.
    await this.prepareGenerations(staged.filter(({ state }) => state === 'staging'));
    const outcomes = await this.generationOutcomes(staged.map(({ id }) => id));
    const outcomeById = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
    // Revoking an owner deletes its endpoint and, by cascade, every generation of it: a Secure Link the lifecycle
    // re-provisions after a failover, a deleted host or database. A workload removed while its move was prepared has
    // nothing left to place, so it leaves the batch instead of failing it (rc.20 B-17: one such link failed every
    // other workload's outcome and repeated as a reconciliation failure).
    const withdrawn = staged.filter(({ id }) => !outcomeById.has(id));
    if (withdrawn.length) {
      logger.info('Relay rebalance skipped workloads removed while their move was prepared', {
        endpointIds: withdrawn.map(({ endpointId }) => endpointId),
      });
    }
    await this.audit.log({
      userId: userId ?? null,
      action: 'relay.pool.rebalance.stage',
      resourceType: 'relay_pool',
      resourceId: 'system',
      details: {
        generations: outcomes,
        ...(withdrawn.length ? { withdrawnEndpointIds: withdrawn.map(({ endpointId }) => endpointId) } : {}),
        endpointIds: options.endpointIds ?? null,
        automatic: options.automatic === true,
      },
    });
    this.events.publish('system.relay.health.changed', { poolId: 'system', action: 'rebalance_finished' });
    return staged.flatMap((generation) => {
      const outcome = outcomeById.get(generation.id);
      return outcome ? [{ ...generation, ...outcome }] : [];
    });
  }

  private async generationOutcomes(ids: string[]) {
    return this.db
      .select({
        id: relayEndpointAssignmentGenerations.id,
        state: relayEndpointAssignmentGenerations.state,
        error: relayEndpointAssignmentGenerations.activationError,
      })
      .from(relayEndpointAssignmentGenerations)
      .where(inArray(relayEndpointAssignmentGenerations.id, ids));
  }

  private async prepareGenerations(
    generations: Array<{ id: string; endpointId: string; generation: number }>
  ): Promise<void> {
    if (!generations.length) return;
    try {
      await this.policy.syncSnapshot();
    } catch (error) {
      await this.closeStaging(
        generations.map(({ id }) => id),
        error
      );
      return;
    }
    const nodeSyncs = new Map<string, Promise<number>>();
    for (const generation of generations) this.preparingGenerations.add(generation.id);
    const results = await Promise.allSettled(
      generations.map(async (generation) => {
        const remoteNodes = await this.remoteNodesForGenerations([generation.id]);
        const remoteResults = await Promise.allSettled(
          remoteNodes.map(async ({ nodeId }) => {
            if (!nodeId) throw new Error('Selected remote relay is not enrolled');
            let sync = nodeSyncs.get(nodeId);
            if (!sync) {
              sync = this.policy.syncRemoteInstancePolicy(nodeId);
              nodeSyncs.set(nodeId, sync);
            }
            return sync;
          })
        );
        const remoteFailure = remoteResults.find((result) => result.status === 'rejected');
        if (remoteFailure?.status === 'rejected') throw remoteFailure.reason;
        await this.prepareStagedGeneration(generation);
      })
    );
    // Publishing any outcome advances the signing fence. Finish every sibling's
    // grant issuance and probes before activation OR failure can change policy.
    for (const generation of generations) this.preparingGenerations.delete(generation.id);
    const publicationErrors: unknown[] = [];
    for (const [index, result] of results.entries()) {
      try {
        if (result.status === 'rejected') await this.closeStaging([generations[index].id], result.reason);
        else await this.tryActivate(generations[index].id);
      } catch (error) {
        // An activation commits before it is published. When the local relay is restarting, the policy sync that
        // runs every 30 seconds publishes it; the transition itself stands.
        if (isTransientRelayPoolError(error)) {
          logger.debug('Relay rebalance outcome is published by the next policy sync', {
            generationId: generations[index].id,
            error: relayPoolErrorMessage(error),
          });
          continue;
        }
        publicationErrors.push(error);
      }
    }
    if (publicationErrors.length) throw publicationErrors[0];
  }

  private async remoteNodesForGenerations(ids: string[]) {
    return this.db
      .selectDistinct({ nodeId: relayInstances.nodeId })
      .from(relayEndpointAssignments)
      .innerJoin(relayInstances, eq(relayEndpointAssignments.relayInstanceId, relayInstances.id))
      .where(
        and(
          inArray(relayEndpointAssignments.assignmentGenerationId, ids),
          eq(relayInstances.poolId, 'system'),
          eq(relayInstances.kind, 'remote')
        )
      );
  }

  private async withdrawGenerations(ids: string[]): Promise<void> {
    // Keep the committed outcome and original diagnostic even if a disconnected
    // participant cannot receive revocation yet. Normal policy refresh retries it.
    const pending = (error: unknown) => {
      const message = relayPoolErrorMessage(error);
      // A relay that is restarting or reconnecting gets the policy from the regular sync; nothing to report.
      if (isTransientRelayPoolError(error))
        logger.debug('Relay generation policy cleanup deferred', { error: message });
      else logger.warn('Relay generation policy cleanup remains pending', { error: message });
    };
    try {
      await this.policy.reconcileAndSync();
    } catch (error) {
      pending(error);
    }
    try {
      const remoteNodes = await this.remoteNodesForGenerations(ids);
      const results = await Promise.allSettled(
        remoteNodes.flatMap(({ nodeId }) => (nodeId ? [this.policy.syncRemoteInstancePolicy(nodeId)] : []))
      );
      for (const result of results) {
        if (result.status === 'rejected') pending(result.reason);
      }
    } catch (error) {
      pending(error);
    }
  }

  /** Ends a preparation that did not complete: a transient cause defers it, any other fails it. */
  private closeStaging(ids: string[], error: unknown): Promise<void> {
    return isTransientRelayPoolError(error) ? this.deferStaging(ids, error) : this.failStaging(ids, error);
  }

  private async failStaging(ids: string[], error: unknown): Promise<void> {
    await this.endStaging(ids, 'failed', relayPoolErrorMessage(error));
  }

  /**
   * Rolls staged generations back as not attempted: a transient condition (a busy or disconnected daemon, the local
   * relay restarting, a restart that interrupted the preparation) proves nothing about the placement. The
   * generation retires without ever having been active, which keeps its number and the cause for the attempt
   * history while it neither fails the workload nor degrades the pool; the reconciler tries again shortly.
   */
  private async deferStaging(ids: string[], cause: unknown): Promise<void> {
    const deferred = await this.endStaging(ids, 'retired', `${DEFERRED_NOTE}: ${relayPoolErrorMessage(cause)}`);
    if (!deferred.length) return;
    const now = Date.now();
    for (const { endpointId } of deferred) {
      const count = (this.deferrals.get(endpointId)?.count ?? 0) + 1;
      const delay = Math.min(TRANSIENT_RETRY_MS * 2 ** (count - 1), AUTO_REBALANCE_RETRY_MS);
      this.deferrals.set(endpointId, { count, retryAt: now + delay });
    }
    logger.info('Relay rebalance deferred by a transient condition; it is retried automatically', {
      endpointIds: deferred.map(({ endpointId }) => endpointId),
      cause: relayPoolErrorMessage(cause),
    });
  }

  private async endStaging(
    ids: string[],
    state: 'failed' | 'retired',
    activationError: string
  ): Promise<Array<{ id: string; endpointId: string }>> {
    const ended: Array<{ id: string; endpointId: string }> = [];
    try {
      for (const id of ids) {
        const changed = await this.db.transaction(async (tx) => {
          // Serialize abandonment with activation; a stale read must not activate a
          // generation that another reconciliation has already failed.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`relay-assignment-generation:${id}`}))`);
          const changed = await tx
            .update(relayEndpointAssignmentGenerations)
            .set({
              state,
              activationError: activationError.slice(0, 1000),
              ...(state === 'retired' ? { retiredAt: new Date() } : {}),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(relayEndpointAssignmentGenerations.id, id),
                eq(relayEndpointAssignmentGenerations.state, 'staging')
              )
            )
            .returning({
              id: relayEndpointAssignmentGenerations.id,
              endpointId: relayEndpointAssignmentGenerations.endpointId,
            });
          if (changed.length) await bumpRelayPolicyRevision(tx);
          return changed;
        });
        // Record only committed transitions. Later DB failures must not skip
        // withdrawal of generations already changed by this batch.
        ended.push(...changed);
      }
    } finally {
      if (ended.length) {
        await this.withdrawGenerations(ended.map(({ id }) => id));
        this.events.publish('system.relay.health.changed', {
          poolId: 'system',
          action: state === 'failed' ? 'rebalance_failed' : 'rebalance_deferred',
        });
      }
    }
    return ended;
  }

  async stageProxyWorkloadRebalance(proxyHostId: string, userId: string) {
    const additional = await this.db
      .select({ id: proxyAdditionalSecureLinks.id })
      .from(proxyAdditionalSecureLinks)
      .where(eq(proxyAdditionalSecureLinks.proxyHostId, proxyHostId));
    const ownerIds = [proxyHostId, ...additional.map(({ id }) => id)];
    const endpoints = await this.db
      .select({ id: relayEndpoints.id })
      .from(relayEndpoints)
      .where(
        and(
          eq(relayEndpoints.ownerKind, 'proxy_host_secure_link'),
          inArray(relayEndpoints.ownerId, ownerIds),
          eq(relayEndpoints.status, 'active')
        )
      );
    if (!endpoints.length) return [];
    return this.stageRebalance(userId, {
      endpointIds: endpoints.map(({ id }) => id),
      allowNoop: true,
    });
  }

  async acknowledgeTarget(generationId: string, relayInstanceId: string, ready: boolean, error?: string) {
    await this.db
      .update(relayEndpointAssignments)
      .set({
        targetRegistrationState: ready ? 'ready' : 'failed',
        targetRegisteredAt: ready ? new Date() : null,
        targetRegistrationError: ready ? null : error?.slice(0, 1000) || 'target registration failed',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(relayEndpointAssignments.assignmentGenerationId, generationId),
          eq(relayEndpointAssignments.relayInstanceId, relayInstanceId)
        )
      );
    return this.tryActivate(generationId);
  }

  async acknowledgeProbe(probeId: string, ready: boolean, error?: string) {
    const [probe] = await this.db
      .update(relayAssignmentSourceProbes)
      .set({
        state: ready ? 'ready' : 'failed',
        acknowledgedAt: ready ? new Date() : null,
        error: ready ? null : error?.slice(0, 1000) || 'source probe failed',
        updatedAt: new Date(),
      })
      .where(eq(relayAssignmentSourceProbes.id, probeId))
      .returning({ generationId: relayAssignmentSourceProbes.assignmentGenerationId });
    return probe ? this.tryActivate(probe.generationId) : false;
  }

  async drainInstance(instanceId: string, userId: string | null, enabled = true, options: { manual?: boolean } = {}) {
    return this.withDrainAction(
      instanceId,
      () => this.setInstanceDrain(instanceId, userId, enabled, options.manual !== false),
      { wait: options.manual === false }
    );
  }

  private async setInstanceDrain(instanceId: string, userId: string | null, enabled: boolean, manual: boolean) {
    const [instance] = await this.db.select().from(relayInstances).where(eq(relayInstances.id, instanceId)).limit(1);
    if (!instance) throw new AppError(404, 'RELAY_INSTANCE_NOT_FOUND', 'Relay instance not found');
    if (instance.kind === 'local')
      throw new AppError(409, 'LOCAL_RELAY_DRAIN_UNSUPPORTED', 'Use pool maintenance for local relay');
    if (!instance.nodeId) throw new AppError(409, 'RELAY_INSTANCE_UNENROLLED', 'Relay instance is not enrolled');
    // Completing an update cannot cancel a separate operator-owned drain.
    if (!manual && !enabled && instance.manualDrainStartedAt) enabled = true;
    // An operator resume cannot take a relay away from an update run that drained it: the run
    // would later restart the worker under the tunnels the resume admitted.
    if (manual && !enabled && !instance.manualDrainStartedAt && (await this.isHeldByUnfinishedUpdate(instance.id))) {
      throw new AppError(
        409,
        'RELAY_HELD_BY_UPDATE',
        'A Relay Pool update drained this relay; retry or abandon that update instead of resuming the relay'
      );
    }
    // An operator drain is Gateway state: a relay that is not connected receives it when it reconnects
    // (reconcileManualDrains), and keeps its offline state meanwhile. A resume or an update's drain needs the relay.
    const connected = this.policy.isRemoteInstanceConnected(instance.nodeId);
    if (!connected && !(enabled && manual)) {
      throw new AppError(409, 'RELAY_NOT_CONNECTED', 'The relay is not connected. Try again once it reconnects.');
    }
    // Persist user intent before remote I/O so a crash or failed delivery cannot
    // lose the deadline. Update-owned drains retain their separate rollout policy.
    const persist = () =>
      this.db
        .update(relayInstances)
        .set({
          state: enabled ? (connected ? 'draining' : instance.state) : 'ready',
          manualDrainStartedAt: enabled
            ? manual
              ? sql`coalesce(${relayInstances.manualDrainStartedAt}, now())`
              : instance.manualDrainStartedAt
            : null,
          drainForcedAt: enabled ? instance.drainForcedAt : null,
          updatedAt: new Date(),
        })
        .where(eq(relayInstances.id, instance.id));
    if (enabled && manual) await persist();
    if (connected) await this.policy.setRemoteInstanceDrain(instance.nodeId, enabled);
    // Resume is command-first: failure must not erase the durable drain intent.
    if (!enabled || !manual) await persist();
    await this.policy.reconcileAndSync();
    await this.audit.log({
      userId,
      action: enabled ? 'relay.instance.drain' : 'relay.instance.resume',
      resourceType: 'relay_instance',
      resourceId: instance.id,
      details: {},
    });
    this.events.publish('system.relay.health.changed', { poolId: instance.poolId, instanceId: instance.id });
    if (enabled) {
      try {
        await this.evacuateInstance(instance.id);
      } catch (error) {
        // An update's drain stands on its own; moving workloads is retried by later placement.
        if (manual) throw error;
        logger.warn('Relay drained for an update; moving its workloads failed', {
          instanceId: instance.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Endpoints whose path includes a daemon without Relay Pool support; advisory on failure. */
  private async poolIncapableEndpoints(endpointIds: string[]): Promise<Set<string>> {
    if (!endpointIds.length) return new Set();
    try {
      return await this.policy.poolIncapableEndpointIds(endpointIds);
    } catch {
      return new Set();
    }
  }

  /** `options.update`: a Relay Pool update whose drain grace ended; it waits for an in-flight drain action. */
  async forceDisconnectInstance(instanceId: string, userId: string | null, options: { update?: boolean } = {}) {
    return this.withDrainAction(
      instanceId,
      () => this.forceDisconnectDrainingInstance(instanceId, userId, options.update === true),
      { wait: options.update === true }
    );
  }

  private async forceDisconnectDrainingInstance(instanceId: string, userId: string | null, update: boolean) {
    const [instance] = await this.db.select().from(relayInstances).where(eq(relayInstances.id, instanceId)).limit(1);
    if (!instance) throw new AppError(404, 'RELAY_INSTANCE_NOT_FOUND', 'Relay instance not found');
    if (instance.kind === 'local')
      throw new AppError(409, 'LOCAL_RELAY_DRAIN_UNSUPPORTED', 'Use pool maintenance for local relay');
    if (!instance.nodeId) throw new AppError(409, 'RELAY_INSTANCE_UNENROLLED', 'Relay instance is not enrolled');
    // A relay that is not connected has nothing to disconnect; its operator drain stays recorded while its state stays
    // offline, so "not draining" would be the wrong reason.
    if (!this.policy.isRemoteInstanceConnected(instance.nodeId)) {
      throw new AppError(409, 'RELAY_NOT_CONNECTED', 'The relay is not connected. Try again once it reconnects.');
    }
    if (instance.state !== 'draining') {
      throw new AppError(409, 'RELAY_INSTANCE_NOT_DRAINING', 'Relay instance must be draining first');
    }
    await this.policy.setRemoteInstanceDrain(instance.nodeId, true, true);
    await this.db
      .update(relayInstances)
      .set({ drainForcedAt: new Date() })
      .where(and(eq(relayInstances.id, instance.id), eq(relayInstances.state, 'draining')));
    await this.audit.log({
      userId,
      action: 'relay.instance.force_disconnect',
      resourceType: 'relay_instance',
      resourceId: instance.id,
      details: {
        activeTunnels: instance.health?.activeTunnels ?? 0,
        ...(update ? { reason: 'relay_pool_update_drain_grace_ended' } : {}),
      },
    });
    this.events.publish('system.relay.health.changed', {
      poolId: instance.poolId,
      instanceId: instance.id,
      action: 'force_disconnect',
    });
    try {
      await this.evacuateInstance(instance.id);
      await this.retireDrainedGenerations();
    } catch (error) {
      // An update goes on with the relay disconnected; later placement passes move and retire the rest.
      if (!update) throw error;
      logger.warn('Relay disconnected for an update; moving its workloads failed', {
        instanceId: instance.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async evacuateInstance(instanceId: string): Promise<void> {
    // An in-flight placement is allowed to finish; the regular reconciler will
    // pick up the persisted drain on its next pass. Never race another batch.
    if (this.rebalanceFlight) return;
    const affected = await this.db
      .selectDistinct({ endpointId: relayEndpointAssignmentGenerations.endpointId })
      .from(relayEndpointAssignments)
      .innerJoin(
        relayEndpointAssignmentGenerations,
        eq(relayEndpointAssignments.assignmentGenerationId, relayEndpointAssignmentGenerations.id)
      )
      .where(
        and(
          eq(relayEndpointAssignments.relayInstanceId, instanceId),
          eq(relayEndpointAssignmentGenerations.state, 'active')
        )
      );
    if (!affected.length) return;
    await this.stageRebalance(undefined, {
      allowNoop: true,
      automatic: true,
      evacuation: true,
      endpointIds: affected.map(({ endpointId }) => endpointId),
    });
  }

  private async tryActivate(generationId: string): Promise<boolean> {
    if (this.preparingGenerations.has(generationId)) return false;
    let failed = false;
    let endpointId: string | undefined;
    const activated = await this.db.transaction(async (tx) => {
      // Removal must not delete a staged assignment between this readiness read
      // and activation. Use the same pool fence as placement and member removal.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-pool-rebalance'))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`relay-assignment-generation:${generationId}`}))`);
      const [generation] = await tx
        .select()
        .from(relayEndpointAssignmentGenerations)
        .where(eq(relayEndpointAssignmentGenerations.id, generationId))
        .limit(1);
      if (!generation || generation.state !== 'staging') return false;
      endpointId = generation.endpointId;
      const [assignments, probes] = await Promise.all([
        tx
          .select()
          .from(relayEndpointAssignments)
          .where(eq(relayEndpointAssignments.assignmentGenerationId, generation.id)),
        tx
          .select()
          .from(relayAssignmentSourceProbes)
          .where(eq(relayAssignmentSourceProbes.assignmentGenerationId, generation.id)),
      ]);
      if (
        assignments.some(({ targetRegistrationState }) => targetRegistrationState === 'failed') ||
        probes.some(({ state }) => state === 'failed')
      ) {
        await tx
          .update(relayEndpointAssignmentGenerations)
          .set({
            state: 'failed',
            activationError:
              [
                ...assignments
                  .filter(({ targetRegistrationState }) => targetRegistrationState === 'failed')
                  .map(({ targetRegistrationError }) => targetRegistrationError),
                ...probes.filter(({ state }) => state === 'failed').map(({ error }) => error),
              ]
                .filter(Boolean)
                .join('; ')
                .slice(0, 1000) || 'Target registration or source reachability probe failed',
            updatedAt: new Date(),
          })
          .where(eq(relayEndpointAssignmentGenerations.id, generation.id));
        await bumpRelayPolicyRevision(tx);
        failed = true;
        return false;
      }
      if (
        assignments.length !== generation.desiredRedundancy ||
        assignments.some(({ targetRegistrationState }) => targetRegistrationState !== 'ready') ||
        probes.some(({ state }) => state !== 'ready')
      ) {
        return false;
      }
      await tx
        .update(relayEndpointAssignmentGenerations)
        .set({ state: 'draining', drainStartedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(relayEndpointAssignmentGenerations.endpointId, generation.endpointId),
            eq(relayEndpointAssignmentGenerations.state, 'active')
          )
        );
      await tx
        .update(relayEndpointAssignmentGenerations)
        .set({ state: 'active', activatedAt: new Date(), activationError: null, updatedAt: new Date() })
        .where(eq(relayEndpointAssignmentGenerations.id, generation.id));
      await tx
        .update(relayEndpoints)
        .set({ activeAssignmentGeneration: generation.generation, updatedAt: new Date() })
        .where(eq(relayEndpoints.id, generation.endpointId));
      await bumpRelayPolicyRevision(tx);
      return true;
    });
    // A verified outcome ends the deferral backoff: a failure carries its own cooldown.
    if ((failed || activated) && endpointId) this.deferrals.delete(endpointId);
    if (failed) await this.withdrawGenerations([generationId]);
    if (activated) {
      await this.policy.reconcileAndSync();
      this.events.publish('system.relay.health.changed', { poolId: 'system', action: 'rebalance_activated' });
    }
    return activated;
  }

  /**
   * Runs one candidate probe. A daemon that did not run it (busy, not connected) is asked again after a short
   * pause; a gated refusal of a source probe counts as verified (see relay-pool-errors). A failure that survives
   * that is transient when its cause passes by itself, and then defers the generation instead of failing it.
   */
  private async runProbe(
    nodeId: string | null,
    role: 'target' | 'source',
    probe: () => Promise<void>
  ): Promise<ProbeResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await (nodeId ? this.withProbeSlot(nodeId, probe) : probe());
        return { ready: true };
      } catch (error) {
        if (role === 'source' && isGatedProbeRefusal(error)) return { ready: true };
        const pause = this.probeRetryDelaysMs[attempt];
        if (pause === undefined || !isRetryableDispatchError(error)) {
          return { ready: false, error: relayPoolErrorMessage(error), transient: isTransientRelayPoolError(error) };
        }
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
    }
  }

  /** Holds one of the daemon's probe slots (PROBES_PER_NODE) while probe runs. */
  private async withProbeSlot<T>(nodeId: string, probe: () => Promise<T>): Promise<T> {
    const slots = this.probeSlots.get(nodeId) ?? { active: 0, waiting: [] };
    this.probeSlots.set(nodeId, slots);
    if (slots.active >= PROBES_PER_NODE) await new Promise<void>((resolve) => slots.waiting.push(resolve));
    else slots.active += 1;
    try {
      return await probe();
    } finally {
      // Hand the slot straight to the next waiting probe, so a late arrival cannot overtake it.
      const next = slots.waiting.shift();
      if (next) next();
      else {
        slots.active -= 1;
        if (!slots.active) this.probeSlots.delete(nodeId);
      }
    }
  }

  private async prepareStagedGeneration(generation: {
    id: string;
    endpointId: string;
    generation: number;
  }): Promise<void> {
    const [[endpoint], routes, assignments, probes] = await Promise.all([
      this.db.select().from(relayEndpoints).where(eq(relayEndpoints.id, generation.endpointId)).limit(1),
      this.db.select().from(relayRoutes).where(eq(relayRoutes.targetEndpointId, generation.endpointId)),
      this.db
        .select({ id: relayEndpointAssignments.id, relayInstanceId: relayEndpointAssignments.relayInstanceId })
        .from(relayEndpointAssignments)
        .where(eq(relayEndpointAssignments.assignmentGenerationId, generation.id)),
      this.db
        .select()
        .from(relayAssignmentSourceProbes)
        .where(eq(relayAssignmentSourceProbes.assignmentGenerationId, generation.id)),
    ]);
    // The owner was revoked meanwhile: the endpoint and, by cascade, this generation are gone.
    if (!endpoint) return;
    const daemonNodeIds = [
      endpoint.subjectId,
      ...routes.filter(({ sourceKind }) => sourceKind === 'daemon').map(({ sourceId }) => sourceId),
    ];
    const grantResults = await Promise.allSettled(
      [...new Set(daemonNodeIds)].map(async (nodeId) => this.policy.syncNodeGrants(nodeId))
    );
    const grantFailure = grantResults.find((result) => result.status === 'rejected');
    if (grantFailure?.status === 'rejected') throw grantFailure.reason;

    const bundleCache = new Map<string, Awaited<ReturnType<RelayPolicyService['getNodeGrantBundle']>>>();
    const getBundle = async (nodeId: string) => {
      let bundle = bundleCache.get(nodeId);
      if (!bundle) {
        bundle = await this.policy.getNodeGrantBundle(nodeId);
        bundleCache.set(nodeId, bundle);
      }
      return bundle;
    };
    // The first transient probe failure ends the preparation: the generation is deferred and probed afresh by the
    // next attempt. A genuine failure recorded before it still fails the generation.
    const outcome: { transient?: string; failed: boolean } = { failed: false };
    const settle = async (result: ProbeResult, acknowledge: (ready: boolean, error?: string) => Promise<unknown>) => {
      if (result.ready) await acknowledge(true);
      else if (result.transient) outcome.transient = result.error;
      else {
        outcome.failed = true;
        await acknowledge(false, result.error);
      }
    };
    const targetBundle = await getBundle(endpoint.subjectId);
    const targetGrant = targetBundle.grants.find(
      ({ role, endpointId }) => role === 'endpoint' && endpointId === generation.endpointId
    );
    for (const assignment of assignments) {
      if (outcome.transient) break;
      const acknowledge = (ready: boolean, error?: string) =>
        this.acknowledgeTarget(generation.id, assignment.relayInstanceId, ready, error);
      const candidate = targetGrant?.candidates?.find(
        ({ relayInstanceId, assignmentGeneration }) =>
          relayInstanceId === assignment.relayInstanceId && assignmentGeneration === String(generation.generation)
      );
      if (!candidate) {
        outcome.failed = true;
        await acknowledge(false, 'Pool candidate grant is unavailable');
        continue;
      }
      const result = await this.runProbe(endpoint.subjectId, 'target', () =>
        this.policy.probeRelayCandidate(endpoint.subjectId, {
          probeId: assignment.id,
          role: 'target',
          endpointId: generation.endpointId,
          assignmentGeneration: String(generation.generation),
          candidate,
        })
      );
      await settle(result, acknowledge);
    }

    for (const probe of probes) {
      if (outcome.transient) break;
      const acknowledge = (ready: boolean, error?: string) => this.acknowledgeProbe(probe.id, ready, error);
      const route = routes.find(
        ({ sourceKind, sourceId }) => sourceKind === probe.sourceKind && sourceId === probe.sourceId
      );
      if (!route) {
        outcome.failed = true;
        await acknowledge(false, 'Relay source route is unavailable');
        continue;
      }
      if (route.sourceKind === 'gateway') {
        const result = await this.runProbe(null, 'source', () =>
          this.policy.probeGatewayRelayCandidate(
            route.id,
            probe.certificateFingerprint,
            probe.relayInstanceId,
            String(generation.generation)
          )
        );
        await settle(result, acknowledge);
        continue;
      }
      if (route.sourceKind !== 'daemon') {
        outcome.failed = true;
        await acknowledge(false, `Unsupported relay source kind ${route.sourceKind}`);
        continue;
      }
      const sourceBundle = await getBundle(route.sourceId);
      const sourceGrant = sourceBundle.grants.find(({ role, routeId }) => role === 'connect' && routeId === route.id);
      const candidate = sourceGrant?.candidates?.find(
        ({ relayInstanceId, assignmentGeneration }) =>
          relayInstanceId === probe.relayInstanceId && assignmentGeneration === String(generation.generation)
      );
      if (!candidate) {
        outcome.failed = true;
        await acknowledge(false, 'Pool candidate grant is unavailable');
        continue;
      }
      const result = await this.runProbe(route.sourceId, 'source', () =>
        this.policy.probeRelayCandidate(route.sourceId, {
          probeId: probe.id,
          role: 'source',
          endpointId: generation.endpointId,
          routeId: route.id,
          assignmentGeneration: String(generation.generation),
          candidate,
        })
      );
      await settle(result, acknowledge);
    }
    if (outcome.transient && !outcome.failed) throw new Error(outcome.transient);
  }
}

export const relayPoolInternals = { chooseCandidates: chooseByRendezvous, isEnrolledRelayInstance };
