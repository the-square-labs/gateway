import { AppError } from '@/middleware/error-handler.js';
import type { StorageProvider } from './object-storage.schemas.js';

/** Providers served over a file protocol rather than the S3 API. */
export const FILE_PROTOCOL_PROVIDERS = ['ftp', 'ftps', 'sftp'] as const;

export type FileProtocolProvider = (typeof FILE_PROTOCOL_PROVIDERS)[number];

const FILE_PROTOCOL_SET: ReadonlySet<string> = new Set(FILE_PROTOCOL_PROVIDERS);

export function isFileProtocolProvider(provider: StorageProvider): provider is FileProtocolProvider {
  return FILE_PROTOCOL_SET.has(provider);
}

/** Default port per file protocol, used when the connection leaves it blank. */
export const FILE_PROTOCOL_DEFAULT_PORTS: Record<FileProtocolProvider, number> = {
  ftp: 21,
  // Implicit FTPS conventionally listens on 990; explicit FTPS upgrades on 21.
  // `implicitTls` decides which of the two applies — see resolveFileProtocolPort.
  ftps: 21,
  sftp: 22,
};

export function resolveFileProtocolPort(
  provider: FileProtocolProvider,
  port: number | null,
  implicitTls: boolean
): number {
  if (port) return port;
  if (provider === 'ftps' && implicitTls) return 990;
  return FILE_PROTOCOL_DEFAULT_PORTS[provider];
}

/**
 * Path segments that must never appear in a bucket, prefix, or object key.
 *
 * `..` would climb above the connection's base path, and an empty segment comes
 * from a doubled slash — both are rejected outright rather than normalized
 * away, so a caller can never smuggle a traversal past a collapsing step.
 */
function assertSafeSegments(segments: string[], label: string): void {
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new AppError(400, 'STORAGE_INVALID_PATH', `Invalid ${label}: path segments must not be empty or relative`);
    }
    if (segment.includes('\0') || segment.includes('/') || segment.includes('\\')) {
      throw new AppError(400, 'STORAGE_INVALID_PATH', `Invalid ${label}: illegal character in path segment`);
    }
  }
}

/** Splits a slash-delimited path into segments, dropping the trailing empty one. */
function splitPath(value: string): string[] {
  const trimmed = value.replace(/\/+$/, '');
  return trimmed === '' ? [] : trimmed.split('/');
}

/** Normalizes a stored base path to a leading-slash, no-trailing-slash form. */
export function normalizeBasePath(basePath: string | null | undefined): string {
  const raw = (basePath ?? '').trim();
  if (raw === '' || raw === '/') return '';
  const segments = splitPath(raw.replace(/^\/+/, ''));
  assertSafeSegments(segments, 'base path');
  return `/${segments.join('/')}`;
}

/**
 * Resolves an absolute remote path from a connection's base path plus the
 * bucket/key pair the object-browser API speaks in.
 *
 * File servers have no buckets, so the first path segment under the base path
 * plays that role: bucket `photos` with key `2024/cat.jpg` on base path
 * `/srv/data` resolves to `/srv/data/photos/2024/cat.jpg`. Every segment is
 * validated, so no input can escape the base path.
 */
export function resolveRemotePath(basePath: string | null, bucket: string, key = ''): string {
  const base = normalizeBasePath(basePath);
  const bucketSegments = splitPath(bucket.replace(/^\/+/, ''));
  if (bucketSegments.length !== 1) {
    throw new AppError(400, 'STORAGE_INVALID_PATH', 'Bucket must be a single path segment');
  }
  assertSafeSegments(bucketSegments, 'bucket');

  const keySegments = splitPath(key.replace(/^\/+/, ''));
  assertSafeSegments(keySegments, 'key');

  return `${base}/${[...bucketSegments, ...keySegments].join('/')}`;
}

/** Resolves the absolute path of a bucket (top-level directory) itself. */
export function resolveBucketPath(basePath: string | null, bucket: string): string {
  return resolveRemotePath(basePath, bucket);
}

/** Joins a listing directory path with an entry name into an object key. */
export function joinKey(prefix: string, name: string): string {
  const normalizedPrefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  return normalizedPrefix === '' ? name : `${normalizedPrefix}/${name}`;
}
