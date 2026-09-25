import { and, eq, notInArray, or, sql } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { backupPolicies, backupRuns } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

/**
 * What to do with finished backup history when its storage is deleted. History
 * blocks deletion unless the caller explicitly chooses `forget`: the records are
 * removed, Gateway can no longer restore or delete those backups, and their files
 * stay where they are (or go with a deleted managed storage).
 */
export type StorageBackupHistoryDisposition = 'forget';

export interface StorageBackupHistoryOptions {
  backupHistory?: StorageBackupHistoryDisposition;
}

const ACTIVE_RUN_STATUSES = ['queued', 'running'] as const;

function referencesConnection(connectionId: string) {
  return or(eq(backupRuns.destinationId, connectionId), eq(backupRuns.stagingStorageConnectionId, connectionId));
}

function finishedRun() {
  return and(notInArray(backupRuns.status, [...ACTIVE_RUN_STATUSES]), eq(backupRuns.runtimeCleanupPending, false));
}

/**
 * Check before destructive runtime teardown; database FKs also close concurrent creation races.
 * Policies and active runs always block. Finished history blocks unless `backupHistory: 'forget'`
 * is passed; the caller then removes it with {@link forgetStorageBackupHistory} in the same
 * transaction that deletes the storage.
 */
export async function assertStorageHasNoBackupReferences(
  db: DrizzleExecutor,
  connectionId: string,
  options: StorageBackupHistoryOptions = {}
) {
  const [policies, runs] = await Promise.all([
    db
      .select({ id: backupPolicies.id })
      .from(backupPolicies)
      .where(
        or(eq(backupPolicies.destinationId, connectionId), eq(backupPolicies.stagingStorageConnectionId, connectionId))
      ),
    db
      .select({
        status: backupRuns.status,
        runtimeCleanupPending: backupRuns.runtimeCleanupPending,
        hasFiles: sql<boolean>`(${backupRuns.manifest} is not null and ${backupRuns.artifactsDeletedAt} is null)`,
      })
      .from(backupRuns)
      .where(referencesConnection(connectionId)),
  ]);
  const activeRuns = runs.filter(
    (run) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status) || run.runtimeCleanupPending
  ).length;
  if (policies.length || activeRuns)
    throw new AppError(
      409,
      'STORAGE_REFERENCED_BY_BACKUPS',
      policies.length
        ? 'Storage is used by backup policies. Delete those policies or move them to other storage before deleting it.'
        : 'Storage is used by backup runs that are still active or cleaning up. Wait for them to finish before deleting it.',
      { policies: policies.length, activeRuns }
    );
  const historyRecords = runs.length;
  if (historyRecords === 0 || options.backupHistory === 'forget') return;
  const backupsWithFiles = runs.filter((run) => run.hasFiles).length;
  throw new AppError(
    409,
    'STORAGE_BACKUP_HISTORY_EXISTS',
    backupsWithFiles
      ? `Storage is referenced by ${historyRecords} backup history record(s), ${backupsWithFiles} of them with backup files. Delete those backups first, or confirm forgetting the history.`
      : `Storage is referenced by ${historyRecords} backup history record(s). Confirm forgetting the history to delete it.`,
    { historyRecords, backupsWithFiles }
  );
}

/**
 * Remove finished backup history that uses this storage as destination or staging.
 * Call inside the transaction that deletes the storage, after
 * {@link assertStorageHasNoBackupReferences} with `backupHistory: 'forget'`.
 * The returned locations are for the audit log: the files there are not deleted.
 */
export async function forgetStorageBackupHistory(db: DrizzleExecutor, connectionId: string) {
  const removed = await db
    .delete(backupRuns)
    .where(and(referencesConnection(connectionId), finishedRun()))
    .returning({
      id: backupRuns.id,
      destinationId: backupRuns.destinationId,
      destinationBucket: backupRuns.destinationBucket,
      ownedPrefix: sql<string | null>`${backupRuns.manifest}->>'ownedPrefix'`,
      artifactsDeletedAt: backupRuns.artifactsDeletedAt,
    });
  const withFiles = removed.filter((run) => run.ownedPrefix && !run.artifactsDeletedAt);
  return {
    historyRecords: removed.length,
    backupsWithFiles: withFiles.length,
    // Bounded so a long history cannot bloat one audit entry.
    keptFiles: withFiles.slice(0, 50).map((run) => ({
      runId: run.id,
      storageId: run.destinationId,
      bucket: run.destinationBucket,
      prefix: run.ownedPrefix,
    })),
  };
}

/** Check before deleting one bucket: backup history and policies read and write through it by name. */
export async function assertStorageBucketHasNoBackupReferences(
  db: DrizzleExecutor,
  connectionId: string,
  bucket: string
) {
  const [policies, runs] = await Promise.all([
    db
      .select({ id: backupPolicies.id })
      .from(backupPolicies)
      .where(
        or(
          and(eq(backupPolicies.destinationId, connectionId), eq(backupPolicies.bucket, bucket)),
          and(eq(backupPolicies.stagingStorageConnectionId, connectionId), eq(backupPolicies.stagingBucket, bucket))
        )
      )
      .limit(1),
    db
      .select({ id: backupRuns.id })
      .from(backupRuns)
      .where(
        or(
          and(eq(backupRuns.destinationId, connectionId), eq(backupRuns.destinationBucket, bucket)),
          and(eq(backupRuns.stagingStorageConnectionId, connectionId), eq(backupRuns.stagingBucket, bucket))
        )
      )
      .limit(1),
  ]);
  if (policies.length || runs.length)
    throw new AppError(
      409,
      'STORAGE_BUCKET_REFERENCED_BY_BACKUPS',
      'Bucket is referenced by backup policies or retained history. Remove those references before deleting it.'
    );
}
