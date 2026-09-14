import { describe, expect, it } from 'vitest';
import { CreateManagedStorageAccessKeySchema, CreateManagedStorageSchema } from './managed-storage.schemas.js';

const baseInput = {
  name: 'artifacts',
  version: '2025-04-22',
  nodeId: '22222222-2222-4222-8222-222222222222',
  storageSizeGb: 10,
  cpuCores: 1,
  memoryMb: 1024,
  publishedPort: 9500,
};

describe('CreateManagedStorageSchema — sftpEnabled/sftpPort', () => {
  it('accepts sftpEnabled:true with a valid sftpPort', () => {
    const result = CreateManagedStorageSchema.parse({ ...baseInput, sftpEnabled: true, sftpPort: 8022 });

    expect(result.sftpEnabled).toBe(true);
    expect(result.sftpPort).toBe(8022);
  });

  it('rejects sftpEnabled:true without sftpPort', () => {
    const result = CreateManagedStorageSchema.safeParse({ ...baseInput, sftpEnabled: true });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('sftpPort'))).toBe(true);
    }
  });

  it('omitting sftpEnabled/sftpPort entirely stays valid (opt-in, unchanged default behavior)', () => {
    const result = CreateManagedStorageSchema.parse(baseInput);

    expect(result.sftpEnabled).toBeUndefined();
    expect(result.sftpPort).toBeUndefined();
  });

  it('sftpEnabled:false with no sftpPort stays valid (not required when explicitly disabled)', () => {
    const result = CreateManagedStorageSchema.parse({ ...baseInput, sftpEnabled: false });

    expect(result.sftpEnabled).toBe(false);
  });

  it('rejects an out-of-range sftpPort', () => {
    const result = CreateManagedStorageSchema.safeParse({ ...baseInput, sftpEnabled: true, sftpPort: 70_000 });

    expect(result.success).toBe(false);
  });
});

describe('CreateManagedStorageSchema — ftpEnabled/ftpPort/ftpPassivePortStart', () => {
  it('accepts ftpEnabled:true with a valid ftpPort and ftpPassivePortStart', () => {
    const result = CreateManagedStorageSchema.parse({
      ...baseInput,
      ftpEnabled: true,
      ftpPort: 8021,
      ftpPassivePortStart: 30_000,
    });

    expect(result.ftpEnabled).toBe(true);
    expect(result.ftpPort).toBe(8021);
    expect(result.ftpPassivePortStart).toBe(30_000);
  });

  it('rejects ftpEnabled:true without ftpPort', () => {
    const result = CreateManagedStorageSchema.safeParse({
      ...baseInput,
      ftpEnabled: true,
      ftpPassivePortStart: 30_000,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('ftpPort'))).toBe(true);
    }
  });

  it('rejects ftpEnabled:true without ftpPassivePortStart', () => {
    const result = CreateManagedStorageSchema.safeParse({ ...baseInput, ftpEnabled: true, ftpPort: 8021 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('ftpPassivePortStart'))).toBe(true);
    }
  });

  it('rejects ftpEnabled:true with neither ftpPort nor ftpPassivePortStart', () => {
    const result = CreateManagedStorageSchema.safeParse({ ...baseInput, ftpEnabled: true });

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['ftpPort', 'ftpPassivePortStart']));
    }
  });

  it('omitting ftpEnabled/ftpPort/ftpPassivePortStart entirely stays valid (opt-in, unchanged default behavior)', () => {
    const result = CreateManagedStorageSchema.parse(baseInput);

    expect(result.ftpEnabled).toBeUndefined();
    expect(result.ftpPort).toBeUndefined();
    expect(result.ftpPassivePortStart).toBeUndefined();
  });

  it('ftpEnabled:false with no ftpPort/ftpPassivePortStart stays valid (not required when explicitly disabled)', () => {
    const result = CreateManagedStorageSchema.parse({ ...baseInput, ftpEnabled: false });

    expect(result.ftpEnabled).toBe(false);
  });

  it('rejects an out-of-range ftpPort', () => {
    const result = CreateManagedStorageSchema.safeParse({
      ...baseInput,
      ftpEnabled: true,
      ftpPort: 70_000,
      ftpPassivePortStart: 30_000,
    });

    expect(result.success).toBe(false);
  });

  it('rejects a ftpPassivePortStart whose +9 span exceeds 65535', () => {
    const result = CreateManagedStorageSchema.safeParse({
      ...baseInput,
      ftpEnabled: true,
      ftpPort: 8021,
      ftpPassivePortStart: 65_530,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('ftpPassivePortStart'))).toBe(true);
    }
  });

  it('accepts a ftpPassivePortStart whose +9 span lands exactly on 65535', () => {
    const result = CreateManagedStorageSchema.parse({
      ...baseInput,
      ftpEnabled: true,
      ftpPort: 8021,
      ftpPassivePortStart: 65_526,
    });

    expect(result.ftpPassivePortStart).toBe(65_526);
  });
});

describe('CreateManagedStorageSchema — ftpPassivePortCount', () => {
  it('accepts an in-range ftpPassivePortStart/ftpPassivePortCount pair', () => {
    const result = CreateManagedStorageSchema.parse({
      ...baseInput,
      ftpEnabled: true,
      ftpPort: 8021,
      ftpPassivePortStart: 65_500,
      ftpPassivePortCount: 36,
    });

    expect(result.ftpPassivePortCount).toBe(36);
  });

  it('omitting ftpPassivePortCount entirely stays valid (opt-in, defaults to 10-port behavior downstream)', () => {
    const result = CreateManagedStorageSchema.parse({
      ...baseInput,
      ftpEnabled: true,
      ftpPort: 8021,
      ftpPassivePortStart: 30_000,
    });

    expect(result.ftpPassivePortCount).toBeUndefined();
  });

  it('rejects ftpPassivePortStart + ftpPassivePortCount - 1 exceeding 65535', () => {
    const result = CreateManagedStorageSchema.safeParse({
      ...baseInput,
      ftpEnabled: true,
      ftpPort: 8021,
      ftpPassivePortStart: 65_530,
      ftpPassivePortCount: 10,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path.includes('ftpPassivePortStart') || issue.path.includes('ftpPassivePortCount')
        )
      ).toBe(true);
    }
  });

  it('accepts ftpPassivePortStart + ftpPassivePortCount - 1 landing exactly on 65535', () => {
    const result = CreateManagedStorageSchema.parse({
      ...baseInput,
      ftpEnabled: true,
      ftpPort: 8021,
      ftpPassivePortStart: 65_500,
      ftpPassivePortCount: 36,
    });

    expect(result.ftpPassivePortStart).toBe(65_500);
    expect(result.ftpPassivePortCount).toBe(36);
  });

  it('rejects ftpPassivePortCount of 0 (below the [1,64] range)', () => {
    const result = CreateManagedStorageSchema.safeParse({
      ...baseInput,
      ftpEnabled: true,
      ftpPort: 8021,
      ftpPassivePortStart: 30_000,
      ftpPassivePortCount: 0,
    });

    expect(result.success).toBe(false);
  });

  it('rejects ftpPassivePortCount of 65 (above the [1,64] range)', () => {
    const result = CreateManagedStorageSchema.safeParse({
      ...baseInput,
      ftpEnabled: true,
      ftpPort: 8021,
      ftpPassivePortStart: 30_000,
      ftpPassivePortCount: 65,
    });

    expect(result.success).toBe(false);
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
