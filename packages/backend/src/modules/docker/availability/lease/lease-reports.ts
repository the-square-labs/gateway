import { and, eq, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type AvailabilityLeaseMemberKind,
  availabilityLeaseMembers,
  type DockerAvailabilityLeaseObservationSource,
  dockerAvailabilityLeaseObservations,
  dockerAvailabilityLeaseState,
  dockerAvailabilityPlacements,
} from '@/db/schema/index.js';
import type { AvailabilityLeaseReport } from '@/grpc/generated/types.js';
import { createChildLogger } from '@/lib/logger.js';
import { normalizeLeaseBallot } from './lease-codec.js';
import { HOLDING_LEASE_ROLES } from './lease-constants.js';
import {
  classifyLeaseHolderChange,
  type LeaseHolderChange,
  type LeaseHolderChangeKind,
  type LeaseObservationCandidate,
  type LeaseObservationState,
  mergeLeaseObservation,
} from './lease-planning.js';

const logger = createChildLogger('AvailabilityLeaseReports');

export interface LeaseHolderChangeNotice extends LeaseHolderChange {
  policyId: string;
  slot: number;
  /** failover or handoff; null for the first holder of a key. */
  kind: LeaseHolderChangeKind | null;
  placementId: string | null;
  source: DockerAvailabilityLeaseObservationSource;
  sourceId: string;
}

export interface LeaseReportSender {
  memberId: string;
  kind: AvailabilityLeaseMemberKind;
  nodeId: string | null;
  relayInstanceId: string | null;
}

function toNumber(value: string | number | undefined | null): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function keyOf(policyId: string, slot: number): string {
  return `${policyId}/${slot}`;
}

/**
 * Lease reports from daemon heartbeats and relay health (D9): persisted acks per member and the holder of every
 * key. A holder change without a planned handoff is audited as docker.availability.lease_failover, a planned one as
 * docker.availability.lease_handoff.
 */
export class AvailabilityLeaseReports {
  constructor(private readonly db: DrizzleClient) {}

  async ingest(
    sender: LeaseReportSender,
    report: AvailabilityLeaseReport,
    now = new Date()
  ): Promise<{ notices: LeaseHolderChangeNotice[]; identityChanged: boolean }> {
    // Nginx daemons only observe leases and report just the applied revision, without a member id; the sender
    // itself comes from the authenticated control stream.
    const reportedMemberId = report.memberId || (sender.kind === 'nginx' ? sender.memberId : '');
    if (!reportedMemberId || reportedMemberId !== sender.memberId) {
      logger.warn('Ignored an availability lease report for another member', {
        memberId: sender.memberId,
        reported: report.memberId,
      });
      return { notices: [], identityChanged: false };
    }
    const identityChanged = await this.recordMember(sender, report, now);
    const source: DockerAvailabilityLeaseObservationSource = sender.kind === 'relay' ? 'relay' : 'daemon';
    const candidates = new Map<string, { policyId: string; slot: number; list: LeaseObservationCandidate[] }>();
    const addCandidate = (policyId: string, slot: number, candidate: LeaseObservationCandidate) => {
      const key = keyOf(policyId, slot);
      const entry = candidates.get(key) ?? { policyId, slot, list: [] };
      entry.list.push(candidate);
      candidates.set(key, entry);
    };
    const reporterRoles = new Map<string, { policyId: string; slot: number; role: string }>();
    if (sender.kind !== 'relay') {
      for (const held of report.held ?? []) {
        if (!held.policyId) continue;
        reporterRoles.set(keyOf(held.policyId, held.slot), {
          policyId: held.policyId,
          slot: held.slot,
          role: held.role,
        });
        const ballot = normalizeLeaseBallot(held.ballot);
        if (!ballot || !HOLDING_LEASE_ROLES.has(held.role)) continue;
        addCandidate(held.policyId, held.slot, {
          holderId: sender.memberId,
          ballot,
          epoch: toNumber(held.epoch),
          manifestVersion: toNumber(held.manifestVersion),
          source: 'daemon',
          sourceId: sender.memberId,
        });
      }
    }
    for (const view of report.acceptor ?? []) {
      if (!view.policyId) continue;
      const ballot = normalizeLeaseBallot(view.committed);
      if (view.state === 'held' && view.holderId && ballot) {
        addCandidate(view.policyId, view.slot, {
          holderId: view.holderId,
          ballot,
          epoch: toNumber(view.epoch),
          manifestVersion: toNumber(view.manifestVersion),
          source: source === 'relay' ? 'relay' : 'acceptor',
          sourceId: sender.memberId,
        });
        continue;
      }
      // An open relay gate names the holder of a verified commit that renewed within the last gate window (A11, A15),
      // also where the relay does not vote: the local relay only shadow-accepts. Its health report is the first lease
      // view Gateway gets after a restart, long before the nodes' control sessions reconnect (stand run ha18/b).
      const gateBallot = normalizeLeaseBallot(view.gateBallot);
      if (sender.kind === 'relay' && view.gateOpen && view.gateHolderId && gateBallot) {
        addCandidate(view.policyId, view.slot, {
          holderId: view.gateHolderId,
          ballot: gateBallot,
          epoch: toNumber(view.epoch),
          manifestVersion: toNumber(view.manifestVersion),
          source: 'relay',
          sourceId: sender.memberId,
        });
      }
    }
    const handoffSuccessors = new Map<string, Set<string>>();
    for (const event of report.events ?? []) {
      if (event.kind !== 'handoff' || !event.successorId || !event.policyId) continue;
      const key = keyOf(event.policyId, event.slot);
      const set = handoffSuccessors.get(key) ?? new Set<string>();
      set.add(event.successorId);
      handoffSuccessors.set(key, set);
    }
    const keys = new Set([...candidates.keys(), ...reporterRoles.keys()]);
    if (sender.kind !== 'relay') {
      // A key this daemon held, or ran a copy for (a claimant: fencing, abandoned, releasing...), but no longer
      // reports was released or its copy stopped. Without the claimant case a fenced holder stayed listed forever,
      // which kept a bootstrap from settling and a closing lease from seeing that no copy runs (D3).
      const claimed = await this.db
        .select({
          policyId: dockerAvailabilityLeaseObservations.policyId,
          slot: dockerAvailabilityLeaseObservations.slot,
        })
        .from(dockerAvailabilityLeaseObservations)
        .where(
          or(
            eq(dockerAvailabilityLeaseObservations.holderId, sender.memberId),
            sql`jsonb_exists(${dockerAvailabilityLeaseObservations.claimants}, ${sender.memberId})`
          )
        );
      for (const { policyId, slot } of claimed) keys.add(keyOf(policyId, slot));
    }
    const notices: LeaseHolderChangeNotice[] = [];
    for (const key of keys) {
      const [policyId, slotText] = [key.slice(0, key.lastIndexOf('/')), key.slice(key.lastIndexOf('/') + 1)];
      const slot = Number(slotText);
      try {
        const notice = await this.applyKey(policyId, slot, {
          candidates: candidates.get(key)?.list ?? [],
          reporter:
            sender.kind === 'relay' ? undefined : { id: sender.memberId, role: reporterRoles.get(key)?.role ?? null },
          handoffSuccessors: handoffSuccessors.get(key) ?? new Set(),
          now,
        });
        if (notice) notices.push(notice);
      } catch (error) {
        logger.debug('Availability lease observation was not applied', {
          policyId,
          slot,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { notices, identityChanged };
  }

  /** Records the member's report; true when its identity key changed (a certificate renewal, H3). */
  private async recordMember(sender: LeaseReportSender, report: AvailabilityLeaseReport, now: Date): Promise<boolean> {
    const [previous] = await this.db
      .select({ identityPublicKey: availabilityLeaseMembers.identityPublicKey })
      .from(availabilityLeaseMembers)
      .where(eq(availabilityLeaseMembers.memberId, sender.memberId))
      .limit(1);
    const manifestAcks: Record<string, { version: number; closed: boolean; voterEpoch?: number }> = {};
    for (const ack of report.manifests ?? []) {
      if (!ack.policyId) continue;
      const voterEpoch = toNumber(ack.voterEpoch);
      manifestAcks[ack.policyId] = {
        version: toNumber(ack.manifestVersion),
        closed: ack.closed,
        ...(voterEpoch > 0 ? { voterEpoch } : {}),
      };
    }
    const values = {
      kind: sender.kind,
      nodeId: sender.nodeId,
      relayInstanceId: sender.relayInstanceId,
      identityPublicKey: report.identityPublicKey?.length
        ? Buffer.from(report.identityPublicKey).toString('base64')
        : null,
      watchdogReady: report.watchdogReady === true,
      incarnation: toNumber(report.incarnation),
      epochAck: toNumber(report.epoch),
      trustedKeyIds: (report.trustedPolicyKeyIds ?? []).filter((id) => typeof id === 'string' && id.length > 0),
      manifestAcks,
      leaseRevision: toNumber(report.leaseRevision),
      abstaining: report.acceptorAbstaining === true,
      reportedAt: now,
      updatedAt: now,
    };
    const identityChanged = Boolean(
      previous?.identityPublicKey && values.identityPublicKey && previous.identityPublicKey !== values.identityPublicKey
    );
    const rotation = identityChanged
      ? { previousIdentityPublicKey: previous!.identityPublicKey, identityRotatedAt: now }
      : {};
    await this.db
      .insert(availabilityLeaseMembers)
      .values({ memberId: sender.memberId, ...values, ...rotation })
      .onConflictDoUpdate({ target: availabilityLeaseMembers.memberId, set: { ...values, ...rotation } });
    return identityChanged;
  }

  private async applyKey(
    policyId: string,
    slot: number,
    input: {
      candidates: LeaseObservationCandidate[];
      reporter?: { id: string; role: string | null };
      handoffSuccessors: Set<string>;
      now: Date;
    }
  ): Promise<LeaseHolderChangeNotice | null> {
    if (!Number.isInteger(slot) || slot < 0 || slot > 31) return null;
    return this.db.transaction(async (tx) => {
      const [state] = await tx
        .select({ plannedHandoffs: dockerAvailabilityLeaseState.plannedHandoffs })
        .from(dockerAvailabilityLeaseState)
        .where(eq(dockerAvailabilityLeaseState.policyId, policyId))
        .limit(1);
      // Reports about a policy the Gateway never put in lease mode are not recorded.
      if (!state) return null;
      const [stored] = await tx
        .select()
        .from(dockerAvailabilityLeaseObservations)
        .where(
          and(
            eq(dockerAvailabilityLeaseObservations.policyId, policyId),
            eq(dockerAvailabilityLeaseObservations.slot, slot)
          )
        )
        .for('update');
      if (!stored && input.candidates.length === 0) return null;
      const previous: LeaseObservationState | null = stored
        ? {
            holderId: stored.holderId,
            ballot: stored.ballot,
            epoch: stored.epoch,
            manifestVersion: stored.manifestVersion,
            source: stored.source,
            sourceId: stored.sourceId,
            observedAt: stored.observedAt,
            holderSince: stored.holderSince,
            lastHolderId: stored.lastHolderId,
            claimants: stored.claimants,
          }
        : null;
      const { next, change } = mergeLeaseObservation(previous, input);
      const placementId = next.holderId ? await this.placementOf(tx, policyId, next.holderId) : null;
      const row = { ...next, placementId, updatedAt: input.now };
      if (stored) {
        await tx
          .update(dockerAvailabilityLeaseObservations)
          .set(row)
          .where(
            and(
              eq(dockerAvailabilityLeaseObservations.policyId, policyId),
              eq(dockerAvailabilityLeaseObservations.slot, slot)
            )
          );
      } else {
        await tx.insert(dockerAvailabilityLeaseObservations).values({ policyId, slot, ...row });
      }
      if (!change) return null;
      return {
        ...change,
        policyId,
        slot,
        kind: classifyLeaseHolderChange(change, slot, state.plannedHandoffs, input.handoffSuccessors, input.now),
        placementId,
        source: next.source,
        sourceId: next.sourceId,
      };
    });
  }

  private async placementOf(
    tx: Parameters<Parameters<DrizzleClient['transaction']>[0]>[0],
    policyId: string,
    nodeId: string
  ): Promise<string | null> {
    const [placement] = await tx
      .select({ id: dockerAvailabilityPlacements.id })
      .from(dockerAvailabilityPlacements)
      .where(and(eq(dockerAvailabilityPlacements.policyId, policyId), eq(dockerAvailabilityPlacements.nodeId, nodeId)))
      .limit(1);
    return placement?.id ?? null;
  }
}
