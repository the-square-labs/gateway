import { eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerAvailabilityPlacements, nodes, type proxyAdditionalSecureLinks } from '@/db/schema/index.js';

type LinkRow = typeof proxyAdditionalSecureLinks.$inferSelect;

/** Capability of daemons that gate Availability member sockets and connectors by the data-plane lease (D8). */
const AVAILABILITY_LEASE_CAPABILITY = 'availability_lease_v1';

export interface AvailabilityMemberSyncContext {
  /** The daemon receiving the bindings understands dormant members. */
  leaseCapable: boolean;
  policyByPlacement: Map<string, string>;
}

/** Lease fields of an Availability member binding in SyncProxySecureLinksCommand. */
export interface AvailabilityMemberBindingFields {
  dormant?: boolean;
  availabilityPolicyId?: string;
  availabilityCandidateId?: string;
}

/**
 * What a secure-link sync needs to describe Availability members: whether the daemon understands dormant members,
 * and the lease policy of each member's placement. Nothing is queried when the node has no Availability member.
 */
export async function availabilityMemberSyncContext(
  db: DrizzleClient,
  nodeId: string,
  bindings: LinkRow[]
): Promise<AvailabilityMemberSyncContext> {
  const placementIds = bindings
    .filter((binding) => binding.purpose === 'availability_member' && binding.referenceId)
    .map((binding) => binding.referenceId!);
  if (placementIds.length === 0) return { leaseCapable: false, policyByPlacement: new Map() };
  const [[node], placements] = await Promise.all([
    db.select({ capabilities: nodes.capabilities }).from(nodes).where(eq(nodes.id, nodeId)).limit(1),
    db
      .select({ id: dockerAvailabilityPlacements.id, policyId: dockerAvailabilityPlacements.policyId })
      .from(dockerAvailabilityPlacements)
      .where(inArray(dockerAvailabilityPlacements.id, placementIds)),
  ]);
  const reported = (node?.capabilities as Record<string, unknown> | null | undefined)?.capabilities;
  return {
    leaseCapable: Array.isArray(reported) && reported.includes(AVAILABILITY_LEASE_CAPABILITY),
    policyByPlacement: new Map(placements.map((placement) => [placement.id, placement.policyId])),
  };
}

/**
 * A daemon without availability_lease_v1 would serve a dormant member like any other; it never receives one, so a
 * standby is reachable only through daemons that open its socket only while it holds the lease.
 */
export function syncableAvailabilityMember(binding: LinkRow, context: AvailabilityMemberSyncContext): boolean {
  return !binding.dormant || context.leaseCapable;
}

export function availabilityMemberBindingFields(
  binding: LinkRow,
  context: AvailabilityMemberSyncContext
): AvailabilityMemberBindingFields {
  if (binding.purpose !== 'availability_member' || !binding.referenceId) return {};
  return {
    dormant: binding.dormant,
    availabilityPolicyId: context.policyByPlacement.get(binding.referenceId) ?? '',
    availabilityCandidateId: binding.dockerNodeId,
  };
}
