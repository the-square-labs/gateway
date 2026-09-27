import { randomInt } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type DockerAvailabilityLeaseMode,
  type DockerAvailabilityLeaseReason,
  dockerAvailabilityLeaseObservations,
  dockerAvailabilityLeaseState,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  proxyAdditionalSecureLinks,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import {
  decodeLeaseSignedBlock,
  encodeLeaseManifest,
  encodeLeaseSignedBlock,
  type LeaseManifestContent,
  type LeaseSigner,
  leaseManifestDigest,
  signLeaseBlock,
} from './lease-codec.js';
import { CLOSE_SETTLE_MS, GATE_WINDOW_MS } from './lease-constants.js';
import { evaluateLeaseGating } from './lease-gating.js';
import type { LeaseParticipants } from './lease-participants.js';
import {
  bootstrapAcknowledged,
  bootstrapFromHolders,
  bootstrapFromServing,
  type LeasePlanningPlacement,
  leaseCandidatePlacements,
  orderLeaseCandidates,
} from './lease-planning.js';
import type { LeaseClusterRow, LeaseMemberRow, LeaseStateRow } from './lease-store.js';
import { ensureLeaseState } from './lease-store.js';
import { holdsEveryMajority } from './lease-voters.js';

const logger = createChildLogger('AvailabilityLeasePolicies');

/** A policy that left lease mode waits this long before it may bootstrap again, so a flapping gate cannot thrash. */
const LEASE_REENTRY_HOLD_MS = 60_000;

/** A7/A16: shown while a switch from available to strict waits for the other copies and the relay gate window. */
const STRICT_SWITCH_PENDING: DockerAvailabilityLeaseReason = {
  code: 'strict_switch_pending',
  message:
    'Strict partition mode becomes active once every other copy has stopped and the relay gate window (24 s) has passed',
};

type PolicyRow = Pick<
  typeof dockerAvailabilityPolicies.$inferSelect,
  'id' | 'mode' | 'desiredReplicaCount' | 'partitionMode' | 'priorityMode' | 'nodePriority' | 'specFingerprint'
>;
type ObservationRow = typeof dockerAvailabilityLeaseObservations.$inferSelect;

export interface LeaseModeChange {
  policyId: string;
  from: DockerAvailabilityLeaseMode;
  to: DockerAvailabilityLeaseMode;
  reason: DockerAvailabilityLeaseReason | null;
  /** Legacy adopts these as its serving placements (A5): the last observed holder per slot. */
  lastHolders: Array<{ slot: number; holderId: string }>;
}

export interface LeasePoliciesOutcome {
  changed: boolean;
  modeChanges: LeaseModeChange[];
  /** Some policy needs the cluster voter config. */
  wanted: boolean;
}

export interface LeasePoliciesContext {
  participants: LeaseParticipants;
  members: Map<string, LeaseMemberRow>;
  cluster: LeaseClusterRow;
  clusterReady: boolean;
  capableVoters: number;
  totalVoters: number;
  controllerSupportsLease: boolean;
  now: Date;
}

/**
 * The last holder per slot; before any holder was observed, the reserved bootstrap holders, whose legacy copies kept
 * running while they tried to acquire (A5).
 */
function lastHolders(
  observations: ObservationRow[],
  bootstrap: Array<{ slot: number; holderId: string }>
): Array<{ slot: number; holderId: string }> {
  const observed = observations.flatMap((observation) => {
    const holderId = observation.holderId ?? observation.lastHolderId;
    return holderId ? [{ slot: observation.slot, holderId }] : [];
  });
  const slots = new Set(observed.map(({ slot }) => slot));
  return [...observed, ...bootstrap.filter((entry) => !slots.has(entry.slot))].sort((a, b) => a.slot - b.slot);
}

/** Per-policy lease mode (D10, A5, A7) and its signed manifest (D4). */
export class AvailabilityLeasePolicies {
  constructor(
    private readonly db: DrizzleClient,
    private readonly sign: LeaseSigner
  ) {}

  /** Whether any policy would use or already uses the lease, before the cluster config exists. */
  async wanted(): Promise<boolean> {
    const [policy] = await this.db
      .select({ id: dockerAvailabilityPolicies.id })
      .from(dockerAvailabilityPolicies)
      .where(inArray(dockerAvailabilityPolicies.mode, ['replicated', 'failover']))
      .limit(1);
    return Boolean(policy);
  }

  async reconcile(context: LeasePoliciesContext, onlyPolicyId?: string): Promise<LeasePoliciesOutcome> {
    const [policies, states] = await Promise.all([
      this.db
        .select({
          id: dockerAvailabilityPolicies.id,
          mode: dockerAvailabilityPolicies.mode,
          desiredReplicaCount: dockerAvailabilityPolicies.desiredReplicaCount,
          partitionMode: dockerAvailabilityPolicies.partitionMode,
          priorityMode: dockerAvailabilityPolicies.priorityMode,
          nodePriority: dockerAvailabilityPolicies.nodePriority,
          specFingerprint: dockerAvailabilityPolicies.specFingerprint,
        })
        .from(dockerAvailabilityPolicies)
        .where(onlyPolicyId ? eq(dockerAvailabilityPolicies.id, onlyPolicyId) : undefined),
      this.db
        .select()
        .from(dockerAvailabilityLeaseState)
        .where(onlyPolicyId ? eq(dockerAvailabilityLeaseState.policyId, onlyPolicyId) : undefined),
    ]);
    const stateByPolicy = new Map(states.map((state) => [state.policyId, state]));
    const relevant = policies.filter(
      (policy) => policy.mode !== 'single' || (stateByPolicy.get(policy.id)?.mode ?? 'legacy') !== 'legacy'
    );
    const outcome: LeasePoliciesOutcome = {
      changed: false,
      modeChanges: [],
      wanted: relevant.some((policy) => policy.mode !== 'single'),
    };
    if (relevant.length === 0) return outcome;
    const policyIds = relevant.map((policy) => policy.id);
    const [placements, observations] = await Promise.all([
      this.db
        .select({
          id: dockerAvailabilityPlacements.id,
          policyId: dockerAvailabilityPlacements.policyId,
          nodeId: dockerAvailabilityPlacements.nodeId,
          desiredState: dockerAvailabilityPlacements.desiredState,
          serving: dockerAvailabilityPlacements.serving,
          createdAt: dockerAvailabilityPlacements.createdAt,
        })
        .from(dockerAvailabilityPlacements)
        .where(inArray(dockerAvailabilityPlacements.policyId, policyIds)),
      this.db
        .select()
        .from(dockerAvailabilityLeaseObservations)
        .where(inArray(dockerAvailabilityLeaseObservations.policyId, policyIds)),
    ]);
    const placementIds = placements.map((placement) => placement.id);
    const ingressRows = placementIds.length
      ? await this.db
          .select({
            referenceId: proxyAdditionalSecureLinks.referenceId,
            nodeId: proxyAdditionalSecureLinks.sourceNodeId,
          })
          .from(proxyAdditionalSecureLinks)
          .where(
            and(
              eq(proxyAdditionalSecureLinks.purpose, 'availability_member'),
              inArray(proxyAdditionalSecureLinks.referenceId, placementIds)
            )
          )
      : [];
    const policyOfPlacement = new Map(placements.map((placement) => [placement.id, placement.policyId]));
    for (const policy of relevant) {
      try {
        const state = stateByPolicy.get(policy.id) ?? (await ensureLeaseState(this.db, policy.id));
        const policyPlacements = placements.filter((placement) => placement.policyId === policy.id);
        const ingressNodes = ingressRows
          .filter((row) => row.referenceId && policyOfPlacement.get(row.referenceId) === policy.id)
          .map((row) => row.nodeId);
        const result = await this.reconcilePolicy(
          policy,
          state,
          policyPlacements,
          ingressNodes,
          observations.filter((observation) => observation.policyId === policy.id),
          context
        );
        outcome.changed ||= result.changed;
        if (result.modeChange) outcome.modeChanges.push(result.modeChange);
      } catch (error) {
        logger.warn('Availability lease reconciliation of a policy failed; it will be retried', {
          policyId: policy.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcome;
  }

  private async reconcilePolicy(
    policy: PolicyRow,
    state: LeaseStateRow,
    placements: LeasePlanningPlacement[],
    ingressNodes: string[],
    observations: ObservationRow[],
    context: LeasePoliciesContext
  ): Promise<{ changed: boolean; modeChange: LeaseModeChange | null }> {
    const now = context.now;
    const candidateNodes = [...new Set(leaseCandidatePlacements(placements).map((placement) => placement.nodeId))];
    const gating = evaluateLeaseGating({
      controllerSupportsLease: context.controllerSupportsLease,
      legacyRequested: state.legacyRequested,
      policyMode: policy.mode,
      clusterReady: context.clusterReady && Boolean(context.cluster.signingKeyId),
      candidates: candidateNodes.map((nodeId) => ({
        nodeId,
        capable: context.participants.byId.get(nodeId)?.capable ?? false,
      })),
      ingress: [...new Set(ingressNodes)].map((nodeId) => ({
        nodeId,
        capable: context.participants.byId.get(nodeId)?.capable ?? false,
      })),
      capableVoters: context.capableVoters,
      totalVoters: context.totalVoters,
    });
    const slots = policy.mode === 'replicated' ? policy.desiredReplicaCount : 1;
    const observationBySlot = new Map(observations.map((observation) => [observation.slot, observation]));
    const updates: Partial<typeof dockerAvailabilityLeaseState.$inferInsert> = {};
    let next: DockerAvailabilityLeaseMode = state.mode;
    const plannedHandoffs = state.plannedHandoffs.filter((handoff) => Date.parse(handoff.expiresAt) > now.getTime());
    if (plannedHandoffs.length !== state.plannedHandoffs.length) updates.plannedHandoffs = plannedHandoffs;

    if (state.mode === 'legacy') {
      // Only a policy that already left lease mode waits; a policy that never ran one bootstraps right away.
      const settled =
        state.manifestVersion === 0 || now.getTime() - state.modeChangedAt.getTime() >= LEASE_REENTRY_HOLD_MS;
      if (gating.eligible && settled) {
        next = 'bootstrapping';
        updates.bootstrapId = randomInt(1, 2 ** 47);
        updates.bootstrap = bootstrapFromServing(placements, slots);
        updates.strictRequestedAt = null;
        updates.copiesStoppedAt = null;
        updates.closingStartedAt = null;
        updates.closingAckedAt = null;
      }
    } else if (state.mode !== 'closing' && !gating.eligible) {
      next = 'closing';
      updates.closingStartedAt = now;
      updates.closingAckedAt = null;
    } else if (
      state.mode === 'lease' &&
      state.publishedPartitionMode === 'available' &&
      policy.partitionMode === 'strict'
    ) {
      // A7: strict takes over like a bootstrap, with the holder observed now named for each slot.
      next = 'bootstrapping';
      updates.bootstrapId = randomInt(1, 2 ** 47);
      updates.bootstrap = bootstrapFromHolders(
        observations.map((observation) => ({ slot: observation.slot, holderId: observation.holderId })),
        slots
      );
      updates.strictRequestedAt = now;
      updates.copiesStoppedAt = null;
    } else if (state.mode === 'bootstrapping') {
      // A5/A7/A16: the reserved holders hold, nobody else reports a running copy, and the relay gate window passed
      // since, so no relay still admits another copy. The entry stays in every manifest version until then.
      if (!bootstrapAcknowledged(state.bootstrap, observationBySlot)) {
        if (state.copiesStoppedAt) updates.copiesStoppedAt = null;
      } else if (!state.copiesStoppedAt) {
        updates.copiesStoppedAt = now;
      } else if (now.getTime() - state.copiesStoppedAt.getTime() >= GATE_WINDOW_MS) {
        next = 'lease';
        updates.bootstrap = [];
        updates.bootstrapId = 0;
        updates.strictRequestedAt = null;
        updates.copiesStoppedAt = null;
      }
    } else if (state.mode === 'closing') {
      const closedAckers = new Set(
        [...context.members.values()]
          .filter((member) => {
            const ack = member.manifestAcks[policy.id];
            return ack?.closed === true && ack.version >= state.manifestVersion;
          })
          .map((member) => member.memberId)
      );
      const holders = lastHolders(observations, state.bootstrap);
      // Without a known holder only the majority path is safe: someone may hold without the Gateway having seen it.
      const holdersAcked = holders.length > 0 && holders.every(({ holderId }) => closedAckers.has(holderId));
      let ackedAt = state.closingAckedAt;
      if (!ackedAt && holdsEveryMajority(context.cluster.quorumSets, closedAckers)) {
        ackedAt = now;
        updates.closingAckedAt = now;
      }
      if (holdersAcked || (ackedAt && now.getTime() - ackedAt.getTime() >= CLOSE_SETTLE_MS)) {
        next = 'legacy';
        updates.manifestBlock = null;
        updates.bootstrap = [];
        updates.bootstrapId = 0;
      }
    }

    if (next !== state.mode) {
      updates.mode = next;
      updates.modeChangedAt = now;
    }
    const strictRequestedAt =
      updates.strictRequestedAt !== undefined ? updates.strictRequestedAt : state.strictRequestedAt;
    const reason = !gating.eligible
      ? gating.reason
      : next === 'bootstrapping' && strictRequestedAt
        ? STRICT_SWITCH_PENDING
        : null;
    const reasonChanged = JSON.stringify(reason) !== JSON.stringify(state.reason ?? null);
    if (reasonChanged) updates.reason = reason;
    const merged: LeaseStateRow = { ...state, ...(updates as Partial<LeaseStateRow>) };
    let blockChanged = false;
    if (next !== 'legacy') {
      const published = await this.publishManifest(policy, merged, placements, slots, context);
      if (published) {
        Object.assign(updates, published);
        blockChanged = true;
      }
    }
    if (Object.keys(updates).length > 0) {
      await this.db
        .update(dockerAvailabilityLeaseState)
        .set({ ...updates, updatedAt: now })
        .where(eq(dockerAvailabilityLeaseState.policyId, policy.id));
    }
    const modeChange =
      next !== state.mode
        ? {
            policyId: policy.id,
            from: state.mode,
            to: next,
            reason,
            lastHolders: lastHolders(observations, state.bootstrap),
          }
        : null;
    if (modeChange) logger.info('Availability lease mode changes', { ...modeChange, lastHolders: undefined });
    return { changed: blockChanged || (next === 'legacy' && state.mode === 'closing'), modeChange };
  }

  private async publishManifest(
    policy: PolicyRow,
    state: LeaseStateRow,
    placements: LeasePlanningPlacement[],
    slots: number,
    context: LeasePoliciesContext
  ): Promise<Partial<typeof dockerAvailabilityLeaseState.$inferInsert> | null> {
    const signingKeyId = context.cluster.signingKeyId;
    if (!signingKeyId || context.cluster.epoch === 0) return null;
    const closed = state.mode === 'closing';
    const candidates = orderLeaseCandidates(policy, placements).flatMap((nodeId) => {
      const publicKey = context.participants.byId.get(nodeId)?.publicKey;
      return publicKey ? [{ id: nodeId, publicKey: Buffer.from(publicKey, 'base64') }] : [];
    });
    if (candidates.length === 0 && !closed) return null;
    const known = new Set(candidates.map((candidate) => candidate.id));
    const content: LeaseManifestContent = {
      policyId: policy.id,
      mode: policy.mode === 'replicated' ? 'replicated' : 'failover',
      partitionMode: policy.partitionMode,
      slots,
      candidates,
      specFingerprint: policy.specFingerprint,
      epoch: context.cluster.epoch,
      closed,
      bootstrapId: state.bootstrap.length > 0 ? state.bootstrapId : 0,
      // A bootstrap holder must be a candidate; one that is not stays unreserved (rank-based acquisition).
      bootstrap: state.bootstrap.filter((entry) => entry.slot < slots && known.has(entry.holderId)),
    };
    const digest = leaseManifestDigest(content);
    if (digest === state.manifestDigest && state.manifestBlock) {
      // A16: once voters trust a new policy key the current manifest is signed again with it, same payload.
      const current = decodeLeaseSignedBlock(Buffer.from(state.manifestBlock, 'base64'));
      if (current.signingKeyId === signingKeyId) return null;
      const resigned = await signLeaseBlock(current.kind, current.payload, signingKeyId, this.sign);
      return { manifestBlock: encodeLeaseSignedBlock(resigned).toString('base64') };
    }
    const manifestVersion = state.manifestVersion + 1;
    const block = await signLeaseBlock(
      'LEASE_BLOCK_KIND_MANIFEST',
      encodeLeaseManifest(content, manifestVersion),
      signingKeyId,
      this.sign
    );
    return {
      manifestVersion,
      manifestEpoch: context.cluster.epoch,
      manifestDigest: digest,
      manifestBlock: encodeLeaseSignedBlock(block).toString('base64'),
      publishedPartitionMode: policy.partitionMode,
    };
  }
}
