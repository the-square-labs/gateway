import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type {
  ManagedWorkloadStore,
  WorkloadPendingOperation,
  WorkloadRow,
  WorkloadRowPatch,
} from '@/modules/managed-workloads/managed-workload-store.js';
export class StorageWorkloadStore implements ManagedWorkloadStore {
  // biome-ignore lint/complexity/noUselessConstructor: Stable commercial constructor contract.
  constructor(_db: DrizzleClient) {}
  async getById(_id: string): Promise<WorkloadRow | undefined> {
    return commercialModuleUnavailable();
  }
  async listPending(): Promise<WorkloadRow[]> {
    return commercialModuleUnavailable();
  }
  async claimOperation(
    _id: string,
    _fromStatus: string,
    _op: WorkloadPendingOperation,
    _patch: WorkloadRowPatch
  ): Promise<WorkloadRow | undefined> {
    return commercialModuleUnavailable();
  }
  async setStatus(_id: string, _patch: WorkloadRowPatch): Promise<WorkloadRow> {
    return commercialModuleUnavailable();
  }
  async setReady(_id: string, _patch: WorkloadRowPatch): Promise<WorkloadRow> {
    return commercialModuleUnavailable();
  }
  async clearPending(_id: string, _patch: WorkloadRowPatch): Promise<WorkloadRow> {
    return commercialModuleUnavailable();
  }
  async delete(_id: string): Promise<void> {
    return commercialModuleUnavailable();
  }
}
