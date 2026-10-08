import type { DrizzleExecutor } from '@/db/client.js';
import {
  type IngressGroupDestination,
  loadIngressGroupDestinations,
} from '@/modules/ingress-groups/ingress-group-destinations.js';
import { type RouteIngressNode, type RouteIngressNodeCandidate, toRouteIngressNode } from './route-ingress-nodes.js';

/** What a route creator learns about an ingress group: enough to pick it, nothing that needs nodes:details. */
export type RouteIngressGroup = IngressGroupDestination<RouteIngressNode>;

/**
 * Ingress groups a new route may be placed on: the creator may view the group, every member is one of `allowedNodes`
 * (open to the creator's grant at this destination) and not locked for new services, and some member is active.
 */
export async function loadRouteIngressGroups(
  db: DrizzleExecutor,
  allowedNodes: readonly RouteIngressNodeCandidate[],
  scopes: readonly string[]
): Promise<RouteIngressGroup[]> {
  const usable = allowedNodes.filter((node) => !node.serviceCreationLocked).map(toRouteIngressNode);
  return loadIngressGroupDestinations(db, usable, scopes);
}
