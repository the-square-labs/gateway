import { asc, eq, ne, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  availabilityLeaseCluster,
  availabilityLeaseKeyRotations,
  dockerAvailabilityLeaseState,
  relayPolicySigningKeys,
} from '@/db/schema/index.js';
import { type LeaseSigner, leaseKeyRotationMessage, policyKeyFingerprint } from './lease-codec.js';
import { LEASE_CLUSTER_ID } from './lease-constants.js';
import { ensureLeaseCluster, type LeaseClusterRow, type LeaseMemberRow } from './lease-store.js';
import { holdsEveryMajority } from './lease-voters.js';

export interface LeaseSigningOutcome {
  cluster: LeaseClusterRow;
  /** The key chain or the signing key changed: redistribute (manifests are re-signed by the policies step). */
  changed: boolean;
}

interface PolicyKeyRow {
  keyId: string;
  publicKey: string;
  status: string;
  hasPrivateKey: boolean;
}

/**
 * The policy key chain for lease blocks (A14, A16). Voters are per policy since A18, so a new key signs manifests only
 * after a majority of every quorum set of every lease-mode policy trusts it.
 */
export class AvailabilityLeaseCluster {
  constructor(
    private readonly db: DrizzleClient,
    private readonly sign: LeaseSigner
  ) {}

  async reconcile(input: { members: Map<string, LeaseMemberRow> }): Promise<LeaseSigningOutcome> {
    let cluster = await ensureLeaseCluster(this.db);
    const keys = await this.loadPolicyKeys();
    let changed = await this.ensureRotationLinks(keys);
    const voterSets = (
      await this.db
        .select({ quorumSets: dockerAvailabilityLeaseState.quorumSets })
        .from(dockerAvailabilityLeaseState)
        .where(ne(dockerAvailabilityLeaseState.mode, 'legacy'))
    ).map(({ quorumSets }) => quorumSets);
    const signingKeyId = this.chooseSigningKey(cluster, keys, voterSets, input.members);
    if (signingKeyId && signingKeyId !== cluster.signingKeyId) {
      const [row] = await this.db
        .update(availabilityLeaseCluster)
        .set({ signingKeyId, revision: sql`${availabilityLeaseCluster.revision} + 1`, updatedAt: new Date() })
        .where(eq(availabilityLeaseCluster.id, LEASE_CLUSTER_ID))
        .returning();
      if (row) cluster = row;
      changed = true;
    }
    return { cluster, changed };
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
   * linked while the previous key still signs, so any member that trusts the old key can verify blocks of the new one.
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
   * A14: lease manifests move to the active policy key only after a majority of every quorum set of every lease-mode
   * policy trusts it. Until then the previous signer keeps signing while it still has its private half.
   */
  private chooseSigningKey(
    cluster: LeaseClusterRow,
    keys: PolicyKeyRow[],
    voterSets: string[][][],
    members: Map<string, LeaseMemberRow>
  ): string | null {
    const active = keys.find((key) => key.status === 'active' && key.hasPrivateKey);
    const current = keys.find((key) => key.keyId === cluster.signingKeyId && key.hasPrivateKey);
    if (!current) return active?.keyId ?? null;
    if (!active || active.keyId === current.keyId) return current.keyId;
    const trusting = new Set(
      [...members.values()]
        .filter((member) => member.trustedKeyIds.includes(active.keyId))
        .map((member) => member.memberId)
    );
    const policiesWithVoters = voterSets.filter((sets) => sets.length > 0);
    return policiesWithVoters.every((sets) => holdsEveryMajority(sets, trusting)) ? active.keyId : current.keyId;
  }
}
