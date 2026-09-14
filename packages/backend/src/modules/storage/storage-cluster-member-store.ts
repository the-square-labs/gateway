import { asc, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { type ManagedStorageClusterMemberRow, managedStorageClusterMembers } from '@/db/schema/managed-storage.js';

/**
 * Drizzle data-access class over `managed_storage_cluster_members`. Mirrors
 * `StorageWorkloadStore`'s constructor style; not a `ManagedWorkloadStore`
 * implementation since members aren't workloads themselves.
 */
export class StorageClusterMemberStore {
  constructor(private readonly db: DrizzleClient) {}

  async listByCluster(clusterId: string): Promise<ManagedStorageClusterMemberRow[]> {
    return this.db
      .select()
      .from(managedStorageClusterMembers)
      .where(eq(managedStorageClusterMembers.clusterId, clusterId))
      .orderBy(asc(managedStorageClusterMembers.memberIndex));
  }

  async insertMembers(
    clusterId: string,
    members: { nodeId: string; memberIndex: number; drives: number }[]
  ): Promise<ManagedStorageClusterMemberRow[]> {
    if (members.length === 0) return [];
    return this.db
      .insert(managedStorageClusterMembers)
      .values(
        members.map((m) => ({
          clusterId,
          nodeId: m.nodeId,
          memberIndex: m.memberIndex,
          drives: m.drives,
        }))
      )
      .returning();
  }

  async setMemberStatus(id: string, patch: { status?: string; lastError?: string | null }): Promise<void> {
    await this.db
      .update(managedStorageClusterMembers)
      .set({
        ...(patch.status !== undefined ? { status: patch.status as never } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        updatedAt: new Date(),
      })
      .where(eq(managedStorageClusterMembers.id, id));
  }

  async deleteByCluster(clusterId: string): Promise<void> {
    await this.db.delete(managedStorageClusterMembers).where(eq(managedStorageClusterMembers.clusterId, clusterId));
  }
}
