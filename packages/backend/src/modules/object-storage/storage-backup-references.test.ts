import { describe, expect, it, vi } from 'vitest';
import { backupPolicies } from '@/db/schema/index.js';
import { assertStorageHasNoBackupReferences } from './storage-backup-references.js';

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
