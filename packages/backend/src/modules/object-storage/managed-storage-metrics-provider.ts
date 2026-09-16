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
    return (await this.getSnapshot(clusterId))?.metrics ?? null;
  }

  async getSnapshot(clusterId: string): Promise<{ timestamp: string | null; metrics: ManagedStorageMetrics } | null> {
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

    const timestamps = nodeRows.map((row) => row.lastHealthReport?.timestamp);
    const timestamp =
      nodeRows.length === nodeIds.length &&
      timestamps.every(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Date.now() / 1000 + 60
      )
        ? new Date(Math.min(...timestamps) * 1000).toISOString()
        : null;

    return {
      timestamp,
      metrics: buildManagedStorageMetrics(
        nodeRows.map((row) => ({
          id: row.id,
          healthReport: (row.lastHealthReport as MetricsHealthReport | null) ?? null,
        })),
        members.map((member) => ({
          nodeId: member.nodeId,
          containerName: memberContainerName(clusterId, member.memberIndex),
          storageMountPathSuffix: `/storage/mounts/${clusterId}-${member.memberIndex}`,
        }))
      ),
    };
  }
}
