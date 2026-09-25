import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes.js';
import { objectStorageConnections } from './object-storage.js';
import { users } from './users.js';

export type StorageCopyMode = 'copy' | 'sync';
export type StorageCopyJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface StorageCopyLimits {
  timeoutSeconds: number;
  cpuCores: number;
  memoryMb: number;
  /** Parallel object transfers (rclone --transfers). */
  transfers: number;
}

/** Live counters reported by the runner while a job runs. Never contains credentials. */
export interface StorageCopyProgress {
  phase?: string;
  bucket?: string;
  bucketsDone: number;
  bucketsTotal: number;
  /** Bytes and objects transferred so far across all buckets. */
  bytes: number;
  objects: number;
  checks: number;
  errors: number;
  /** Bytes the current bucket's transfer expects in total, when known. */
  totalBytes?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number | null;
  updatedAt?: string;
}

export interface StorageCopyObjectTotals {
  objects: number;
  bytes: number;
}

/** Result of `rclone check` (and `rclone size`) for one bucket. Key lists are bounded samples. */
export interface StorageCopyBucketReport {
  name: string;
  /** The bucket was created on the destination by this job. */
  created: boolean;
  /** Dry run only: the destination bucket does not exist yet. */
  missingOnDestination?: boolean;
  source: StorageCopyObjectTotals | null;
  destination: StorageCopyObjectTotals | null;
  matched: number;
  /** Present on the source, absent on the destination. */
  missing: number;
  /** Present on both sides with a different size or hash. */
  differing: number;
  /** Present only on the destination; null when not checked (copy mode checks one way). */
  extra: number | null;
  errors: number;
  missingKeys: string[];
  differingKeys: string[];
  extraKeys: string[];
  error?: string;
}

export interface StorageCopyReport {
  mode: StorageCopyMode;
  dryRun: boolean;
  /** Every checked object matches (and, for sync, the destination has no extra objects). */
  clean: boolean;
  buckets: StorageCopyBucketReport[];
  totals: {
    buckets: number;
    sourceObjects: number;
    sourceBytes: number;
    destinationObjects: number;
    destinationBytes: number;
    missing: number;
    differing: number;
    extra: number;
    errors: number;
  };
  transferred: StorageCopyObjectTotals;
  /** Some bucket entries or key samples were left out to keep the report bounded. */
  truncated?: boolean;
}

/**
 * Server-side object copy/sync between two S3 connections, run by the backup runner on a Storage node.
 * Rows hold safe metadata only: credentials are resolved at dispatch and never stored here. Connection
 * and node references are nulled on delete so a finished job never blocks deleting a migrated storage.
 */
export const storageCopyJobs = pgTable(
  'storage_copy_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceConnectionId: uuid('source_connection_id').references(() => objectStorageConnections.id, {
      onDelete: 'set null',
    }),
    sourceConnectionName: text('source_connection_name').notNull(),
    destinationConnectionId: uuid('destination_connection_id').references(() => objectStorageConnections.id, {
      onDelete: 'set null',
    }),
    destinationConnectionName: text('destination_connection_name').notNull(),
    /** Selected bucket names; null copies every source bucket. */
    buckets: jsonb('buckets').$type<string[] | null>(),
    mode: text('mode').$type<StorageCopyMode>().notNull(),
    dryRun: boolean('dry_run').notNull().default(false),
    /** Missing destination buckets may be created (the actor held storage:objects:admin on the destination). */
    createBuckets: boolean('create_buckets').notNull().default(false),
    /** A sync was allowed into a managed destination whose writes were not frozen while links or keys could write. */
    allowLiveDestination: boolean('allow_live_destination').notNull().default(false),
    executorNodeId: uuid('executor_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    status: text('status').$type<StorageCopyJobStatus>().notNull().default('queued'),
    phase: text('phase').notNull().default('queued'),
    limits: jsonb('limits').$type<StorageCopyLimits>().notNull(),
    progress: jsonb('progress').$type<StorageCopyProgress | null>(),
    report: jsonb('report').$type<StorageCopyReport | null>(),
    sanitizedError: text('sanitized_error'),
    dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
    /** Per-job relay routes still need revoking. */
    runtimeCleanupPending: boolean('runtime_cleanup_pending').notNull().default(false),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('storage_copy_jobs_status_idx').on(table.status),
    index('storage_copy_jobs_source_idx').on(table.sourceConnectionId),
    index('storage_copy_jobs_destination_idx').on(table.destinationConnectionId),
    index('storage_copy_jobs_executor_idx').on(table.executorNodeId),
    index('storage_copy_jobs_created_at_idx').on(table.createdAt),
  ]
);

export type StorageCopyJobRow = typeof storageCopyJobs.$inferSelect;
