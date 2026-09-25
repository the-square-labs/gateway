import { describe, expect, it } from 'vitest';
import { CreateManagedStorageAccessKeySchema, CreateManagedStorageSchema } from './managed-storage.schemas.js';

const baseInput = {
  name: 'artifacts',
  version: '4.47',
  nodeId: '22222222-2222-4222-8222-222222222222',
  storageSizeGb: 10,
  cpuCores: 1,
  memoryMb: 1024,
  publishedPort: 9500,
};

function issuePaths(input: Record<string, unknown>): string[] {
  const result = CreateManagedStorageSchema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('CreateManagedStorageSchema — SeaweedFS single-node shape', () => {
  it('accepts the plain single-node create', () => {
    const result = CreateManagedStorageSchema.parse(baseInput);

    expect(result.memberNodeIds).toBeUndefined();
    expect(result.sftpEnabled).toBeUndefined();
    expect(result.ftpEnabled).toBeUndefined();
  });

  it('accepts engine seaweedfs and refuses any other engine', () => {
    expect(CreateManagedStorageSchema.parse({ ...baseInput, engine: 'seaweedfs' }).engine).toBe('seaweedfs');
    const result = CreateManagedStorageSchema.safeParse({ ...baseInput, engine: 'minio' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ path: ['engine'], message: expect.stringContaining('legacy engine') }),
      ]);
    }
  });

  it('requires at least 512 MiB of memory', () => {
    expect(issuePaths({ ...baseInput, memoryMb: 511 })).toContain('memoryMb');
    expect(CreateManagedStorageSchema.parse({ ...baseInput, memoryMb: 512 }).memoryMb).toBe(512);
  });

  it('refuses a distributed member list with a single-node message', () => {
    const result = CreateManagedStorageSchema.safeParse({
      ...baseInput,
      memberNodeIds: [
        '44444444-4444-4444-8444-444444444441',
        '44444444-4444-4444-8444-444444444442',
        '44444444-4444-4444-8444-444444444443',
        '44444444-4444-4444-8444-444444444444',
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ path: ['memberNodeIds'], message: expect.stringContaining('single-node') }),
      ]);
    }
  });

  it('accepts a single member entry as the same single-node shape', () => {
    const result = CreateManagedStorageSchema.parse({ ...baseInput, memberNodeIds: [baseInput.nodeId] });

    expect(result.memberNodeIds).toEqual([baseInput.nodeId]);
  });

  it('refuses more than one drive per node', () => {
    expect(issuePaths({ ...baseInput, drivesPerNode: 2 })).toContain('drivesPerNode');
  });

  it('refuses SFTP and FTP listeners instead of silently dropping them', () => {
    expect(issuePaths({ ...baseInput, sftpEnabled: true, sftpPort: 8022 })).toEqual(['sftpEnabled']);
    expect(issuePaths({ ...baseInput, ftpEnabled: true, ftpPort: 8021, ftpPassivePortStart: 30_000 })).toEqual([
      'ftpEnabled',
    ]);
  });

  it('keeps explicit sftpEnabled:false / ftpEnabled:false valid for older clients', () => {
    const result = CreateManagedStorageSchema.parse({ ...baseInput, sftpEnabled: false, ftpEnabled: false });

    expect(result.sftpEnabled).toBe(false);
    expect(result.ftpEnabled).toBe(false);
  });
});

describe('CreateManagedStorageAccessKeySchema — bucket-name validation (scope-injection guard)', () => {
  it('defaults access to read-write and accepts valid S3 bucket names', () => {
    const result = CreateManagedStorageAccessKeySchema.parse({ buckets: ['artifacts', 'my-bucket.1'] });
    expect(result.access).toBe('read-write');
    expect(result.buckets).toEqual(['artifacts', 'my-bucket.1']);
  });

  it.each([
    ['*'],
    ['foo*'],
    ['a?b'],
    ['UPPER'],
    ['has space'],
    ['a/b'],
    ['a,b'],
    ['ab'] /* too short */,
  ])('rejects the scope-widening / illegal bucket name %j', (bad) => {
    expect(() => CreateManagedStorageAccessKeySchema.parse({ buckets: [bad] })).toThrow();
  });

  it('rejects an over-long bucket list', () => {
    const many = Array.from({ length: 65 }, (_, i) => `bucket-${i}`);
    expect(() => CreateManagedStorageAccessKeySchema.parse({ buckets: many })).toThrow();
  });

  it('accepts a future ISO expiresAt', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const result = CreateManagedStorageAccessKeySchema.parse({ expiresAt: future });
    expect(result.expiresAt).toBe(future);
  });

  it('rejects a past expiresAt', () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(() => CreateManagedStorageAccessKeySchema.parse({ expiresAt: past })).toThrow();
  });

  it('rejects a non-ISO expiresAt', () => {
    expect(() => CreateManagedStorageAccessKeySchema.parse({ expiresAt: 'next tuesday' })).toThrow();
  });

  it('omitting expiresAt stays valid (no expiry)', () => {
    const result = CreateManagedStorageAccessKeySchema.parse({});
    expect(result.expiresAt).toBeUndefined();
  });
});
