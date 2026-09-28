import { asc } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { ingressGroupMembers, ingressGroups } from '@/db/schema/ingress-groups.js';
import { orderIngressMembers } from '@/modules/ingress-groups/ingress-nodes.js';
import { type RouteIngressNode, type RouteIngressNodeCandidate, toRouteIngressNode } from './route-ingress-nodes.js';

/** What a route creator learns about an ingress group: enough to pick it, nothing that needs nodes:details. */
export interface RouteIngressGroup {
  id: string;
  name: string;
  slug: string;
  dnsFailoverMode: string;
  members: Array<RouteIngressNode & { state: 'joining' | 'active' | 'draining' }>;
}

/**
 * Every ingress group as a route destination, members in site order with their identity and availability. A group
 * with a member that is not a known nginx node, or a member locked for new services, is not a destination.
 */
export async function loadRouteIngressGroupCandidates(
  db: DrizzleExecutor,
  candidates: readonly RouteIngressNodeCandidate[]
): Promise<RouteIngressGroup[]> {
  const [groups, members] = await Promise.all([
    db
      .select({
        id: ingressGroups.id,
        name: ingressGroups.name,
        slug: ingressGroups.slug,
        dnsFailoverMode: ingressGroups.dnsFailoverMode,
      })
      .from(ingressGroups)
      .orderBy(asc(ingressGroups.name), asc(ingressGroups.id)),
    db.select().from(ingressGroupMembers),
  ]);
  const byId = new Map(candidates.map((node) => [node.id, node]));
  return groups.flatMap((group) => {
    const ordered = orderIngressMembers(members.filter((member) => member.groupId === group.id));
    const nodes = ordered.map((member) => ({ member, node: byId.get(member.nodeId) }));
    if (nodes.length === 0 || nodes.some(({ node }) => !node || node.serviceCreationLocked)) return [];
    return [
      {
        ...group,
        members: nodes.map(({ member, node }) => ({ ...toRouteIngressNode(node!), state: member.state })),
      },
    ];
  });
}
