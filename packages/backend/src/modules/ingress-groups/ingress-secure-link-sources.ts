import { eq, or, type SQL, sql } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { proxyAdditionalSecureLinks } from '@/db/schema/proxy-additional-secure-links.js';
import { groupsOfNodeSql, type IngressTarget, ingressGroupMemberNodeIds } from './ingress-nodes.js';

/**
 * Additional Secure Links a node is a source of: links recorded with it as source, and every link of a route served
 * by one of its groups (a group route's link has one source per member).
 */
export function secureLinksSourcedByNode(_db: DrizzleExecutor | null, nodeId: string): SQL {
  return or(
    eq(proxyAdditionalSecureLinks.sourceNodeId, nodeId),
    sql`${proxyAdditionalSecureLinks.proxyHostId} in (select "id" from "proxy_hosts" where "ingress_group_id" in ${groupsOfNodeSql(nodeId)})`
  ) as SQL;
}

/** The source nginx nodes of a Secure Link that belongs to a route: every member of its group, else its source. */
export async function secureLinkSourceNodeIds(
  db: DrizzleExecutor,
  host: IngressTarget | null | undefined,
  recordedSourceNodeId: string | null
): Promise<string[]> {
  if (host?.ingressGroupId) {
    const members = await ingressGroupMemberNodeIds(db, host.ingressGroupId);
    if (members.length > 0) return members;
  }
  return recordedSourceNodeId ? [recordedSourceNodeId] : host?.nodeId ? [host.nodeId] : [];
}
