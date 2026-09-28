import { createHash } from 'node:crypto';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { ingressMemberDeliveries } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

export const INGRESS_MEMBER_OFFLINE_MESSAGE =
  'The ingress node is offline; the route is delivered to it when it reconnects';

export interface IngressMemberFailure {
  nodeId: string;
  message: string;
}

/**
 * A group route did not reach every connected member. `appliedNodeIds` already serve the new config; callers that
 * roll back re-deliver the previous state there. Offline members are not failures: they converge on reconnect.
 */
export class IngressDeliveryError extends AppError {
  constructor(
    readonly hostId: string,
    readonly appliedNodeIds: string[],
    readonly failures: IngressMemberFailure[],
    readonly offlineNodeIds: string[]
  ) {
    super(
      failures.length > 0 ? 502 : 409,
      failures.length > 0 ? 'INGRESS_GROUP_DELIVERY_FAILED' : 'INGRESS_GROUP_UNAVAILABLE',
      failures.length > 0
        ? `The route could not be applied on ${failures.length} ingress group member(s): ${failures
            .map((failure) => `${failure.nodeId}: ${failure.message}`)
            .join('; ')}`
        : 'No member of the ingress group is connected; the route was not applied anywhere',
      { hostId, appliedNodeIds, failures, offlineNodeIds }
    );
  }
}

export function ingressConfigHash(config: string): string {
  return createHash('sha256').update(config).digest('hex');
}

type DeliveryPatch = Partial<Omit<typeof ingressMemberDeliveries.$inferInsert, 'hostId' | 'nodeId'>>;

/** Upserts the delivery state of one member of a group route. */
export async function markIngressMemberDelivery(
  db: DrizzleExecutor,
  hostId: string,
  nodeId: string,
  patch: DeliveryPatch
): Promise<void> {
  const values = { ...patch, updatedAt: new Date() };
  await db
    .insert(ingressMemberDeliveries)
    .values({ hostId, nodeId, ...values })
    .onConflictDoUpdate({ target: [ingressMemberDeliveries.hostId, ingressMemberDeliveries.nodeId], set: values });
}

/** Drops delivery rows of a host: all of them, only `nodeIds`, or all except `keepNodeIds`. */
export async function forgetIngressMemberDeliveries(
  db: DrizzleExecutor,
  hostId: string,
  options: { nodeIds?: string[]; keepNodeIds?: string[] } = {}
): Promise<void> {
  if (options.nodeIds && options.nodeIds.length === 0) return;
  await db
    .delete(ingressMemberDeliveries)
    .where(
      and(
        eq(ingressMemberDeliveries.hostId, hostId),
        options.nodeIds ? inArray(ingressMemberDeliveries.nodeId, options.nodeIds) : undefined,
        options.keepNodeIds?.length ? notInArray(ingressMemberDeliveries.nodeId, options.keepNodeIds) : undefined
      )
    );
}

/** Delivery rows of hosts (for API views and the convergence reconciler). */
export async function listIngressMemberDeliveries(db: DrizzleExecutor, hostIds: string[]) {
  if (hostIds.length === 0) return [];
  return db.select().from(ingressMemberDeliveries).where(inArray(ingressMemberDeliveries.hostId, hostIds));
}

/** Members whose delivery is not confirmed (pending or failed), oldest attempt first. */
export async function unsettledIngressMemberDeliveries(db: DrizzleExecutor, limit = 200) {
  return db
    .select()
    .from(ingressMemberDeliveries)
    .where(inArray(ingressMemberDeliveries.status, ['pending', 'failed']))
    .orderBy(sql`${ingressMemberDeliveries.attemptedAt} asc nulls first`)
    .limit(limit);
}
