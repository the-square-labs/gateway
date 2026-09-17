import type { DrizzleClient } from '@/db/client.js';
import type { ManagedStorageClusterMemberRow } from '@/db/schema/managed-storage.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
export class StorageClusterMemberStore {
  // biome-ignore lint/complexity/noUselessConstructor: Stable commercial constructor contract.
  constructor(_db: DrizzleClient) {}
  async listByCluster(_clusterId: string): Promise<ManagedStorageClusterMemberRow[]> {
    return commercialModuleUnavailable();
  }
  async insertMembers(
    _clusterId: string,
    _members: {
      nodeId: string;
      memberIndex: number;
      drives: number;
    }[]
  ): Promise<ManagedStorageClusterMemberRow[]> {
    return commercialModuleUnavailable();
  }
  async setMemberStatus(
    _id: string,
    _patch: {
      status?: string;
      lastError?: string | null;
    }
  ): Promise<void> {
    return commercialModuleUnavailable();
  }
  async deleteByCluster(_clusterId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
}
