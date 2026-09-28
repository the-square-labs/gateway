import { asc, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { domains } from '@/db/schema/domains.js';
import { ingressGroupMembers } from '@/db/schema/ingress-groups.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';

/** A route or domain as far as its ingress placement goes: one node, or a group of nodes. */
export interface IngressTarget {
  nodeId: string | null;
  ingressGroupId?: string | null;
}

export interface IngressGroupMemberRow {
  groupId: string;
  nodeId: string;
  priority: number;
  state: 'joining' | 'active' | 'draining';
}

/** Members in site-preference order: priority, then node id (stable when two share a priority). */
export function orderIngressMembers<T extends { nodeId: string; priority: number }>(members: readonly T[]): T[] {
  return [...members].sort((left, right) => left.priority - right.priority || left.nodeId.localeCompare(right.nodeId));
}

/** Every member row of one group, ordered; draining members included. */
export async function ingressGroupMemberRows(db: DrizzleExecutor, groupId: string): Promise<IngressGroupMemberRow[]> {
  return db
    .select({
      groupId: ingressGroupMembers.groupId,
      nodeId: ingressGroupMembers.nodeId,
      priority: ingressGroupMembers.priority,
      state: ingressGroupMembers.state,
    })
    .from(ingressGroupMembers)
    .where(eq(ingressGroupMembers.groupId, groupId))
    .orderBy(asc(ingressGroupMembers.priority), asc(ingressGroupMembers.nodeId));
}

/**
 * The ordered member node ids of one ingress group (empty for an unknown group). Joining and draining members serve
 * (a joining member is being prepared, a draining one until its removal finishes), so they are included; DNS uses
 * {@link activeIngressGroupMemberNodeIds}.
 */
export async function ingressGroupMemberNodeIds(db: DrizzleExecutor, groupId: string): Promise<string[]> {
  return (await ingressGroupMemberRows(db, groupId)).map((row) => row.nodeId);
}

/** Members that are published in DNS: every member except draining ones. */
export async function activeIngressGroupMemberNodeIds(db: DrizzleExecutor, groupId: string): Promise<string[]> {
  return (await ingressGroupMemberRows(db, groupId)).filter((row) => row.state === 'active').map((row) => row.nodeId);
}

/** Ordered member node ids of several groups at once. */
export async function ingressGroupMembersByGroup(
  db: DrizzleExecutor,
  groupIds: readonly string[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const unique = [...new Set(groupIds)];
  if (unique.length === 0) return result;
  const rows = await db
    .select({
      groupId: ingressGroupMembers.groupId,
      nodeId: ingressGroupMembers.nodeId,
      priority: ingressGroupMembers.priority,
    })
    .from(ingressGroupMembers)
    .where(inArray(ingressGroupMembers.groupId, unique));
  for (const groupId of unique) {
    result.set(
      groupId,
      orderIngressMembers(rows.filter((row) => row.groupId === groupId)).map((row) => row.nodeId)
    );
  }
  return result;
}

/**
 * The nginx nodes that serve a route or domain, in site-preference order. This is the single resolver every
 * delivery, validation, health, cleanup, migration, TLS, ACME, Pages and lease path uses; a single-node target
 * resolves to its node exactly as before.
 */
export async function resolveIngressNodes(db: DrizzleExecutor, target: IngressTarget): Promise<string[]> {
  if (target.ingressGroupId) return ingressGroupMemberNodeIds(db, target.ingressGroupId);
  return target.nodeId ? [target.nodeId] : [];
}

/** resolveIngressNodes for many targets with one query; keyed like the input array. */
export async function resolveIngressNodesForMany<T extends IngressTarget>(
  db: DrizzleExecutor,
  targets: readonly T[]
): Promise<Map<T, string[]>> {
  const groups = await ingressGroupMembersByGroup(
    db,
    targets.flatMap((target) => (target.ingressGroupId ? [target.ingressGroupId] : []))
  );
  return new Map(
    targets.map((target) => [
      target,
      target.ingressGroupId ? (groups.get(target.ingressGroupId) ?? []) : target.nodeId ? [target.nodeId] : [],
    ])
  );
}

/** The groups a node is a member of. */
export async function ingressGroupIdsOfNode(db: DrizzleExecutor, nodeId: string): Promise<string[]> {
  const rows = await db
    .select({ groupId: ingressGroupMembers.groupId })
    .from(ingressGroupMembers)
    .where(eq(ingressGroupMembers.nodeId, nodeId));
  return rows.map((row) => row.groupId);
}

/**
 * SQL conditions for "served by this node". They embed the membership lookup as a subquery, so building them needs
 * no database round trip (and callers keep one query). The subqueries name their tables and columns as plain SQL:
 * relational queries (`db.query.x.findMany`) re-alias every column object in a where clause to the root table.
 */
export function groupsOfNodeSql(nodeId: string): SQL {
  return sql`(select "group_id" from "ingress_group_members" where "node_id" = ${nodeId})`;
}

/** Proxy hosts a node serves: its own single-node routes and the routes of every group it is a member of. */
export function proxyHostsServedByNode(_db: DrizzleExecutor | null, nodeId: string): SQL {
  return or(eq(proxyHosts.nodeId, nodeId), sql`${proxyHosts.ingressGroupId} in ${groupsOfNodeSql(nodeId)}`) as SQL;
}

/** Domains a node serves (single-node domains and the domains of its groups). */
export function domainsServedByNode(_db: DrizzleExecutor | null, nodeId: string): SQL {
  return or(eq(domains.nginxNodeId, nodeId), sql`${domains.ingressGroupId} in ${groupsOfNodeSql(nodeId)}`) as SQL;
}
