import { eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAvailabilityLeaseState,
  dockerAvailabilityPlacements,
  nodes,
  type proxyAdditionalSecureLinks,
} from '@/db/schema/index.js';

type LinkRow = typeof proxyAdditionalSecureLinks.$inferSelect;

/** Capability of daemons that gate Availability member sockets and connectors by the data-plane lease (D8). */
const AVAILABILITY_LEASE_CAPABILITY = 'availability_lease_v1';

export interface AvailabilityMemberSyncContext {
  /** The daemon receiving the bindings understands dormant members. */
  leaseCapable: boolean;
  policyByPlacement: Map<string, string>;
  /** Policies in lease mode: only their members are gated by the lease (B2). */
  leasePolicies: ReadonlySet<string>;
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
  if (placementIds.length === 0) return { leaseCapable: false, policyByPlacement: new Map(), leasePolicies: new Set() };
  const [[node], placements, leaseStates] = await Promise.all([
    db.select({ capabilities: nodes.capabilities }).from(nodes).where(eq(nodes.id, nodeId)).limit(1),
    db
      .select({ id: dockerAvailabilityPlacements.id, policyId: dockerAvailabilityPlacements.policyId })
      .from(dockerAvailabilityPlacements)
      .where(inArray(dockerAvailabilityPlacements.id, placementIds)),
    db
      .select({ policyId: dockerAvailabilityLeaseState.policyId })
      .from(dockerAvailabilityLeaseState)
      .where(eq(dockerAvailabilityLeaseState.mode, 'lease')),
  ]);
  const reported = (node?.capabilities as Record<string, unknown> | null | undefined)?.capabilities;
  return {
    leaseCapable: Array.isArray(reported) && reported.includes(AVAILABILITY_LEASE_CAPABILITY),
    policyByPlacement: new Map(placements.map((placement) => [placement.id, placement.policyId])),
    leasePolicies: new Set(leaseStates.map(({ policyId }) => policyId)),
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
  const policyId = context.policyByPlacement.get(binding.referenceId);
  // B2: only a lease-mode policy's members are gated by the lease; bootstrapping, closing and legacy members keep
  // today's always-open sockets. The field is cleared as soon as the policy leaves lease mode (the sync is complete).
  if (!policyId || !context.leasePolicies.has(policyId)) return { dormant: binding.dormant };
  // In lease mode the lease, not the member's dormant flag, decides where the workload runs (D8), and Gateway learns
  // it after the fact: a successor's container starts after Gateway already marked its member live, and a takeover
  // happens while Gateway still marks the member dormant. Every lease-mode member is sent dormant, so a target daemon
  // keeps it committed while its container is stopped and binds it once the holder starts, instead of rejecting the
  // whole set; a rejected member used to be dropped from the node's committed bindings.
  return { dormant: true, availabilityPolicyId: policyId, availabilityCandidateId: binding.dockerNodeId };
}
