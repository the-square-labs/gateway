import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { backupPolicies, backupRuns } from '@/db/schema/index.js';
import {
  assertStorageBucketHasNoBackupReferences,
  assertStorageHasNoBackupReferences,
  forgetStorageBackupHistory,
} from './storage-backup-references.js';

function dbWith(policies: unknown[], runs: unknown[]) {
  const result = (table: unknown) => (table === backupPolicies ? policies : runs);
  return {
    select: vi.fn(() => ({
      from: vi.fn((table) => ({
        // Storage deletion awaits the where() result; bucket deletion adds limit(1).
        where: vi.fn(() =>
          Object.assign(Promise.resolve(result(table)), { limit: vi.fn().mockResolvedValue(result(table)) })
        ),
      })),
    })),
  };
}

const finished = { status: 'completed', runtimeCleanupPending: false, hasFiles: false };

describe('storage backup reference protection', () => {
  it('allows deletion when no policy or history references the storage', async () => {
    await expect(assertStorageHasNoBackupReferences(dbWith([], []) as never, 'storage')).resolves.toBeUndefined();
  });

  it.each([
    [[{ id: 'policy' }], [], { policies: 1, activeRuns: 0 }],
    [[], [{ ...finished, status: 'running' }], { policies: 0, activeRuns: 1 }],
    [[], [{ ...finished, runtimeCleanupPending: true }], { policies: 0, activeRuns: 1 }],
  ])('always rejects policies and active runs, even when history may be forgotten', async (policies, runs, details) => {
    for (const options of [{}, { backupHistory: 'forget' as const }]) {
      await expect(
        assertStorageHasNoBackupReferences(dbWith(policies, runs) as never, 'storage', options)
      ).rejects.toMatchObject({ statusCode: 409, code: 'STORAGE_REFERENCED_BY_BACKUPS', details });
    }
  });

  it('blocks on finished history until forgetting it is confirmed, reporting what would be forgotten', async () => {
    const runs = [
      { ...finished, hasFiles: true },
      { ...finished, status: 'failed' },
    ];
    await expect(assertStorageHasNoBackupReferences(dbWith([], runs) as never, 'storage')).rejects.toMatchObject({
      statusCode: 409,
      code: 'STORAGE_BACKUP_HISTORY_EXISTS',
      details: { historyRecords: 2, backupsWithFiles: 1 },
    });
    await expect(
      assertStorageHasNoBackupReferences(dbWith([], runs) as never, 'storage', { backupHistory: 'forget' })
    ).resolves.toBeUndefined();
  });

  it('forgets only finished runs that use the storage as destination or staging, and reports kept files', async () => {
    let condition: unknown;
    const returning = vi.fn().mockResolvedValue([
      {
        id: 'with-files',
        destinationId: 'storage',
        destinationBucket: 'backups',
        ownedPrefix: 'db/run',
        artifactsDeletedAt: null,
      },
      {
        id: 'retired',
        destinationId: 'storage',
        destinationBucket: 'backups',
        ownedPrefix: 'db/old',
        artifactsDeletedAt: new Date(),
      },
      {
        id: 'failed',
        destinationId: 'storage',
        destinationBucket: 'backups',
        ownedPrefix: null,
        artifactsDeletedAt: null,
      },
    ]);
    const db = {
      delete: vi.fn((table) => {
        expect(table).toBe(backupRuns);
        return {
          where: vi.fn((value) => {
            condition = value;
            return { returning };
          }),
        };
      }),
    };
    await expect(forgetStorageBackupHistory(db as never, 'storage')).resolves.toEqual({
      historyRecords: 3,
      backupsWithFiles: 1,
      keptFiles: [{ runId: 'with-files', storageId: 'storage', bucket: 'backups', prefix: 'db/run' }],
    });
    const query = new PgDialect().sqlToQuery(condition as never);
    expect(query.sql).toContain('"destination_id"');
    expect(query.sql).toContain('"staging_storage_connection_id"');
    expect(query.sql).toContain('"runtime_cleanup_pending"');
    expect(query.sql).toContain('"backup_runs"."status" not in');
    expect(query.params).toEqual(expect.arrayContaining(['storage', 'queued', 'running', false]));
  });
});

describe('storage bucket backup reference protection', () => {
  it('matches destination and staging usage of that exact bucket on that connection', async () => {
    const conditions = new Map<unknown, unknown>();
    const db = {
      select: vi.fn(() => ({
        from: vi.fn((table) => ({
          where: vi.fn((condition) => {
            conditions.set(table, condition);
            return { limit: vi.fn().mockResolvedValue([]) };
          }),
        })),
      })),
    };
    await assertStorageBucketHasNoBackupReferences(db as never, 'storage', 'backups');
    const dialect = new PgDialect();
    const policies = dialect.sqlToQuery(conditions.get(backupPolicies) as never);
    const runs = dialect.sqlToQuery(conditions.get(backupRuns) as never);
    expect(policies.sql).toContain('"bucket"');
    expect(policies.sql).toContain('"staging_bucket"');
    expect(policies.params).toEqual(['storage', 'backups', 'storage', 'backups']);
    expect(runs.sql).toContain('"destination_bucket"');
    expect(runs.sql).toContain('"staging_bucket"');
    expect(runs.params).toEqual(['storage', 'backups', 'storage', 'backups']);
  });
  it('allows deleting a bucket no policy or retained history uses', async () => {
    await expect(
      assertStorageBucketHasNoBackupReferences(dbWith([], []) as never, 'storage', 'scratch')
    ).resolves.toBeUndefined();
  });
  it.each([
    [['policy'], []],
    [[], ['run']],
  ])('rejects deleting a bucket backups write to or stage through', async (policies, runs) => {
    await expect(
      assertStorageBucketHasNoBackupReferences(dbWith(policies, runs) as never, 'storage', 'backups')
    ).rejects.toMatchObject({ statusCode: 409, code: 'STORAGE_BUCKET_REFERENCED_BY_BACKUPS' });
  });
});
