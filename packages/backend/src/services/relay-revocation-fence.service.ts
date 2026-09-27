import { eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { relayEndpoints, relayInstances, relayPolicyState, relayPools, relayRoutes } from '@/db/schema/index.js';
import type { RelayPolicyRouteEntry } from '@/db/schema/relay.js';
import {
  type BuiltPolicyRoute,
  type CurrentPolicyRoute,
  projectBuiltRoutes,
  type RelayRevokedRouteFence,
  reconcileRevocations,
  revocationFencesForEndpoints,
  staleRelaysByRoute,
  trustedAcknowledgement,
} from './relay-revocation-fence.js';

/** Serializes route history writes with policy snapshot builds, which hold the same lock. */
export const RELAY_POLICY_REVISION_LOCK = 'gateway-relay-remote-policy-revision';

const HAS_UNACKNOWLEDGED_REMOVAL = sql`jsonb_path_exists(${relayInstances.policyRoutes}, '$[*] ? (exists(@.removedAtRevision))')`;
const HAS_STALE_ROUTE = sql`jsonb_path_exists(${relayInstances.policyRoutes}, '$[*] ? (exists(@.staleAt))')`;

export interface RelayRevocationTransition {
  instanceId: string;
  poolId: string;
  displayName: string;
  /** Whether the relay is now stale for at least one revoked route. */
  stale: boolean;
  staleRoutes: number;
}

export interface RelayRevocationOutcome {
  transitions: RelayRevocationTransition[];
  /** Daemons whose grant bundles change: sources lose the stale relay, endpoints gain or lose fences. */
  nodeIds: string[];
}

const NO_OUTCOME: RelayRevocationOutcome = { transitions: [], nodeIds: [] };

/**
 * Records, inside a snapshot build transaction that holds RELAY_POLICY_REVISION_LOCK, the route
 * tuples the snapshot carries for the relay, keeping earlier tuples until it acknowledges.
 */
export async function recordBuiltPolicyRoutes(
  tx: Pick<DrizzleClient, 'update'>,
  instance: { id: string; policyRoutes?: RelayPolicyRouteEntry[] | null },
  built: BuiltPolicyRoute[],
  revision: number
): Promise<void> {
  await tx
    .update(relayInstances)
    .set({ policyRoutes: projectBuiltRoutes(instance.policyRoutes, built, revision) })
    .where(eq(relayInstances.id, instance.id));
}

/** Relays stale for at least one revoked route, with their route history. */
export async function loadStaleRelayRoutes(
  db: Pick<DrizzleClient, 'select'>
): Promise<Array<{ id: string; policyRoutes: RelayPolicyRouteEntry[] | null }>> {
  return db
    .select({ id: relayInstances.id, policyRoutes: relayInstances.policyRoutes })
    .from(relayInstances)
    .where(HAS_STALE_ROUTE);
}

/** What grant issuance needs to keep stale relays away from the routes they may still admit. */
export async function loadRevocationFenceState(db: Pick<DrizzleClient, 'select'>) {
  const stale = await loadStaleRelayRoutes(db);
  return {
    staleRelaysByRoute: staleRelaysByRoute(stale),
    async fencesForEndpoints(endpointIds: string[]): Promise<RelayRevokedRouteFence[]> {
      const endpoints = new Set(endpointIds);
      const routeIds = [
        ...new Set(
          stale.flatMap(({ policyRoutes }) =>
            (policyRoutes ?? [])
              .filter((entry) => entry.staleAt && endpoints.has(entry.endpointId))
              .map(({ routeId }) => routeId)
          )
        ),
      ];
      if (!routeIds.length) return [];
      const routes = await db
        .select({
          id: relayRoutes.id,
          generation: relayRoutes.generation,
          targetEndpointId: relayRoutes.targetEndpointId,
        })
        .from(relayRoutes)
        .where(inArray(relayRoutes.id, routeIds));
      return revocationFencesForEndpoints(
        stale,
        endpoints,
        new Map(routes.map((route) => [route.id, route satisfies CurrentPolicyRoute]))
      );
    },
  };
}

/**
 * Tracks, per relay, the route tuples it may still admit and whether it applied the policy that
 * revoked them in time. Relays report the revision they applied every few seconds, so a relay
 * that Gateway can reach clears a revocation long before the deadline; one cut off from Gateway
 * does not, and becomes stale only for the revoked routes.
 */
export class RelayRevocationFenceService {
  private lastEvaluatedRevision: number | null = null;

  constructor(private readonly db: DrizzleClient) {}

  async evaluate(now = new Date(), judgeFrom = 0): Promise<RelayRevocationOutcome> {
    const [state] = await this.db
      .select({ revision: relayPolicyState.revision })
      .from(relayPolicyState)
      .where(eq(relayPolicyState.id, 'current'))
      .limit(1);
    if (!state) return NO_OUTCOME;
    // Tuples turn into revocations only when the policy changes; otherwise only relays still
    // holding dropped tuples can acknowledge them or run past their deadline.
    const full = state.revision !== this.lastEvaluatedRevision;
    const candidates = await this.db
      .select({ id: relayInstances.id })
      .from(relayInstances)
      .where(full ? isNotNull(relayInstances.policyRoutes) : HAS_UNACKNOWLEDGED_REMOVAL);
    if (!candidates.length) {
      this.lastEvaluatedRevision = state.revision;
      return NO_OUTCOME;
    }
    const outcome = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${RELAY_POLICY_REVISION_LOCK}))`);
      // One connection: the reads run in turn.
      const instances = await tx
        .select({
          id: relayInstances.id,
          poolId: relayInstances.poolId,
          displayName: relayInstances.displayName,
          appliedPolicyRevision: relayInstances.appliedPolicyRevision,
          policyRoutes: relayInstances.policyRoutes,
        })
        .from(relayInstances)
        .where(
          inArray(
            relayInstances.id,
            candidates.map(({ id }) => id)
          )
        );
      const pools = await tx.select({ id: relayPools.id, revision: relayPools.desiredPolicyRevision }).from(relayPools);
      const routes = await tx
        .select({
          id: relayRoutes.id,
          generation: relayRoutes.generation,
          targetEndpointId: relayRoutes.targetEndpointId,
          sourceKind: relayRoutes.sourceKind,
          sourceId: relayRoutes.sourceId,
        })
        .from(relayRoutes);
      const endpoints = await tx
        .select({
          id: relayEndpoints.id,
          generation: relayEndpoints.generation,
          subjectKind: relayEndpoints.subjectKind,
          subjectId: relayEndpoints.subjectId,
        })
        .from(relayEndpoints);
      const poolRevisions = new Map(pools.map((pool) => [pool.id, pool.revision]));
      const routeById = new Map(routes.map((route) => [route.id, route]));
      const endpointById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
      const endpointGenerations = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint.generation]));
      const transitions: RelayRevocationTransition[] = [];
      const nodeIds = new Set<string>();
      for (const instance of instances) {
        const issued = poolRevisions.get(instance.poolId) ?? 0;
        const reconciled = reconcileRevocations(instance.policyRoutes, {
          acknowledgedRevision: trustedAcknowledgement(instance.appliedPolicyRevision, issued),
          nextRevision: issued + 1,
          routes: routeById,
          endpointGenerations,
          now,
          judgeFrom,
        });
        if (!reconciled.changed) continue;
        await tx
          .update(relayInstances)
          .set({ policyRoutes: reconciled.entries })
          .where(eq(relayInstances.id, instance.id));
        if (!reconciled.newlyStale.length && !reconciled.cleared.length) continue;
        const staleRoutes = new Set(reconciled.entries.filter((e) => e.staleAt).map(({ routeId }) => routeId));
        transitions.push({
          instanceId: instance.id,
          poolId: instance.poolId,
          displayName: instance.displayName,
          stale: staleRoutes.size > 0,
          staleRoutes: staleRoutes.size,
        });
        for (const entry of [...reconciled.newlyStale, ...reconciled.cleared]) {
          const route = routeById.get(entry.routeId);
          if (route?.sourceKind === 'daemon') nodeIds.add(route.sourceId);
          const endpoint = endpointById.get(entry.endpointId);
          if (endpoint?.subjectKind === 'daemon') nodeIds.add(endpoint.subjectId);
        }
      }
      return { transitions, nodeIds: [...nodeIds].sort() };
    });
    this.lastEvaluatedRevision = state.revision;
    return outcome;
  }
}
