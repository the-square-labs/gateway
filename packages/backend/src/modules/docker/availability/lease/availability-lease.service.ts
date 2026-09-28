import { randomInt } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type DockerAvailabilityPartitionMode,
  dockerAvailabilityLeaseObservations,
  dockerAvailabilityLeaseState,
  dockerAvailabilityPolicies,
  relayInstances,
} from '@/db/schema/index.js';
import type { AvailabilityLeaseReport, CommandResult } from '@/grpc/generated/types.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type { RelayPolicySigningKeyService } from '@/services/relay-policy-signing-key.service.js';
import { AvailabilityLeaseCluster } from './lease-cluster.js';
import type { LeaseSigner } from './lease-codec.js';
import {
  AVAILABILITY_LEASE_CAPABILITY,
  MEMBER_REPORT_FRESH_MS,
  PLANNED_HANDOFF_TTL_MS,
  RELAY_CONNECTIONS_FRESH_MS,
} from './lease-constants.js';
import { AvailabilityLeaseDistribution, type RelayLeasePolicyFields } from './lease-distribution.js';
import { availabilityStandbyCount } from './lease-gating.js';
import { loadLeaseParticipants } from './lease-participants.js';
import { AvailabilityLeasePolicies, type LeaseModeChange } from './lease-policies.js';
import { type RelayLeaseOwner, type RelayLeasePolicyIds, relayLeasePolicyIds } from './lease-relay-gate.js';
import { AvailabilityLeaseReports, type LeaseHolderChangeNotice, type LeaseReportSender } from './lease-reports.js';
import {
  bumpLeaseRevision,
  ensureLeaseState,
  type LeaseStateRow,
  leaseReachableMemberIds,
  loadLeaseCluster,
  loadLeaseMembers,
  type RelayConnectedMembers,
} from './lease-store.js';
import type {
  DockerAvailabilityLeaseController,
  DockerAvailabilityLeaseHandoffInput,
  DockerAvailabilityLeaseView,
  DockerAvailabilityLeaseWitnessView,
} from './lease-types.js';
import { type LeaseWitnessWarning, leaseVoterMargin } from './lease-voters.js';
import { validateLeaseWitness } from './lease-witness.js';

const logger = createChildLogger('AvailabilityLeaseService');

function leaseWitnessView(state: LeaseStateRow | null): DockerAvailabilityLeaseWitnessView | null {
  if (!state) return null;
  const first = state.witnesses[0];
  return {
    memberId: first?.memberId ?? null,
    kind: first?.kind ?? null,
    auto: first?.auto ?? true,
    minRttMs: first?.minRttMs ?? null,
    warning: (state.witnessWarning as LeaseWitnessWarning | null) ?? null,
  };
}

/**
 * Host side of the Availability data-plane lease (OSS). It chooses voters and epochs, signs voter configs and
 * manifests with the relay policy key, delivers them, gates policies by capability, ingests lease reports and
 * audits autonomous transitions. The paid controller decides placements; it attaches here as the lease controller.
 */
export class AvailabilityLeaseService {
  private controller: DockerAvailabilityLeaseController | null = null;
  private relayPublisher: { publishAvailabilityLeaseChange(): Promise<void> } | null = null;
  private readonly cluster: AvailabilityLeaseCluster;
  private readonly policies: AvailabilityLeasePolicies;
  private readonly reports: AvailabilityLeaseReports;
  private readonly distribution: AvailabilityLeaseDistribution;
  private reconciling: Promise<void> | null = null;
  private rerun: Promise<void> | null = null;
  /** Members each relay last reported a live Coordinate stream from (voter reachability). */
  private readonly relayConnections = new Map<string, RelayConnectedMembers>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly registry: NodeRegistryService,
    private readonly audit: Pick<AuditService, 'log'>,
    private readonly events: Pick<EventBusService, 'publish'>,
    policyKeys: Pick<RelayPolicySigningKeyService, 'signPayload'>
  ) {
    const sign: LeaseSigner = (message, keyId) => policyKeys.signPayload(message, keyId);
    this.cluster = new AvailabilityLeaseCluster(db, sign);
    this.policies = new AvailabilityLeasePolicies(db, sign);
    this.reports = new AvailabilityLeaseReports(db);
    this.distribution = new AvailabilityLeaseDistribution(db, registry);
  }

  /** The paid Availability controller; without one every policy stays legacy. */
  attachController(controller: DockerAvailabilityLeaseController): void {
    this.controller = controller;
  }

  setRelayPublisher(publisher: { publishAvailabilityLeaseChange(): Promise<void> }): void {
    this.relayPublisher = publisher;
  }

  /** D7: the fixed standby count, min(2, candidates - slots). */
  standbyCount(candidateNodes: number, slots: number): number {
    return availabilityStandbyCount(candidateNodes, slots);
  }

  /**
   * Periodic and on-demand reconciliation. A caller that arrives while a run is in flight gets one follow-up run that
   * starts after it, so a change it just wrote is never judged by a run that read the state before.
   */
  reconcile(): Promise<void> {
    if (this.reconciling) {
      this.rerun ??= this.reconciling
        .catch(() => undefined)
        .then(() => {
          this.rerun = null;
          return this.reconcile();
        });
      return this.rerun;
    }
    this.reconciling = this.reconcileOnce().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  /** Re-evaluates the lease after the controller changed placements, candidates or the partition mode. */
  async republishPolicy(_policyId: string): Promise<void> {
    await this.reconcile();
  }

  private async reconcileOnce(): Promise<void> {
    const now = new Date();
    const members = new Map((await loadLeaseMembers(this.db)).map((member) => [member.memberId, member]));
    const participants = await loadLeaseParticipants(this.db, this.registry, members);
    const controllerSupportsLease = this.controller?.leaseModeSupported() === true;
    const cluster = await this.cluster.reconcile({ members });
    const outcome = await this.policies.reconcile({
      participants,
      members,
      cluster: cluster.cluster,
      controllerSupportsLease,
      now,
    });
    if (cluster.changed || outcome.changed) await bumpLeaseRevision(this.db);
    if (cluster.changed || outcome.changed) {
      void this.relayPublisher?.publishAvailabilityLeaseChange().catch((error) => {
        logger.warn('Relays will receive the availability lease change with the next policy refresh', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    await this.distribution.syncDaemons(members, now.getTime());
    for (const change of outcome.modeChanges) await this.notifyModeChange(change);
  }

  private async notifyModeChange(change: LeaseModeChange): Promise<void> {
    this.events.publish('docker.availability.changed', { policyId: change.policyId, action: `lease_${change.to}` });
    try {
      await this.controller?.leaseModeChanged(change);
    } catch (error) {
      logger.warn('The Availability controller did not take a lease mode change', {
        policyId: change.policyId,
        to: change.to,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Lease fields of every relay policy envelope (relay.v1 PolicyEnvelopePayload 40, 41). */
  relayPolicyFields(): Promise<RelayLeasePolicyFields> {
    return this.distribution.relayFields();
  }

  /** relay.v1 lease_policy_id of endpoints and routes gated by the relay's lease view (lease mode only). */
  relayLeasePolicyIds(endpoints: RelayLeaseOwner[], routes: RelayLeaseOwner[]): Promise<RelayLeasePolicyIds> {
    return relayLeasePolicyIds(this.db, endpoints, routes);
  }

  /** Policy keys whose private half must survive: the key that signs lease blocks (A14). */
  async retainedSigningKeyIds(): Promise<string[]> {
    const cluster = await loadLeaseCluster(this.db);
    return cluster?.signingKeyId ? [cluster.signingKeyId] : [];
  }

  /** A docker or nginx daemon's heartbeat lease section. */
  async ingestDaemonReport(nodeId: string, nodeType: string, report: AvailabilityLeaseReport): Promise<void> {
    if (nodeType !== 'docker' && nodeType !== 'nginx') return;
    await this.ingest({ memberId: nodeId, kind: nodeType, nodeId, relayInstanceId: null }, report);
  }

  /** A relay's acceptor and gate view, from its runtime status or local health. */
  async ingestRelayReport(relayInstanceId: string, report: AvailabilityLeaseReport): Promise<void> {
    const connected = report.connectedMemberIds;
    if (Array.isArray(connected)) {
      this.relayConnections.set(relayInstanceId, {
        relayId: relayInstanceId,
        memberIds: connected.filter((id) => typeof id === 'string' && id.length > 0),
        reportedAt: Date.now(),
      });
    }
    await this.ingest({ memberId: relayInstanceId, kind: 'relay', nodeId: null, relayInstanceId }, report);
  }

  private async ingest(sender: LeaseReportSender, report: AvailabilityLeaseReport): Promise<void> {
    const { notices, identityChanged } = await this.reports.ingest(sender, report);
    for (const notice of notices) await this.recordHolderChange(notice);
    // H3: a renewed identity key must reach every manifest that lists the member before its frames are dropped for
    // long; republish now instead of on the next interval.
    if (identityChanged) {
      void this.reconcile().catch((error) => {
        logger.warn('Availability lease manifests will pick up the renewed identity key on the next reconcile', {
          memberId: sender.memberId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private async recordHolderChange(notice: LeaseHolderChangeNotice): Promise<void> {
    if (notice.kind) {
      const takeoverAt = notice.holderSince ?? new Date();
      await this.audit.log({
        userId: null,
        action: `docker.availability.lease_${notice.kind}`,
        resourceType: 'docker_availability_policy',
        resourceId: notice.policyId,
        // N-5: the transition happened when the voters saw the new holder take over, which after an autonomous
        // failover while Gateway was down is well before Gateway learns about it.
        occurredAt: takeoverAt,
        details: {
          slot: notice.slot,
          fromNodeId: notice.from,
          toNodeId: notice.to,
          placementId: notice.placementId,
          ballot: notice.ballot,
          observedBy: notice.sourceId,
          source: notice.source,
          takeoverAt: takeoverAt.toISOString(),
          noticedAt: new Date().toISOString(),
        },
      });
      this.events.publish('docker.availability.changed', { policyId: notice.policyId, action: `lease_${notice.kind}` });
    }
    try {
      await this.controller?.leaseHolderChanged(notice);
    } catch (error) {
      logger.warn('The Availability controller did not take a lease holder change', {
        policyId: notice.policyId,
        slot: notice.slot,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Legacy policies are driven by the backend; every other lease mode is not (D9, A5). */
  async isReactive(policyId: string): Promise<boolean> {
    const [state] = await this.db
      .select({ mode: dockerAvailabilityLeaseState.mode })
      .from(dockerAvailabilityLeaseState)
      .where(eq(dockerAvailabilityLeaseState.policyId, policyId))
      .limit(1);
    return (state?.mode ?? 'legacy') === 'legacy';
  }

  async getPolicyLease(policyId: string, now = new Date()): Promise<DockerAvailabilityLeaseView> {
    const [[state], observations, members, localRelays] = await Promise.all([
      this.db
        .select()
        .from(dockerAvailabilityLeaseState)
        .where(eq(dockerAvailabilityLeaseState.policyId, policyId))
        .limit(1),
      this.db
        .select()
        .from(dockerAvailabilityLeaseObservations)
        .where(eq(dockerAvailabilityLeaseObservations.policyId, policyId)),
      loadLeaseMembers(this.db),
      this.db.select({ id: relayInstances.id }).from(relayInstances).where(eq(relayInstances.kind, 'local')),
    ]);
    const reachable = leaseReachableMemberIds({
      members,
      connections: this.relayConnections.values(),
      localRelayIds: new Set(localRelays.map(({ id }) => id)),
      now: now.getTime(),
      memberFreshMs: MEMBER_REPORT_FRESH_MS,
      connectionFreshMs: RELAY_CONNECTIONS_FRESH_MS,
    });
    return {
      mode: state?.mode ?? 'legacy',
      reason: state?.reason ?? null,
      manifestVersion: state?.manifestVersion ?? 0,
      epoch: state?.voterEpoch ?? 0,
      publishedPartitionMode: state?.publishedPartitionMode ?? null,
      holders: observations
        .sort((left, right) => left.slot - right.slot)
        .map((observation) => ({
          slot: observation.slot,
          holderNodeId: observation.holderId,
          placementId: observation.placementId,
          ballot: observation.ballot,
          observedAt: observation.observedAt,
          holderSince: observation.holderSince,
          source: observation.source,
        })),
      bootstrap: (state?.bootstrap ?? []).map((entry) => ({ slot: entry.slot, holderNodeId: entry.holderId })),
      strictPending: state?.mode === 'bootstrapping' && state.strictRequestedAt !== null,
      surgeSlots: state?.surgeSlots ?? 0,
      copiesStoppedAt: state?.copiesStoppedAt ?? null,
      voterMargin: state ? leaseVoterMargin(state.voterEpoch, state.quorumSets, reachable) : null,
      voters: state?.quorumSets.at(-1) ?? [],
      witness: leaseWitnessView(state ?? null),
      witnesses: state?.witnesses ?? [],
    };
  }

  /**
   * Writes the partition mode (D11, A7) and republishes the manifest. The caller has already authorized the policy
   * mutation.
   */
  async setPartitionMode(policyId: string, partitionMode: DockerAvailabilityPartitionMode): Promise<void> {
    const updated = await this.db
      .update(dockerAvailabilityPolicies)
      .set({ partitionMode, updatedAt: new Date() })
      .where(eq(dockerAvailabilityPolicies.id, policyId))
      .returning({ id: dockerAvailabilityPolicies.id });
    if (updated.length === 0) throw new AppError(404, 'AVAILABILITY_NOT_FOUND', 'Availability policy not found');
    await this.republishPolicy(policyId);
  }

  /** A19: checks a configured witness before a policy is enabled or updated with it. */
  validateWitness(witness: string, scope: { policyId?: string; candidateNodeIds?: readonly string[] }): Promise<void> {
    return validateLeaseWitness(this.db, witness, scope);
  }

  /**
   * A19: sets the policy's witness (a relay instance id or a docker node id), or null for the automatic choice, and
   * republishes the manifest; a voter change runs through a joint epoch (A4). The caller authorized the mutation.
   */
  async setWitness(policyId: string, witness: string | null): Promise<void> {
    if (witness) await validateLeaseWitness(this.db, witness, { policyId });
    const updated = await this.db
      .update(dockerAvailabilityPolicies)
      .set({ witness, updatedAt: new Date() })
      .where(eq(dockerAvailabilityPolicies.id, policyId))
      .returning({ id: dockerAvailabilityPolicies.id });
    if (updated.length === 0) throw new AppError(404, 'AVAILABILITY_NOT_FOUND', 'Availability policy not found');
    await this.republishPolicy(policyId);
  }

  /**
   * Holds a policy on the legacy path (true) or releases it to the capability gate again (false). Holding it closes a
   * running lease first (A5): use it before operations that need the backend path, such as disabling Availability.
   */
  async setLegacyRequested(policyId: string, requested: boolean): Promise<void> {
    await ensureLeaseState(this.db, policyId);
    await this.db
      .update(dockerAvailabilityLeaseState)
      .set({ legacyRequested: requested, updatedAt: new Date() })
      .where(eq(dockerAvailabilityLeaseState.policyId, policyId));
    await this.republishPolicy(policyId);
  }

  /**
   * Replaces the bootstrap reservation of a policy that is still bootstrapping, with a new bootstrap_id (A5). Only for
   * the stuck state where a reserved holder died before it acquired and no holder was observed since.
   */
  async reissueBootstrap(policyId: string, bootstrap: Array<{ slot: number; holderNodeId: string }>): Promise<void> {
    const updated = await this.db
      .update(dockerAvailabilityLeaseState)
      .set({
        bootstrapId: randomInt(1, 2 ** 47),
        bootstrap: bootstrap.map((entry) => ({ slot: entry.slot, holderId: entry.holderNodeId })),
        copiesStoppedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(dockerAvailabilityLeaseState.policyId, policyId), eq(dockerAvailabilityLeaseState.mode, 'bootstrapping'))
      )
      .returning({ policyId: dockerAvailabilityLeaseState.policyId });
    if (updated.length === 0) {
      throw new AppError(
        409,
        'AVAILABILITY_LEASE_NOT_BOOTSTRAPPING',
        'The policy is not waiting for a bootstrap holder'
      );
    }
    await this.republishPolicy(policyId);
  }

  /**
   * D9: temporary extra lease slots for a replicated rollout (surge). The manifest then publishes
   * desiredReplicaCount + count slots under a new version; lowering the count removes the highest slots, whose
   * holders stop and release. Failover policies have exactly one slot and reject any surge.
   */
  async setSurgeSlots(policyId: string, count: number): Promise<void> {
    const [policy] = await this.db
      .select({
        mode: dockerAvailabilityPolicies.mode,
        desiredReplicaCount: dockerAvailabilityPolicies.desiredReplicaCount,
        rolloutPolicy: dockerAvailabilityPolicies.rolloutPolicy,
      })
      .from(dockerAvailabilityPolicies)
      .where(eq(dockerAvailabilityPolicies.id, policyId))
      .limit(1);
    if (!policy) throw new AppError(404, 'AVAILABILITY_NOT_FOUND', 'Availability policy not found');
    if (!Number.isInteger(count) || count < 0) {
      throw new AppError(400, 'AVAILABILITY_LEASE_SURGE_INVALID', 'Surge slots must be a non-negative integer');
    }
    if (count > 0 && policy.mode !== 'replicated') {
      throw new AppError(409, 'AVAILABILITY_LEASE_SURGE_UNSUPPORTED', 'Only replicated policies can surge lease slots');
    }
    if (count > policy.rolloutPolicy.maxSurge || policy.desiredReplicaCount + count > 32) {
      throw new AppError(
        400,
        'AVAILABILITY_LEASE_SURGE_INVALID',
        'Surge slots exceed the rollout policy maxSurge or the 32 slot limit'
      );
    }
    await ensureLeaseState(this.db, policyId);
    await this.db
      .update(dockerAvailabilityLeaseState)
      .set({ surgeSlots: count, updatedAt: new Date() })
      .where(eq(dockerAvailabilityLeaseState.policyId, policyId));
    await this.republishPolicy(policyId);
  }

  /** Marks the next holder change of a key as planned, so it is audited as a handoff (D9). */
  async registerPlannedHandoff(
    policyId: string,
    input: {
      slot: number;
      fromHolderId: string | null;
      toHolderId: string;
      operationId?: string | null;
      ttlMs?: number;
    }
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await ensureLeaseState(tx, policyId);
      const [state] = await tx
        .select({ plannedHandoffs: dockerAvailabilityLeaseState.plannedHandoffs })
        .from(dockerAvailabilityLeaseState)
        .where(eq(dockerAvailabilityLeaseState.policyId, policyId))
        .for('update');
      const now = Date.now();
      const kept = (state?.plannedHandoffs ?? []).filter(
        (handoff) => Date.parse(handoff.expiresAt) > now && handoff.slot !== input.slot
      );
      kept.push({
        slot: input.slot,
        fromHolderId: input.fromHolderId,
        toHolderId: input.toHolderId,
        operationId: input.operationId ?? null,
        expiresAt: new Date(now + (input.ttlMs ?? PLANNED_HANDOFF_TTL_MS)).toISOString(),
      });
      await tx
        .update(dockerAvailabilityLeaseState)
        .set({ plannedHandoffs: kept, updatedAt: new Date() })
        .where(eq(dockerAvailabilityLeaseState.policyId, policyId));
    });
  }

  /**
   * Planned handoff (D9, A6): asks the current holder of a key to release it to the successor. The holder checks the
   * successor is ready, stops its workload, deregisters and only then releases.
   */
  async requestHandoff(policyId: string, input: DockerAvailabilityLeaseHandoffInput): Promise<CommandResult> {
    const view = await this.getPolicyLease(policyId);
    if (view.mode !== 'lease') {
      throw new AppError(409, 'AVAILABILITY_LEASE_NOT_ACTIVE', 'Handoff needs the policy to run in lease mode');
    }
    const holder = view.holders.find((entry) => entry.slot === input.slot)?.holderNodeId ?? null;
    if (!holder) throw new AppError(409, 'AVAILABILITY_LEASE_NO_HOLDER', 'The lease has no current holder to hand off');
    if (!this.registry.hasCapability(holder, AVAILABILITY_LEASE_CAPABILITY)) {
      throw new AppError(503, 'AVAILABILITY_NODE_DISCONNECTED', 'Waiting for the lease holder to reconnect', {
        retryable: true,
      });
    }
    await this.registerPlannedHandoff(policyId, {
      slot: input.slot,
      fromHolderId: holder,
      toHolderId: input.successorNodeId,
      operationId: input.operationId ?? null,
    });
    return this.registry.sendCommand(
      holder,
      {
        availabilityLeaseHandoff: {
          policyId,
          slot: input.slot,
          successorId: input.successorNodeId,
          operationId: input.operationId ?? '',
          successorGeneration: String(input.successorGeneration),
          manifestVersion: String(view.manifestVersion),
        },
      },
      input.timeoutMs ?? 60_000
    );
  }
}
