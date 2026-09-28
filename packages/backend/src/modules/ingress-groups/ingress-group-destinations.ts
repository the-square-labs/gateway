import { asc } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { ingressGroupMembers, ingressGroups } from '@/db/schema/ingress-groups.js';
import { orderIngressMembers } from './ingress-nodes.js';

type MemberState = 'joining' | 'active' | 'draining';

/** An ingress group offered as the destination of a new route or domain, members in site-preference order. */
export interface IngressGroupDestination<TNode> {
  id: string;
  name: string;
  slug: string;
  dnsFailoverMode: string;
  members: Array<TNode & { state: MemberState }>;
}

/**
 * Every ingress group that can take a new route or domain: each member must be one of `usableNodes` (the nodes the
 * caller may use and that can serve it) and at least one member must be active. A group with any other member is not
 * offered, because placing something on a group places it on every member.
 */
export async function loadIngressGroupDestinations<TNode extends { id: string }>(
  db: DrizzleExecutor,
  usableNodes: readonly TNode[]
): Promise<IngressGroupDestination<TNode>[]> {
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
  const byId = new Map(usableNodes.map((node) => [node.id, node]));
  return groups.flatMap((group) => {
    const ordered = orderIngressMembers(members.filter((member) => member.groupId === group.id));
    const resolved = ordered.map((member) => ({ member, node: byId.get(member.nodeId) }));
    if (resolved.length === 0 || resolved.some(({ node }) => !node)) return [];
    if (!ordered.some((member) => member.state === 'active')) return [];
    return [
      {
        ...group,
        members: resolved.map(({ member, node }) => ({ ...node!, state: member.state as MemberState })),
      },
    ];
  });
}
