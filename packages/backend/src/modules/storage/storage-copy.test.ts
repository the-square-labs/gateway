import { describe, expect, it, vi } from 'vitest';
import { backupPolicies, storageCopyJobs } from '@/db/schema/index.js';
import { assertStorageHasNoBackupReferences } from '@/modules/object-storage/storage-backup-references.js';
import { StartStorageCopyJobSchema } from './storage-copy.schemas.js';
import { StorageCopyService } from './storage-copy.service.js';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const DESTINATION = '22222222-2222-4222-8222-222222222222';

function dbWith(copyJobs: unknown[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table) => ({
        where: vi.fn(() => Promise.resolve(table === storageCopyJobs ? copyJobs : table === backupPolicies ? [] : [])),
      })),
    })),
  };
}

describe('storage copy contract', () => {
  it('validates start requests without accepting paths, commands or the same storage twice', () => {
    expect(
      StartStorageCopyJobSchema.parse({ sourceStorageId: SOURCE, destinationStorageId: DESTINATION, buckets: 'all' })
    ).toEqual({
      sourceStorageId: SOURCE,
      destinationStorageId: DESTINATION,
      buckets: 'all',
      mode: 'copy',
      dryRun: false,
    });
    expect(
      StartStorageCopyJobSchema.parse({
        sourceStorageId: SOURCE,
        destinationStorageId: DESTINATION,
        buckets: ['a-b', 'a-b'],
      }).buckets
    ).toEqual(['a-b']);
    expect(
      StartStorageCopyJobSchema.parse({
        sourceStorageId: SOURCE,
        destinationStorageId: DESTINATION,
        buckets: 'all',
        mode: 'sync',
        allowLiveDestination: true,
      }).allowLiveDestination
    ).toBe(true);
    for (const input of [
      { sourceStorageId: SOURCE, destinationStorageId: SOURCE, buckets: 'all' },
      { sourceStorageId: SOURCE, destinationStorageId: DESTINATION, buckets: ['../etc'] },
      { sourceStorageId: SOURCE, destinationStorageId: DESTINATION, buckets: ['a/b'] },
      { sourceStorageId: SOURCE, destinationStorageId: DESTINATION, buckets: [] },
      { sourceStorageId: SOURCE, destinationStorageId: DESTINATION, buckets: 'all', mode: 'move' },
      { sourceStorageId: SOURCE, destinationStorageId: DESTINATION, buckets: 'all', command: 'id' },
      { sourceStorageId: SOURCE, destinationStorageId: DESTINATION, buckets: 'all', limits: { transfers: 64 } },
    ])
      expect(StartStorageCopyJobSchema.safeParse(input).success).toBe(false);
  });

  it('is unavailable without the commercial module', async () => {
    const service = new StorageCopyService();
    await expect(service.list({}, { userId: 'user', scopes: [] })).rejects.toMatchObject({
      code: 'COMMERCIAL_MODULE_UNAVAILABLE',
    });
  });

  it('blocks deleting a storage that an active copy job uses, but not one with finished jobs', async () => {
    await expect(
      assertStorageHasNoBackupReferences(dbWith([{ id: 'job-1', status: 'running' }]) as never, SOURCE)
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'STORAGE_REFERENCED_BY_COPY_JOBS',
      details: { jobIds: ['job-1'] },
    });
    await expect(
      assertStorageHasNoBackupReferences(dbWith([{ id: 'job-2', status: 'completed' }]) as never, SOURCE)
    ).resolves.toBeUndefined();
  });
});
