import { eq, or } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { backupPolicies, backupRuns } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

/** Check before destructive runtime teardown; database FKs also close concurrent creation races. */
export async function assertStorageHasNoBackupReferences(db: DrizzleExecutor, connectionId: string) {
  const [policies, runs] = await Promise.all([
    db
      .select({ id: backupPolicies.id })
      .from(backupPolicies)
      .where(
        or(eq(backupPolicies.destinationId, connectionId), eq(backupPolicies.stagingStorageConnectionId, connectionId))
      )
      .limit(1),
    db
      .select({ id: backupRuns.id })
      .from(backupRuns)
      .where(or(eq(backupRuns.destinationId, connectionId), eq(backupRuns.stagingStorageConnectionId, connectionId)))
      .limit(1),
  ]);
  if (policies.length || runs.length)
    throw new AppError(
      409,
      'STORAGE_REFERENCED_BY_BACKUPS',
      'Storage is referenced by backup policies or retained history. Remove those references before deleting it.'
    );
}
