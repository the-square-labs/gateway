import { status as GrpcStatus } from '@grpc/grpc-js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
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
import type { RelayManagedDatabaseListenerConfig } from '@/db/schema/relay.js';
import {
  RELAY_MAX_FRAME_BYTES,
  type RelayControlClient,
  type RelayHealthResponse,
  type RelayPolicySnapshot,
} from '@/grpc/relay-control.client.js';
import { encodeRelayV1Message } from '@/grpc/relay-proto.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CryptoService } from './crypto.service.js';
import type { EventBusService } from './event-bus.service.js';
import type { NodeDispatchService } from './node-dispatch.service.js';
import {
  type RelayGrantBundle,
  RelayGrantIssuerService,
  RelayPolicyNotAcknowledgedError,
} from './relay-grant-issuer.service.js';
import { RelayGrantKeyService } from './relay-grant-key.service.js';
import {
  backfillRelayNodeFingerprints,
  bumpRelayPolicyRevision,
  reconcileManagedDatabaseRelayPolicy,
  updateManagedDatabaseRelayStatus,
} from './relay-policy-reconciler.js';
import {
  RELAY_POLICY_KEY_VALID_FROM_SKEW_MS,
  RelayPolicySigningKeyService,
  type RelayPolicyTrustAnchor,
} from './relay-policy-signing-key.service.js';
import { effectiveRelayMaxConcurrentSessions } from './relay-session-limits.js';

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
}

export type ProxyRouteRuntime = RelayRouteRuntime;

const logger = createChildLogger('RelayPolicyService');
const INTERNAL_REGISTRY_ID = 'gateway-internal-registry';
const INTERNAL_REGISTRY_CERTIFICATE_ID = 'local:gateway-internal-registry';
const REGISTRY_ROUTE_OWNER_KINDS = ['registry_secure_link', 'registry_ingress'] as const;
type RegistryRouteOwnerKind = (typeof REGISTRY_ROUTE_OWNER_KINDS)[number];

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
/** How long a grant dispatch waits for remote relays to take the policy it depends on. */
const REMOTE_POLICY_PUSH_GRACE_MS = 3_000;
const REVISION_RAISE_INTERVAL_MS = 5 * 60 * 1000;
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
    'sendRelayGrantBundle' | 'sendRelayPolicy' | 'setRelayDrain' | 'probeRelayCandidate'
  >;
  private lastGrantRefreshAt = 0;
  private lastGrantRefreshRevision = 0;
  private readonly grantIssuer: RelayGrantIssuerService;
  private readonly grantKeys: RelayGrantKeyService;
  private readonly policyKeys: RelayPolicySigningKeyService;
  private relaySettingsSync: Promise<void> = Promise.resolve();
  private snapshotSync: Promise<unknown> = Promise.resolve();
  private readonly nodeGrantSyncs = new Map<
    string,
    Promise<Awaited<ReturnType<NodeDispatchService['sendRelayGrantBundle']>>>
  >();
  private readonly lastNodeGrantBundles = new Map<string, RelayGrantBundle>();
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

  setAuditService(audit: Pick<AuditService, 'log'>): void {
    this.audit = audit;
  }

  setEventBus(events: EventBusService): void {
    this.events = events;
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

  syncRemoteInstancePolicy(nodeId: string, timeoutMs?: number): Promise<number> {
    // Build and deliver in order per relay: two concurrent pushes could otherwise arrive
    // newest first, and the relay would refuse the older one as a stale revision.
    const previous = this.remotePolicySyncs.get(nodeId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.syncRemoteInstancePolicyOnce(nodeId, timeoutMs));
    this.remotePolicySyncs.set(nodeId, current);
    const settle = () => {
      if (this.remotePolicySyncs.get(nodeId) === current) this.remotePolicySyncs.delete(nodeId);
    };
    current.then(settle, settle);
    return current;
  }

  private async syncRemoteInstancePolicyOnce(nodeId: string, timeoutMs?: number): Promise<number> {
    if (!this.dispatch) throw new Error('Relay node dispatch is not configured');
    const [instance] = await this.db
      .select({ id: relayInstances.id })
      .from(relayInstances)
      .where(and(eq(relayInstances.nodeId, nodeId), eq(relayInstances.kind, 'remote')))
      .limit(1);
    if (!instance) throw new Error('Remote relay instance is unavailable');
    const snapshot = await this.buildInstanceSnapshot(instance.id);
    const args = [nodeId, snapshot.encodedRequest, String(snapshot.revision), String(snapshot.expiresAtUnix)] as const;
    const result = timeoutMs
      ? await this.dispatch.sendRelayPolicy(...args, timeoutMs)
      : await this.dispatch.sendRelayPolicy(...args);
    if (!result.success) throw new Error(result.error || 'Remote relay rejected policy snapshot');
    this.remotePolicyRevisions.set(
      nodeId,
      Math.max(this.remotePolicyRevisions.get(nodeId) ?? 0, snapshot.globalRevision)
    );
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
      let signed = await this.buildInstanceSnapshot(local.id, trustedKeyIds, revisionFloor);
      let response: { appliedRevision: string; unchanged: boolean };
      try {
        response = await this.relay.applyEncodedSnapshot(signed.encodedRequest);
      } catch (error) {
        if (!isLocalPolicyLockout(error)) throw error;
        const trust = await this.policyKeys.getEnrollmentTrust();
        await this.recoverLocalPolicyTrust(trust, health, error);
        signed = await this.buildInstanceSnapshot(local.id, [trust.keyId], revisionFloor);
        try {
          response = await this.relay.applyEncodedSnapshot(signed.encodedRequest);
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
    targetNodeId: string,
    managedDatabaseListener?: RelayManagedDatabaseListenerConfig
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
      managedDatabaseListener
    );
    await this.syncSnapshot();
    await Promise.all([this.syncNodeGrants(sourceNodeId), this.syncNodeGrants(targetNodeId)]);
    return routeId;
  }

  async adoptBindingRoute(
    placementBindingId: string,
    bindingId: string,
    managedDatabaseId: string,
    sourceNodeId: string,
    targetNodeId: string,
    managedDatabaseListener: RelayManagedDatabaseListenerConfig
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
      await tx
        .update(relayRoutes)
        .set({
          ownerId: bindingId,
          sourceKind: 'daemon',
          sourceId: sourceNodeId,
          sourceCertificateSha256: source.certificateFingerprint,
          targetEndpointId: endpointId,
          managedDatabaseListener,
          generation: placementRoute.generation + 1,
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
        managedDatabaseListener
      ));
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

  async ensureManagedStorageProxySecureLink(
    linkId: string,
    clusterId: string,
    sourceNodeId: string,
    targetNodeId: string
  ): Promise<string> {
    const endpointId = await this.ensureManagedStorageEndpoint(clusterId, targetNodeId);
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
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

  private async getOwnedRouteRuntime(ownerKind: string, ownerId: string): Promise<RelayRouteRuntime | null> {
    const [route] = await this.db
      .select({ id: relayRoutes.id })
      .from(relayRoutes)
      .where(and(eq(relayRoutes.ownerKind, ownerKind), eq(relayRoutes.ownerId, ownerId)))
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

  async getProxyRouteRuntime(linkId: string): Promise<ProxyRouteRuntime | null> {
    return this.getOwnedRouteRuntime('proxy_host_secure_link', linkId);
  }

  async getManagedDatabaseBindingRouteRuntime(bindingId: string): Promise<RelayRouteRuntime | null> {
    return this.getOwnedRouteRuntime('managed_database_binding', bindingId);
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
    const routeId =
      (await this.currentGatewayRoute(
        'managed_database_gateway',
        'managed_database',
        managedDatabaseId,
        database.nodeId,
        appCertificateFingerprint
      )) ?? (await this.ensureGatewayRoute(managedDatabaseId, database.nodeId, appCertificateFingerprint));
    const assignment = await this.withAcknowledgedPolicy(() =>
      this.grantIssuer.issueGatewayConnectAssignment(routeId, appCertificateFingerprint)
    );
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
    await this.syncNodeGrants(target.nodeId);
    await this.syncNodeGrants(sourceNodeId);
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

  async ensureStorageBindingRoute(
    bindingId: string,
    clusterId: string,
    sourceNodeId: string,
    targetNodeId: string
  ): Promise<string> {
    const endpointId = await this.ensureManagedStorageEndpoint(clusterId, targetNodeId);
    const source = await this.grantIssuer.requireNodeIdentity(sourceNodeId);
    const routeId = await this.ensureRoute(
      'managed_storage_binding',
      bindingId,
      'daemon',
      sourceNodeId,
      source.certificateFingerprint,
      endpointId
    );
    await this.syncSnapshot();
    await this.syncNodeGrants(targetNodeId);
    await this.syncNodeGrants(sourceNodeId);
    return routeId;
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
    await this.syncNodeGrants(targetNodeId);
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
    const assignment = await this.withAcknowledgedPolicy(() =>
      this.grantIssuer.issueGatewayConnectAssignment(routeId, appCertificateFingerprint)
    );
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

  async syncNodeGrantBundle(nodeId: string) {
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
        // Give the remote relays a moment to take the policy these grants depend on.
        await this.waitForRemotePush();
        const bundle = await this.getNodeGrantBundle(nodeId);
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

  async syncNodeGrants(nodeId: string): Promise<void> {
    if (!this.dispatch) return;
    let result = await this.syncNodeGrantBundle(nodeId);
    if (!result.success && (await this.raiseRevisionAboveDaemon(nodeId, result.error))) {
      result = await this.syncNodeGrantBundle(nodeId);
    }
    if (result.success) this.staleGrantRefusals.delete(nodeId);
    if (!result.success) throw new Error(result.error || `Daemon ${nodeId} rejected relay grants`);
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
    managedDatabaseListener?: RelayManagedDatabaseListenerConfig
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
          })
          .returning({ id: relayRoutes.id });
        await bumpRelayPolicyRevision(tx);
        return created.id;
      }
      if (
        current.sourceId !== sourceId ||
        current.sourceCertificateSha256 !== sourceCertificateSha256 ||
        current.targetEndpointId !== targetEndpointId ||
        !managedDatabaseListenerConfigsEqual(current.managedDatabaseListener, managedDatabaseListener)
      ) {
        await tx
          .update(relayRoutes)
          .set({
            sourceKind,
            sourceId,
            sourceCertificateSha256,
            targetEndpointId,
            managedDatabaseListener: managedDatabaseListener ?? null,
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

  private async buildInstanceSnapshot(
    instanceId: string,
    reportedPolicyKeyIds?: string[],
    appliedRevisionFloor = 0
  ): Promise<{
    encodedRequest: Buffer;
    revision: number;
    globalRevision: number;
    expiresAtUnix: number;
  }> {
    const relaySettings = (await this.settings.getConfig()).relay;
    const issuedAt = new Date();
    const expiresAtUnix = Math.floor((issuedAt.getTime() + 15 * 60 * 1000) / 1000);
    const projection = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-remote-policy-revision'))`);
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
      return { instance, state, grantKeys, selectedAssignments, endpoints, routes, revision: poolRevision.revision };
    });

    // The relay's own trust decides the signer: a relay that missed a rotation gets its snapshot
    // signed by an old key it still trusts, and learns the active key from that snapshot.
    const policyKeys = await this.policyKeys.resolveInstancePolicyKeys(
      projection.instance,
      issuedAt,
      reportedPolicyKeyIds
    );
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
      policySigningKeys: policyKeys.keys.map((key) => ({
        keyId: key.keyId,
        publicKey: key.publicKey,
        publicKeyFingerprint: key.fingerprint,
        status: key.status === 'pending' ? 'active' : key.status,
        // Relays check validFrom against their own clock; start it early by the skew they allow.
        validFromUnix: String(
          key.activatedAt ? Math.floor((key.activatedAt.getTime() - RELAY_POLICY_KEY_VALID_FROM_SKEW_MS) / 1000) : 0
        ),
        verifyUntilUnix: String(key.verifyUntil ? Math.floor(key.verifyUntil.getTime() / 1000) : 0),
      })),
    });
    const signed = await this.policyKeys.signPayload(payload, policyKeys.signingKeyId);
    return {
      encodedRequest: encodeRelayV1Message('ApplySnapshotRequest', {
        signedEnvelope: { signingKeyId: signed.signingKeyId, payload, signature: signed.signature },
      }),
      revision: projection.revision,
      globalRevision: projection.state.revision,
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
