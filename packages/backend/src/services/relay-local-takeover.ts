import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayEndpoints,
  relayInstances,
  relayRoutes,
} from '@/db/schema/index.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from './event-bus.service.js';
import type { RelayPolicyService } from './relay-policy.service.js';

/**
 * A Relay Pool update recreates the local Compose relay last. When another relay can carry the local relay's
 * workloads, the update drains it like a remote relay first, so its sessions move instead of dropping when the
 * container is recreated. Only the update drains the local relay; an operator cannot.
 */

type RelayInstanceRow = typeof relayInstances.$inferSelect;

const EVACUATION_POLL_MS = 2_000;

/** The workloads the local relay carries sessions for: endpoints of its active assignments that some route targets. */
async function localRelayRoutedEndpoints(db: DrizzleClient, localInstanceId: string) {
  const assigned = await db
    .selectDistinct({ id: relayEndpoints.id, ownerKind: relayEndpoints.ownerKind })
    .from(relayEndpointAssignments)
    .innerJoin(
      relayEndpointAssignmentGenerations,
      eq(relayEndpointAssignments.assignmentGenerationId, relayEndpointAssignmentGenerations.id)
    )
    .innerJoin(relayEndpoints, eq(relayEndpointAssignmentGenerations.endpointId, relayEndpoints.id))
    .where(
      and(
        eq(relayEndpointAssignments.relayInstanceId, localInstanceId),
        eq(relayEndpointAssignmentGenerations.state, 'active'),
        eq(relayEndpoints.status, 'active')
      )
    );
  if (!assigned.length) return [];
  const routed = await db
    .selectDistinct({ id: relayRoutes.targetEndpointId })
    .from(relayRoutes)
    .where(
      inArray(
        relayRoutes.targetEndpointId,
        assigned.map(({ id }) => id)
      )
    );
  const routedIds = new Set(routed.map(({ id }) => id));
  return assigned.filter(({ id }) => routedIds.has(id));
}

/**
 * Why no other relay can carry the local relay's workloads while an update recreates it, or null when one can: a
 * connected remote relay is ready with a valid policy (every pool member is its own fault domain), and every workload
 * with a route can move to it. The internal registry and paths with a daemon without Relay Pool support are served
 * only by the local relay, and a workload whose node reaches no relay off the Gateway host cannot move; a drain would
 * refuse their new sessions for the whole drain instead of dropping the open ones for a second.
 */
export async function localRelayTakeoverBlocker(
  db: DrizzleClient,
  policy: Pick<RelayPolicyService, 'isRemoteInstanceConnected' | 'poolIncapableEndpointIds'>,
  pool: { instances: RelayInstanceRow[]; gatewayHostOnlyEndpointIds: ReadonlySet<string> },
  localInstanceId: string,
  now = Date.now()
): Promise<string | null> {
  const local = pool.instances.find(({ id }) => id === localInstanceId);
  if (!local) return 'the local relay is not in the Relay Pool';
  const takeover = pool.instances.some(
    (instance) =>
      instance.kind === 'remote' &&
      instance.state === 'ready' &&
      Boolean(instance.capabilities?.features?.includes('relay_pool_v1')) &&
      Boolean(instance.policyExpiresAt && instance.policyExpiresAt.getTime() > now) &&
      Boolean(instance.nodeId && policy.isRemoteInstanceConnected(instance.nodeId))
  );
  if (!takeover) return 'no other relay was ready to take its workloads over';
  const endpoints = await localRelayRoutedEndpoints(db, local.id);
  if (endpoints.some(({ ownerKind }) => ownerKind === 'internal_registry')) {
    return 'nodes pull images from the internal registry through it, and only the local relay serves the registry';
  }
  const endpointIds = endpoints.map(({ id }) => id);
  const legacy = endpointIds.length ? await policy.poolIncapableEndpointIds(endpointIds) : new Set<string>();
  if (legacy.size) {
    return `${legacy.size} workload(s) have a daemon without Relay Pool support on their path, which only the local relay serves`;
  }
  const hostOnly = endpointIds.filter((id) => pool.gatewayHostOnlyEndpointIds.has(id)).length;
  if (hostOnly) return `${hostOnly} workload(s) reach no relay outside the Gateway host`;
  return null;
}

/**
 * Waits until the drained local relay carries no workload with a route any more, the evacuation having moved them
 * to other relays. False at the deadline: some workload could not move, and the drain must not refuse its sessions.
 */
export async function waitForLocalRelayEvacuation(
  db: DrizzleClient,
  localInstanceId: string,
  timeoutMs: number,
  throwIfAbandoned: () => void
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    throwIfAbandoned();
    if (!(await localRelayRoutedEndpoints(db, localInstanceId)).length) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, EVACUATION_POLL_MS));
  }
}

interface LocalRelayDrainDeps {
  db: DrizzleClient;
  policy: Pick<RelayPolicyService, 'setLocalInstanceDrain' | 'reconcileAndSync'>;
  audit: Pick<AuditService, 'log'>;
  events: Pick<EventBusService, 'publish'>;
}

/** Drains or resumes the local relay for an update. The command goes first: a relay that refused it is left as it was. */
export async function setLocalRelayUpdateDrain(
  deps: LocalRelayDrainDeps,
  instance: RelayInstanceRow,
  userId: string | null,
  enabled: boolean
): Promise<void> {
  await deps.policy.setLocalInstanceDrain(enabled);
  // The relay's health reports carry the state from now on; an unavailable relay keeps its own state.
  await deps.db
    .update(relayInstances)
    .set({
      state: enabled ? 'draining' : 'ready',
      drainForcedAt: enabled ? instance.drainForcedAt : null,
      updatedAt: new Date(),
    })
    .where(and(eq(relayInstances.id, instance.id), inArray(relayInstances.state, ['ready', 'draining'])));
  await deps.policy.reconcileAndSync();
  await deps.audit.log({
    userId,
    action: enabled ? 'relay.instance.drain' : 'relay.instance.resume',
    resourceType: 'relay_instance',
    resourceId: instance.id,
    details: {},
  });
  deps.events.publish('system.relay.health.changed', { poolId: instance.poolId, instanceId: instance.id });
}
