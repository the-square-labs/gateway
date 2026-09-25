import { and, eq, inArray, or } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { storageCopyJobs } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

const ACTIVE_COPY_STATUSES = ['queued', 'running'] as const;

/**
 * A storage must not disappear under a running data copy. Finished copy jobs never block deletion: their
 * connection references are nulled and the job report stays readable.
 */
export async function assertStorageHasNoActiveCopyJobs(db: DrizzleExecutor, connectionId: string) {
  const jobs = await db
    .select({ id: storageCopyJobs.id, status: storageCopyJobs.status })
    .from(storageCopyJobs)
    .where(
      and(
        or(
          eq(storageCopyJobs.sourceConnectionId, connectionId),
          eq(storageCopyJobs.destinationConnectionId, connectionId)
        ),
        inArray(storageCopyJobs.status, [...ACTIVE_COPY_STATUSES])
      )
    );
  const active = jobs.filter((job) => (ACTIVE_COPY_STATUSES as readonly string[]).includes(job.status));
  if (active.length)
    throw new AppError(
      409,
      'STORAGE_REFERENCED_BY_COPY_JOBS',
      'Storage is used by a data copy job that is still running. Wait for it to finish or cancel it before deleting the storage.',
      { jobIds: active.slice(0, 10).map((job) => job.id) }
    );
}
