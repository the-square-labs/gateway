import { eq, sql } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import {
  availabilityLeaseCluster,
  availabilityLeaseKeyRotations,
  availabilityLeaseMembers,
  dockerAvailabilityLeaseState,
} from '@/db/schema/index.js';
import { LEASE_CLUSTER_ID, MAX_KEY_ROTATION_LINKS } from './lease-constants.js';

export type LeaseClusterRow = typeof availabilityLeaseCluster.$inferSelect;
export type LeaseMemberRow = typeof availabilityLeaseMembers.$inferSelect;
export type LeaseStateRow = typeof dockerAvailabilityLeaseState.$inferSelect;
export type LeaseKeyRotationRow = typeof availabilityLeaseKeyRotations.$inferSelect;
type Executor = DrizzleExecutor;

export async function loadLeaseCluster(db: Executor): Promise<LeaseClusterRow | null> {
  const [row] = await db
    .select()
    .from(availabilityLeaseCluster)
    .where(eq(availabilityLeaseCluster.id, LEASE_CLUSTER_ID))
    .limit(1);
  return row ?? null;
}

/** Creates the singleton cluster row on first use. */
export async function ensureLeaseCluster(db: Executor): Promise<LeaseClusterRow> {
  await db.insert(availabilityLeaseCluster).values({ id: LEASE_CLUSTER_ID }).onConflictDoNothing();
  const row = await loadLeaseCluster(db);
  if (!row) throw new Error('Availability lease cluster state is unavailable');
  return row;
}

/** Any change of a published block or of the key chain moves the distribution revision. */
export async function bumpLeaseRevision(db: Executor): Promise<number> {
  const [row] = await db
    .update(availabilityLeaseCluster)
    .set({ revision: sql`${availabilityLeaseCluster.revision} + 1`, updatedAt: new Date() })
    .where(eq(availabilityLeaseCluster.id, LEASE_CLUSTER_ID))
    .returning({ revision: availabilityLeaseCluster.revision });
  return row?.revision ?? 0;
}

export async function loadLeaseMembers(db: Executor): Promise<LeaseMemberRow[]> {
  return db.select().from(availabilityLeaseMembers);
}

/** Rotation links in chain order (oldest first), bounded like the daemon-side key chain. */
export async function loadLeaseKeyRotations(db: Executor): Promise<LeaseKeyRotationRow[]> {
  const rows = await db.select().from(availabilityLeaseKeyRotations);
  return rows
    .sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.keyId.localeCompare(right.keyId)
    )
    .slice(-MAX_KEY_ROTATION_LINKS);
}

/** Lease state of a policy, created in legacy on first use. */
export async function ensureLeaseState(db: Executor, policyId: string): Promise<LeaseStateRow> {
  await db.insert(dockerAvailabilityLeaseState).values({ policyId }).onConflictDoNothing();
  const [row] = await db
    .select()
    .from(dockerAvailabilityLeaseState)
    .where(eq(dockerAvailabilityLeaseState.policyId, policyId))
    .limit(1);
  if (!row) throw new Error(`Availability lease state for policy ${policyId} is unavailable`);
  return row;
}

/** The members a relay last reported a live Coordinate stream from, and when. */
export interface RelayConnectedMembers {
  memberIds: readonly string[];
  reportedAt: number;
}

/**
 * Members a relay recently reported a live Coordinate stream from: reachable through the data plane before their own
 * report arrives. After a Gateway restart the local relay reports within seconds, while the nodes' control sessions
 * reconnect only after their backoff (stand run ha18/b). Members known to abstain are left out.
 */
export function relayConnectedMemberIds(
  members: LeaseMemberRow[],
  connections: Iterable<RelayConnectedMembers>,
  now: number,
  freshMs: number
): Set<string> {
  const abstaining = new Set(members.filter((member) => member.abstaining).map((member) => member.memberId));
  const reachable = new Set<string>();
  for (const connection of connections) {
    if (now - connection.reportedAt > freshMs) continue;
    for (const id of connection.memberIds) {
      if (!abstaining.has(id)) reachable.add(id);
    }
  }
  return reachable;
}

/** Members whose report is recent and who do not abstain: the reachable voters (D2 margin). */
export function reachableMemberIds(members: LeaseMemberRow[], now: number, freshMs: number): Set<string> {
  return new Set(
    members
      .filter(
        (member) => !member.abstaining && member.reportedAt !== null && now - member.reportedAt.getTime() <= freshMs
      )
      .map((member) => member.memberId)
  );
}
