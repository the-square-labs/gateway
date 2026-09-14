import { eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { managedStorageClusterMembers, nodes } from '@/db/schema/index.js';
import { memberContainerName } from '@/modules/storage/storage-workload-dispatch.js';
import {
  buildManagedStorageMetrics,
  type ManagedStorageMetrics,
  type MetricsHealthReport,
} from './managed-storage-metrics.js';

/**
 * Reads resource metrics for a managed storage cluster out of the node health
 * reports already persisted by the daemon control stream.
 *
 * This is a read of existing state, not a new collection path: monitoring polls
 * it alongside the latency probe, so a cluster's CPU, memory, disk, swap, and
 * network numbers cost one query rather than a round-trip to the node.
 */
export class ManagedStorageMetricsProvider {
  constructor(private readonly db: DrizzleClient) {}

  async getMetrics(clusterId: string): Promise<ManagedStorageMetrics | null> {
    const members = await this.db
      .select({ nodeId: managedStorageClusterMembers.nodeId, memberIndex: managedStorageClusterMembers.memberIndex })
      .from(managedStorageClusterMembers)
      .where(eq(managedStorageClusterMembers.clusterId, clusterId));

    if (members.length === 0) return null;

    const nodeIds = [...new Set(members.map((member) => member.nodeId))];
    const nodeRows = await this.db
      .select({ id: nodes.id, lastHealthReport: nodes.lastHealthReport })
      .from(nodes)
      .where(inArray(nodes.id, nodeIds));

    return buildManagedStorageMetrics(
      nodeRows.map((row) => ({
        id: row.id,
        healthReport: (row.lastHealthReport as MetricsHealthReport | null) ?? null,
      })),
      members.map((member) => ({
        nodeId: member.nodeId,
        containerName: memberContainerName(clusterId, member.memberIndex),
      }))
    );
  }
}
