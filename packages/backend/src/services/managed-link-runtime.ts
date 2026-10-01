import type { NodeManagedLinkReport } from '@/db/schema/nodes.js';

/**
 * A managed link's connections as the nodes that run its workloads report them (managed_link_runtime_v1). The node's
 * host listener (the storage connector socket for a storage link) is the link's single gate: it holds the link at its
 * capacity whichever relay of the pool carries a connection, so these are the link's real numbers, while each relay
 * only sees its share.
 */
export interface ManagedLinkConnections {
  /** Open connections of the link. */
  active: number;
  /** The link's capacity, signed into its grant; the sum over an Availability link's placements. */
  limit: number;
  /** Connections the nodes refused at the link's or the node's limit since their daemons started. */
  rejectedTotal: string;
  /** The reason of the latest refused connection, whatever refused it. */
  lastRejectionReason: string | null;
  lastRejectedAt: string | null;
  /** When the oldest of the reports was taken. */
  reportedAt: string;
}

/** What one node reported about one of the link's routes; `link` is null when the report leaves the link out. */
export interface ManagedLinkNodeReport {
  link: NodeManagedLinkReport | null;
  reportedAt: Date;
}

/**
 * The connections of a link from the reports of the nodes behind its routes (one route, or one per Availability
 * placement). Null when a route's node does not report links (an older daemon, or no report since it connected):
 * the relay's numbers stand then.
 */
export function sumManagedLinkReports(reports: Array<ManagedLinkNodeReport | null>): ManagedLinkConnections | null {
  if (!reports.length || reports.some((report) => report === null)) return null;
  const present = reports as ManagedLinkNodeReport[];
  let latest: NodeManagedLinkReport | null = null;
  for (const { link } of present) {
    if (link?.lastRejectedAt && (!latest?.lastRejectedAt || link.lastRejectedAt > latest.lastRejectedAt)) latest = link;
  }
  return {
    active: present.reduce((sum, { link }) => sum + (link?.activeConnections ?? 0), 0),
    limit: present.reduce((sum, { link }) => sum + (link?.connectionLimit ?? 0), 0),
    rejectedTotal: String(present.reduce((sum, { link }) => sum + (link?.rejectedTotal ?? 0), 0)),
    lastRejectionReason: latest?.lastRejectionReason ?? null,
    lastRejectedAt: latest?.lastRejectedAt ?? null,
    reportedAt: new Date(Math.min(...present.map(({ reportedAt }) => reportedAt.getTime()))).toISOString(),
  };
}

/**
 * A link's runtime with its nodes' counts: activeStreams are the link's open connections and throttledTotal adds the
 * connections the nodes refused at the link's limit to those the relays refused.
 */
export function withManagedLinkConnections<Runtime extends { activeStreams: number; throttledTotal: string }>(
  runtime: Runtime,
  connections: ManagedLinkConnections | null
): Runtime & { connections: ManagedLinkConnections | null } {
  if (!connections) return { ...runtime, connections: null };
  return {
    ...runtime,
    activeStreams: connections.active,
    throttledTotal: String(Number(runtime.throttledTotal || 0) + Number(connections.rejectedTotal)),
    connections,
  };
}
