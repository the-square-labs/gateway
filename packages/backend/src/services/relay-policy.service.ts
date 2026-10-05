import type { Duplex } from 'node:stream';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  managedDatabaseBindingPlacements,
  managedDatabaseInstances,
  managedStorageClusters,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayEndpoints,
  relayGrantSigningKeys,
  relayInstances,
  relayPolicyState,
  relayPools,
  relayRoutes,
} from '@/db/schema/index.js';
import type { RelayManagedDatabaseListenerConfig, RelaySecureLinkEgressConfig } from '@/db/schema/relay.js';
import {
  LEGACY_RELAY_PATH_ID,
  RELAY_MAX_FRAME_BYTES,
  type RelayControlClient,
  type RelayHealthResponse,
  type RelayPolicySnapshot,
} from '@/grpc/relay-control.client.js';
import { encodeRelayV1Message } from '@/grpc/relay-proto.js';
import { type AttachablePath, ResumeSessionError } from '@/grpc/relay-resume.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { leaseLaneNodeIds } from '@/modules/docker/availability/lease/lease-relay-lanes.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import {
  LEGACY_RELAY_POLICY_LEASE_SECONDS,
  LONG_POLICY_LEASE_CAPABILITY,
} from '@/modules/settings/general-settings.service.js';
import { isNodeNotConnectedError } from '@/services/node-connection-errors.js';
import type { CryptoService } from './crypto.service.js';
import type { EventBusService } from './event-bus.service.js';
import {
  type ManagedLinkConnections,
  sumManagedLinkReports,
  withManagedLinkConnections,
} from './managed-link-runtime.js';
import type { NodeDispatchService } from './node-dispatch.service.js';
import type { NodeRegistryService } from './node-registry.service.js';
import { relayGrantBundleFingerprint } from './relay-grant-bundle-fingerprint.js';
import {
  type RelayGrantBundle,
  RelayGrantIssuerService,
  RelayPolicyNotAcknowledgedError,
} from './relay-grant-issuer.service.js';
import { RelayGrantKeyService } from './relay-grant-key.service.js';
import {
  CONTAINER_LINK_OWNER_KIND,
  RelayLinkRoutes,
  routeTransportRestartRequired,
  secureLinkEgressEqual,
} from './relay-link-routes.js';
import {
  backfillRelayNodeFingerprints,
  bumpRelayPolicyRevision,
  reconcileManagedDatabaseRelayPolicy,
  reconcileManagedStorageRelayPolicy,
  removeOrphanedRelayState,
  updateManagedDatabaseRelayStatus,
} from './relay-policy-reconciler.js';
import { RelayPolicySigningKeyService, type RelayPolicyTrustAnchor } from './relay-policy-signing-key.service.js';
import { relayPolicySnapshotContent, relayPolicySnapshotKey } from './relay-policy-snapshot-content.js';
import {
  holdsCurrentSnapshot,
  loadInstancePolicyState,
  RELAY_POLICY_REVISION_LOCK,
  recordBuiltSnapshot,
} from './relay-revocation-fence.service.js';
import { effectiveRelayMaxConcurrentSessions } from './relay-session-limits.js';
import { candidateDrainDeadline, type RelayStreamReports, RelayStreamResumeService } from './relay-stream-resume.js';
import type { RelayAssignmentRole } from './relay-topology.js';
import { parseRelayGrantEgressStatuses, type SecureLinkEgressStatus } from './secure-link-egress-status.js';

export type { RelayGrantAssignment, RelayGrantBundle, RelayGrantClaims } from './relay-grant-issuer.service.js';

export interface RelayRouteRuntime {
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
  /**
   * Managed links: what the nodes running the link's workloads report. activeStreams, openedTotal and the byte counters
   * are theirs and throttledTotal includes their refusals; null when a node does not report links (an older daemon).
   */
  connections?: ManagedLinkConnections | null;
}

export type ProxyRouteRuntime = RelayRouteRuntime;

/** A link runtime older than this asks the link's nodes for a fresh report (they report every 30 s on their own). */
const MANAGED_LINK_REPORT_FRESH_MS = 5_000;

const logger = createChildLogger('RelayPolicyService');

export interface RelayGrantSyncOptions {
  /** Skip a daemon that recently got a bundle allowing exactly the same (see deliveredRecently). */
  skipUnchanged?: boolean;
}

/**
 * Ensure calls repeat on every reconciliation and link probe with nothing changed. Revocations,
 * identity changes and reconnects always deliver.
 */
const ROUTINE_GRANT_SYNC: RelayGrantSyncOptions = { skipUnchanged: true };
const INTERNAL_REGISTRY_ID = 'gateway-internal-registry';
const INTERNAL_REGISTRY_CERTIFICATE_ID = 'local:gateway-internal-registry';
const REGISTRY_ROUTE_OWNER_KINDS = ['registry_secure_link', 'registry_ingress'] as const;
type RegistryRouteOwnerKind = (typeof REGISTRY_ROUTE_OWNER_KINDS)[number];

/**
 * Whether the daemon must open the listener anew: its network, address or port changed. A change of the workloads it
 * admits alone keeps the route's generation, so the relay keeps its tunnels and a daemon updates the listener in place
 * with the connections it holds (an Availability copy adopted as the standalone workload).
 */
export function managedDatabaseListenerRestartRequired(
  current: RelayManagedDatabaseListenerConfig | null | undefined,
  desired: RelayManagedDatabaseListenerConfig | null | undefined
): boolean {
  if (!current || !desired) return !(current == null && desired == null);
  return (
    current.networkName !== desired.networkName ||
    current.listenAddress !== desired.listenAddress ||
    current.listenPort !== desired.listenPort
  );
}

export function managedDatabaseListenerConfigsEqual(
  current: RelayManagedDatabaseListenerConfig | null | undefined,
  desired: RelayManagedDatabaseListenerConfig | null | undefined
): boolean {
  if (!current || !desired) return current == null && desired == null;
  if (
    current.networkName !== desired.networkName ||
    current.listenAddress !== desired.listenAddress ||
    current.listenPort !== desired.listenPort ||
    !Array.isArray(current.allowedSources) ||
    !Array.isArray(desired.allowedSources) ||
    current.allowedSources.length !== desired.allowedSources.length
  ) {
    return false;
  }
  const currentSources = [...current.allowedSources].sort();
  const desiredSources = [...desired.allowedSources].sort();
  return currentSources.every((source, index) => source === desiredSources[index]);
}

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

function proxyLinkSources(sourceNodeIds: string | readonly string[]): string[] {
  return [...new Set(typeof sourceNodeIds === 'string' ? [sourceNodeIds] : sourceNodeIds)];
}

interface RelayRouteRuntimeReport {
  routeId: string;
  activeTunnels?: unknown;
  openedTotal?: unknown;
  completedTotal?: unknown;
  failedTotal?: unknown;
  throttledTotal?: unknown;
  sourceToTargetBytes?: unknown;
  targetToSourceBytes?: unknown;
  setupLatencyP95Microseconds?: unknown;
  averageDurationMilliseconds?: unknown;
  lastActivityUnixMilliseconds?: unknown;
  metricsSinceUnixMilliseconds?: unknown;
}

/** One route's runtime as the relay reports it. */
function relayRouteRuntime(runtime: RelayRouteRuntimeReport): RelayRouteRuntime {
  const lastActivityMillis = Number(runtime.lastActivityUnixMilliseconds || 0);
  const metricsSinceMillis = Number(runtime.metricsSinceUnixMilliseconds || 0);
  return {
    routeId: runtime.routeId,
    activeStreams: Number(runtime.activeTunnels || 0),
    openedTotal: String(runtime.openedTotal ?? '0'),
    completedTotal: String(runtime.completedTotal ?? '0'),
    failedTotal: String(runtime.failedTotal ?? '0'),
    throttledTotal: String(runtime.throttledTotal ?? '0'),
    sourceToTargetBytes: String(runtime.sourceToTargetBytes ?? '0'),
    targetToSourceBytes: String(runtime.targetToSourceBytes ?? '0'),
    setupLatencyP95Ms: Number(runtime.setupLatencyP95Microseconds || 0) / 1000,
    averageDurationMs: Number(runtime.averageDurationMilliseconds || 0),
    lastActivityAt: lastActivityMillis > 0 ? new Date(lastActivityMillis).toISOString() : null,
    metricsSince: new Date(metricsSinceMillis > 0 ? metricsSinceMillis : Date.now()).toISOString(),
  };
}

/**
 * The runtime of a link served by several relay routes: a group route's Secure Link (one route per member) or an
 * Availability database link (one route per placement). It is the sum of those routes.
 */
function sumRouteRuntimes(runtimes: RelayRouteRuntimeReport[]): RelayRouteRuntime {
  const total = (pick: (runtime: RelayRouteRuntimeReport) => unknown) =>
    runtimes.reduce((sum, runtime) => sum + Number(pick(runtime) || 0), 0);
  const lastActivityMillis = Math.max(
    0,
    ...runtimes.map((runtime) => Number(runtime.lastActivityUnixMilliseconds || 0))
  );
  const since = runtimes
    .map((runtime) => Number(runtime.metricsSinceUnixMilliseconds || 0))
    .filter((value) => value > 0);
  const opened = total((runtime) => runtime.openedTotal);
  return {
    routeId: runtimes[0]?.routeId ?? '',
    activeStreams: total((runtime) => runtime.activeTunnels),
    openedTotal: String(opened),
    completedTotal: String(total((runtime) => runtime.completedTotal)),
    failedTotal: String(total((runtime) => runtime.failedTotal)),
    throttledTotal: String(total((runtime) => runtime.throttledTotal)),
    sourceToTargetBytes: String(total((runtime) => runtime.sourceToTargetBytes)),
    targetToSourceBytes: String(total((runtime) => runtime.targetToSourceBytes)),
    setupLatencyP95Ms:
      Math.max(0, ...runtimes.map((runtime) => Number(runtime.setupLatencyP95Microseconds || 0))) / 1000,
    averageDurationMs:
      opened > 0
        ? runtimes.reduce(
            (sum, runtime) => sum + Number(runtime.averageDurationMilliseconds || 0) * Number(runtime.openedTotal || 0),
            0
          ) / opened
        : 0,
    lastActivityAt: lastActivityMillis > 0 ? new Date(lastActivityMillis).toISOString() : null,
    metricsSince: new Date(since.length > 0 ? Math.min(...since) : Date.now()).toISOString(),
  };
}

/** The local relay could not be reached at all, as opposed to refusing what it was sent. */
function isRelayUnavailable(error: unknown): boolean {
  const code = (error as { code?: number } | null)?.code;
  return code === GrpcStatus.UNAVAILABLE || code === GrpcStatus.DEADLINE_EXCEEDED;
}

function isSignedRotationRefusal(error: unknown): boolean {
  return errorMessage(error).includes('require signed rotation');
}

/**
 * A snapshot refusal only a local trust reset repairs. The relay pins the signer but not a
 * window that covers now (its pinned entry aged out, for example after Gateway's database was
 * restored), or it is bound to another Gateway instance (Gateway reinstalled over an existing
 * relay volume). Neither changes by retrying.
 */
function isLocalPolicyLockout(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    (error as { code?: number } | null)?.code === GrpcStatus.FAILED_PRECONDITION &&
    (message.includes('policy envelope signature is invalid') || message.includes('snapshot gateway instance changed'))
  );
}

/** Advertised by local relay builds that implement ResetLocalPolicyTrust. */
export const LOCAL_POLICY_TRUST_RESET_CAPABILITY = 'policy_trust_reset_v1';
/** A trust reset repairs the local relay in one step; repeating it sooner cannot help and would hide a loop. */
export const LOCAL_POLICY_TRUST_RESET_COOLDOWN_MS = 10 * 60 * 1000;
/** A local recovery stays visible this long after it succeeded. */
const LOCAL_POLICY_TRUST_RECOVERED_VISIBLE_MS = 24 * 60 * 60 * 1000;
/** Pushes on the policy-change path must not hold local publication behind a slow remote relay. */
const REMOTE_POLICY_PUSH_TIMEOUT_MS = 10_000;
const REMOTE_POLICY_PUSH_RETRY_MS = 60_000;
/** A relay that lost its policy gets it at most this often from its reports (N-7). */
const REMOTE_POLICY_LOSS_SYNC_INTERVAL_MS = 5_000;
const LOCAL_POLICY_LOSS_SYNC_INTERVAL_MS = 2_000;
/** How long a grant dispatch waits for remote relays to take the policy it depends on. */
const REMOTE_POLICY_PUSH_GRACE_MS = 3_000;
const REVISION_RAISE_INTERVAL_MS = 5 * 60 * 1000;
/** A grant refresh that stays pending the same way is reported again after this long. */
const PENDING_GRANT_REFRESH_REPORT_MS = 5 * 60 * 1000;
/** Largest revision floor a relay report may impose; beyond it JavaScript numbers lose precision. */
const MAX_REVISION_FLOOR = Number.MAX_SAFE_INTEGER - 1_000_000;
/**
 * How far one report may move a revision sequence. A database restore leaves Gateway behind by
 * at most the policy changes and snapshots since the backup, far below this; a relay or daemon,
 * even a compromised one, cannot push the sequence toward the precision limit of its column.
 */
const MAX_REVISION_JUMP = 1_000_000;
/** Refusals without a revision a daemon must repeat before they count as a restore. */
const STALE_REFUSALS_BEFORE_RAISE = 3;

export const LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE =
  'The local relay trusts only policy signing keys Gateway can no longer sign with, and its version cannot reset ' +
  'that trust. Update the Relay Pool to the current release; Gateway then recovers it automatically. To recover ' +
  'by hand, rename relay.db in the relay state volume (keep identity-rotation.json) and run docker restart on the ' +
  'relay container.';

export type RelayPolicyTrustState =
  | 'locked_out'
  | 'recovered'
  | 'recovery_unsupported'
  | 'recovery_failed'
  | 'reenrollment_required';

/** Why a relay refuses Gateway's policy and what repairs it, for health surfaces. */
export interface RelayPolicyTrustStatus {
  state: RelayPolicyTrustState;
  message: string;
  observedAt: string;
  trustedKeyIds: string[];
}

export function remoteRelayReenrollmentMessage(): string {
  return (
    'This relay trusts only policy signing keys Gateway can no longer sign with, so it refuses every policy. ' +
    'Re-enroll it: create a re-enrollment token for this relay and run the relay installer with it on the host. ' +
    'The relay keeps its place in the pool and pins the current key.'
  );
}

export class RelayPolicyService {
  private dispatch?: Pick<
    NodeDispatchService,
    'sendRelayGrantBundle' | 'sendRelayPolicy' | 'setRelayDrain' | 'probeRelayCandidate' | 'isNodeConnected'
  >;
  private lastGrantRefreshAt = 0;
  private lastGrantRefreshRevision = 0;
  private readonly grantIssuer: RelayGrantIssuerService;
  private readonly linkRoutes: RelayLinkRoutes;
  private readonly grantKeys: RelayGrantKeyService;
  private readonly policyKeys: RelayPolicySigningKeyService;
  private readonly streamResume: RelayStreamResumeService;
  private relaySettingsSync: Promise<void> = Promise.resolve();
  private snapshotSync: Promise<unknown> = Promise.resolve();
  private readonly nodeGrantSyncs = new Map<
    string,
    Promise<Awaited<ReturnType<NodeDispatchService['sendRelayGrantBundle']>>>
  >();
  private readonly lastNodeGrantBundles = new Map<string, RelayGrantBundle>();
  /** Per daemon: what the last delivered bundle allowed, and when it was delivered. */
  private readonly deliveredGrantBundles = new Map<string, { fingerprint: string; at: number }>();
  private readonly nodeGrantEpochs = new Map<string, { valid: boolean; pending: number }>();
  /** Per remote node: builds and deliveries in order, so a relay never sees an older revision after a newer one. */
  private readonly remotePolicySyncs = new Map<string, Promise<unknown>>();
  /** Per remote node: the global policy revision it last acknowledged from the policy-change path. */
  private readonly remotePolicyRevisions = new Map<string, number>();
  private readonly remotePolicyPushFailedAt = new Map<string, number>();
  private remotePush: Promise<void> = Promise.resolve();
  private remotePushRevision = 0;
  private audit?: Pick<AuditService, 'log'>;
  private events?: EventBusService;
  private localPolicyTrust: RelayPolicyTrustStatus | null = null;
  private lastRevisionRaiseAt = 0;
  /** Per daemon: consecutive grant bundle refusals that named no revision. */
  private readonly staleGrantRefusals = new Map<string, number>();
  private lastLocalPolicyTrustResetAt = 0;
  private lastLocalPolicyLossSyncAt = 0;
  /** The pending grant refresh last reported; see reportPendingGrantRefresh. */
  private pendingGrantRefresh: { message: string; reportedAt: number } | null = null;
  private initialAssignmentPlanner?: (
    endpointId: string
  ) => Promise<Array<{ relayInstanceId: string; role: RelayAssignmentRole }> | null>;
  private readonly remotePolicyLossSyncAt = new Map<string, number>();
  /** Availability lease blocks and key chain for PolicyEnvelopePayload fields 40 and 41. */
  private availabilityLeaseSource?: () => Promise<{ leaseBlocks: unknown[]; leaseKeyRotations: unknown[] }>;
  /** Endpoints and routes the relay admits only through its lease gate (EndpointPolicy 10, RoutePolicy 12). */
  private availabilityLeaseGate?: (
    endpoints: Array<{ id: string; ownerKind: string; ownerId: string }>,
    routes: Array<{ id: string; ownerKind: string; ownerId: string }>
  ) => Promise<{ endpoints: Map<string, string>; routes: Map<string, string> }>;
  /** What the nodes running managed links' workloads report about the links' connections. */
  private managedLinkReports?: Pick<NodeRegistryService, 'managedLinkReport' | 'requestHealthReport'> &
    Partial<Pick<NodeRegistryService, 'relayStreamReports'>>;

  constructor(
    private readonly db: DrizzleClient,
    cryptoService: CryptoService,
    private readonly settings: GeneralSettingsService,
    private readonly relay: RelayControlClient
  ) {
    this.grantIssuer = new RelayGrantIssuerService(db, cryptoService, settings);
    this.linkRoutes = new RelayLinkRoutes({
      db,
      requireNodeIdentity: (nodeId) => this.grantIssuer.requireNodeIdentity(nodeId),
      syncSnapshot: () => this.syncSnapshot(),
      syncNodeGrants: (nodeId, options) => this.syncNodeGrants(nodeId, options),
      policyNodeIds: () => this.grantIssuer.policyNodeIds(),
      ensureEndpointAssignment: (endpointId) => this.ensureLegacyCompatibleAssignment(endpointId),
    });
    this.grantKeys = new RelayGrantKeyService(db, cryptoService, settings);
    this.policyKeys = new RelayPolicySigningKeyService(db, cryptoService);
    this.streamResume = new RelayStreamResumeService(db, cryptoService, {
      syncNodeGrants: (nodeId) => this.syncNodeGrants(nodeId),
    });
    this.grantIssuer.setResumeSecretSource(() => this.streamResume.secret());
  }

  setManagedLinkReports(
    reports: Pick<NodeRegistryService, 'managedLinkReport' | 'requestHealthReport'> &
      Partial<Pick<NodeRegistryService, 'relayStreamReports'>>
  ): void {
    this.managedLinkReports = reports;
  }

  /** The relay stream sessions (RSv1) daemons reported recently; empty when none reports them. */
  relayStreamReports(): RelayStreamReports {
    return this.managedLinkReports?.relayStreamReports?.() ?? [];
  }

  /**
   * Moves Gateway's own resumable streams (database tools, storage browser) off a relay that started draining, paced
   * to its drain deadline. Daemons learn the same from their grant bundles.
   */
  migrateGatewayStreams(relayInstanceId: string, drainDeadlineAt: Date | null): void {
    try {
      const deadline = drainDeadlineAt ? Number(candidateDrainDeadline(drainDeadlineAt) ?? 0) : 0;
      this.relay.migrateResumableTunnels?.(relayInstanceId, deadline);
    } catch (error) {
      logger.warn("Moving Gateway's own streams off a draining relay failed", {
        relayInstanceId,
        error: errorMessage(error),
      });
    }
  }

  /**
   * Brings every route's resumable stream state in line with what its source and target support, in order (see
   * RelayStreamResumeService). A node that reconnects with other capabilities is reconciled before its grants go out.
   */
  async reconcileStreamResume(maxWaitMs = 10_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Bounded: a pass waits for other daemons' acknowledgements, and the caller's own delivery must not.
    await Promise.race([
      this.streamResume.reconcile(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, maxWaitMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** The shared secure-link connector image that connector egress assignments name. */
  setSecureLinkConnectorImage(image: string): void {
    this.grantIssuer.setConnectorImage(image);
  }

  setNodeDispatch(
    dispatch: Pick<
      NodeDispatchService,
      'sendRelayGrantBundle' | 'sendRelayPolicy' | 'setRelayDrain' | 'probeRelayCandidate' | 'isNodeConnected'
    >
  ): void {
    this.dispatch = dispatch;
  }

  /**
   * The pool's placement of a new endpoint's first assignment (RelayPoolService.planInitialAssignment), or null for
   * the legacy local shape.
   */
  setInitialAssignmentPlanner(
    planner: (endpointId: string) => Promise<Array<{ relayInstanceId: string; role: RelayAssignmentRole }> | null>
  ): void {
    this.initialAssignmentPlanner = planner;
  }

  setAuditService(audit: Pick<AuditService, 'log'>): void {
    this.audit = audit;
  }

  /**
   * Every relay snapshot carries the signed lease voter config, manifests and policy key chain; the lease service also
   * names the policy key that signs lease blocks so its private half is never destroyed (A14).
   */
  setAvailabilityLeaseSource(source: {
    relayPolicyFields(): Promise<{ leaseBlocks: unknown[]; leaseKeyRotations: unknown[] }>;
    retainedSigningKeyIds(): Promise<string[]>;
    relayLeasePolicyIds?(
      endpoints: Array<{ id: string; ownerKind: string; ownerId: string }>,
      routes: Array<{ id: string; ownerKind: string; ownerId: string }>
    ): Promise<{ endpoints: Map<string, string>; routes: Map<string, string> }>;
  }): void {
    this.availabilityLeaseSource = () => source.relayPolicyFields();
    this.availabilityLeaseGate = source.relayLeasePolicyIds
      ? (endpoints, routes) => source.relayLeasePolicyIds!(endpoints, routes)
      : undefined;
    this.policyKeys.setRetainedKeyIds(() => source.retainedSigningKeyIds());
  }

  /** A lease block changed: publish a new revision to the local relay and push it to remote relays. */
  async publishAvailabilityLeaseChange(): Promise<void> {
    await this.db.transaction((tx) => bumpRelayPolicyRevision(tx));
    await this.syncSnapshot();
    // Lease lanes follow the policies' voters and candidates (stand run c1).
    const nodeIds = await leaseLaneNodeIds(this.db).catch(() => []);
    await Promise.allSettled(nodeIds.map((nodeId) => this.syncNodeGrants(nodeId, { skipUnchanged: true })));
  }

  setEventBus(events: EventBusService): void {
    this.events = events;
    events.subscribe('system.relay.health.changed', (payload) => {
      // The local relay answers but holds no policy (it restarted with a fresh relay.db): deliver it now instead of
      // at the next periodic sync, so endpoint registrations are not refused for up to a minute (N-7).
      if ((payload as { reason?: unknown } | null)?.reason !== 'policy_snapshot_required') return;
      this.syncLocalPolicyAfterLoss();
    });
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

  /** Throttled: a relay stuck without policy reports it on every probe transition. */
  private syncLocalPolicyAfterLoss(now = Date.now()): void {
    if (now - this.lastLocalPolicyLossSyncAt < LOCAL_POLICY_LOSS_SYNC_INTERVAL_MS) return;
    this.lastLocalPolicyLossSyncAt = now;
    void this.syncSnapshot().catch((error) => {
      logger.warn('Local relay policy delivery after a lost snapshot deferred to the next sync', {
        error: errorMessage(error),
      });
    });
  }

  /**
   * A remote relay reported the policy revision it holds. A relay that holds none, or an older one than it held
   * before, lost its state or restarted from an old copy: send its snapshot now, without waiting for the next policy
   * change or lease refresh (N-7). Throttled per relay.
   */
  noteRemoteAppliedRevision(
    nodeId: string,
    reportedRevision: number,
    previousRevision: number,
    now = Date.now()
  ): void {
    if (!this.dispatch) return;
    if (reportedRevision > 0 && reportedRevision >= previousRevision) return;
    if (now - (this.remotePolicyLossSyncAt.get(nodeId) ?? 0) < REMOTE_POLICY_LOSS_SYNC_INTERVAL_MS) return;
    this.remotePolicyLossSyncAt.set(nodeId, now);
    logger.info('Remote relay holds no current policy; delivering its snapshot', {
      nodeId,
      reportedRevision,
      previousRevision,
    });
    void this.syncRemoteInstancePolicy(nodeId, REMOTE_POLICY_PUSH_TIMEOUT_MS, { force: true }).catch((error) => {
      logger.warn('Remote relay policy delivery after a lost snapshot deferred to the next refresh', {
        nodeId,
        error: errorMessage(error),
      });
    });
  }

  async ensureInitialized(): Promise<void> {
    await backfillRelayNodeFingerprints(this.db);
    await this.grantKeys.ensureInitialized();
    await this.policyKeys.ensureInitialized();
    await this.streamResume.ensureInitialized();
    await this.reconcileInternalRegistryEndpoint();
    await reconcileManagedDatabaseRelayPolicy(this.db);
    await reconcileManagedStorageRelayPolicy(this.db);
    // Daemons are not connected yet: each gets its bundle without the removed state when it registers.
    await removeOrphanedRelayState(this.db);
    await this.syncSnapshot().catch((error) => {
      logger.warn('Initial relay policy sync deferred until relay is reachable', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async getPolicyEnrollmentTrust() {
    return this.policyKeys.getEnrollmentTrust();
  }

  /**
   * Delivers the relay's policy snapshot. `force` sends it even when Gateway's records say the relay holds it: a
   * relay that (re)connects may have lost its state (relay.db renamed or restored) and would refuse every
   * registration with "policy snapshot is required" until the next policy change or lease refresh (N-7).
   */
  syncRemoteInstancePolicy(nodeId: string, timeoutMs?: number, options: { force?: boolean } = {}): Promise<number> {
    // Build and deliver in order per relay: two concurrent pushes could otherwise arrive
    // newest first, and the relay would refuse the older one as a stale revision.
    const previous = this.remotePolicySyncs.get(nodeId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.syncRemoteInstancePolicyOnce(nodeId, timeoutMs, options.force === true));
    this.remotePolicySyncs.set(nodeId, current);
    const settle = () => {
      if (this.remotePolicySyncs.get(nodeId) === current) this.remotePolicySyncs.delete(nodeId);
    };
    current.then(settle, settle);
    return current;
  }

  private async syncRemoteInstancePolicyOnce(nodeId: string, timeoutMs?: number, force = false): Promise<number> {
    if (!this.dispatch) throw new Error('Relay node dispatch is not configured');
    const [instance] = await this.db
      .select({ id: relayInstances.id })
      .from(relayInstances)
      .where(and(eq(relayInstances.nodeId, nodeId), eq(relayInstances.kind, 'remote')))
      .limit(1);
    if (!instance) throw new Error('Remote relay instance is unavailable');
    const snapshot = await this.buildInstanceSnapshot(instance.id, undefined, 0, { force });
    // A relay that reports the unchanged snapshot needs nothing sent.
    if (snapshot.encodedRequest) {
      const args = [
        nodeId,
        snapshot.encodedRequest,
        String(snapshot.revision),
        String(snapshot.expiresAtUnix),
      ] as const;
      const result = timeoutMs
        ? await this.dispatch.sendRelayPolicy(...args, timeoutMs)
        : await this.dispatch.sendRelayPolicy(...args);
      if (!result.success) throw new Error(result.error || 'Remote relay rejected policy snapshot');
    }
    this.remotePolicyRevisions.set(
      nodeId,
      Math.max(this.remotePolicyRevisions.get(nodeId) ?? 0, snapshot.globalRevision)
    );
    // The relay answers again: pushes of later changes must not wait out an earlier failure's cooldown.
    this.remotePolicyPushFailedAt.delete(nodeId);
    return snapshot.revision;
  }

  /** Whether the relay's supervisor holds its control stream; drain commands reach only such a relay. */
  isRemoteInstanceConnected(nodeId: string): boolean {
    return this.dispatch?.isNodeConnected(nodeId) ?? false;
  }

  async setRemoteInstanceDrain(nodeId: string, enabled: boolean, forceDisconnect = false): Promise<void> {
    if (!this.dispatch) throw new Error('Relay node dispatch is not configured');
    const result = await this.dispatch.setRelayDrain(nodeId, enabled, forceDisconnect);
    if (!result.success) throw new Error(result.error || 'Remote relay drain command failed');
  }

  /** The local relay's drain, which only a Relay Pool update takes while another relay carries its workloads. */
  async setLocalInstanceDrain(enabled: boolean, forceDisconnect = false): Promise<void> {
    await this.relay.setDrain(enabled, forceDisconnect);
  }

  async probeRelayCandidate(
    nodeId: string,
    input: Parameters<NodeDispatchService['probeRelayCandidate']>[1]
  ): Promise<void> {
    if (!this.dispatch) throw new Error('Relay node dispatch is not configured');
    const result = await this.dispatch.probeRelayCandidate(nodeId, input);
    if (!result.success) throw new Error(result.error || 'Relay candidate probe failed');
  }

  async probeManagedDatabaseBindingRoute(nodeId: string, bindingId: string): Promise<void> {
    const bundle = this.lastNodeGrantBundles.get(nodeId) ?? (await this.getNodeGrantBundle(nodeId));
    const assignment = bundle.grants.find(
      (grant) =>
        grant.role === 'connect' && grant.ownerKind === 'managed_database_binding' && grant.ownerId === bindingId
    );
    if (!assignment) throw new Error('Managed database binding relay grant is unavailable');
    if (!assignment.routeId || !assignment.targetEndpointId) {
      throw new Error('Managed database binding relay route is incomplete');
    }
    const candidates = assignment.candidates ?? [];
    if (candidates.length === 0) return;
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        await this.probeRelayCandidate(nodeId, {
          probeId: bindingId,
          role: 'source',
          endpointId: assignment.targetEndpointId,
          routeId: assignment.routeId,
          assignmentGeneration: candidate.assignmentGeneration,
          candidate,
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Managed database binding relay route is unavailable');
  }

  /**
   * Delivers a node's grants until the daemon reports the connector egress of one link route listening for the route's
   * current generation (egressStatuses in the ACK). The daemon answers `pending` while it brings the egress up, so the
   * bundle is re-sent with backoff (1 s doubling to 8 s; an unchanged bundle is cheap) until `timeoutMs`, then this
   * throws with the daemon's last reason, which the caller shows on the link.
   */
  async awaitSecureLinkEgress(
    nodeId: string,
    ownerKind: 'managed_storage_binding' | 'managed_database_binding' | 'container_link',
    ownerId: string,
    options: { timeoutMs?: number; initialDelayMs?: number } = {}
  ): Promise<SecureLinkEgressStatus> {
    const deadline = Date.now() + (options.timeoutMs ?? 90_000);
    let delayMs = options.initialDelayMs ?? 1_000;
    let reason = 'the daemon did not report it';
    for (let attempt = 0; attempt === 0 || Date.now() < deadline; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, Math.max(0, deadline - Date.now()))));
        delayMs = Math.min(delayMs * 2, 8_000);
      }
      const [route] = await this.db
        .select({ generation: relayRoutes.generation, egress: relayRoutes.secureLinkEgress })
        .from(relayRoutes)
        .where(
          and(
            eq(relayRoutes.ownerKind, ownerKind),
            eq(relayRoutes.ownerId, ownerId),
            eq(relayRoutes.sourceKind, 'daemon'),
            eq(relayRoutes.sourceId, nodeId)
          )
        )
        .limit(1);
      if (!route?.egress) throw new Error('the link route has no connector egress');
      const result = await this.syncNodeGrantBundle(nodeId);
      if (!result.success) {
        reason = result.error || 'the daemon rejected the relay grants';
        continue;
      }
      const status = parseRelayGrantEgressStatuses(result.detail)[ownerId];
      if (status?.state === 'ready' && status.routeGeneration === route.generation) return status;
      reason = status?.error || (status ? `it is ${status.state}` : 'the daemon did not report it');
    }
    throw new Error(`the secure-link connector is not listening for the link: ${reason}`);
  }

  /**
   * What the node's daemon reports about its connector egress now, by owner id: the ACK of a freshly delivered bundle
   * (egressStatuses). Null when the bundle was not delivered.
   */
  async secureLinkEgressStatuses(nodeId: string): Promise<Record<string, SecureLinkEgressStatus> | null> {
    const result = await this.syncNodeGrantBundle(nodeId);
    return result.success ? parseRelayGrantEgressStatuses(result.detail) : null;
  }

  /** Probes the relay path of one link route from its source node, like a managed database link's. */
  async probeLinkRoute(nodeId: string, ownerKind: string, ownerId: string): Promise<void> {
    const bundle = this.lastNodeGrantBundles.get(nodeId) ?? (await this.getNodeGrantBundle(nodeId));
    const assignment = bundle.grants.find(
      (grant) => grant.role === 'connect' && grant.ownerKind === ownerKind && grant.ownerId === ownerId
    );
    if (!assignment?.routeId || !assignment.targetEndpointId) throw new Error('The link relay grant is unavailable');
    const candidates = assignment.candidates ?? [];
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        await this.probeRelayCandidate(nodeId, {
          probeId: ownerId,
          role: 'source',
          endpointId: assignment.targetEndpointId,
          routeId: assignment.routeId,
          assignmentGeneration: candidate.assignmentGeneration,
          candidate,
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    if (candidates.length)
      throw lastError instanceof Error ? lastError : new Error('The link relay route is unavailable');
  }

  syncSnapshot(): Promise<number> {
    // Publish in build order, and always build after earlier callers finish:
    // coalescing can hand a policy writer an ACK for a pre-write projection.
    const sync = this.snapshotSync.then(() => this.syncSnapshotOnce());
    this.snapshotSync = sync.catch(() => undefined);
    return sync;
  }

  private async syncSnapshotOnce(): Promise<number> {
    // A transient health RPC failure must not downgrade a pool-capable Relay
    // to the legacy snapshot shape. Doing so removes assignment generations
    // from the live policy and revokes otherwise healthy endpoint streams.
    // Absence of getHealth still identifies a genuinely legacy client.
    const health = this.relay.getHealth ? await this.relay.getHealth() : null;
    if (health?.poolId === 'system' && health.capabilities?.includes('relay_pool_v1')) {
      const [local] = await this.db
        .select({
          id: relayInstances.id,
          buildVersion: relayInstances.buildVersion,
          protocolMajor: relayInstances.protocolMajor,
          capabilities: relayInstances.capabilities,
        })
        .from(relayInstances)
        .where(and(eq(relayInstances.poolId, 'system'), eq(relayInstances.kind, 'local')))
        .limit(1);
      if (!local || health.relayInstanceId !== local.id) {
        throw new Error('Local Relay Pool identity does not match persisted instance identity');
      }
      const liveFeatures = [...new Set(health.capabilities)].sort();
      const persistedFeatures = Array.isArray(local.capabilities?.features)
        ? [...local.capabilities.features].sort()
        : [];
      if (
        local.buildVersion !== health.buildVersion ||
        local.protocolMajor !== health.protocolMajor ||
        local.capabilities?.protocolMajor !== health.protocolMajor ||
        liveFeatures.length !== persistedFeatures.length ||
        liveFeatures.some((feature, index) => feature !== persistedFeatures[index])
      ) {
        await this.db
          .update(relayInstances)
          .set({
            buildVersion: health.buildVersion,
            protocolMajor: health.protocolMajor,
            capabilities: {
              ...local.capabilities,
              protocolMajor: health.protocolMajor,
              features: liveFeatures,
            },
            updatedAt: new Date(),
          })
          .where(eq(relayInstances.id, local.id));
      }
      const trustedKeyIds = await this.ensureLocalPolicyTrust(health);
      // The relay refuses a revision below the one it applied. After Gateway's database was
      // restored from a backup its sequence is behind; continue above the relay's instead.
      const revisionFloor = Number(health.appliedRevision || 0);
      // The live report says what the relay holds now; the stored one may predate a relay that lost its state
      // (relay.db renamed), which then waited for the next policy change (N-7).
      let signed = await this.buildInstanceSnapshot(local.id, trustedKeyIds, revisionFloor, {
        liveAppliedRevision: revisionFloor,
      });
      let response: { appliedRevision: string; unchanged: boolean };
      try {
        response = await this.applyLocalSnapshot(signed);
      } catch (error) {
        if (!isLocalPolicyLockout(error)) throw error;
        const trust = await this.policyKeys.getEnrollmentTrust();
        await this.recoverLocalPolicyTrust(trust, health, error);
        signed = await this.buildInstanceSnapshot(local.id, [trust.keyId], revisionFloor, {
          liveAppliedRevision: revisionFloor,
        });
        try {
          response = await this.applyLocalSnapshot(signed);
        } catch (retryError) {
          if (errorMessage(retryError).includes('snapshot gateway instance changed')) {
            // The reset took, but this relay build cannot rebind to this Gateway instance.
            this.setLocalPolicyTrust(
              'recovery_unsupported',
              LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE,
              health.policyKeyIds ?? []
            );
          }
          throw retryError;
        }
      }
      const applied = Number(response.appliedRevision);
      if (!Number.isSafeInteger(applied) || applied !== signed.revision) {
        throw new Error(`Relay acknowledged revision ${response.appliedRevision}, expected ${signed.revision}`);
      }
      // Pool snapshot sequence numbers include lease refreshes and are not the
      // global grant revision. Only acknowledge the projection actually sent.
      this.grantIssuer.acknowledgeRevision(signed.globalRevision);
      this.settleLocalPolicyTrust();
      // Beside the snapshot chain, never inside it: a remote relay that is busy (renewing,
      // updating) must not hold up every local sync, grant issue and tunnel open behind it.
      this.startRemotePush(signed.globalRevision);
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

  /** The local relay already holds an unchanged snapshot; applying it again would be a no-op. */
  private applyLocalSnapshot(signed: {
    encodedRequest: Buffer | null;
    revision: number;
  }): Promise<{ appliedRevision: string; unchanged: boolean }> {
    if (!signed.encodedRequest) return Promise.resolve({ appliedRevision: String(signed.revision), unchanged: true });
    return this.relay.applyEncodedSnapshot(signed.encodedRequest);
  }

  /**
   * Pins the active policy key on the local relay and returns the key ids it trusts, which
   * choose the signer of its next snapshot. The local relay refuses an unsigned new key once
   * it trusts any key. If it still trusts an old key whose private half Gateway retains, that
   * key signs a snapshot carrying the active one. If it trusts none that Gateway can sign
   * with, typically because relay.db was restored from a backup older than the active key,
   * the local-only reset re-pins the active key. Remote relays never take that path.
   */
  private async ensureLocalPolicyTrust(health: RelayHealthResponse): Promise<string[]> {
    const reportedKeyIds = health.policyKeyIds ?? [];
    const trust = await this.policyKeys.getEnrollmentTrust();
    try {
      await this.relay.bootstrapPolicyTrust(trust.keyId, trust.publicKey, trust.fingerprint);
      return [trust.keyId];
    } catch (error) {
      if (!isSignedRotationRefusal(error)) throw error;
      const plan = await this.policyKeys.resolveInstancePolicyKeys(
        { kind: 'local', policySigningKeyId: null, health: null },
        new Date(),
        reportedKeyIds
      );
      if (plan.signingKeyId !== trust.keyId) return reportedKeyIds;
      await this.recoverLocalPolicyTrust(trust, health, error);
      return [trust.keyId];
    }
  }

  /**
   * Re-pins the active key on the local relay after it refused Gateway's policy for a reason
   * only a reset repairs. Runs at most once per cooldown, is audited, and never touches a
   * remote relay: the relay itself accepts the call only in local combined mode. A relay
   * build without the call leaves an actionable status instead of a silent sync failure.
   */
  private async recoverLocalPolicyTrust(
    trust: RelayPolicyTrustAnchor,
    health: RelayHealthResponse,
    refusal: unknown
  ): Promise<void> {
    const trustedKeyIds = health.policyKeyIds ?? [];
    const reason = errorMessage(refusal);
    if (typeof this.relay.resetLocalPolicyTrust !== 'function') {
      this.setLocalPolicyTrust('recovery_unsupported', LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE, trustedKeyIds);
      throw refusal;
    }
    // Every relay build with the reset call advertises it, and only such a build can rebind to
    // another Gateway instance. Asking an older build starts no cooldown, so the relay is
    // recovered on the first sync after it is updated, well inside the update's health wait.
    if (!health.capabilities?.includes(LOCAL_POLICY_TRUST_RESET_CAPABILITY)) {
      this.setLocalPolicyTrust('recovery_unsupported', LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE, trustedKeyIds);
      throw new Error(`${LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE} Relay refusal: ${reason}`);
    }
    const now = Date.now();
    const nextAttemptAt = this.lastLocalPolicyTrustResetAt + LOCAL_POLICY_TRUST_RESET_COOLDOWN_MS;
    if (now < nextAttemptAt) {
      const current = this.localPolicyTrust;
      if (current?.state !== 'recovery_unsupported' && current?.state !== 'recovery_failed') {
        this.setLocalPolicyTrust(
          'locked_out',
          `The local relay still refuses Gateway policy after its trust was reset (${reason}). ` +
            `Gateway retries the reset after ${new Date(nextAttemptAt).toISOString()}.`,
          trustedKeyIds
        );
      }
      throw new Error(`Local relay refuses Gateway policy; trust reset retries after the cooldown: ${reason}`);
    }
    let replacedKeyIds: string[];
    try {
      ({ replacedKeyIds } = await this.relay.resetLocalPolicyTrust(trust.keyId, trust.publicKey, trust.fingerprint));
      this.lastLocalPolicyTrustResetAt = now;
    } catch (error) {
      const unimplemented = (error as { code?: number } | null)?.code === GrpcStatus.UNIMPLEMENTED;
      // The cooldown starts only once the relay answered and could reset: an unreachable relay or
      // one without the call was not reset.
      if (!isRelayUnavailable(error) && !unimplemented) this.lastLocalPolicyTrustResetAt = now;
      if (unimplemented) {
        this.setLocalPolicyTrust('recovery_unsupported', LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE, trustedKeyIds);
        logger.error('Local relay refuses Gateway policy and cannot reset its trust', { reason });
        throw new Error(`${LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE} Relay refusal: ${reason}`);
      }
      this.setLocalPolicyTrust(
        'recovery_failed',
        `Gateway could not reset the local relay's policy trust: ${errorMessage(error)}`,
        trustedKeyIds
      );
      throw error;
    }
    logger.warn('Local relay refused Gateway policy; re-pinned the active policy signing key', {
      activeKeyId: trust.keyId,
      replacedKeyIds,
      reason,
    });
    this.setLocalPolicyTrust(
      'recovered',
      `The local relay trusted no policy key Gateway could sign with (${reason}). Gateway re-pinned the active key.`,
      [trust.keyId]
    );
    await this.audit
      ?.log({
        userId: null,
        action: 'relay.policy_trust.reset',
        resourceType: 'relay_instance',
        resourceId: health.relayInstanceId || 'local',
        details: { activeKeyId: trust.keyId, replacedKeyIds, previouslyTrustedKeyIds: trustedKeyIds, reason },
      })
      .catch(() => undefined);
  }

  private setLocalPolicyTrust(state: RelayPolicyTrustState, message: string, trustedKeyIds: string[]): void {
    const changed = this.localPolicyTrust?.state !== state || this.localPolicyTrust?.message !== message;
    this.localPolicyTrust = { state, message, observedAt: new Date().toISOString(), trustedKeyIds };
    if (changed) this.events?.publish('system.relay.health.changed', { poolId: 'system', action: 'policy_trust' });
  }

  /** The local relay accepted a snapshot: an open problem is over; a recovery stays visible for a while. */
  private settleLocalPolicyTrust(): void {
    const current = this.localPolicyTrust;
    if (!current) return;
    if (
      current.state !== 'recovered' ||
      Date.now() - Date.parse(current.observedAt) > LOCAL_POLICY_TRUST_RECOVERED_VISIBLE_MS
    ) {
      this.localPolicyTrust = null;
      this.events?.publish('system.relay.health.changed', { poolId: 'system', action: 'policy_trust' });
    }
  }

  /** The local relay's policy trust problem, or its recent automatic recovery. */
  getLocalPolicyTrustStatus(): RelayPolicyTrustStatus | null {
    return this.localPolicyTrust ? { ...this.localPolicyTrust } : null;
  }

  /**
   * Policy trust status per relay for health surfaces. The local relay reports what automatic
   * recovery saw. A remote relay whose reported trust holds no key Gateway can still sign with
   * is locked out for good: only a re-enrollment repairs it.
   */
  async describePolicyTrust(
    instances: Array<{
      id: string;
      kind: string;
      health: { policySigningKeyIds?: string[] } | null;
      capabilities?: { features?: string[] } | null;
    }>
  ): Promise<Map<string, RelayPolicyTrustStatus>> {
    const result = new Map<string, RelayPolicyTrustStatus>();
    const reported = instances.map(({ health }) => health?.policySigningKeyIds ?? []);
    const signable = await this.policyKeys.assessReportedTrust(reported);
    const observedAt = new Date().toISOString();
    instances.forEach((instance, index) => {
      if (instance.kind === 'local') {
        const local = this.getLocalPolicyTrustStatus();
        if (local) result.set(instance.id, local);
        else if (signable[index] === false) {
          const canReset = instance.capabilities?.features?.includes(LOCAL_POLICY_TRUST_RESET_CAPABILITY) === true;
          result.set(instance.id, {
            state: canReset ? 'locked_out' : 'recovery_unsupported',
            message: canReset
              ? 'The local relay trusts no policy signing key Gateway can sign with. Gateway resets its trust automatically on the next policy sync.'
              : LOCAL_POLICY_TRUST_UNSUPPORTED_MESSAGE,
            observedAt,
            trustedKeyIds: reported[index] ?? [],
          });
        }
        return;
      }
      if (signable[index] === false) {
        result.set(instance.id, {
          state: 'reenrollment_required',
          message: remoteRelayReenrollmentMessage(),
          observedAt,
          trustedKeyIds: reported[index] ?? [],
        });
      }
    });
    return result;
  }

  /** Queues a push of this revision to remote relays; pushes run one after another. */
  private startRemotePush(revision: number): void {
    if (!this.dispatch || revision <= this.remotePushRevision) return;
    this.remotePushRevision = revision;
    this.remotePush = this.remotePush
      .then(() => this.pushChangedRemotePolicies(revision))
      .catch((error) => {
        logger.warn('Remote relay policy push failed', { revision, error: errorMessage(error) });
      });
  }

  /** Waits for queued remote pushes, but never longer than a short grace. */
  private async waitForRemotePush(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.remotePush,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REMOTE_POLICY_PUSH_GRACE_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /**
   * Delivers a changed policy to remote relays right after the local relay applied it, before
   * daemons receive grants naming those relays. Otherwise a new route, endpoint generation or
   * grant key reaches the daemons minutes before the remote relays that must verify it. Best
   * effort: a relay that misses this push gets the policy from the periodic lease refresh.
   */
  private async pushChangedRemotePolicies(globalRevision: number): Promise<void> {
    if (!this.dispatch) return;
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
    const now = Date.now();
    const stale = instances.flatMap(({ nodeId }) =>
      nodeId &&
      (this.remotePolicyRevisions.get(nodeId) ?? 0) < globalRevision &&
      now - (this.remotePolicyPushFailedAt.get(nodeId) ?? 0) >= REMOTE_POLICY_PUSH_RETRY_MS
        ? [nodeId]
        : []
    );
    if (!stale.length) return;
    const results = await Promise.allSettled(
      stale.map((nodeId) => this.syncRemoteInstancePolicy(nodeId, REMOTE_POLICY_PUSH_TIMEOUT_MS))
    );
    results.forEach((result, index) => {
      const nodeId = stale[index]!;
      if (result.status === 'fulfilled') {
        this.remotePolicyPushFailedAt.delete(nodeId);
        return;
      }
      if (isNodeNotConnectedError(result.reason)) {
        // A relay that is not connected gets its snapshot when it reconnects (forced push on connect). No cooldown:
        // it would also hold back the pushes of the changes made right after it reconnected, and daemons would
        // present grants the relay does not know yet ("grant does not match policy", B-18).
        logger.debug('Remote relay policy push waits for the relay to reconnect', { nodeId });
        return;
      }
      // An unresponsive relay must not slow every local sync; the lease refresh keeps trying.
      this.remotePolicyPushFailedAt.set(nodeId, Date.now());
      logger.warn('Remote relay policy push deferred to the next lease refresh', {
        nodeId,
        error: errorMessage(result.reason),
      });
    });
  }

  async reconcileAndSync(): Promise<number> {
    await backfillRelayNodeFingerprints(this.db);
    await reconcileManagedDatabaseRelayPolicy(this.db);
    await reconcileManagedStorageRelayPolicy(this.db);
    const orphanedNodeIds = await removeOrphanedRelayState(this.db);
    const revision = await this.syncSnapshot();
    await this.refreshAllNodeGrantsIfDue().then(
      () => {
        this.pendingGrantRefresh = null;
      },
      (error) => this.reportPendingGrantRefresh(error)
    );
    await this.withdrawOrphanedState(orphanedNodeIds);
    // Resumable streams only add to raw ones; their state never holds the policy back, and a pass that waits for
    // daemons to acknowledge does not hold up the caller (a drain, a placement) either.
    void this.streamResume.reconcile().catch((error) => {
      logger.warn('Resumable relay stream changes are retried at the next reconcile', { error: errorMessage(error) });
    });
    return revision;
  }

  /**
   * Removes relay endpoints and routes whose owner no longer exists (a Route deleted while its link was being
   * provisioned, or by an earlier release that left them behind) and withdraws them from the daemons they named.
   */
  async removeOrphanedState(): Promise<void> {
    const nodeIds = await removeOrphanedRelayState(this.db);
    if (nodeIds.length === 0) return;
    await this.syncSnapshot();
    await this.withdrawOrphanedState(nodeIds);
  }

  /**
   * A daemon left without any relay state is not among the nodes a grant refresh reaches, and one the refresh just
   * reached is skipped. A daemon that is offline gets its bundle when it reconnects.
   */
  private async withdrawOrphanedState(nodeIds: readonly string[]): Promise<void> {
    await Promise.allSettled(nodeIds.map((nodeId) => this.syncNodeGrants(nodeId, ROUTINE_GRANT_SYNC)));
  }

  /**
   * Every reconcile refreshes the daemons' grants, and every relay rebalance activation reconciles: while one daemon
   * is disconnected each of them failed the same way, and the rc.20 main stand logged this warning every 2 s (B-17).
   * The same pending refresh is reported once per interval; a different one, at once.
   */
  private reportPendingGrantRefresh(error: unknown, now = Date.now()): void {
    const message = error instanceof Error ? error.message : String(error);
    const last = this.pendingGrantRefresh;
    if (last?.message === message && now - last.reportedAt < PENDING_GRANT_REFRESH_REPORT_MS) {
      logger.debug('Relay policy reconciled but some daemon grant bundles remain pending', { error: message });
      return;
    }
    this.pendingGrantRefresh = { message, reportedAt: now };
    logger.warn('Relay policy reconciled but some daemon grant bundles remain pending', { error: message });
  }

  async rotateIfDue(now = new Date()): Promise<boolean> {
    const grantRotated = await this.grantKeys.rotateIfDue(
      now,
      () => this.syncSnapshot(),
      () => this.refreshAllNodeGrantsIfDue(true)
    );
    const pendingPolicyKey = await this.policyKeys.beginRotationIfDue(now);
    if (pendingPolicyKey) {
      // The local relay has to receive the pending key in a snapshot signed by the current
      // one, exactly like the remote relays, before that key can be promoted.
      await this.syncSnapshot();
      await this.syncAllRemoteInstancePolicies();
    }
    const policyChanged = await this.finalizePolicySigningKeyRotation(now);
    return grantRotated || Boolean(pendingPolicyKey) || policyChanged;
  }

  async finalizePolicySigningKeyRotation(now = new Date()): Promise<boolean> {
    const promoted = await this.policyKeys.promoteAcknowledgedPending(now);
    const retired = await this.policyKeys.retireExpiredVerificationKeys(now);
    await this.policyKeys.destroyUnneededPrivateKeys(now);
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

  async ensureManagedStorageEndpoint(clusterId: string, nodeId: string): Promise<string> {
    const [database] = await this.db
      .select({ nodeId: managedStorageClusters.nodeId, status: managedStorageClusters.status })
      .from(managedStorageClusters)
      .where(eq(managedStorageClusters.id, clusterId))
      .limit(1);
    if (!database || database.nodeId !== nodeId || !['creating', 'ready', 'updating'].includes(database.status)) {
      throw new Error('Managed storage relay endpoint is unavailable');
    }
    const node = await this.grantIssuer.requireNodeIdentity(nodeId);
    const endpoint = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(relayEndpoints)
        .where(and(eq(relayEndpoints.ownerKind, 'managed_storage'), eq(relayEndpoints.ownerId, clusterId)))
        .limit(1);
      if (!current) {
        const [created] = await tx
          .insert(relayEndpoints)
          .values({
            ownerKind: 'managed_storage',
            ownerId: clusterId,
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
    if (!endpoint.active) throw new Error('Managed storage relay endpoint is awaiting lifecycle reconciliation');
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
    const routeIds = await this.ensureInternalRegistryRoutes([bindingId], sourceNodeId, ownerKind);
    return routeIds.get(bindingId)!;
  }

  /**
   * The registry routes of one node's bindings, published and granted once for all of them. Per binding, a node with
   * a dozen HA repositories rebuilt the policy snapshot and resent its grants a dozen times on every 15-s token
   * refresh; its sync outlived the tokens it carried and blocked image preparation for minutes (stand rc20pre3, N-14).
   */
  async ensureInternalRegistryRoutes(
    bindingIds: readonly string[],
    sourceNodeId: string,
    ownerKind: RegistryRouteOwnerKind = 'registry_secure_link'
  ): Promise<Map<string, string>> {
    if (!(REGISTRY_ROUTE_OWNER_KINDS as readonly string[]).includes(ownerKind)) {
      throw new Error('Unsupported registry relay route owner kind');
    }
    const routeIds = new Map<string, string>();
    if (bindingIds.length === 0) return routeIds;
    const endpointId = await this.reconcileInternalRegistryEndpoint();
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
    for (const bindingId of new Set(bindingIds)) {
      routeIds.set(
        bindingId,
        await this.ensureRoute(ownerKind, bindingId, 'daemon', sourceNodeId, source.certificateFingerprint, endpointId)
      );
    }
    await this.syncSnapshot();
    await this.syncNodeGrants(sourceNodeId, ROUTINE_GRANT_SYNC);
    return routeIds;
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
    targetNodeId: string,
    managedDatabaseListener?: RelayManagedDatabaseListenerConfig,
    /** The connector egress of the link's node; undefined keeps the route's. */
    secureLinkEgress?: RelaySecureLinkEgressConfig | null
  ): Promise<string> {
    const endpointId = await this.ensureManagedDatabaseEndpoint(managedDatabaseId, targetNodeId);
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
    const routeId = await this.ensureRoute(
      'managed_database_binding',
      bindingId,
      'daemon',
      sourceNodeId,
      source.certificateFingerprint,
      endpointId,
      managedDatabaseListener,
      secureLinkEgress
    );
    await this.syncSnapshot();
    await Promise.all([
      this.syncNodeGrants(sourceNodeId, ROUTINE_GRANT_SYNC),
      this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC),
    ]);
    return routeId;
  }

  async adoptBindingRoute(
    placementBindingId: string,
    bindingId: string,
    managedDatabaseId: string,
    sourceNodeId: string,
    targetNodeId: string,
    managedDatabaseListener: RelayManagedDatabaseListenerConfig | undefined,
    /** The connector egress of the adopted route; undefined keeps the placement route's. */
    secureLinkEgress?: RelaySecureLinkEgressConfig | null
  ): Promise<string> {
    const endpointId = await this.ensureManagedDatabaseEndpoint(managedDatabaseId, targetNodeId);
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
    const adoptedRouteId = await this.db.transaction(async (tx) => {
      const [placementRoute] = await tx
        .select()
        .from(relayRoutes)
        .where(and(eq(relayRoutes.ownerKind, 'managed_database_binding'), eq(relayRoutes.ownerId, placementBindingId)))
        .limit(1);
      if (!placementRoute) return null;
      await tx
        .delete(relayRoutes)
        .where(and(eq(relayRoutes.ownerKind, 'managed_database_binding'), eq(relayRoutes.ownerId, bindingId)));
      // Only a changed source, target or listener address moves the generation. A new generation makes
      // the relay close the route's tunnels and the daemon replace its listener; a workload that stays
      // on the same node and network keeps its open connections while the route changes owner.
      const changed =
        placementRoute.sourceKind !== 'daemon' ||
        placementRoute.sourceId !== sourceNodeId ||
        placementRoute.sourceCertificateSha256 !== source.certificateFingerprint ||
        placementRoute.targetEndpointId !== endpointId ||
        routeTransportRestartRequired(
          {
            managedDatabaseListener: placementRoute.managedDatabaseListener ?? null,
            secureLinkEgress: placementRoute.secureLinkEgress ?? null,
          },
          {
            managedDatabaseListener: managedDatabaseListener ?? null,
            secureLinkEgress:
              secureLinkEgress === undefined ? (placementRoute.secureLinkEgress ?? null) : secureLinkEgress,
          }
        );
      await tx
        .update(relayRoutes)
        .set({
          ownerId: bindingId,
          sourceKind: 'daemon',
          sourceId: sourceNodeId,
          sourceCertificateSha256: source.certificateFingerprint,
          targetEndpointId: endpointId,
          managedDatabaseListener: managedDatabaseListener ?? null,
          ...(secureLinkEgress === undefined ? {} : { secureLinkEgress }),
          generation: changed ? placementRoute.generation + 1 : placementRoute.generation,
          updatedAt: new Date(),
        })
        .where(eq(relayRoutes.id, placementRoute.id));
      await bumpRelayPolicyRevision(tx);
      return placementRoute.id;
    });
    const routeId =
      adoptedRouteId ??
      (await this.ensureRoute(
        'managed_database_binding',
        bindingId,
        'daemon',
        sourceNodeId,
        source.certificateFingerprint,
        endpointId,
        managedDatabaseListener,
        secureLinkEgress
      ));
    await this.syncSnapshot();
    await Promise.all([
      this.syncNodeGrants(sourceNodeId, ROUTINE_GRANT_SYNC),
      this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC),
    ]);
    return routeId;
  }

  /** Whether relay policy already carries this Secure Link to the given target node (it may be serving now). */
  async hasProxySecureLinkEndpoint(linkId: string, targetNodeId: string): Promise<boolean> {
    const [endpoint] = await this.db
      .select({ id: relayEndpoints.id })
      .from(relayEndpoints)
      .where(
        and(
          eq(relayEndpoints.ownerKind, 'proxy_host_secure_link'),
          eq(relayEndpoints.ownerId, linkId),
          eq(relayEndpoints.subjectId, targetNodeId),
          eq(relayEndpoints.status, 'active')
        )
      )
      .limit(1);
    return Boolean(endpoint);
  }

  /**
   * The relay endpoint of a proxy Secure Link on its target node and one route per source nginx node. A route on an
   * ingress group has one source per member: every member gets its own route, connect grant and relay transports
   * for the same endpoint, and routes of sources that no longer serve the link are removed. One source keeps today's
   * behaviour: a changed source moves the existing route in place.
   */
  /** The Docker node a Route or Additional Secure Link reaches now: its relay endpoint's subject, if it has one. */
  async proxySecureLinkTargetNodeId(linkId: string): Promise<string | null> {
    const [endpoint] = await this.db
      .select({ subjectId: relayEndpoints.subjectId })
      .from(relayEndpoints)
      .where(
        and(
          eq(relayEndpoints.ownerKind, 'proxy_host_secure_link'),
          eq(relayEndpoints.ownerId, linkId),
          eq(relayEndpoints.subjectKind, 'daemon')
        )
      )
      .limit(1);
    return endpoint?.subjectId ?? null;
  }

  async ensureProxySecureLink(
    linkId: string,
    sourceNodeIds: string | readonly string[],
    targetNodeId: string
  ): Promise<string> {
    const target = await this.grantIssuer.requireNodeIdentity(targetNodeId);
    const { endpointId, formerTargetNodeId } = await this.db.transaction(async (tx) => {
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
        return { endpointId: created.id, formerTargetNodeId: null };
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
      return {
        endpointId: current.id,
        formerTargetNodeId: current.subjectId !== targetNodeId ? current.subjectId : null,
      };
    });
    // The routes first: whether the first assignment may leave the legacy shape depends on every daemon on the
    // path, its sources included.
    const { routeIds, removedSourceIds } = await this.ensureProxyLinkSourceRoutes(linkId, sourceNodeIds, endpointId);
    await this.ensureLegacyCompatibleAssignment(endpointId);
    await this.syncSnapshot();
    await Promise.all([
      this.syncProxyLinkSourceGrants(sourceNodeIds, removedSourceIds),
      this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC),
      // A link that moved to another node (its container or deployment migrated) leaves its former node without a
      // grant for it once the new node holds one. A former node that is offline gets its bundle when it reconnects.
      formerTargetNodeId
        ? this.syncNodeGrants(formerTargetNodeId, ROUTINE_GRANT_SYNC).catch((error) =>
            logger.warn('A moved Secure Link left grants on its former node until it reconnects', {
              linkId,
              nodeId: formerTargetNodeId,
              error: error instanceof Error ? error.message : String(error),
            })
          )
        : Promise.resolve(),
    ]);
    return routeIds[0]!;
  }

  async ensureManagedStorageProxySecureLink(
    linkId: string,
    clusterId: string,
    sourceNodeIds: string | readonly string[],
    targetNodeId: string
  ): Promise<string> {
    const endpointId = await this.ensureManagedStorageEndpoint(clusterId, targetNodeId);
    const { routeIds, removedSourceIds } = await this.ensureProxyLinkSourceRoutes(linkId, sourceNodeIds, endpointId);
    await this.syncSnapshot();
    await Promise.all([
      this.syncProxyLinkSourceGrants(sourceNodeIds, removedSourceIds),
      this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC),
    ]);
    return routeIds[0]!;
  }

  /**
   * The grants of a link's sources. A member of an ingress group that is not connected, and a former source that is
   * not, get their grant bundle in their reconnect sync: they must not fail the link's change on the members that are
   * online (IG-1). The one source of a single-node link fails as before.
   */
  private async syncProxyLinkSourceGrants(
    sourceNodeIds: string | readonly string[],
    removedSourceIds: readonly string[]
  ): Promise<void> {
    const sources = proxyLinkSources(sourceNodeIds);
    const group = sources.length > 1;
    await Promise.all(
      [...new Set([...sources, ...removedSourceIds])].map(async (nodeId) => {
        try {
          await this.syncNodeGrants(nodeId, ROUTINE_GRANT_SYNC);
        } catch (error) {
          if ((group || !sources.includes(nodeId)) && isNodeNotConnectedError(error)) {
            logger.debug('Relay grants of a Secure Link source wait for its reconnect', { nodeId });
            return;
          }
          throw error;
        }
      })
    );
  }

  /**
   * One `proxy_host_secure_link` route per source daemon for the link endpoint (relay_routes_proxy_link_source_unique).
   * Returns the route ids in source order and the sources whose routes were removed or moved away.
   */
  private async ensureProxyLinkSourceRoutes(
    linkId: string,
    sourceNodeIds: string | readonly string[],
    targetEndpointId: string
  ): Promise<{ routeIds: string[]; removedSourceIds: string[] }> {
    const sources = proxyLinkSources(sourceNodeIds);
    if (sources.length === 0) throw new Error('A proxy Secure Link needs at least one source nginx node');
    const identities = await Promise.all(sources.map((nodeId) => this.grantIssuer.requireNodeIdentity(nodeId)));
    return this.db.transaction(async (tx) => {
      const current = await tx
        .select()
        .from(relayRoutes)
        .where(and(eq(relayRoutes.ownerKind, 'proxy_host_secure_link'), eq(relayRoutes.ownerId, linkId)));
      let changed = false;
      const routeIds: string[] = [];
      const removedSourceIds: string[] = [];
      // A single-source link moving to another node keeps its route (and its runtime metrics) in place.
      const moveInPlace =
        sources.length === 1 && current.length === 1 && current[0]!.sourceId !== sources[0] ? current[0]! : null;
      for (const [index, sourceId] of sources.entries()) {
        const fingerprint = identities[index]!.certificateFingerprint;
        const existing =
          moveInPlace ?? current.find((route) => route.sourceKind === 'daemon' && route.sourceId === sourceId);
        if (!existing) {
          const [created] = await tx
            .insert(relayRoutes)
            .values({
              ownerKind: 'proxy_host_secure_link',
              ownerId: linkId,
              sourceKind: 'daemon',
              sourceId,
              sourceCertificateSha256: fingerprint,
              targetEndpointId,
              maxFrameBytes: RELAY_MAX_FRAME_BYTES,
            })
            .returning({ id: relayRoutes.id });
          routeIds.push(created.id);
          changed = true;
          continue;
        }
        if (
          existing.sourceKind !== 'daemon' ||
          existing.sourceId !== sourceId ||
          existing.sourceCertificateSha256 !== fingerprint ||
          existing.targetEndpointId !== targetEndpointId ||
          existing.managedDatabaseListener != null
        ) {
          if (existing.sourceKind === 'daemon' && existing.sourceId !== sourceId) {
            removedSourceIds.push(existing.sourceId);
          }
          await tx
            .update(relayRoutes)
            .set({
              sourceKind: 'daemon',
              sourceId,
              sourceCertificateSha256: fingerprint,
              targetEndpointId,
              managedDatabaseListener: null,
              generation: existing.generation + 1,
              updatedAt: new Date(),
            })
            .where(eq(relayRoutes.id, existing.id));
          changed = true;
        }
        routeIds.push(existing.id);
      }
      const stale = current.filter((route) => !routeIds.includes(route.id));
      if (stale.length > 0) {
        await tx.delete(relayRoutes).where(
          inArray(
            relayRoutes.id,
            stale.map((route) => route.id)
          )
        );
        for (const route of stale) if (route.sourceKind === 'daemon') removedSourceIds.push(route.sourceId);
        changed = true;
      }
      if (changed) await bumpRelayPolicyRevision(tx);
      return { routeIds, removedSourceIds };
    });
  }

  private async getOwnedRouteRuntime(ownerKind: string, ownerId: string): Promise<RelayRouteRuntime | null> {
    const [route] = await this.db
      .select({ id: relayRoutes.id })
      .from(relayRoutes)
      .where(and(eq(relayRoutes.ownerKind, ownerKind), eq(relayRoutes.ownerId, ownerId)))
      .limit(1);
    if (!route) return null;
    return relayRouteRuntime(await this.relay.getRouteRuntime(route.id));
  }

  async getProxyRouteRuntime(linkId: string): Promise<ProxyRouteRuntime | null> {
    const routes = await this.db
      .select({ id: relayRoutes.id })
      .from(relayRoutes)
      .where(and(eq(relayRoutes.ownerKind, 'proxy_host_secure_link'), eq(relayRoutes.ownerId, linkId)));
    if (routes.length <= 1) return this.getOwnedRouteRuntime('proxy_host_secure_link', linkId);
    // A route on an ingress group has one relay route per member: its runtime is their sum.
    const runtimes = await Promise.all(routes.map((route) => this.relay.getRouteRuntime(route.id)));
    return sumRouteRuntimes(runtimes);
  }

  async getManagedDatabaseBindingRouteRuntime(bindingId: string): Promise<RelayRouteRuntime | null> {
    const own = await this.managedLinkRoutes('managed_database_binding', [bindingId]);
    if (own.length) return this.managedLinkRuntime(own);
    // Availability serves the link through one route per placement and drops the link's own route.
    const placements = await this.db
      .select({ id: managedDatabaseBindingPlacements.id })
      .from(managedDatabaseBindingPlacements)
      .where(eq(managedDatabaseBindingPlacements.bindingId, bindingId));
    if (!placements.length) return null;
    const routes = await this.managedLinkRoutes(
      'managed_database_binding',
      placements.map(({ id }) => id)
    );
    return routes.length ? this.managedLinkRuntime(routes) : null;
  }

  async getManagedStorageBindingRouteRuntime(bindingId: string): Promise<RelayRouteRuntime | null> {
    // An Availability workload runs the link from every placement node, one route each: the runtime is their sum.
    const routes = await this.managedLinkRoutes('managed_storage_binding', [bindingId]);
    return routes.length ? this.managedLinkRuntime(routes) : null;
  }

  /**
   * Sets what the source daemon of one link route serves locally (its connector egress, and for a database link its
   * host listener) without dropping the route's tunnels while one of them keeps serving. Delivering the grants is the
   * caller's: the ACK of `syncNodeGrantBundle` reports the egress (egressStatuses).
   */
  setLinkRouteTransport(
    ownerKind: 'managed_storage_binding' | 'managed_database_binding' | 'container_link',
    ownerId: string,
    sourceNodeId: string,
    change: {
      secureLinkEgress?: RelaySecureLinkEgressConfig | null;
      managedDatabaseListener?: RelayManagedDatabaseListenerConfig | null;
    }
  ): Promise<{ routeId: string; generation: number } | null> {
    return this.linkRoutes.setRouteTransport(ownerKind, ownerId, sourceNodeId, change);
  }

  /** What one link route from a node serves locally now (listener, connector egress), or null without a route. */
  getLinkRouteTransport(
    ownerKind: 'managed_storage_binding' | 'managed_database_binding' | 'container_link',
    ownerId: string,
    sourceNodeId: string
  ) {
    return this.linkRoutes.getRouteTransport(ownerKind, ownerId, sourceNodeId);
  }

  /** The relay endpoint of a container link (or of one target placement) on its target node. */
  async ensureContainerLinkEndpoint(
    ownerId: string,
    targetNodeId: string
  ): Promise<{ endpointId: string; formerTargetNodeId: string | null }> {
    const result = await this.linkRoutes.ensureContainerLinkEndpoint(ownerId, targetNodeId);
    await this.syncSnapshot();
    await this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC);
    return result;
  }

  /** The route of a container link from one source node to the endpoint that serves it for that node. */
  ensureContainerLinkRoute(
    linkId: string,
    sourceNodeId: string,
    endpointOwnerId: string,
    secureLinkEgress: RelaySecureLinkEgressConfig
  ): Promise<{ routeId: string; generation: number; targetNodeId: string }> {
    return this.linkRoutes.ensureContainerLinkRoute(linkId, sourceNodeId, endpointOwnerId, secureLinkEgress);
  }

  revokeContainerLinkRoute(linkId: string, sourceNodeId: string): Promise<void> {
    return this.linkRoutes.revokeContainerLinkRoute(linkId, sourceNodeId);
  }

  /** A container link's relay counters: the sum of its routes (one per source node). */
  /**
   * A container link's runtime: its routes (one per consumer node) and what those nodes report about it, same-node
   * dials that never reach a relay included, as for managed database and storage links.
   */
  async getContainerLinkRouteRuntime(linkId: string): Promise<RelayRouteRuntime | null> {
    const routes = await this.linkRoutes.containerLinkRoutes(linkId);
    return routes.length ? this.managedLinkRuntime(routes) : null;
  }

  /** The source nodes a container link has routes from (its node and Availability placement nodes). */
  async containerLinkSourceNodeIds(linkId: string): Promise<string[]> {
    const routes = await this.linkRoutes.containerLinkRoutes(linkId);
    return routes.filter((route) => route.ownerKind === CONTAINER_LINK_OWNER_KIND).map((route) => route.sourceId);
  }

  private managedLinkRoutes(ownerKind: 'managed_database_binding' | 'managed_storage_binding', ownerIds: string[]) {
    return this.db
      .select({
        id: relayRoutes.id,
        ownerKind: relayRoutes.ownerKind,
        ownerId: relayRoutes.ownerId,
        sourceKind: relayRoutes.sourceKind,
        sourceId: relayRoutes.sourceId,
      })
      .from(relayRoutes)
      .where(and(eq(relayRoutes.ownerKind, ownerKind), inArray(relayRoutes.ownerId, ownerIds)));
  }

  /**
   * A managed link's runtime: its relay routes (one, or one per Availability placement) and what the nodes running
   * its workloads report. The node holds the link at its capacity whichever relay of the pool carries a connection,
   * so its count is the link's open connections; the local relay sees only its share.
   */
  private async managedLinkRuntime(
    routes: Array<{ id: string; ownerKind: string; ownerId: string; sourceKind: string; sourceId: string }>
  ): Promise<RelayRouteRuntime> {
    // A placement whose route the relay does not run yet (or any more) adds nothing.
    const results = await Promise.allSettled(routes.map((route) => this.relay.getRouteRuntime(route.id)));
    const runtimes = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    if (!runtimes.length) throw (results[0] as PromiseRejectedResult).reason;
    const relayRuntime = runtimes.length === 1 ? relayRouteRuntime(runtimes[0]!) : sumRouteRuntimes(runtimes);
    const now = Date.now();
    const reports = routes.map((route) => {
      if (route.sourceKind !== 'daemon' || !this.managedLinkReports) return null;
      const report = this.managedLinkReports.managedLinkReport(route.sourceId, route.ownerKind, route.ownerId);
      if (!report || now - report.reportedAt.getTime() > MANAGED_LINK_REPORT_FRESH_MS) {
        this.managedLinkReports.requestHealthReport(route.sourceId, MANAGED_LINK_REPORT_FRESH_MS);
      }
      return report;
    });
    return withManagedLinkConnections(relayRuntime, sumManagedLinkReports(reports));
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
    await this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC);
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
    const routeId =
      (await this.currentGatewayRoute(
        'managed_database_gateway',
        'managed_database',
        managedDatabaseId,
        database.nodeId,
        appCertificateFingerprint
      )) ?? (await this.ensureGatewayRoute(managedDatabaseId, database.nodeId, appCertificateFingerprint));
    return this.openGatewayRouteTunnel(routeId, appCertificateFingerprint);
  }

  /**
   * A tunnel from Gateway itself on its route. Resumable (RSv1) when the connect assignment carries stream_resume:
   * the stream then moves to another relay (or the same one back) on drain, GOAWAY or path failure, reissuing the
   * assignment for every new path. A target that turns out not to be resume-aware latches the route raw for a while.
   */
  private async openGatewayRouteTunnel(routeId: string, appCertificateFingerprint: string): Promise<Duplex> {
    const issue = () =>
      this.withAcknowledgedPolicy(() =>
        this.grantIssuer.issueGatewayConnectAssignment(routeId, appCertificateFingerprint)
      );
    const assignment = await issue();
    const resume = assignment.streamResume;
    if (resume && !this.relay.isResumeLegacy(routeId)) {
      let first: typeof assignment | null = assignment;
      const dial = async (avoidRelayId: string | null) => {
        const current = first ?? (await issue());
        first = null;
        const path = await this.openGatewayResumePath(current, avoidRelayId);
        const key = current.streamResume;
        return key ? { path, keyId: key.keyId, key: Buffer.from(key.key) } : { path };
      };
      try {
        return await this.relay.openResumableTunnel(
          {
            routeId,
            keyId: resume.keyId,
            key: Buffer.from(resume.key),
            halfCloseTimeoutMs: resume.halfCloseTimeoutMs ?? 0,
          },
          dial
        );
      } catch (error) {
        if (!(error instanceof ResumeSessionError && error.code === 'legacy_peer')) throw error;
        logger.warn('Gateway relay route target is not resume-aware; using raw streams', { routeId });
      }
    }
    const activeCandidates = assignment.candidates.filter(({ assignmentState }) => assignmentState === 'active');
    let lastError: unknown;
    for (const candidate of activeCandidates) {
      try {
        return this.relay.trackLegacyTunnel(
          candidate.local
            ? await this.relay.openTunnel(candidate.grant)
            : await this.relay.openCandidateTunnel(candidate),
          candidate.relayInstanceId
        );
      } catch (error) {
        lastError = error;
      }
    }
    if (!activeCandidates.length) return this.relay.trackLegacyTunnel(await this.relay.openTunnel(assignment.grant));
    throw lastError instanceof Error ? lastError : new Error('Relay pool is unavailable');
  }

  /** One relay path of a resumable Gateway stream: the first active candidate that opens, avoiding a relay we leave. */
  private async openGatewayResumePath(
    assignment: Awaited<ReturnType<RelayGrantIssuerService['issueGatewayConnectAssignment']>>,
    avoidRelayId: string | null
  ): Promise<AttachablePath> {
    const activeCandidates = assignment.candidates.filter(({ assignmentState }) => assignmentState === 'active');
    if (!activeCandidates.length) {
      if (avoidRelayId === LEGACY_RELAY_PATH_ID) throw new Error('No other relay is available');
      return this.relay.openLocalResumePath(assignment.grant, LEGACY_RELAY_PATH_ID);
    }
    let lastError: unknown;
    for (const candidate of activeCandidates) {
      if (avoidRelayId && candidate.relayInstanceId === avoidRelayId) continue;
      try {
        return candidate.local
          ? await this.relay.openLocalResumePath(candidate.grant, candidate.relayInstanceId)
          : await this.relay.openCandidateResumePath(candidate);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('No other relay is available');
  }

  async probeGatewayRelayCandidate(
    routeId: string,
    appCertificateFingerprint: string,
    relayInstanceId: string,
    assignmentGeneration: string
  ): Promise<void> {
    const assignment = await this.withAcknowledgedPolicy(() =>
      this.grantIssuer.issueGatewayConnectAssignment(routeId, appCertificateFingerprint)
    );
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

  async ensureBackupRoute(
    runId: string,
    sourceNodeId: string,
    target: { kind: 'database' | 'storage'; id: string; nodeId: string },
    ownerKind: 'database_backup_source' | 'database_backup_restore' | 'storage_backup_target' | 'storage_backup_staging'
  ): Promise<string> {
    const endpointId =
      target.kind === 'database'
        ? await this.ensureManagedDatabaseEndpoint(target.id, target.nodeId)
        : await this.ensureManagedStorageEndpoint(target.id, target.nodeId);
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
    await this.ensureRoute(ownerKind, runId, 'daemon', sourceNodeId, source.certificateFingerprint, endpointId);
    await this.syncSnapshot();
    await this.syncNodeGrants(target.nodeId, ROUTINE_GRANT_SYNC);
    await this.syncNodeGrants(sourceNodeId, ROUTINE_GRANT_SYNC);
    // The daemon resolves an assignment by owner kind and this per-run owner ID.
    return runId;
  }

  async revokeBackupRoutes(runId: string): Promise<void> {
    for (const kind of [
      'database_backup_source',
      'database_backup_restore',
      'storage_backup_target',
      'storage_backup_staging',
    ] as const) {
      await this.revokeOwner(kind, runId);
    }
  }

  /**
   * The route of a storage link from one workload node (relay_routes_storage_link_source_unique). A link has one route
   * per node that runs its workload: its own node, and every placement node while Availability runs the workload. All
   * of them lead to the link's cluster, so pointing the link at another cluster takes every route along. Returns the
   * route of `sourceNodeId`.
   */
  async ensureStorageBindingRoute(
    bindingId: string,
    clusterId: string,
    sourceNodeId: string,
    targetNodeId: string
  ): Promise<string> {
    const endpointId = await this.ensureManagedStorageEndpoint(clusterId, targetNodeId);
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
    const { routeId, retargetedSourceIds } = await this.db.transaction(async (tx) => {
      const routes = await tx
        .select()
        .from(relayRoutes)
        .where(and(eq(relayRoutes.ownerKind, 'managed_storage_binding'), eq(relayRoutes.ownerId, bindingId)));
      let changed = false;
      let routeId: string;
      const own = routes.find((route) => route.sourceKind === 'daemon' && route.sourceId === sourceNodeId);
      if (!own) {
        const [created] = await tx
          .insert(relayRoutes)
          .values({
            ownerKind: 'managed_storage_binding',
            ownerId: bindingId,
            sourceKind: 'daemon',
            sourceId: sourceNodeId,
            sourceCertificateSha256: source.certificateFingerprint,
            targetEndpointId: endpointId,
            maxFrameBytes: RELAY_MAX_FRAME_BYTES,
          })
          .returning({ id: relayRoutes.id });
        routeId = created.id;
        changed = true;
      } else {
        routeId = own.id;
        if (own.sourceCertificateSha256 !== source.certificateFingerprint || own.targetEndpointId !== endpointId) {
          await tx
            .update(relayRoutes)
            .set({
              sourceCertificateSha256: source.certificateFingerprint,
              targetEndpointId: endpointId,
              generation: own.generation + 1,
              updatedAt: new Date(),
            })
            .where(eq(relayRoutes.id, own.id));
          changed = true;
        }
      }
      const retargetedSourceIds: string[] = [];
      for (const route of routes) {
        if (route.id === routeId || route.targetEndpointId === endpointId) continue;
        await tx
          .update(relayRoutes)
          .set({ targetEndpointId: endpointId, generation: route.generation + 1, updatedAt: new Date() })
          .where(eq(relayRoutes.id, route.id));
        if (route.sourceKind === 'daemon') retargetedSourceIds.push(route.sourceId);
        changed = true;
      }
      if (changed) await bumpRelayPolicyRevision(tx);
      return { routeId, retargetedSourceIds };
    });
    await this.syncSnapshot();
    await this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC);
    await this.syncNodeGrants(sourceNodeId, ROUTINE_GRANT_SYNC);
    for (const nodeId of new Set(retargetedSourceIds)) await this.syncNodeGrants(nodeId, ROUTINE_GRANT_SYNC);
    return routeId;
  }

  /** Removes the route of a storage link from one workload node, leaving its other routes in place. */
  async revokeStorageBindingRoute(bindingId: string, sourceNodeId: string): Promise<void> {
    const removed = await this.db.transaction(async (tx) => {
      const routes = await tx
        .delete(relayRoutes)
        .where(
          and(
            eq(relayRoutes.ownerKind, 'managed_storage_binding'),
            eq(relayRoutes.ownerId, bindingId),
            eq(relayRoutes.sourceKind, 'daemon'),
            eq(relayRoutes.sourceId, sourceNodeId)
          )
        )
        .returning({ id: relayRoutes.id });
      if (routes.length) await bumpRelayPolicyRevision(tx);
      return routes.length > 0;
    });
    if (!removed) return;
    await this.syncSnapshot();
    const affectedNodes = new Set([...(await this.grantIssuer.policyNodeIds()), sourceNodeId]);
    await Promise.allSettled([...affectedNodes].map((nodeId) => this.syncNodeGrants(nodeId)));
  }

  async ensureStorageGatewayRoute(
    clusterId: string,
    targetNodeId: string,
    appCertificateFingerprint: string
  ): Promise<string> {
    const endpointId = await this.ensureManagedStorageEndpoint(clusterId, targetNodeId);
    const state = await this.grantIssuer.requireState();
    const routeId = await this.ensureRoute(
      'managed_storage_gateway',
      clusterId,
      'gateway',
      state.gatewayInstanceId,
      appCertificateFingerprint,
      endpointId
    );
    await this.syncSnapshot();
    await this.syncNodeGrants(targetNodeId, ROUTINE_GRANT_SYNC);
    return routeId;
  }

  async openStorageGatewayTunnel(clusterId: string, appCertificateFingerprint: string) {
    const [database] = await this.db
      .select({ nodeId: managedStorageClusters.nodeId, status: managedStorageClusters.status })
      .from(managedStorageClusters)
      .where(eq(managedStorageClusters.id, clusterId))
      .limit(1);
    if (!database || (database.status !== 'ready' && database.status !== 'updating')) {
      throw new Error('Managed storage is unavailable');
    }
    const routeId =
      (await this.currentGatewayRoute(
        'managed_storage_gateway',
        'managed_storage',
        clusterId,
        database.nodeId,
        appCertificateFingerprint
      )) ?? (await this.ensureStorageGatewayRoute(clusterId, database.nodeId, appCertificateFingerprint));
    return this.openGatewayRouteTunnel(routeId, appCertificateFingerprint);
  }

  async revokeOwner(
    ownerKind:
      | 'database_backup_source'
      | 'database_backup_restore'
      | 'storage_backup_target'
      | 'storage_backup_staging'
      | 'managed_storage'
      | 'managed_storage_binding'
      | 'managed_storage_gateway'
      | 'managed_database_binding'
      | 'managed_database_gateway'
      | 'managed_database'
      | 'proxy_host_secure_link'
      | 'container_link'
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
      ownerKind === 'managed_database' ||
      ownerKind === 'managed_storage' ||
      ownerKind === 'proxy_host_secure_link' ||
      ownerKind === 'container_link' ||
      ownerKind === 'internal_registry'
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
        ownerKind === 'managed_database' ||
        ownerKind === 'managed_storage' ||
        ownerKind === 'proxy_host_secure_link' ||
        ownerKind === 'container_link' ||
        ownerKind === 'internal_registry'
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
    this.lastNodeGrantBundles.delete(nodeId);
    this.deliveredGrantBundles.delete(nodeId);
    const epoch = this.nodeGrantEpochs.get(nodeId);
    if (epoch) epoch.valid = false;
    this.nodeGrantEpochs.delete(nodeId);
    await this.syncSnapshot();
    await Promise.allSettled(
      affectedRoutes
        .filter(({ sourceKind }) => sourceKind === 'daemon')
        .map(({ nodeId: affectedNodeId }) => this.syncNodeGrants(affectedNodeId))
    );
  }

  /**
   * Delivers the node's grant bundle; resolves with the daemon's ACK, sent once the bundle is applied. A daemon applies
   * grant syncs off its command loop, so a command sent before this ACK may run before the grants: a caller whose next
   * command depends on them (a probe, registry bindings, an egress wait) awaits this first.
   */
  async syncNodeGrantBundle(nodeId: string, options: RelayGrantSyncOptions = {}) {
    if (!this.dispatch) throw new Error('Relay node dispatch is not configured');
    const epoch = this.nodeGrantEpochs.get(nodeId) ?? { valid: true, pending: 0 };
    epoch.pending += 1;
    this.nodeGrantEpochs.set(nodeId, epoch);
    const previous = this.nodeGrantSyncs.get(nodeId) ?? Promise.resolve(undefined);
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        if (!epoch.valid) {
          return {
            commandId: '',
            success: false,
            error: 'Relay grant sync was revoked',
            detail: '',
            data: Buffer.alloc(0),
          };
        }
        // A bundle the daemon holds already depends on no new policy: skip it before waiting for remote pushes,
        // which with a busy pool cost every routine sync the whole grace (stand rc20pre3, N-14).
        if (options.skipUnchanged) {
          const unchanged = await this.getNodeGrantBundle(nodeId);
          if (await this.deliveredRecently(nodeId, relayGrantBundleFingerprint(unchanged))) {
            return { commandId: '', success: true, error: '', detail: 'unchanged', data: Buffer.alloc(0) };
          }
        }
        // Give the remote relays a moment to take the policy these grants depend on.
        await this.waitForRemotePush();
        const bundle = await this.getNodeGrantBundle(nodeId);
        const fingerprint = relayGrantBundleFingerprint(bundle);
        if (options.skipUnchanged && (await this.deliveredRecently(nodeId, fingerprint))) {
          return { commandId: '', success: true, error: '', detail: 'unchanged', data: Buffer.alloc(0) };
        }
        if (!epoch.valid) {
          return {
            commandId: '',
            success: false,
            error: 'Relay grant sync was revoked',
            detail: '',
            data: Buffer.alloc(0),
          };
        }
        const result = await this.dispatch!.sendRelayGrantBundle(nodeId, bundle);
        // Queue ownership is not write validity: A's acknowledged bundle stays
        // authoritative even when B is queued and subsequently fails.
        if (result.success && epoch.valid) {
          this.lastNodeGrantBundles.set(nodeId, bundle);
          this.deliveredGrantBundles.set(nodeId, { fingerprint, at: Date.now() });
        }
        return result;
      });
    this.nodeGrantSyncs.set(nodeId, current);
    try {
      return await current;
    } finally {
      if (this.nodeGrantSyncs.get(nodeId) === current) this.nodeGrantSyncs.delete(nodeId);
      epoch.pending -= 1;
      if (epoch.pending === 0 && this.nodeGrantEpochs.get(nodeId) === epoch) this.nodeGrantEpochs.delete(nodeId);
    }
  }

  async syncNodeGrants(nodeId: string, options: RelayGrantSyncOptions = {}): Promise<void> {
    if (!this.dispatch) return;
    let result = await this.syncNodeGrantBundle(nodeId, options);
    if (!result.success && (await this.raiseRevisionAboveDaemon(nodeId, result.error))) {
      result = await this.syncNodeGrantBundle(nodeId, options);
    }
    if (result.success) this.staleGrantRefusals.delete(nodeId);
    if (!result.success) throw new Error(result.error || `Daemon ${nodeId} rejected relay grants`);
  }

  /**
   * Whether the daemon got a bundle allowing exactly the same within the grant refresh interval.
   * Its grants are then still fresh, and a resend only makes it re-apply and re-renew everything.
   */
  private async deliveredRecently(nodeId: string, fingerprint: string): Promise<boolean> {
    const delivered = this.deliveredGrantBundles.get(nodeId);
    if (delivered?.fingerprint !== fingerprint) return false;
    const intervalMs = ((await this.settings.getConfig()).relayGrantTtlHours * 60 * 60 * 1000) / 4;
    return Date.now() - delivered.at < intervalMs;
  }

  /**
   * A daemon refuses a grant bundle older than the one it holds. That happens after Gateway's
   * database was restored from a backup: its revision sequence went back while daemons kept
   * newer bundles, and no grant could reach them until the sequence caught up. Continue the
   * sequence above the daemon's, then resend. Rate-limited, since every change bumps it anyway.
   */
  private async raiseRevisionAboveDaemon(nodeId: string, error: string | undefined): Promise<boolean> {
    const message = error ?? '';
    const olderRevision = message.match(/relay grant revision \d+ is older than (\d+)/);
    // This daemon names no revision. One such refusal is ordinary out-of-order delivery; only a
    // daemon that keeps refusing every bundle holds a sequence Gateway lost to a restore.
    const staleWithoutRevision = /stale relay grant bundle/.test(message);
    if (!olderRevision && !staleWithoutRevision) {
      this.staleGrantRefusals.delete(nodeId);
      return false;
    }
    const current = Number((await this.grantIssuer.requireState()).revision);
    let floor: number;
    if (olderRevision) {
      const held = Number(olderRevision[1]);
      // At or below Gateway's own revision this is an older bundle delivered late, not a restore.
      if (!Number.isSafeInteger(held) || held <= current) return false;
      floor = Math.min(held, current + MAX_REVISION_JUMP);
    } else {
      const refusals = (this.staleGrantRefusals.get(nodeId) ?? 0) + 1;
      this.staleGrantRefusals.set(nodeId, refusals);
      if (refusals < STALE_REFUSALS_BEFORE_RAISE) return false;
      floor = current + MAX_REVISION_JUMP;
    }
    const now = Date.now();
    if (now - this.lastRevisionRaiseAt < REVISION_RAISE_INTERVAL_MS) return false;
    if (!Number.isSafeInteger(floor) || floor > MAX_REVISION_FLOOR) return false;
    this.lastRevisionRaiseAt = now;
    this.staleGrantRefusals.delete(nodeId);
    await this.db
      .update(relayPolicyState)
      .set({ revision: sql`greatest(${relayPolicyState.revision} + 1, ${floor + 1})`, updatedAt: new Date() })
      .where(eq(relayPolicyState.id, 'current'));
    logger.warn('A daemon holds newer relay grants than Gateway; continued the policy revision above them', {
      nodeId,
      floor,
      refusal: message,
    });
    await this.syncSnapshot();
    return true;
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
      this.withAcknowledgedPolicy(() => this.grantIssuer.getNodeGrantBundle(nodeId)),
      this.settings.getConfig(),
    ]);
    return { ...bundle, dataLanes: config.relay.dataLanes, readChunkBytes: config.relay.readChunkBytes };
  }

  async issueGatewayConnectGrant(routeId: string, appCertificateFingerprint: string) {
    return this.withAcknowledgedPolicy(() =>
      this.grantIssuer.issueGatewayConnectGrant(routeId, appCertificateFingerprint)
    );
  }

  private async withAcknowledgedPolicy<T>(issue: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await issue();
      } catch (error) {
        if (!(error instanceof RelayPolicyNotAcknowledgedError) || attempt >= 2) throw error;
        try {
          await this.syncSnapshot();
        } catch (syncError) {
          if (!isRelayUnavailable(syncError)) throw syncError;
          // The local relay is down and sees no grants at all, while holding every grant back
          // would also stop the remote relays once their grants expire. Deliver the policy to
          // the remote relays first, then sign for it.
          logger.warn('Local relay is unavailable; issuing relay grants without its acknowledgement', {
            revision: error.revision,
            error: errorMessage(syncError),
          });
          this.startRemotePush(error.revision);
          await this.waitForRemotePush();
          this.grantIssuer.allowUnacknowledgedRevision(error.revision);
          return issue();
        }
      }
    }
  }

  /** Endpoints whose path includes a daemon without Relay Pool support. */
  poolIncapableEndpointIds(endpointIds: string[]): Promise<Set<string>> {
    return this.grantIssuer.poolIncapableEndpointIds(endpointIds);
  }

  /**
   * The Gateway route a tunnel can open through as it is: it names this Gateway and its
   * certificate, and targets the owner's active endpoint on the owner's node with that node's
   * current certificate and a live assignment. Opening a tunnel then only issues a grant,
   * instead of re-ensuring the endpoint and route, pushing policy twice and re-sending the
   * target daemon's whole grant bundle every time.
   */
  private async currentGatewayRoute(
    ownerKind: 'managed_database_gateway' | 'managed_storage_gateway',
    endpointOwnerKind: 'managed_database' | 'managed_storage',
    ownerId: string,
    nodeId: string,
    appCertificateFingerprint: string
  ): Promise<string | null> {
    const [route] = await this.db
      .select({
        id: relayRoutes.id,
        sourceKind: relayRoutes.sourceKind,
        sourceId: relayRoutes.sourceId,
        sourceCertificateSha256: relayRoutes.sourceCertificateSha256,
        targetEndpointId: relayRoutes.targetEndpointId,
      })
      .from(relayRoutes)
      .where(and(eq(relayRoutes.ownerKind, ownerKind), eq(relayRoutes.ownerId, ownerId)))
      .limit(1);
    if (!route || route.sourceKind !== 'gateway' || route.sourceCertificateSha256 !== appCertificateFingerprint) {
      return null;
    }
    const [endpoint] = await this.db
      .select({
        id: relayEndpoints.id,
        ownerKind: relayEndpoints.ownerKind,
        ownerId: relayEndpoints.ownerId,
        subjectId: relayEndpoints.subjectId,
        certificateSha256: relayEndpoints.certificateSha256,
        status: relayEndpoints.status,
      })
      .from(relayEndpoints)
      .where(eq(relayEndpoints.id, route.targetEndpointId))
      .limit(1);
    if (
      !endpoint ||
      endpoint.status !== 'active' ||
      endpoint.ownerKind !== endpointOwnerKind ||
      endpoint.ownerId !== ownerId ||
      endpoint.subjectId !== nodeId
    ) {
      return null;
    }
    const [state, node, [assigned]] = await Promise.all([
      this.grantIssuer.requireState(),
      this.grantIssuer.requireNodeIdentity(nodeId).catch(() => null),
      this.db
        .select({ id: relayEndpointAssignmentGenerations.id })
        .from(relayEndpointAssignmentGenerations)
        .where(
          and(
            eq(relayEndpointAssignmentGenerations.endpointId, endpoint.id),
            eq(relayEndpointAssignmentGenerations.state, 'active')
          )
        )
        .limit(1),
    ]);
    if (route.sourceId !== state.gatewayInstanceId || node?.certificateFingerprint !== endpoint.certificateSha256) {
      return null;
    }
    return assigned ? route.id : null;
  }

  private async ensureRoute(
    ownerKind: string,
    ownerId: string,
    sourceKind: string,
    sourceId: string,
    sourceCertificateSha256: string,
    targetEndpointId: string,
    managedDatabaseListener?: RelayManagedDatabaseListenerConfig,
    /** undefined keeps the route's connector egress. */
    secureLinkEgress?: RelaySecureLinkEgressConfig | null
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
            managedDatabaseListener,
            secureLinkEgress: secureLinkEgress ?? null,
          })
          .returning({ id: relayRoutes.id });
        await bumpRelayPolicyRevision(tx);
        return created.id;
      }
      const desiredEgress = secureLinkEgress === undefined ? (current.secureLinkEgress ?? null) : secureLinkEgress;
      const moved =
        current.sourceId !== sourceId ||
        current.sourceCertificateSha256 !== sourceCertificateSha256 ||
        current.targetEndpointId !== targetEndpointId ||
        routeTransportRestartRequired(
          {
            managedDatabaseListener: current.managedDatabaseListener ?? null,
            secureLinkEgress: current.secureLinkEgress ?? null,
          },
          { managedDatabaseListener: managedDatabaseListener ?? null, secureLinkEgress: desiredEgress }
        );
      if (
        moved ||
        !managedDatabaseListenerConfigsEqual(current.managedDatabaseListener, managedDatabaseListener) ||
        !secureLinkEgressEqual(current.secureLinkEgress, desiredEgress)
      ) {
        await tx
          .update(relayRoutes)
          .set({
            sourceKind,
            sourceId,
            sourceCertificateSha256,
            targetEndpointId,
            managedDatabaseListener: managedDatabaseListener ?? null,
            secureLinkEgress: desiredEgress,
            // Only the admitted workloads changed: the route keeps its tunnels (see managedDatabaseListenerRestartRequired).
            generation: moved ? current.generation + 1 : current.generation,
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

  /**
   * Gives an endpoint without an active assignment its first one. That is the local relay alone, the shape legacy
   * grants need, unless the pool planner places it right away: an Availability member whose path runs Relay Pool
   * daemons goes on every ready lease relay from its first generation (D7), so a takeover in its first minute already
   * reaches the successor through every relay. Other endpoints move off the local relay by a staged, probed
   * rebalance.
   */
  private async ensureLegacyCompatibleAssignment(endpointId: string): Promise<void> {
    const [known] = await this.db
      .select({ id: relayEndpointAssignmentGenerations.id })
      .from(relayEndpointAssignmentGenerations)
      .where(
        and(
          eq(relayEndpointAssignmentGenerations.endpointId, endpointId),
          eq(relayEndpointAssignmentGenerations.state, 'active')
        )
      )
      .limit(1);
    if (known) return;
    const planned = this.initialAssignmentPlanner
      ? await this.initialAssignmentPlanner(endpointId).catch((error) => {
          logger.warn('Relay placement of a new endpoint is unavailable; it starts on the local relay', {
            endpointId,
            error: errorMessage(error),
          });
          return null;
        })
      : null;
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
      if (planned?.length) {
        const [latest] = await tx
          .select({ generation: relayEndpointAssignmentGenerations.generation })
          .from(relayEndpointAssignmentGenerations)
          .where(eq(relayEndpointAssignmentGenerations.endpointId, endpointId))
          .orderBy(desc(relayEndpointAssignmentGenerations.generation))
          .limit(1);
        const generation = (latest?.generation ?? 0) + 1;
        const [placed] = await tx
          .insert(relayEndpointAssignmentGenerations)
          .values({
            endpointId,
            generation,
            state: 'active',
            desiredRedundancy: planned.length,
            activatedAt: new Date(),
          })
          .returning({ id: relayEndpointAssignmentGenerations.id });
        await tx.insert(relayEndpointAssignments).values(
          planned.map(({ relayInstanceId, role }) => ({
            assignmentGenerationId: placed.id,
            relayInstanceId,
            role,
            targetRegistrationState: 'ready' as const,
            targetRegisteredAt: new Date(),
          }))
        );
        await tx
          .update(relayEndpoints)
          .set({ activeAssignmentGeneration: generation, updatedAt: new Date() })
          .where(eq(relayEndpoints.id, endpointId));
        await bumpRelayPolicyRevision(tx);
        return;
      }
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

  private async buildInstanceSnapshot(
    instanceId: string,
    reportedPolicyKeyIds?: string[],
    appliedRevisionFloor = 0,
    /**
     * force: build and send even an unchanged snapshot. liveAppliedRevision: the revision the relay reported just
     * now; an unchanged snapshot is skipped only when the relay holds exactly it.
     */
    delivery: { force?: boolean; liveAppliedRevision?: number } = {}
  ): Promise<{
    /** Null when the relay already holds this content at `revision`: nothing to send. */
    encodedRequest: Buffer | null;
    revision: number;
    globalRevision: number;
    expiresAtUnix: number;
  }> {
    const generalSettings = await this.settings.getConfig();
    const relaySettings = generalSettings.relay;
    const issuedAt = new Date();
    const issuedAtUnix = Math.floor(issuedAt.getTime() / 1000);
    const projection = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${RELAY_POLICY_REVISION_LOCK}))`);
      // Writers bump this row in the same transaction as projection changes.
      // Holding SHARE until the projection is built prevents mixed revisions
      // under READ COMMITTED, while allowing writers to proceed during RPC I/O.
      const [state] = await tx
        .select()
        .from(relayPolicyState)
        .where(eq(relayPolicyState.id, 'current'))
        .limit(1)
        .for('share');
      const [[instance], grantKeys] = await Promise.all([
        tx.select().from(relayInstances).where(eq(relayInstances.id, instanceId)).limit(1),
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
      // A relay refuses any revision below the one it applied, and Gateway's own sequence can
      // fall behind it (a database restored from a backup). Continue above what the relay
      // reports, or has reported, so it is never locked out until the sequence catches up.
      // The floor comes from a relay's report; one report moves the sequence by a bounded jump.
      const reported = Math.min(
        MAX_REVISION_FLOOR,
        Math.max(
          Number.isSafeInteger(instance.appliedPolicyRevision) ? instance.appliedPolicyRevision : 0,
          Number.isSafeInteger(appliedRevisionFloor) ? appliedRevisionFloor : 0
        )
      );

      // An instance that has not reported policy_long_lease_v1 may still be running a relay build
      // that rejects any envelope lease over 15 minutes; keep it on the legacy lease until it upgrades.
      const instanceFeatures = Array.isArray(instance.capabilities?.features) ? instance.capabilities.features : [];
      const leaseSeconds = instanceFeatures.includes(LONG_POLICY_LEASE_CAPABILITY)
        ? generalSettings.relayPolicyLeaseHours * 60 * 60
        : LEGACY_RELAY_POLICY_LEASE_SECONDS;
      const expiresAtUnix = Math.floor((issuedAt.getTime() + leaseSeconds * 1000) / 1000);

      // Everything that decides the envelope content is read before its content key, so an
      // unchanged key means an unchanged envelope. These reads use their own connections and take
      // no locks. The relay's own trust decides the signer: a relay that missed a rotation gets its
      // snapshot signed by an old key it still trusts, and learns the active key from that snapshot.
      const policyKeys = await this.policyKeys.resolveInstancePolicyKeys(instance, issuedAt, reportedPolicyKeyIds);
      const lease = this.availabilityLeaseSource
        ? await this.availabilityLeaseSource().catch((error) => {
            // Relays keep the lease blocks they have; the next snapshot carries them again.
            logger.warn('Relay snapshot is built without availability lease blocks', { error: errorMessage(error) });
            return null;
          })
        : null;
      // Never fail open: without the lease gate ids the relay would admit a lease-mode placement like a legacy one.
      const leaseGate = this.availabilityLeaseGate ? await this.availabilityLeaseGate(endpoints, routes) : null;
      const content = relayPolicySnapshotContent({
        gatewayInstanceId: state.gatewayInstanceId,
        poolId: instance.poolId,
        relayInstanceId: instance.id,
        grantKeys,
        assignments: selectedAssignments,
        endpoints,
        routes,
        admission: relaySettings,
        policyKeys: policyKeys.keys,
        routePolicy: relayRoutePolicy,
        leaseGate,
        lease,
      });
      const key = relayPolicySnapshotKey(content, policyKeys.signingKeyId, leaseSeconds);
      const previous = await loadInstancePolicyState(tx, instance.id);
      // Syncs run on every policy touch; unchanged content must not spend a revision, or the relay
      // re-applies the same policy every few seconds. A lease past half its life is renewed.
      const held = delivery.liveAppliedRevision ?? reported;
      if (!delivery.force && holdsCurrentSnapshot(previous, key, held, issuedAtUnix, leaseSeconds)) {
        return {
          unchanged: true as const,
          state,
          revision: previous!.snapshotRevision!,
          expiresAtUnix: previous!.snapshotExpiresAtUnix!,
        };
      }
      const own = sql`greatest(${relayPools.desiredPolicyRevision}, ${state.revision})`;
      const [poolRevision] = await tx
        .update(relayPools)
        // Legacy snapshots use the global revision as their transport sequence.
        // Keep pool snapshots strictly newer when upgrading from that format.
        .set({
          desiredPolicyRevision: sql`greatest(${own}, least(${reported}, ${own} + ${MAX_REVISION_JUMP})) + 1`,
          updatedAt: issuedAt,
        })
        .where(eq(relayPools.id, instance.poolId))
        .returning({ revision: relayPools.desiredPolicyRevision });
      if (!poolRevision) throw new Error('Relay pool is unavailable');
      // Under the revision lock, so a revocation is always judged against the snapshots built.
      const endpointGenerations = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint.generation]));
      await recordBuiltSnapshot(
        tx,
        instance.id,
        previous,
        selectedAssignments.flatMap(({ endpointId }) =>
          routes.flatMap((route) => {
            const endpointGeneration = endpointGenerations.get(endpointId);
            return route.targetEndpointId !== endpointId || endpointGeneration === undefined
              ? []
              : [{ routeId: route.id, endpointId, routeGeneration: route.generation, endpointGeneration }];
          })
        ),
        { key, revision: poolRevision.revision, issuedAtUnix, expiresAtUnix }
      );
      return {
        unchanged: false as const,
        state,
        content,
        signingKeyId: policyKeys.signingKeyId,
        revision: poolRevision.revision,
        expiresAtUnix,
      };
    });
    if (projection.unchanged) {
      return {
        encodedRequest: null,
        revision: projection.revision,
        globalRevision: projection.state.revision,
        expiresAtUnix: projection.expiresAtUnix,
      };
    }
    const payload = encodeRelayV1Message('PolicyEnvelopePayload', {
      ...projection.content,
      revision: String(projection.revision),
      issuedAtUnix: String(issuedAtUnix),
      expiresAtUnix: String(projection.expiresAtUnix),
    });
    const signed = await this.policyKeys.signPayload(payload, projection.signingKeyId);
    return {
      encodedRequest: encodeRelayV1Message('ApplySnapshotRequest', {
        signedEnvelope: { signingKeyId: signed.signingKeyId, payload, signature: signed.signature },
      }),
      revision: projection.revision,
      globalRevision: projection.state.revision,
      expiresAtUnix: projection.expiresAtUnix,
    };
  }

  private async updateManagedDatabaseStatus(managedDatabaseId: string, databaseStatus: string): Promise<void> {
    const changed = await updateManagedDatabaseRelayStatus(this.db, managedDatabaseId, databaseStatus);
    if (!changed) return;
    await this.syncSnapshot();
    await this.refreshAllNodeGrantsIfDue(true).catch(() => undefined);
  }
}
