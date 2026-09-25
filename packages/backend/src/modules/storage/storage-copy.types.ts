import type {
  StorageCopyBucketReport,
  StorageCopyJobStatus,
  StorageCopyLimits,
  StorageCopyMode,
  StorageCopyProgress,
  StorageCopyReport,
} from '@/db/schema/storage-copy.js';

export type {
  StorageCopyBucketReport,
  StorageCopyJobStatus,
  StorageCopyLimits,
  StorageCopyMode,
  StorageCopyProgress,
  StorageCopyReport,
};

/** Node daemon capability of executors that run storage copy jobs. */
export const STORAGE_COPY_CAPABILITY = 'storage_copy_v1';

export interface StartStorageCopyJobInput {
  sourceStorageId: string;
  destinationStorageId: string;
  /** `all` copies every source bucket; otherwise the named buckets, under the same names on the destination. */
  buckets: 'all' | string[];
  mode: StorageCopyMode;
  /** Compare only: report what copy/sync would transfer (or delete) without writing anything. */
  dryRun: boolean;
  /**
   * Create missing destination buckets. Defaults to true when the caller holds storage:objects:admin on the
   * destination; passing true without that scope is refused.
   */
  createBuckets?: boolean;
  /**
   * `sync` deletes destination objects the source does not have, so it is refused into a managed cluster whose
   * writes are not frozen while workload links or writable access keys could write to it. True overrides that.
   */
  allowLiveDestination?: boolean;
  /** Storage node that runs the copy; chosen automatically when omitted. */
  executorNodeId?: string;
  limits?: Partial<StorageCopyLimits>;
}

export interface StorageCopyJobListQuery {
  /** Jobs whose source or destination is this connection. */
  storageId?: string;
  status?: StorageCopyJobStatus | 'active';
  limit?: number;
}

/** The caller: user id plus the effective (folder-expanded, token-bounded) scopes of this request. */
export interface StorageCopyActor {
  userId: string;
  scopes: string[];
}

export interface StorageCopyJobView {
  id: string;
  source: { storageId: string | null; name: string };
  destination: { storageId: string | null; name: string };
  buckets: 'all' | string[];
  mode: StorageCopyMode;
  dryRun: boolean;
  createBuckets: boolean;
  allowLiveDestination: boolean;
  executorNodeId: string | null;
  status: StorageCopyJobStatus;
  phase: string;
  limits: StorageCopyLimits;
  progress: StorageCopyProgress | null;
  report: StorageCopyReport | null;
  error: string | null;
  createdById: string | null;
  deadlineAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
