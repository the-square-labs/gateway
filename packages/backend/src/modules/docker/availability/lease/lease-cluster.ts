import { asc, eq, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type AvailabilityLeaseClusterMember,
  availabilityLeaseCluster,
  availabilityLeaseKeyRotations,
  relayPolicySigningKeys,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import {
  decodeLeaseSignedBlock,
  encodeLeaseSignedBlock,
  encodeLeaseVoterConfig,
  type LeaseSigner,
  leaseKeyRotationMessage,
  policyKeyFingerprint,
  signLeaseBlock,
} from './lease-codec.js';
import { EPOCH_SETTLE_MS, LEASE_CLUSTER_ID } from './lease-constants.js';
import type { LeaseParticipants } from './lease-participants.js';
import { ensureLeaseCluster, type LeaseClusterRow, type LeaseMemberRow } from './lease-store.js';
import { holdsEveryMajority, sameVoterSet, selectLeaseVoters } from './lease-voters.js';

const logger = createChildLogger('AvailabilityLeaseCluster');

export interface LeaseClusterOutcome {
  cluster: LeaseClusterRow;
  /** A block or the key chain changed: redistribute. */
  changed: boolean;
  /** D10 inputs: capable voters and the voter set size by rule. */
  capableVoters: number;
  totalVoters: number;
  /** The published config is persisted by a majority of every quorum set. */
  ready: boolean;
}

interface PolicyKeyRow {
  keyId: string;
  publicKey: string;
  status: string;
  hasPrivateKey: boolean;
}

function membersEqual(left: AvailabilityLeaseClusterMember[], right: AvailabilityLeaseClusterMember[]): boolean {
  const key = (members: AvailabilityLeaseClusterMember[]) =>
    JSON.stringify([...members].sort((a, b) => a.id.localeCompare(b.id)));
  return key(left) === key(right);
}

/**
 * The cluster voter config (D2, A4, A9, A10) and the policy key chain for lease blocks (A14). Voter changes go
 * through a joint epoch; the new epoch settles only after a majority of the old and of the new set persisted it and
 * every active lease renewed under it (or could no longer be alive without having done so).
 */
export class AvailabilityLeaseCluster {
  constructor(
    private readonly db: DrizzleClient,
    private readonly sign: LeaseSigner
  ) {}

  async reconcile(input: {
    participants: LeaseParticipants;
    members: Map<string, LeaseMemberRow>;
    /** Epochs under which each currently held lease last renewed. */
    activeLeaseEpochs: number[];
    /** Some policy needs the lease (eligible or already in a lease mode). */
    wanted: boolean;
    now: Date;
  }): Promise<LeaseClusterOutcome> {
    let cluster = await ensureLeaseCluster(this.db);
    const keys = await this.loadPolicyKeys();
    let changed = await this.ensureRotationLinks(keys);
    const signingKeyId = this.chooseSigningKey(cluster, keys, input.members);
    if (signingKeyId && signingKeyId !== cluster.signingKeyId) {
      cluster = await this.update({ signingKeyId, ...(await this.resign(cluster, signingKeyId)) });
      changed = true;
    }
    const sets = cluster.quorumSets;
    const currentVoters = sets.at(-1) ?? [];
    const selection = selectLeaseVoters(
      [...input.participants.relays, ...input.participants.daemons],
      currentVoters,
      input.now.getTime()
    );
    const outcome = (row: LeaseClusterRow, didChange: boolean): LeaseClusterOutcome => ({
      cluster: row,
      changed: didChange,
      capableVoters: selection.voterIds.length,
      totalVoters: selection.voterIds.length + selection.incapableRelayIds.length,
      ready: row.epoch > 0 && this.persistedByMajority(row, input.members),
    });
    if (!signingKeyId || selection.voterIds.length === 0 || (!input.wanted && cluster.epoch === 0)) {
      return outcome(cluster, changed);
    }
    if (cluster.epoch === 0) {
      cluster = await this.publish(cluster, [selection.voterIds], input.participants, signingKeyId, {
        jointStartedAt: null,
        jointAckedAt: null,
      });
      return outcome(cluster, true);
    }
    if (sets.length === 2) {
      const [previous, next] = sets as [string[], string[]];
      let jointAckedAt = cluster.jointAckedAt;
      if (!jointAckedAt) {
        const acked = this.ackedIds(input.members, cluster.epoch);
        if (holdsEveryMajority([previous], acked) && holdsEveryMajority([next], acked)) {
          jointAckedAt = input.now;
          cluster = await this.update({ jointAckedAt });
        }
      }
      const renewedUnderJoint = input.activeLeaseEpochs.every((epoch) => epoch >= cluster.epoch);
      // A16: both majorities acked, every active lease renewed under the joint epoch, and the drift-safe hold passed.
      if (jointAckedAt && renewedUnderJoint && input.now.getTime() - jointAckedAt.getTime() >= EPOCH_SETTLE_MS) {
        logger.info('Availability lease voter epoch settles', { epoch: cluster.epoch + 1, voters: next.length });
        cluster = await this.publish(cluster, [next], input.participants, signingKeyId, {
          jointStartedAt: null,
          jointAckedAt: null,
        });
        return outcome(cluster, true);
      }
      return outcome(cluster, changed);
    }
    if (!sameVoterSet(currentVoters, selection.voterIds)) {
      logger.info('Availability lease voter set changes through a joint epoch', {
        epoch: cluster.epoch + 1,
        previous: currentVoters.length,
        next: selection.voterIds.length,
      });
      cluster = await this.publish(cluster, [currentVoters, selection.voterIds], input.participants, signingKeyId, {
        jointStartedAt: input.now,
        jointAckedAt: null,
      });
      return outcome(cluster, true);
    }
    const members = this.configMembers([currentVoters], input.participants, cluster.members);
    if (!membersEqual(members, cluster.members)) {
      // Same voters, but an identity key changed or a non-voting relay joined: a new epoch with the same quorum set.
      cluster = await this.publish(cluster, [currentVoters], input.participants, signingKeyId, {
        jointStartedAt: null,
        jointAckedAt: null,
      });
      return outcome(cluster, true);
    }
    return outcome(cluster, changed);
  }

  private ackedIds(members: Map<string, LeaseMemberRow>, epoch: number): Set<string> {
    return new Set([...members.values()].filter((member) => member.epochAck >= epoch).map((member) => member.memberId));
  }

  private persistedByMajority(cluster: LeaseClusterRow, members: Map<string, LeaseMemberRow>): boolean {
    return holdsEveryMajority(cluster.quorumSets, this.ackedIds(members, cluster.epoch));
  }

  /**
   * Members: every voter of every quorum set plus every capable relay. A relay outside the quorum sets records shadow
   * accepts for its data-path gate (A11) without its vote counting.
   */
  private configMembers(
    sets: string[][],
    participants: LeaseParticipants,
    previous: AvailabilityLeaseClusterMember[]
  ): AvailabilityLeaseClusterMember[] {
    const ids = new Set(sets.flat());
    for (const relay of participants.relays) if (relay.capable && relay.publicKey) ids.add(relay.id);
    const published = new Map(previous.map((member) => [member.id, member]));
    return [...ids].sort().flatMap((id) => {
      const participant = participants.byId.get(id);
      if (participant?.publicKey) return [{ id, role: participant.role, publicKey: participant.publicKey }];
      // A voter that left (node deleted, key no longer reported) keeps its published key while it is still part of
      // the old quorum set of a joint epoch, so that set is not silently shrunk.
      const kept = published.get(id);
      return kept ? [kept] : [];
    });
  }

  private async publish(
    cluster: LeaseClusterRow,
    requestedSets: string[][],
    participants: LeaseParticipants,
    signingKeyId: string,
    joint: { jointStartedAt: Date | null; jointAckedAt: Date | null }
  ): Promise<LeaseClusterRow> {
    const members = this.configMembers(requestedSets, participants, cluster.members);
    const known = new Set(members.map((member) => member.id));
    // A voter whose key is unknown cannot sign accepts; it never enters a published quorum set.
    const sets = requestedSets.map((set) => set.filter((id) => known.has(id)).sort());
    const epoch = cluster.epoch + 1;
    const payload = encodeLeaseVoterConfig({
      epoch,
      members: members.map((member) => ({ ...member, publicKey: Buffer.from(member.publicKey, 'base64') })),
      quorumSets: sets,
    });
    const block = await signLeaseBlock('LEASE_BLOCK_KIND_VOTER_CONFIG', payload, signingKeyId, this.sign);
    return this.update({
      epoch,
      members,
      quorumSets: sets,
      voterConfigBlock: encodeLeaseSignedBlock(block).toString('base64'),
      revision: sql`${availabilityLeaseCluster.revision} + 1`,
      ...joint,
    });
  }

  /**
   * A16: after a voter majority trusts a new policy key, the current config is signed again with it (same payload),
   * so a peer that trusts only the new key can verify blocks forwarded between members.
   */
  private async resign(cluster: LeaseClusterRow, signingKeyId: string): Promise<{ voterConfigBlock?: string }> {
    if (!cluster.voterConfigBlock) return {};
    const current = decodeLeaseSignedBlock(Buffer.from(cluster.voterConfigBlock, 'base64'));
    if (current.signingKeyId === signingKeyId) return {};
    const block = await signLeaseBlock(current.kind, current.payload, signingKeyId, this.sign);
    return { voterConfigBlock: encodeLeaseSignedBlock(block).toString('base64') };
  }

  private async update(
    values: {
      [Key in keyof typeof availabilityLeaseCluster.$inferInsert]?:
        | (typeof availabilityLeaseCluster.$inferInsert)[Key]
        | SQL;
    }
  ): Promise<LeaseClusterRow> {
    const [row] = await this.db
      .update(availabilityLeaseCluster)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(availabilityLeaseCluster.id, LEASE_CLUSTER_ID))
      .returning();
    if (!row) throw new Error('Availability lease cluster state is unavailable');
    return row;
  }

  private async loadPolicyKeys(): Promise<PolicyKeyRow[]> {
    return this.db
      .select({
        keyId: relayPolicySigningKeys.keyId,
        publicKey: relayPolicySigningKeys.publicKey,
        status: relayPolicySigningKeys.status,
        hasPrivateKey: sql<boolean>`(${relayPolicySigningKeys.encryptedPrivateKey} is not null and ${relayPolicySigningKeys.encryptedDek} is not null)`,
      })
      .from(relayPolicySigningKeys)
      .orderBy(asc(relayPolicySigningKeys.createdAt), asc(relayPolicySigningKeys.keyId));
  }

  /**
   * A14: every key is introduced by the key created before it, signed by that key's private half. A pending key is
   * linked while the previous key still signs, so any voter that trusts the old key can verify blocks of the new one.
   */
  private async ensureRotationLinks(keys: PolicyKeyRow[]): Promise<boolean> {
    if (keys.length < 2) return false;
    const existing = new Set(
      (await this.db.select({ keyId: availabilityLeaseKeyRotations.keyId }).from(availabilityLeaseKeyRotations)).map(
        ({ keyId }) => keyId
      )
    );
    let changed = false;
    for (let index = 1; index < keys.length; index++) {
      const previous = keys[index - 1]!;
      const next = keys[index]!;
      if (existing.has(next.keyId) || !previous.hasPrivateKey) continue;
      const publicKey = Buffer.from(next.publicKey, 'base64');
      const signed = await this.sign(leaseKeyRotationMessage(next.keyId, publicKey), previous.keyId);
      await this.db
        .insert(availabilityLeaseKeyRotations)
        .values({
          keyId: next.keyId,
          previousKeyId: previous.keyId,
          publicKey: next.publicKey,
          publicKeyFingerprint: policyKeyFingerprint(publicKey),
          signature: signed.signature.toString('base64'),
        })
        .onConflictDoNothing();
      changed = true;
    }
    return changed;
  }

  /**
   * A14: lease blocks move to the active policy key only after a majority of every quorum set trusts it. Until then
   * the previous signer keeps signing while it still has its private half.
   */
  private chooseSigningKey(
    cluster: LeaseClusterRow,
    keys: PolicyKeyRow[],
    members: Map<string, LeaseMemberRow>
  ): string | null {
    const active = keys.find((key) => key.status === 'active' && key.hasPrivateKey);
    const current = keys.find((key) => key.keyId === cluster.signingKeyId && key.hasPrivateKey);
    if (!current || cluster.epoch === 0 || cluster.quorumSets.length === 0) return active?.keyId ?? null;
    if (!active || active.keyId === current.keyId) return current.keyId;
    const trusting = new Set(
      [...members.values()]
        .filter((member) => member.trustedKeyIds.includes(active.keyId))
        .map((member) => member.memberId)
    );
    return holdsEveryMajority(cluster.quorumSets, trusting) ? active.keyId : current.keyId;
  }
}
