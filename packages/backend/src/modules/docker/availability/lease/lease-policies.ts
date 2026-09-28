import { randomInt } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type DockerAvailabilityLeaseMode,
  type DockerAvailabilityLeaseReason,
  dockerAvailabilityLeaseObservations,
  dockerAvailabilityLeaseState,
  dockerAvailabilityOperations,
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
  type LeaseRetainedSlot,
  type LeaseSigner,
  leaseManifestCandidateIds,
  leaseManifestClosure,
  leaseManifestDigest,
  signLeaseBlock,
} from './lease-codec.js';
import {
  CLOSE_SETTLE_MS,
  GATE_WINDOW_MS,
  LEASE_IMPOSSIBLE_HYSTERESIS_MS,
  LEASE_TERM_MS,
  RETAINED_LEASE_ROLE,
} from './lease-constants.js';
import { evaluateLeaseGating } from './lease-gating.js';
import {
  type LeaseParticipants,
  leaseVoterCandidates,
  leaseWitnessPool,
  manifestCandidateAllowed,
} from './lease-participants.js';
import {
  bootstrapAcknowledged,
  bootstrapFromHolders,
  bootstrapFromServing,
  type LeasePlanningPlacement,
  leaseCandidatePlacements,
  orderLeaseCandidates,
} from './lease-planning.js';
import { loadPolicyRelays } from './lease-policy-relays.js';
import { planPolicyVoters } from './lease-policy-voters.js';
import type { LeaseClusterRow, LeaseMemberRow, LeaseStateRow } from './lease-store.js';
import { ensureLeaseState } from './lease-store.js';
import { holdsEveryMajority, type PolicyVoterSelection, selectPolicyVoters } from './lease-voters.js';

const logger = createChildLogger('AvailabilityLeasePolicies');

/** A policy that left lease mode waits this long before it may bootstrap again, so a flapping gate cannot thrash. */
const LEASE_REENTRY_HOLD_MS = 60_000;

/**
 * D1: operations that change the workload's runtime on the legacy path. Lease bootstrap waits until none of them is
 * pending, waiting or running: the switch never lands in the middle of one (stand run rc20 B-1: bootstrapping began 5 s
 * into an enable, reserved no holder because the origin was not recorded serving yet, and the daemons' lease gate
 * then refused the enable's own activation).
 */
const BOOTSTRAP_WAITS_FOR_OPERATIONS = ['enable', 'rollout'] as const;

/** A7/A16: shown while a switch from available to strict waits for the other copies and the relay gate window. */
const STRICT_SWITCH_PENDING: DockerAvailabilityLeaseReason = {
  code: 'strict_switch_pending',
  message:
    'Strict partition mode becomes active once every other copy has stopped and the relay gate window (24 s) has passed',
};

type PolicyRow = Pick<
  typeof dockerAvailabilityPolicies.$inferSelect,
  | 'id'
  | 'mode'
  | 'desiredReplicaCount'
  | 'partitionMode'
  | 'priorityMode'
  | 'nodePriority'
  | 'specFingerprint'
  | 'witness'
>;
type ObservationRow = typeof dockerAvailabilityLeaseObservations.$inferSelect;

export interface LeaseModeChange {
  policyId: string;
  from: DockerAvailabilityLeaseMode;
  to: DockerAvailabilityLeaseMode;
  reason: DockerAvailabilityLeaseReason | null;
  /** Legacy adopts these as its serving placements (A5): the last observed holder per slot. */
  lastHolders: Array<{ slot: number; holderId: string }>;
  /**
   * Graceful close (closing -> legacy): the slots whose holder reported itself retained under the closed manifest. Its
   * copy never stopped and runs on; legacy adopts it as RUNNING and never restarts it. Every other slot of lastHolders
   * expired (its holder fenced, or may have) and the legacy path starts it again. Empty for any other transition.
   */
  retainedHolders: Array<{ slot: number; holderId: string }>;
}

export interface LeasePoliciesOutcome {
  changed: boolean;
  modeChanges: LeaseModeChange[];
  /** Some policy uses or may use the lease. */
  wanted: boolean;
}

export interface LeasePoliciesContext {
  participants: LeaseParticipants;
  members: Map<string, LeaseMemberRow>;
  cluster: LeaseClusterRow;
  controllerSupportsLease: boolean;
  now: Date;
}

/** D3 exclusion of a candidate node; a node Gateway has no docker row for cannot be reached at all. */
function participantExclusion(participants: LeaseParticipants, nodeId: string) {
  const participant = participants.byId.get(nodeId);
  return participant ? participant.exclusion : ('offline' as const);
}

/** Since when lease mode has been impossible without a break, from the stored reason; now when it just became so. */
function impossibleSince(reason: DockerAvailabilityLeaseReason | null | undefined, now: Date): Date {
  const since = reason?.since ? Date.parse(reason.since) : Number.NaN;
  return Number.isFinite(since) && since <= now.getTime() ? new Date(since) : now;
}

/** Nodes that hold, run or are reserved for a slot right now: a per-node exclusion never cuts them (D3). */
function activeLeaseNodeIds(observations: ObservationRow[], state: LeaseStateRow): Set<string> {
  const ids = new Set<string>();
  for (const observation of observations) {
    if (observation.holderId) ids.add(observation.holderId);
    for (const claimant of Object.keys(observation.claimants ?? {})) ids.add(claimant);
  }
  if (state.mode === 'bootstrapping') for (const entry of state.bootstrap) ids.add(entry.holderId);
  return ids;
}

/**
 * Graceful close: the retained holders a new closed manifest names, one per slot: the committed holder Gateway sees
 * for the slot now (its ballot is the one it proposed with). Closing from bootstrapping also names each slot's
 * reserved holder Gateway saw no commit of, with an empty ballot: if its bootstrap commit raced the close the acceptors
 * confirm it on the commit they hold and its copy is retained instead of fenced; if it never committed nothing changes
 * (its legacy copy was never lease-bound). Any other unheld slot has none; its holder, if any, fences.
 */
function retainedFromObservations(
  observations: ObservationRow[],
  slots: number,
  bootstrap: Array<{ slot: number; holderId: string }> = []
): LeaseRetainedSlot[] {
  const committed = committedHolders(observations, slots);
  const named = new Set(committed.map((entry) => entry.slot));
  const reserved = bootstrap
    .filter((entry) => entry.slot < slots && !named.has(entry.slot))
    .map((entry) => ({ slot: entry.slot, holderId: entry.holderId, ballot: null }));
  return [...committed, ...reserved].sort((left, right) => left.slot - right.slot);
}

function committedHolders(observations: ObservationRow[], slots: number): LeaseRetainedSlot[] {
  return observations
    .filter(
      (observation) =>
        observation.slot < slots &&
        observation.holderId !== null &&
        observation.ballot !== null &&
        observation.ballot.proposerId === observation.holderId
    )
    .sort((left, right) => left.slot - right.slot)
    .map((observation) => ({
      slot: observation.slot,
      holderId: observation.holderId!,
      // Field order fixed (jsonb reorders keys): the manifest digest must not change from one reconcile to the next.
      ballot: {
        round: observation.ballot!.round,
        incarnation: observation.ballot!.incarnation,
        proposerId: observation.ballot!.proposerId,
      },
    }));
}

/**
 * A named holder's copy keeps running through the close: it reported itself retained (a majority of every quorum set
 * confirmed the close to it), or it is a reserved bootstrap holder named without a ballot that persisted the close,
 * does not hold the key and runs no lease role for it. A not-yet-acquired bootstrap holder drops its round on the
 * closed manifest and can no longer commit, and the close never touches its legacy copy; a bootstrap commit that raced
 * the close shows as a lease role (holding, then retained or fencing) in its reports first.
 */
export function keepsRunningThroughClose(
  entry: LeaseRetainedSlot,
  observation: Pick<ObservationRow, 'claimants' | 'holderId'> | undefined,
  closedAckers: ReadonlySet<string>
): boolean {
  if (reportsRetained(observation, entry.holderId)) return true;
  if (entry.ballot !== null) return false;
  const holds = observation?.holderId === entry.holderId;
  const leaseRole = Boolean(observation?.claimants?.[entry.holderId]);
  return !holds && !leaseRole && closedAckers.has(entry.holderId);
}

/** The named holder reported itself retained: a majority of every quorum set confirmed the close to it. */
export function reportsRetained(observation: Pick<ObservationRow, 'claimants'> | undefined, holderId: string): boolean {
  return observation?.claimants?.[holderId]?.role === RETAINED_LEASE_ROLE;
}

/** The observation without the slot's retained holder, whose copy legitimately keeps running. */
function withoutRetainedHolder(observation: ObservationRow, holderId: string | undefined): ObservationRow {
  if (!holderId) return observation;
  const claimants = { ...(observation.claimants ?? {}) };
  delete claimants[holderId];
  return { ...observation, holderId: observation.holderId === holderId ? null : observation.holderId, claimants };
}

/**
 * A5 / D3: closing may hand the policy to legacy before the settle time only when no copy can run anywhere: no slot has
 * a holder or a daemon reporting a role in which its copy may run, and every node that could hold (candidates, last
 * holders, claimants, reserved holders) persisted the closed manifest, so none of them acquires again.
 */
function closedEverywhere(input: {
  observations: ObservationRow[];
  bootstrap: Array<{ slot: number; holderId: string }>;
  candidateNodeIds: readonly string[];
  closedAckers: ReadonlySet<string>;
  /** Every slot has a confirmed retained holder: nobody can acquire any key any more, acks are not needed. */
  everySlotRetained?: boolean;
}): boolean {
  const running = input.observations.some(
    (observation) => observation.holderId !== null || Object.keys(observation.claimants ?? {}).length > 0
  );
  if (running) return false;
  if (input.everySlotRetained) return true;
  const possible = new Set<string>(input.candidateNodeIds);
  for (const observation of input.observations) {
    if (observation.lastHolderId) possible.add(observation.lastHolderId);
  }
  for (const entry of input.bootstrap) possible.add(entry.holderId);
  return possible.size > 0 && [...possible].every((id) => input.closedAckers.has(id));
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
          witness: dockerAvailabilityPolicies.witness,
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
    const [placements, observations, runtimeOperations] = await Promise.all([
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
      this.db
        .select({ policyId: dockerAvailabilityOperations.policyId })
        .from(dockerAvailabilityOperations)
        .where(
          and(
            inArray(dockerAvailabilityOperations.policyId, policyIds),
            inArray(dockerAvailabilityOperations.type, [...BOOTSTRAP_WAITS_FOR_OPERATIONS]),
            inArray(dockerAvailabilityOperations.status, ['pending', 'waiting', 'running'])
          )
        ),
    ]);
    const runtimeChanging = new Set(runtimeOperations.map((operation) => operation.policyId));
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
    const policyRelays = await loadPolicyRelays(this.db, policyIds);
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
          [...(policyRelays.get(policy.id) ?? [])],
          context,
          runtimeChanging.has(policy.id)
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
    relayIds: string[],
    context: LeasePoliciesContext,
    runtimeChanging = false
  ): Promise<{ changed: boolean; modeChange: LeaseModeChange | null }> {
    const now = context.now;
    const participants = context.participants;
    const candidatePlacements = leaseCandidatePlacements(placements);
    const candidateNodes = [...new Set(candidatePlacements.map((placement) => placement.nodeId))];
    const servingNodes = new Set(
      candidatePlacements.filter((placement) => placement.serving).map((placement) => placement.nodeId)
    );
    const ranked = orderLeaseCandidates(policy, placements);
    const selection = this.selectVoters(policy, state, ranked, participants);
    const entering = state.mode === 'legacy';
    const entryStable = (id: string) => participants.byId.get(id)?.entryStable === true;
    const gating = evaluateLeaseGating({
      controllerSupportsLease: context.controllerSupportsLease,
      legacyRequested: state.legacyRequested,
      policyMode: policy.mode,
      signingReady: Boolean(context.cluster.signingKeyId),
      entering,
      candidates: candidateNodes.map((nodeId) => ({
        nodeId,
        exclusion: participantExclusion(participants, nodeId),
        serving: servingNodes.has(nodeId),
      })),
      heldSlots: observations.filter((observation) => observation.holderId !== null).length,
      ingress: [...new Set(ingressNodes)].map((nodeId) => ({
        nodeId,
        capable: participants.byId.get(nodeId)?.capable ?? false,
      })),
      relays: relayIds.map((relayId) => ({
        relayId,
        capable: participants.byId.get(relayId)?.capable ?? false,
      })),
      voters: { viable: selection.viable, nonVotingCandidateIds: selection.nonVotingCandidateIds },
      unsettled: entering
        ? {
            nodeIds: [
              ...candidateNodes,
              ...ingressNodes,
              ...selection.witnesses.filter((witness) => witness.kind === 'docker').map(({ memberId }) => memberId),
            ].filter((id) => !entryStable(id)),
            relayIds: [
              ...relayIds,
              ...selection.witnesses.filter((witness) => witness.kind === 'relay').map(({ memberId }) => memberId),
            ].filter((id) => !entryStable(id)),
          }
        : undefined,
    });
    // D9: a rollout's surge is a temporary extra slot; failover stays at one slot.
    const slots = policy.mode === 'replicated' ? Math.min(32, policy.desiredReplicaCount + state.surgeSlots) : 1;
    const observationBySlot = new Map(observations.map((observation) => [observation.slot, observation]));
    const updates: Partial<typeof dockerAvailabilityLeaseState.$inferInsert> = {};
    let next: DockerAvailabilityLeaseMode = state.mode;
    const plannedHandoffs = state.plannedHandoffs.filter((handoff) => Date.parse(handoff.expiresAt) > now.getTime());
    if (plannedHandoffs.length !== state.plannedHandoffs.length) updates.plannedHandoffs = plannedHandoffs;
    // D3: a lease-mode policy leaves only after lease mode stayed impossible for 2 minutes without a break; an
    // explicit request (lifecycle hold, disable) closes at once. Meanwhile the lease keeps running as it is.
    const since = gating.eligible ? null : gating.immediate ? now : impossibleSince(state.reason, now);
    const leaving =
      !gating.eligible &&
      state.mode !== 'legacy' &&
      state.mode !== 'closing' &&
      (gating.immediate || now.getTime() - since!.getTime() >= LEASE_IMPOSSIBLE_HYSTERESIS_MS);

    // Graceful close: the closed manifest being published names the retained holders; they stay the same for the whole
    // close (read back from the published block), and a new close names the committed holders seen now.
    const closedManifest = state.mode === 'closing' ? leaseManifestClosure(state.manifestBlock) : null;
    const closure = { retained: closedManifest?.closed ? closedManifest.retained : [] };
    let retainedNow: LeaseRetainedSlot[] = [];

    if (state.mode === 'legacy') {
      // Only a policy that already left lease mode waits; a policy that never ran one bootstraps right away.
      const settled =
        state.manifestVersion === 0 || now.getTime() - state.modeChangedAt.getTime() >= LEASE_REENTRY_HOLD_MS;
      if (gating.eligible && settled && !runtimeChanging) {
        next = 'bootstrapping';
        updates.bootstrapId = randomInt(1, 2 ** 47);
        updates.bootstrap = bootstrapFromServing(placements, slots);
        updates.strictRequestedAt = null;
        updates.copiesStoppedAt = null;
        updates.closingStartedAt = null;
        updates.closingAckedAt = null;
      }
    } else if (leaving) {
      next = 'closing';
      updates.closingStartedAt = now;
      updates.closingAckedAt = null;
    } else if (
      gating.eligible &&
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
      let ackedAt = state.closingAckedAt;
      if (!ackedAt && holdsEveryMajority(state.quorumSets, closedAckers)) {
        ackedAt = now;
        updates.closingAckedAt = now;
      }
      // Graceful close + D3: legacy starts nothing before every held slot is retained by its named holder (its copy
      // keeps running, legacy adopts it as running) or expired, and every other copy is gone. Retained: the holder
      // reports that a majority of every quorum set confirmed the close to it; nobody can acquire the key any more.
      // Released: besides the retained copies no copy runs anywhere and every node that could hold knows the lease is
      // closed. Expired: a voter majority persisted the close, so no renewal succeeded since, and T x 1.1 / 0.9 plus
      // the fence stop margin passed; a named holder that never reported retained (partitioned) fenced by then.
      const retainedBySlot = new Map(closure.retained.map((entry) => [entry.slot, entry.holderId]));
      retainedNow = closure.retained.filter((entry) =>
        keepsRunningThroughClose(entry, observationBySlot.get(entry.slot), closedAckers)
      );
      const released =
        retainedNow.length === closure.retained.length &&
        closedEverywhere({
          observations: observations.map((observation) =>
            withoutRetainedHolder(observation, retainedBySlot.get(observation.slot))
          ),
          bootstrap: state.bootstrap,
          candidateNodeIds: candidateNodes,
          closedAckers,
          everySlotRetained: Array.from({ length: slots }, (_, slot) => slot).every((slot) =>
            retainedNow.some((entry) => entry.slot === slot)
          ),
        });
      if (released || (ackedAt && now.getTime() - ackedAt.getTime() >= CLOSE_SETTLE_MS)) {
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
    const reason: DockerAvailabilityLeaseReason | null = !gating.eligible
      ? { ...gating.reason, ...(gating.immediate ? {} : { since: since!.toISOString() }) }
      : next === 'bootstrapping' && strictRequestedAt
        ? STRICT_SWITCH_PENDING
        : null;
    const reasonChanged = JSON.stringify(reason) !== JSON.stringify(state.reason ?? null);
    if (reasonChanged) updates.reason = reason;
    const merged: LeaseStateRow = { ...state, ...(updates as Partial<LeaseStateRow>) };
    let blockChanged = false;
    if (next !== 'legacy') {
      const published = await this.publishManifest(
        policy,
        merged,
        slots,
        observations,
        context,
        ranked,
        // Voters change only to a viable selection, and never while the lease closes (the close needs stable sets).
        selection.viable && next !== 'closing' ? selection : null,
        next === 'closing'
          ? closedManifest?.closed
            ? closure.retained
            : retainedFromObservations(observations, slots, state.mode === 'bootstrapping' ? state.bootstrap : [])
          : undefined
      );
      Object.assign(updates, published.updates);
      blockChanged = published.published;
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
            retainedHolders:
              next === 'legacy' && state.mode === 'closing'
                ? retainedNow.map(({ slot, holderId }) => ({ slot, holderId }))
                : [],
          }
        : null;
    if (modeChange) logger.info('Availability lease mode changes', { ...modeChange, lastHolders: undefined });
    return { changed: blockChanged || (next === 'legacy' && state.mode === 'closing'), modeChange };
  }

  /**
   * The desired voters (A18, D3): voter-capable candidates, then witnesses. A current voter or witness keeps its place
   * through a short incapability (grace), so a daemon restart or a rolling update never changes the voters.
   */
  private selectVoters(
    policy: PolicyRow,
    state: LeaseStateRow,
    ranked: string[],
    participants: LeaseParticipants
  ): PolicyVoterSelection {
    const currentVoters = new Set(state.quorumSets.flat());
    const currentAuto = state.witnesses.filter((witness) => witness.auto).map((witness) => witness.memberId);
    return selectPolicyVoters({
      candidates: leaseVoterCandidates(participants, ranked, currentVoters),
      pool: leaseWitnessPool(participants, new Set(state.witnesses.map((witness) => witness.memberId))),
      configuredWitness: policy.witness,
      currentAutoWitnesses: currentAuto,
    });
  }

  private async publishManifest(
    policy: PolicyRow,
    state: LeaseStateRow,
    slots: number,
    observations: ObservationRow[],
    context: LeasePoliciesContext,
    ranked: string[],
    selection: PolicyVoterSelection | null,
    retained?: LeaseRetainedSlot[]
  ): Promise<{ updates: Partial<typeof dockerAvailabilityLeaseState.$inferInsert>; published: boolean }> {
    const none = { updates: {}, published: false };
    const signingKeyId = context.cluster.signingKeyId;
    if (!signingKeyId) return none;
    const closed = state.mode === 'closing';
    const participants = context.participants;
    // D3: a node that runs an outdated daemon (or has no identity) is no manifest candidate, so it never acquires. A
    // node already listed keeps its place through the 2-minute grace, and a node that holds or runs a copy is never
    // cut (removal from the manifest fences it). Offline and watchdog-less nodes stay: the data plane keeps them from
    // holding by itself, and taking them out would only churn the manifest.
    const active = activeLeaseNodeIds(observations, state);
    const listed = new Set(leaseManifestCandidateIds(state.manifestBlock));
    const candidates = ranked.flatMap((nodeId) => {
      const participant = participants.byId.get(nodeId);
      const publicKey = participant?.publicKey;
      if (
        !publicKey ||
        !manifestCandidateAllowed(participant, { active: active.has(nodeId), listed: listed.has(nodeId) })
      )
        return [];
      return [{ id: nodeId, publicKey: Buffer.from(publicKey, 'base64') }];
    });
    if (candidates.length === 0 && !closed) return none;
    const currentVoters = state.quorumSets.at(-1) ?? [];
    // A closing lease keeps its voters as they are, joint or not: the close needs a majority of the sets it names.
    const plan = closed
      ? { next: state, jointStarted: false }
      : planPolicyVoters({
          state,
          desired: selection ? selection.voterIds : currentVoters,
          memberOf: (id) => {
            const participant = participants.byId.get(id);
            return participant?.publicKey ? { id, role: participant.role, publicKey: participant.publicKey } : null;
          },
          ackedEpoch: (memberId) => {
            const ack = context.members.get(memberId)?.manifestAcks[policy.id];
            if (!ack) return 0;
            if (ack.voterEpoch) return ack.voterEpoch;
            return state.jointVersion > 0 && ack.version >= state.jointVersion ? state.voterEpoch : 0;
          },
          activeLeaseEpochs: observations
            .filter(
              (observation) =>
                observation.holderId && context.now.getTime() - observation.observedAt.getTime() <= 2 * LEASE_TERM_MS
            )
            .map((observation) => observation.epoch),
          now: context.now,
        });
    const voters = plan.next;
    const updates: Partial<typeof dockerAvailabilityLeaseState.$inferInsert> = {};
    if (selection && JSON.stringify(selection.witnesses) !== JSON.stringify(state.witnesses))
      updates.witnesses = selection.witnesses;
    if (selection && selection.warning !== state.witnessWarning) updates.witnessWarning = selection.warning;
    if (voters.jointAckedAt !== state.jointAckedAt) updates.jointAckedAt = voters.jointAckedAt;
    // Members (A18): the voters of every quorum set, plus every capable relay as a non-voting member so its data-path
    // gate keeps shadow accepts for this policy (A11, A15). nginx daemons are observers and never members.
    const voterIds = new Set(voters.quorumSets.flat());
    const members = [
      ...voters.voterMembers.filter((member) => voterIds.has(member.id)),
      ...participants.relays
        .filter((relay) => relay.voterCapable && relay.publicKey && !voterIds.has(relay.id))
        .map((relay) => ({ id: relay.id, role: 'relay' as const, publicKey: relay.publicKey! })),
    ].sort((left, right) => left.id.localeCompare(right.id));
    const known = new Set(candidates.map((candidate) => candidate.id));
    const content: LeaseManifestContent = {
      policyId: policy.id,
      mode: policy.mode === 'replicated' ? 'replicated' : 'failover',
      partitionMode: policy.partitionMode,
      slots,
      candidates,
      specFingerprint: policy.specFingerprint,
      voterEpoch: voters.voterEpoch,
      closed,
      bootstrapId: state.bootstrap.length > 0 ? state.bootstrapId : 0,
      // A bootstrap holder must be a candidate; one that is not stays unreserved (rank-based acquisition).
      bootstrap: state.bootstrap.filter((entry) => entry.slot < slots && known.has(entry.holderId)),
      members: members.map((member) => ({ ...member, publicKey: Buffer.from(member.publicKey, 'base64') })),
      quorumSets: voters.quorumSets,
      // Graceful close: a retained holder must be a candidate of the same manifest (acceptors check it by its key).
      ...(closed
        ? { retained: (retained ?? []).filter((entry) => entry.slot < slots && known.has(entry.holderId)) }
        : {}),
    };
    const digest = leaseManifestDigest(content);
    if (digest === state.manifestDigest && state.manifestBlock) {
      // A16: once voters trust a new policy key the current manifest is signed again with it, same payload.
      const current = decodeLeaseSignedBlock(Buffer.from(state.manifestBlock, 'base64'));
      if (current.signingKeyId === signingKeyId) return { updates, published: false };
      const resigned = await signLeaseBlock(current.kind, current.payload, signingKeyId, this.sign);
      return {
        updates: { ...updates, manifestBlock: encodeLeaseSignedBlock(resigned).toString('base64') },
        published: true,
      };
    }
    const manifestVersion = state.manifestVersion + 1;
    const block = await signLeaseBlock(
      'LEASE_BLOCK_KIND_MANIFEST',
      encodeLeaseManifest(content, manifestVersion),
      signingKeyId,
      this.sign
    );
    return {
      updates: {
        ...updates,
        manifestVersion,
        voterEpoch: voters.voterEpoch,
        quorumSets: voters.quorumSets,
        voterMembers: voters.voterMembers,
        jointVersion: plan.jointStarted ? manifestVersion : voters.jointVersion,
        jointAckedAt: voters.jointAckedAt,
        manifestDigest: digest,
        manifestBlock: encodeLeaseSignedBlock(block).toString('base64'),
        publishedPartitionMode: policy.partitionMode,
      },
      published: true,
    };
  }
}
