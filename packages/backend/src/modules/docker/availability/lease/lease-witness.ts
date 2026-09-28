import { eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerAvailabilityPlacements, nodes, relayInstances } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { AVAILABILITY_LEASE_CAPABILITY } from './lease-constants.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reportedCapabilities(value: unknown): string[] {
  const list = (value as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * A19: a configured witness must be a relay instance or a docker node that advertises availability_lease_v2, is not a
 * candidate of the policy and runs on another host than every known candidate. nginx daemons are observers only.
 * Candidates chosen later (all compatible nodes) are checked at run time; an ineligible witness then falls back to
 * the automatic choice with the warning configured_witness_unavailable.
 */
export async function validateLeaseWitness(
  db: DrizzleClient,
  witness: string,
  scope: { policyId?: string; candidateNodeIds?: readonly string[] }
): Promise<void> {
  if (!UUID.test(witness)) {
    throw new AppError(400, 'AVAILABILITY_WITNESS_INVALID', 'The witness must be a relay instance id or a node id');
  }
  const placementNodes = scope.policyId
    ? (
        await db
          .select({ nodeId: dockerAvailabilityPlacements.nodeId })
          .from(dockerAvailabilityPlacements)
          .where(eq(dockerAvailabilityPlacements.policyId, scope.policyId))
      ).map(({ nodeId }) => nodeId)
    : [];
  const candidates = [...new Set([...(scope.candidateNodeIds ?? []), ...placementNodes])];
  if (candidates.includes(witness)) {
    throw new AppError(400, 'AVAILABILITY_WITNESS_IS_CANDIDATE', 'The witness cannot be a candidate node');
  }
  const [relay] = await db
    .select({
      nodeId: relayInstances.nodeId,
      faultDomainId: relayInstances.faultDomainId,
      capabilities: relayInstances.capabilities,
    })
    .from(relayInstances)
    .where(eq(relayInstances.id, witness))
    .limit(1);
  const [node] = relay
    ? []
    : await db
        .select({
          id: nodes.id,
          type: nodes.type,
          hostIdentityId: nodes.hostIdentityId,
          capabilities: nodes.capabilities,
        })
        .from(nodes)
        .where(eq(nodes.id, witness))
        .limit(1);
  if (!relay && !node) {
    throw new AppError(400, 'AVAILABILITY_WITNESS_NOT_FOUND', 'No relay instance or node has this id');
  }
  if (node && node.type !== 'docker') {
    throw new AppError(400, 'AVAILABILITY_WITNESS_INVALID', 'Only a relay or a Docker node can be a witness');
  }
  const capable = relay
    ? (relay.capabilities?.features ?? []).includes(AVAILABILITY_LEASE_CAPABILITY)
    : reportedCapabilities(node!.capabilities).includes(AVAILABILITY_LEASE_CAPABILITY);
  if (!capable) {
    throw new AppError(
      400,
      'AVAILABILITY_WITNESS_NOT_CAPABLE',
      'The witness does not run a version with data-plane failover (availability_lease_v2)'
    );
  }
  const witnessNodeId = relay ? relay.nodeId : node!.id;
  const hostOf = new Map<string, string>();
  const nodeIds = [...candidates, ...(witnessNodeId ? [witnessNodeId] : [])];
  if (nodeIds.length > 0) {
    for (const row of await db
      .select({ id: nodes.id, hostIdentityId: nodes.hostIdentityId })
      .from(nodes)
      .where(inArray(nodes.id, nodeIds))) {
      hostOf.set(row.id, row.hostIdentityId ?? row.id);
    }
  }
  const witnessHost = witnessNodeId ? hostOf.get(witnessNodeId) : undefined;
  if (witnessHost && candidates.some((candidate) => hostOf.get(candidate) === witnessHost)) {
    throw new AppError(400, 'AVAILABILITY_WITNESS_SAME_HOST', 'The witness runs on the same host as a candidate');
  }
}
