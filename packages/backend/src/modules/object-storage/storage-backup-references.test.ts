import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { backupPolicies, backupRuns } from '@/db/schema/index.js';
import {
  assertStorageBucketHasNoBackupReferences,
  assertStorageHasNoBackupReferences,
} from './storage-backup-references.js';

function dbWith(policies: unknown[], runs: unknown[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table) => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(table === backupPolicies ? policies : runs) })),
      })),
    })),
  };
}
describe('storage backup reference protection', () => {
  it('allows deletion when no policy or retained history depends on credentials', async () => {
    await expect(assertStorageHasNoBackupReferences(dbWith([], []) as never, 'storage')).resolves.toBeUndefined();
  });
  it.each([
    [['policy'], []],
    [[], ['run']],
  ])('rejects before destructive teardown for policies or runs', async (policies, runs) => {
    await expect(assertStorageHasNoBackupReferences(dbWith(policies, runs) as never, 'storage')).rejects.toMatchObject({
      code: 'STORAGE_REFERENCED_BY_BACKUPS',
    });
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
