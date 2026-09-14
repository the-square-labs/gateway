import { describe, expect, it } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import {
  isFileProtocolProvider,
  joinKey,
  normalizeBasePath,
  resolveBucketPath,
  resolveFileProtocolPort,
  resolveRemotePath,
} from './object-storage-protocol.js';

describe('isFileProtocolProvider', () => {
  it('recognizes file protocols', () => {
    expect(isFileProtocolProvider('ftp')).toBe(true);
    expect(isFileProtocolProvider('ftps')).toBe(true);
    expect(isFileProtocolProvider('sftp')).toBe(true);
  });

  it('rejects S3 providers', () => {
    expect(isFileProtocolProvider('aws')).toBe(false);
    expect(isFileProtocolProvider('minio')).toBe(false);
    expect(isFileProtocolProvider('cloudflare_r2')).toBe(false);
    expect(isFileProtocolProvider('other')).toBe(false);
  });
});

describe('resolveFileProtocolPort', () => {
  it('keeps an explicit port', () => {
    expect(resolveFileProtocolPort('ftp', 2121, false)).toBe(2121);
    expect(resolveFileProtocolPort('sftp', 2222, false)).toBe(2222);
  });

  it('falls back to protocol defaults', () => {
    expect(resolveFileProtocolPort('ftp', null, false)).toBe(21);
    expect(resolveFileProtocolPort('sftp', null, false)).toBe(22);
    expect(resolveFileProtocolPort('ftps', null, false)).toBe(21);
  });

  it('uses 990 for implicit FTPS', () => {
    expect(resolveFileProtocolPort('ftps', null, true)).toBe(990);
  });
});

describe('normalizeBasePath', () => {
  it('normalizes empty and root values to an empty string', () => {
    expect(normalizeBasePath(null)).toBe('');
    expect(normalizeBasePath('')).toBe('');
    expect(normalizeBasePath('   ')).toBe('');
    expect(normalizeBasePath('/')).toBe('');
  });

  it('adds a leading slash and strips trailing ones', () => {
    expect(normalizeBasePath('srv/data')).toBe('/srv/data');
    expect(normalizeBasePath('/srv/data/')).toBe('/srv/data');
  });

  it('rejects relative segments', () => {
    expect(() => normalizeBasePath('/srv/../etc')).toThrow(AppError);
    expect(() => normalizeBasePath('/srv/./data')).toThrow(AppError);
  });
});

describe('resolveRemotePath', () => {
  it('joins base path, bucket and key', () => {
    expect(resolveRemotePath('/srv/data', 'photos', '2024/cat.jpg')).toBe('/srv/data/photos/2024/cat.jpg');
  });

  it('works without a base path', () => {
    expect(resolveRemotePath(null, 'photos', 'cat.jpg')).toBe('/photos/cat.jpg');
  });

  it('resolves the bucket itself when no key is given', () => {
    expect(resolveBucketPath('/srv/data', 'photos')).toBe('/srv/data/photos');
  });

  it('requires the bucket to be a single segment', () => {
    expect(() => resolveRemotePath('/srv', 'a/b', '')).toThrow(AppError);
  });

  // The traversal guard is the security boundary for file protocols: without
  // it, any key could reach outside the connection's configured base path.
  it('rejects traversal through the key', () => {
    expect(() => resolveRemotePath('/srv/data', 'photos', '../../etc/passwd')).toThrow(AppError);
    expect(() => resolveRemotePath('/srv/data', 'photos', 'a/../../b')).toThrow(AppError);
  });

  it('rejects traversal through the bucket', () => {
    expect(() => resolveRemotePath('/srv/data', '..', 'x')).toThrow(AppError);
  });

  it('rejects doubled slashes and empty segments', () => {
    expect(() => resolveRemotePath('/srv/data', 'photos', 'a//b')).toThrow(AppError);
  });

  it('rejects null bytes and backslashes', () => {
    expect(() => resolveRemotePath('/srv/data', 'photos', 'a\0b')).toThrow(AppError);
    expect(() => resolveRemotePath('/srv/data', 'photos', 'a\\..\\b')).toThrow(AppError);
  });

  it('ignores a leading slash on the key instead of treating it as absolute', () => {
    expect(resolveRemotePath('/srv/data', 'photos', '/cat.jpg')).toBe('/srv/data/photos/cat.jpg');
  });

  it('tolerates a trailing slash on a directory key', () => {
    expect(resolveRemotePath('/srv/data', 'photos', '2024/')).toBe('/srv/data/photos/2024');
  });
});

describe('joinKey', () => {
  it('joins a prefix and a name', () => {
    expect(joinKey('2024', 'cat.jpg')).toBe('2024/cat.jpg');
  });

  it('returns the bare name at the root', () => {
    expect(joinKey('', 'cat.jpg')).toBe('cat.jpg');
  });

  it('collapses surrounding slashes', () => {
    expect(joinKey('/2024/', 'cat.jpg')).toBe('2024/cat.jpg');
  });
});
