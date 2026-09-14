import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { managedStorageClusters } from '@/db/schema/managed-storage.js';
import type {
  ManagedWorkloadStore,
  WorkloadPendingOperation,
  WorkloadRow,
  WorkloadRowPatch,
} from '@/modules/managed-workloads/managed-workload-store.js';

/**
 * `ManagedWorkloadStore` over `managedStorageClusters`. Near-verbatim mirror
 * of `DatabaseWorkloadStore` (see `modules/databases/database-workload-store.ts`),
 * swapped to the object-storage cluster table.
 */
export class StorageWorkloadStore implements ManagedWorkloadStore {
  constructor(private readonly db: DrizzleClient) {}

  async getById(id: string): Promise<WorkloadRow | undefined> {
    const [row] = await this.db.select().from(managedStorageClusters).where(eq(managedStorageClusters.id, id)).limit(1);
    return row;
  }

  async listPending(): Promise<WorkloadRow[]> {
    return this.db.select().from(managedStorageClusters).where(isNotNull(managedStorageClusters.pendingOperation));
  }

  async claimOperation(
    id: string,
    fromStatus: string,
    op: WorkloadPendingOperation,
    patch: WorkloadRowPatch
  ): Promise<WorkloadRow | undefined> {
    const [row] = await this.db
      .update(managedStorageClusters)
      .set({
        // `op`/`fromStatus` come in through the generic seam as `string`,
        // while the column types are the narrower literal unions declared on
        // `managedStorageClusters` — callers already only ever pass one of
        // those literals, this just re-widens for the seam's generic
        // (kind-agnostic) signature.
        pendingOperation: op as never,
        lastError: null,
        updatedAt: new Date(),
        ...patch,
      })
      .where(
        and(
          eq(managedStorageClusters.id, id),
          eq(managedStorageClusters.status, fromStatus as never),
          isNull(managedStorageClusters.pendingOperation)
        )
      )
      .returning();
    return row;
  }

  async setStatus(id: string, patch: WorkloadRowPatch): Promise<WorkloadRow> {
    const [row] = await this.db
      .update(managedStorageClusters)
      .set({ updatedAt: new Date(), ...patch })
      .where(eq(managedStorageClusters.id, id))
      .returning();
    return row!;
  }

  async setReady(id: string, patch: WorkloadRowPatch): Promise<WorkloadRow> {
    const [row] = await this.db
      .update(managedStorageClusters)
      .set({
        status: 'ready',
        pendingOperation: null,
        lastError: null,
        updatedAt: new Date(),
        ...patch,
      })
      .where(eq(managedStorageClusters.id, id))
      .returning();
    return row!;
  }

  async clearPending(id: string, patch: WorkloadRowPatch): Promise<WorkloadRow> {
    const [row] = await this.db
      .update(managedStorageClusters)
      .set({
        pendingOperation: null,
        lastError: null,
        updatedAt: new Date(),
        ...patch,
      })
      .where(eq(managedStorageClusters.id, id))
      .returning();
    return row!;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(managedStorageClusters).where(eq(managedStorageClusters.id, id));
  }
}
