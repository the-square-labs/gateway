import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  containerLinkPlacements,
  dockerAvailabilityLeaseState,
  dockerAvailabilityPlacements,
  managedDatabaseBindingPlacements,
  proxyAdditionalSecureLinks,
} from '@/db/schema/index.js';

/** A relay endpoint or route as the policy snapshot builder knows it. */
export interface RelayLeaseOwner {
  id: string;
  ownerKind: string;
  ownerId: string;
}

/** relay.v1 EndpointPolicy.lease_policy_id (10) and RoutePolicy.lease_policy_id (12), keyed by endpoint or route id. */
export interface RelayLeasePolicyIds {
  endpoints: Map<string, string>;
  routes: Map<string, string>;
}

/**
 * Which relay endpoints and routes the relay must admit only through its lease gate (A2.4, A8, A11): the Secure
 * Link endpoints of every Availability member (serving or dormant), the container link endpoints of every target
 * placement, and the managed-database binding routes of every placement, for policies in lease mode only.
 * Bootstrapping keeps legacy admission so the legacy serving copy keeps its registration until its first commit;
 * closing and legacy clear the field.
 */
export async function relayLeasePolicyIds(
  db: DrizzleClient,
  endpoints: RelayLeaseOwner[],
  routes: RelayLeaseOwner[]
): Promise<RelayLeasePolicyIds> {
  const result: RelayLeasePolicyIds = { endpoints: new Map(), routes: new Map() };
  const linkIds = endpoints.filter((endpoint) => endpoint.ownerKind === 'proxy_host_secure_link').map((e) => e.ownerId);
  const projectionIds = routes.filter((route) => route.ownerKind === 'managed_database_binding').map((r) => r.ownerId);
  const targetIds = endpoints.filter((endpoint) => endpoint.ownerKind === 'container_link').map((e) => e.ownerId);
  if (linkIds.length === 0 && projectionIds.length === 0 && targetIds.length === 0) return result;
  const leasePolicies = new Set(
    (
      await db
        .select({ policyId: dockerAvailabilityLeaseState.policyId })
        .from(dockerAvailabilityLeaseState)
        .where(eq(dockerAvailabilityLeaseState.mode, 'lease'))
    ).map(({ policyId }) => policyId)
  );
  if (leasePolicies.size === 0) return result;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const [members, projections, targets] = await Promise.all([
    linkIds.some((id) => uuid.test(id))
      ? db
          .select({ ownerId: proxyAdditionalSecureLinks.id, policyId: dockerAvailabilityPlacements.policyId })
          .from(proxyAdditionalSecureLinks)
          .innerJoin(
            dockerAvailabilityPlacements,
            eq(dockerAvailabilityPlacements.id, proxyAdditionalSecureLinks.referenceId)
          )
          .where(
            and(
              eq(proxyAdditionalSecureLinks.purpose, 'availability_member'),
              inArray(
                proxyAdditionalSecureLinks.id,
                linkIds.filter((id) => uuid.test(id))
              )
            )
          )
      : [],
    projectionIds.some((id) => uuid.test(id))
      ? db
          .select({ ownerId: managedDatabaseBindingPlacements.id, policyId: dockerAvailabilityPlacements.policyId })
          .from(managedDatabaseBindingPlacements)
          .innerJoin(
            dockerAvailabilityPlacements,
            eq(dockerAvailabilityPlacements.id, managedDatabaseBindingPlacements.availabilityPlacementId)
          )
          .where(
            and(
              isNotNull(managedDatabaseBindingPlacements.availabilityPlacementId),
              inArray(
                managedDatabaseBindingPlacements.id,
                projectionIds.filter((id) => uuid.test(id))
              )
            )
          )
      : [],
    // A container link reaches an Availability target through one endpoint per target placement; the link's own
    // endpoint (a single-node target) is not a placement and stays ungated.
    targetIds.some((id) => uuid.test(id))
      ? db
          .select({ ownerId: containerLinkPlacements.id, policyId: dockerAvailabilityPlacements.policyId })
          .from(containerLinkPlacements)
          .innerJoin(
            dockerAvailabilityPlacements,
            eq(dockerAvailabilityPlacements.id, containerLinkPlacements.availabilityPlacementId)
          )
          .where(
            and(
              eq(containerLinkPlacements.role, 'target'),
              inArray(
                containerLinkPlacements.id,
                targetIds.filter((id) => uuid.test(id))
              )
            )
          )
      : [],
  ]);
  const memberPolicy = new Map(members.map((row) => [row.ownerId, row.policyId]));
  for (const row of targets) memberPolicy.set(`container_link:${row.ownerId}`, row.policyId);
  const projectionPolicy = new Map(projections.map((row) => [row.ownerId, row.policyId]));
  for (const endpoint of endpoints) {
    const policyId =
      endpoint.ownerKind === 'proxy_host_secure_link'
        ? memberPolicy.get(endpoint.ownerId)
        : endpoint.ownerKind === 'container_link'
          ? memberPolicy.get(`container_link:${endpoint.ownerId}`)
          : undefined;
    if (policyId && leasePolicies.has(policyId)) result.endpoints.set(endpoint.id, policyId);
  }
  for (const route of routes) {
    const policyId = route.ownerKind === 'managed_database_binding' ? projectionPolicy.get(route.ownerId) : undefined;
    if (policyId && leasePolicies.has(policyId)) result.routes.set(route.id, policyId);
  }
  return result;
}
