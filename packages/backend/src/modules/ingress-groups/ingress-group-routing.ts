import { eq, inArray } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { ingressGroups } from '@/db/schema/ingress-groups.js';
import { nodes } from '@/db/schema/nodes.js';
import { AppError } from '@/middleware/error-handler.js';
import { ingressGroupMemberRows } from './ingress-nodes.js';

/** Advertised by nginx daemons with the ingress health responder and per-member rendering (decisions S10). */
export const INGRESS_GROUP_CAPABILITY = 'ingress_group_v1';

export function nodeReportsCapability(capabilities: unknown, capability: string): boolean {
  const reported = (capabilities as { capabilities?: unknown } | null | undefined)?.capabilities;
  return Array.isArray(reported) && reported.includes(capability);
}

export interface RoutableIngressGroup {
  group: typeof ingressGroups.$inferSelect;
  /** Every serving member, site preference first (draining members included: they serve until removed). */
  memberNodeIds: string[];
  /** Members published in DNS. */
  activeNodeIds: string[];
  /** Mirrored into proxy_hosts.node_id / domains.nginx_node_id: the first active member. */
  primaryNodeId: string;
}

/**
 * The group a route or domain is placed on. Refuses an unknown or empty group and a group with a member that is not
 * an nginx node advertising `ingress_group_v1` (an old daemon cannot answer the health endpoint and was never meant
 * to join; see the member add checks).
 */
export async function requireRoutableIngressGroup(db: DrizzleExecutor, groupId: string): Promise<RoutableIngressGroup> {
  const group = await db.query.ingressGroups.findFirst({ where: eq(ingressGroups.id, groupId) });
  if (!group) throw new AppError(404, 'INGRESS_GROUP_NOT_FOUND', 'Ingress group not found');
  const members = await ingressGroupMemberRows(db, groupId);
  const active = members.filter((member) => member.state === 'active');
  if (active.length === 0) {
    throw new AppError(409, 'INGRESS_GROUP_EMPTY', `Ingress group ${group.name} has no active members`, {
      ingressGroupId: groupId,
    });
  }
  const rows = await db
    .select({ id: nodes.id, type: nodes.type, capabilities: nodes.capabilities, hostname: nodes.hostname })
    .from(nodes)
    .where(
      inArray(
        nodes.id,
        members.map((member) => member.nodeId)
      )
    );
  const incapable = members
    .map((member) => rows.find((row) => row.id === member.nodeId))
    .filter(
      (row) => !row || row.type !== 'nginx' || !nodeReportsCapability(row.capabilities, INGRESS_GROUP_CAPABILITY)
    );
  if (incapable.length > 0) {
    throw new AppError(
      409,
      'INGRESS_GROUP_MEMBER_UPDATE_REQUIRED',
      `Update the nginx daemon of every ingress group member first: ${incapable
        .map((row) => row?.hostname ?? 'unknown node')
        .join(', ')} does not support ingress groups`,
      { ingressGroupId: groupId, nodeIds: incapable.map((row) => row?.id ?? null) }
    );
  }
  return {
    group,
    memberNodeIds: members.map((member) => member.nodeId),
    activeNodeIds: active.map((member) => member.nodeId),
    primaryNodeId: active[0]!.nodeId,
  };
}
