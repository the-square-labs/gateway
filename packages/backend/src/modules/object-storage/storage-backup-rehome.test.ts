import { describe, expect, it, vi } from 'vitest';
import { backupPolicies, backupRuns } from '@/db/schema/index.js';
import { rehomeStorageBackupHistory } from './storage-backup-references.js';

const SOURCE = 'storage-source';
const TARGET = 'storage-target';

function run(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: 'completed',
    runtimeCleanupPending: false,
    destinationId: SOURCE,
    destinationBucket: 'backups',
    stagingStorageConnectionId: null,
    stagingBucket: null,
    manifest: {
      artifactKeys: [`db/${id}/dump.pgc`, `db/${id}/manifest.json`],
      sizes: { [`db/${id}/dump.pgc`]: 1000, [`db/${id}/manifest.json`]: 200 },
      ownedPrefix: `db/${id}`,
    },
    artifactsDeletedAt: null,
    ...overrides,
  };
}

function dbWith(policies: unknown[], runs: unknown[]) {
  const moved: Array<{ values: Record<string, unknown> }> = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table) => ({
        where: vi.fn(() => Promise.resolve(table === backupPolicies ? policies : table === backupRuns ? runs : [])),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            moved.push({ values });
            return [{ id: 'moved' }];
          }),
        })),
      })),
    })),
  };
  return { db, moved };
}

function probe(objects: Record<string, number>, buckets = ['backups', 'staging']) {
  return {
    objectSize: vi.fn(async (_bucket: string, key: string) => {
      if (objects[key] === undefined) throw new Error('NotFound');
      return objects[key]!;
    }),
    bucketExists: vi.fn(async (bucket: string) => buckets.includes(bucket)),
  };
}

describe('rehomeStorageBackupHistory', () => {
  it('moves runs whose artifacts exist in the target with their manifest sizes and reports the rest', async () => {
    const runs = [
      run('good'),
      run('missing'),
      run('resized'),
      run('failed', { status: 'failed', manifest: null }),
      run('retired', { artifactsDeletedAt: new Date() }),
      run('staged', {
        destinationId: 'other',
        stagingStorageConnectionId: SOURCE,
        stagingBucket: 'staging',
        manifest: null,
      }),
    ];
    const { db, moved } = dbWith([{ id: 'policy-1' }], runs);
    const target = probe({
      'db/good/dump.pgc': 1000,
      'db/good/manifest.json': 200,
      'db/missing/dump.pgc': 1000,
      'db/resized/dump.pgc': 999,
      'db/resized/manifest.json': 200,
    });

    const result = await rehomeStorageBackupHistory(db as never, SOURCE, TARGET, target);

    expect(result).toMatchObject({
      dryRun: false,
      historyRecords: 6,
      rehomed: 4,
      verifiedArtifacts: 2,
      policiesStillUsingSource: 1,
    });
    expect(result.blocked).toEqual([
      expect.objectContaining({ runId: 'missing', key: 'db/missing/manifest.json', bucket: 'backups' }),
      expect.objectContaining({ runId: 'resized', key: 'db/resized/dump.pgc', reason: expect.stringContaining('999') }),
    ]);
    expect(moved.map((entry) => entry.values)).toEqual([
      { destinationId: TARGET },
      { destinationId: TARGET },
      { destinationId: TARGET },
      { stagingStorageConnectionId: TARGET },
    ]);
  });

  it('changes nothing on a dry run and keeps a run whose staging bucket is missing', async () => {
    const { db, moved } = dbWith([], [run('good', { stagingStorageConnectionId: SOURCE, stagingBucket: 'scratch' })]);

    const result = await rehomeStorageBackupHistory(
      db as never,
      SOURCE,
      TARGET,
      probe({ 'db/good/dump.pgc': 1000, 'db/good/manifest.json': 200 }),
      { dryRun: true }
    );

    expect(result).toMatchObject({
      dryRun: true,
      rehomed: 0,
      blocked: [expect.objectContaining({ runId: 'good', bucket: 'scratch' })],
    });
    expect(moved).toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('refuses while backup runs that use the storage are active', async () => {
    const { db } = dbWith([], [run('running', { status: 'running' })]);

    await expect(rehomeStorageBackupHistory(db as never, SOURCE, TARGET, probe({}))).rejects.toMatchObject({
      statusCode: 409,
      code: 'STORAGE_REFERENCED_BY_BACKUPS',
    });
    expect(db.update).not.toHaveBeenCalled();
  });
});
