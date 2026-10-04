import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { relayEndpoints, relayRoutes } from '@/db/schema/index.js';
import type { RelayManagedDatabaseListenerConfig, RelaySecureLinkEgressConfig } from '@/db/schema/relay.js';
import { RELAY_MAX_FRAME_BYTES } from '@/grpc/relay-control.client.js';
import { bumpRelayPolicyRevision } from './relay-policy-reconciler.js';

export const CONTAINER_LINK_OWNER_KIND = 'container_link';

/** What the source daemon of a link route serves locally: the host listener, the connector egress, or both. */
export interface RelayRouteTransport {
  managedDatabaseListener: RelayManagedDatabaseListenerConfig | null;
  secureLinkEgress: RelaySecureLinkEgressConfig | null;
}

/** The stored egress equals the desired one, `consumersUseAlias` included (whether the route must be written). */
export function secureLinkEgressEqual(
  current: RelaySecureLinkEgressConfig | null | undefined,
  desired: RelaySecureLinkEgressConfig | null | undefined
): boolean {
  if (!current || !desired) return current == null && desired == null;
  return (
    secureLinkEgressServesEqual(current, desired) &&
    (current.consumersUseAlias ?? false) === (desired.consumersUseAlias ?? false)
  );
}

/**
 * The egress listens the same way (network, alias, port, sessions, TLS). `consumersUseAlias` only tells the daemon how
 * to recreate consumers, so it never moves the route's generation (routeTransportRestartRequired).
 */
export function secureLinkEgressServesEqual(
  current: RelaySecureLinkEgressConfig,
  desired: RelaySecureLinkEgressConfig
): boolean {
  return (
    current.networkName === desired.networkName &&
    current.alias === desired.alias &&
    current.listenPort === desired.listenPort &&
    (current.maxSessions ?? 0) === (desired.maxSessions ?? 0) &&
    (current.tlsCaPem ?? '') === (desired.tlsCaPem ?? '') &&
    (current.tlsServerName ?? '') === (desired.tlsServerName ?? '')
  );
}

/** Field by field (jsonb read back from Postgres does not keep key order); admitted sources in any order. */
export function listenerConfigsEqual(
  current: RelayManagedDatabaseListenerConfig | null | undefined,
  desired: RelayManagedDatabaseListenerConfig | null | undefined
): boolean {
  if (!current || !desired) return current == null && desired == null;
  const sources = (config: RelayManagedDatabaseListenerConfig) => [...(config.allowedSources ?? [])].sort().join('\n');
  return (
    current.networkName === desired.networkName &&
    current.listenAddress === desired.listenAddress &&
    current.listenPort === desired.listenPort &&
    sources(current) === sources(desired)
  );
}

/**
 * Whether a change of what the source daemon serves must move the route's generation. A new generation makes the
 * relay close the route's tunnels, so adding or removing one of the two entry points while the other serves (the
 * migration to the shared connector and its revert) keeps it: the connections of the entry point that stays survive.
 * Changing an entry point that keeps serving (another network, address, port or TLS) moves it, and so does adding or
 * removing the only one, as before.
 */
export function routeTransportRestartRequired(current: RelayRouteTransport, desired: RelayRouteTransport): boolean {
  const [fromListener, toListener] = [current.managedDatabaseListener, desired.managedDatabaseListener];
  const [fromEgress, toEgress] = [current.secureLinkEgress, desired.secureLinkEgress];
  const listenerKept = Boolean(fromListener && toListener);
  const egressKept = Boolean(fromEgress && toEgress);
  if (
    listenerKept &&
    (fromListener!.networkName !== toListener!.networkName ||
      fromListener!.listenAddress !== toListener!.listenAddress ||
      fromListener!.listenPort !== toListener!.listenPort)
  ) {
    return true;
  }
  if (egressKept && !secureLinkEgressServesEqual(fromEgress!, toEgress!)) return true;
  // The listener added or removed while the connector keeps serving (the migration and its revert) moves nothing;
  // the only local entry point of a route added or removed restarts it, as before.
  if (Boolean(fromListener) !== Boolean(toListener) && !egressKept) return true;
  // The connector added or removed restarts nothing: the listener keeps serving, or the route had no local entry
  // point the daemon serves (a container link route, a storage route its sidecar serves).
  return false;
}

export interface RelayLinkRouteHost {
  db: DrizzleClient;
  requireNodeIdentity(nodeId: string): Promise<{ certificateFingerprint: string }>;
  syncSnapshot(): Promise<number>;
  syncNodeGrants(nodeId: string, options?: { skipUnchanged?: boolean }): Promise<void>;
  policyNodeIds(): Promise<string[]>;
  ensureEndpointAssignment(endpointId: string): Promise<void>;
}

/**
 * Relay endpoints and routes of links served by the shared secure-link connector: the connector egress of storage,
 * database and container links on their source nodes, and the per-source-node routes and target endpoints of
 * container links.
 */
export class RelayLinkRoutes {
  constructor(private readonly host: RelayLinkRouteHost) {}

  /**
   * Sets what the source daemon of one link route serves locally, without moving the route unless an entry point
   * that keeps serving changes (routeTransportRestartRequired). `undefined` keeps a field. Returns the route and its
   * generation, or null when the link has no route from that node.
   */
  async setRouteTransport(
    ownerKind: string,
    ownerId: string,
    sourceNodeId: string,
    change: {
      secureLinkEgress?: RelaySecureLinkEgressConfig | null;
      managedDatabaseListener?: RelayManagedDatabaseListenerConfig | null;
    }
  ): Promise<{ routeId: string; generation: number } | null> {
    const result = await this.host.db.transaction(async (tx) => {
      const [route] = await tx
        .select()
        .from(relayRoutes)
        .where(
          and(
            eq(relayRoutes.ownerKind, ownerKind),
            eq(relayRoutes.ownerId, ownerId),
            eq(relayRoutes.sourceKind, 'daemon'),
            eq(relayRoutes.sourceId, sourceNodeId)
          )
        )
        .limit(1);
      if (!route) return null;
      const current: RelayRouteTransport = {
        managedDatabaseListener: route.managedDatabaseListener ?? null,
        secureLinkEgress: route.secureLinkEgress ?? null,
      };
      const desired: RelayRouteTransport = {
        managedDatabaseListener:
          change.managedDatabaseListener === undefined
            ? current.managedDatabaseListener
            : change.managedDatabaseListener,
        secureLinkEgress: change.secureLinkEgress === undefined ? current.secureLinkEgress : change.secureLinkEgress,
      };
      const listenerSame = listenerConfigsEqual(current.managedDatabaseListener, desired.managedDatabaseListener);
      if (listenerSame && secureLinkEgressEqual(current.secureLinkEgress, desired.secureLinkEgress)) {
        return { routeId: route.id, generation: route.generation, changed: false };
      }
      const generation = routeTransportRestartRequired(current, desired) ? route.generation + 1 : route.generation;
      await tx
        .update(relayRoutes)
        .set({
          managedDatabaseListener: desired.managedDatabaseListener,
          secureLinkEgress: desired.secureLinkEgress,
          generation,
          updatedAt: new Date(),
        })
        .where(eq(relayRoutes.id, route.id));
      await bumpRelayPolicyRevision(tx);
      return { routeId: route.id, generation, changed: true };
    });
    if (!result) return null;
    if (result.changed) await this.host.syncSnapshot();
    return { routeId: result.routeId, generation: result.generation };
  }

  /** What one link route from a node serves locally now, or null when the link has no route from that node. */
  async getRouteTransport(
    ownerKind: string,
    ownerId: string,
    sourceNodeId: string
  ): Promise<(RelayRouteTransport & { routeId: string; generation: number }) | null> {
    const [route] = await this.host.db
      .select()
      .from(relayRoutes)
      .where(
        and(
          eq(relayRoutes.ownerKind, ownerKind),
          eq(relayRoutes.ownerId, ownerId),
          eq(relayRoutes.sourceKind, 'daemon'),
          eq(relayRoutes.sourceId, sourceNodeId)
        )
      )
      .limit(1);
    if (!route) return null;
    return {
      routeId: route.id,
      generation: route.generation,
      managedDatabaseListener: route.managedDatabaseListener ?? null,
      secureLinkEgress: route.secureLinkEgress ?? null,
    };
  }

  /** The relay endpoint a container link (or one target placement of it) is served from, on its target node. */
  async ensureContainerLinkEndpoint(
    ownerId: string,
    targetNodeId: string
  ): Promise<{ endpointId: string; formerTargetNodeId: string | null }> {
    const target = await this.host.requireNodeIdentity(targetNodeId);
    const result = await this.host.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(relayEndpoints)
        .where(and(eq(relayEndpoints.ownerKind, CONTAINER_LINK_OWNER_KIND), eq(relayEndpoints.ownerId, ownerId)))
        .limit(1);
      if (!current) {
        const [created] = await tx
          .insert(relayEndpoints)
          .values({
            ownerKind: CONTAINER_LINK_OWNER_KIND,
            ownerId,
            subjectKind: 'daemon',
            subjectId: targetNodeId,
            certificateSha256: target.certificateFingerprint,
          })
          .returning({ id: relayEndpoints.id });
        await bumpRelayPolicyRevision(tx);
        return { endpointId: created!.id, formerTargetNodeId: null };
      }
      if (current.subjectId !== targetNodeId || current.certificateSha256 !== target.certificateFingerprint) {
        await tx
          .update(relayEndpoints)
          .set({
            subjectId: targetNodeId,
            certificateSha256: target.certificateFingerprint,
            generation: current.generation + 1,
            status: 'active',
            updatedAt: new Date(),
          })
          .where(eq(relayEndpoints.id, current.id));
        await bumpRelayPolicyRevision(tx);
      }
      return {
        endpointId: current.id,
        formerTargetNodeId: current.subjectId !== targetNodeId ? current.subjectId : null,
      };
    });
    await this.host.ensureEndpointAssignment(result.endpointId);
    return result;
  }

  /**
   * The route of a container link from one source node to the endpoint that serves it now (the link's own, or the
   * endpoint of the target placement chosen for that node). Moving it to another endpoint moves its generation; its
   * egress follows routeTransportRestartRequired.
   */
  async ensureContainerLinkRoute(
    linkId: string,
    sourceNodeId: string,
    endpointOwnerId: string,
    secureLinkEgress: RelaySecureLinkEgressConfig
  ): Promise<{ routeId: string; generation: number; targetNodeId: string }> {
    const [endpoint] = await this.host.db
      .select({ id: relayEndpoints.id, subjectId: relayEndpoints.subjectId })
      .from(relayEndpoints)
      .where(and(eq(relayEndpoints.ownerKind, CONTAINER_LINK_OWNER_KIND), eq(relayEndpoints.ownerId, endpointOwnerId)))
      .limit(1);
    if (!endpoint) throw new Error('Container link relay endpoint is unavailable');
    const source = await this.host.requireNodeIdentity(sourceNodeId);
    const result = await this.host.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(relayRoutes)
        .where(
          and(
            eq(relayRoutes.ownerKind, CONTAINER_LINK_OWNER_KIND),
            eq(relayRoutes.ownerId, linkId),
            eq(relayRoutes.sourceKind, 'daemon'),
            eq(relayRoutes.sourceId, sourceNodeId)
          )
        )
        .limit(1);
      if (!current) {
        const [created] = await tx
          .insert(relayRoutes)
          .values({
            ownerKind: CONTAINER_LINK_OWNER_KIND,
            ownerId: linkId,
            sourceKind: 'daemon',
            sourceId: sourceNodeId,
            sourceCertificateSha256: source.certificateFingerprint,
            targetEndpointId: endpoint.id,
            maxFrameBytes: RELAY_MAX_FRAME_BYTES,
            secureLinkEgress,
          })
          .returning({ id: relayRoutes.id, generation: relayRoutes.generation });
        await bumpRelayPolicyRevision(tx);
        return { routeId: created!.id, generation: created!.generation, changed: true };
      }
      const moved =
        current.sourceCertificateSha256 !== source.certificateFingerprint || current.targetEndpointId !== endpoint.id;
      const transportRestart = routeTransportRestartRequired(
        { managedDatabaseListener: null, secureLinkEgress: current.secureLinkEgress ?? null },
        { managedDatabaseListener: null, secureLinkEgress }
      );
      if (!moved && secureLinkEgressEqual(current.secureLinkEgress, secureLinkEgress)) {
        return { routeId: current.id, generation: current.generation, changed: false };
      }
      const generation = moved || transportRestart ? current.generation + 1 : current.generation;
      await tx
        .update(relayRoutes)
        .set({
          sourceCertificateSha256: source.certificateFingerprint,
          targetEndpointId: endpoint.id,
          secureLinkEgress,
          generation,
          updatedAt: new Date(),
        })
        .where(eq(relayRoutes.id, current.id));
      await bumpRelayPolicyRevision(tx);
      return { routeId: current.id, generation, changed: true };
    });
    if (result.changed) await this.host.syncSnapshot();
    await this.host.syncNodeGrants(endpoint.subjectId, { skipUnchanged: true });
    return { routeId: result.routeId, generation: result.generation, targetNodeId: endpoint.subjectId };
  }

  /** Removes a container link's route from one source node; its other routes and its endpoints stay. */
  async revokeContainerLinkRoute(linkId: string, sourceNodeId: string): Promise<void> {
    const removed = await this.host.db.transaction(async (tx) => {
      const routes = await tx
        .delete(relayRoutes)
        .where(
          and(
            eq(relayRoutes.ownerKind, CONTAINER_LINK_OWNER_KIND),
            eq(relayRoutes.ownerId, linkId),
            eq(relayRoutes.sourceKind, 'daemon'),
            eq(relayRoutes.sourceId, sourceNodeId)
          )
        )
        .returning({ id: relayRoutes.id });
      if (routes.length) await bumpRelayPolicyRevision(tx);
      return routes.length > 0;
    });
    if (!removed) return;
    await this.host.syncSnapshot();
    const affected = new Set([...(await this.host.policyNodeIds()), sourceNodeId]);
    await Promise.allSettled([...affected].map((nodeId) => this.host.syncNodeGrants(nodeId)));
  }

  /** The routes of a container link (one per source node). */
  containerLinkRoutes(linkId: string) {
    return this.host.db
      .select({
        id: relayRoutes.id,
        ownerKind: relayRoutes.ownerKind,
        ownerId: relayRoutes.ownerId,
        sourceKind: relayRoutes.sourceKind,
        sourceId: relayRoutes.sourceId,
        generation: relayRoutes.generation,
        targetEndpointId: relayRoutes.targetEndpointId,
      })
      .from(relayRoutes)
      .where(and(eq(relayRoutes.ownerKind, CONTAINER_LINK_OWNER_KIND), inArray(relayRoutes.ownerId, [linkId])));
  }
}
