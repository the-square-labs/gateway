/**
 * The `ManagedWorkloadStore` seam abstracts the row-persistence half of
 * managed workload lifecycle orchestration (databases today, object storage
 * later): reading a workload row, atomically claiming a pending operation
 * slot, and the various "operation finished" writes (ready, error-cleared
 * transition, pending cleared) that the lifecycle methods on
 * `ManagedDatabaseService` perform directly today via
 * `this.db.update(managedDatabaseInstances)...`.
 *
 * This mirrors the `ManagedWorkloadProvider` seam's shape (see
 * `managed-workload-provider.ts`): the interface here defines the contract,
 * and `DatabaseWorkloadStore` (in `modules/databases/database-workload-store.ts`)
 * moves the verbatim SQL off `ManagedDatabaseService`'s lifecycle methods
 * behind it, unchanged.
 */

/** A pending long-running operation claimed on a workload row. */
export interface WorkloadPendingOperation {
  id: string;
  action: string;
}

/**
 * The lifecycle-relevant slice of a managed workload row. Concrete backing
 * types (e.g. `ManagedDatabaseRow`, the `managedDatabaseInstances`
 * `$inferSelect` type) carry many more columns than this — those extra
 * columns don't break assignability to `WorkloadRow`, since TypeScript
 * structural typing only requires these five fields to be present.
 */
export interface WorkloadRow {
  id: string;
  nodeId: string;
  status: string;
  pendingOperation: WorkloadPendingOperation | null;
  updatedById: string | null;
}

/**
 * Generic "extra fields to write in the same UPDATE" bag for the patch-taking
 * methods below. Concrete stores merge these on top of the method's own
 * default `SET` fields (see each method's doc). Using an untyped bag here —
 * rather than a `Partial<WorkloadRow>` — is deliberate: callers on
 * `ManagedDatabaseService` need to write columns (`publishedPort`,
 * `certificateId`, `lastError`, ...) that aren't part of the seam's
 * lifecycle-only `WorkloadRow` shape, and a future storage-workload store
 * will have its own extra columns again.
 */
export type WorkloadRowPatch = Record<string, unknown>;

/**
 * A store that knows how to persist one kind of managed workload's lifecycle
 * row (create/find/claim/settle) on top of whatever table backs it.
 */
export interface ManagedWorkloadStore {
  /** Reads a workload row by id, or `undefined` when it doesn't exist. */
  getById(id: string): Promise<WorkloadRow | undefined>;

  /**
   * Reads every workload row that still carries a pending operation, for the
   * lifecycle's reconciliation pass. Verbatim relocation of
   * `ManagedDatabaseService.reconcilePendingOperations`'s
   * `this.db.select().from(managedDatabaseInstances).where(isNotNull(pendingOperation))`.
   */
  listPending(): Promise<WorkloadRow[]>;

  /**
   * Atomically claims a pending-operation slot: guarded by
   * `status = fromStatus AND pendingOperation IS NULL`, sets
   * `pendingOperation = op` and clears `lastError`, then applies `patch` in
   * the same `UPDATE` (e.g. the transitional `status` to write and
   * `updatedById`). Returns `undefined` when the guard didn't match — the row
   * was already claimed, or wasn't in `fromStatus`.
   *
   * The transitional `status` value differs by call site (e.g. `'updating'`
   * for a pause/unpause claim, `'creating'` for a provisioning retry claim),
   * so it travels in `patch` rather than being hardcoded here — this keeps
   * the guard-and-claim a single atomic statement instead of a separate
   * claim-then-setStatus pair, which would reopen the race the guard exists
   * to prevent.
   */
  claimOperation(
    id: string,
    fromStatus: string,
    op: WorkloadPendingOperation,
    patch: WorkloadRowPatch
  ): Promise<WorkloadRow | undefined>;

  /** Writes `patch` (plus a fresh `updatedAt`) unconditionally. */
  setStatus(id: string, patch: WorkloadRowPatch): Promise<WorkloadRow>;

  /**
   * Marks a workload ready: defaults to `status: 'ready'`, `pendingOperation:
   * null`, `lastError: null`, then applies `patch` (which may override
   * `status`, e.g. to `'stopped'`) in the same `UPDATE`.
   */
  setReady(id: string, patch: WorkloadRowPatch): Promise<WorkloadRow>;

  /**
   * Clears a workload's pending operation: defaults to `pendingOperation:
   * null`, `lastError: null`, then applies `patch` (e.g. the settled
   * `status` and `updatedById`) in the same `UPDATE`.
   */
  clearPending(id: string, patch: WorkloadRowPatch): Promise<WorkloadRow>;

  /** Deletes the workload row. */
  delete(id: string): Promise<void>;
}
