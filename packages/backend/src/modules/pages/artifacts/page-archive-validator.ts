import { createReadStream } from 'node:fs';
import { posix } from 'node:path';
import { createGunzip } from 'node:zlib';
import { AppError } from '@/middleware/error-handler.js';

const TAR_BLOCK_SIZE = 512;
const MAX_METADATA_BYTES = 1024 * 1024;

export interface PageArchiveLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxExpandedBytes: number;
  maxPathBytes: number;
}

export interface PageArchiveValidationResult {
  fileCount: number;
  expandedSizeBytes: number;
}

interface PendingEntry {
  size: number;
  remaining: number;
  padding: number;
  metadata: 'pax' | 'longname' | null;
  metadataChunks: Buffer[];
}

function archiveError(code: string, message: string): AppError {
  return new AppError(400, code, message);
}

function readTarString(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start);
  return block.subarray(start, end === -1 || end > start + length ? start + length : end).toString('utf8');
}

function readOctal(block: Buffer, start: number, length: number, field: string): number {
  const raw = readTarString(block, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw archiveError('PAGES_ARCHIVE_INVALID_HEADER', `Invalid tar ${field}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw archiveError('PAGES_ARCHIVE_INVALID_HEADER', `Invalid tar ${field}`);
  }
  return value;
}

function verifyChecksum(block: Buffer): void {
  const expected = readOctal(block, 148, 8, 'checksum');
  let actual = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : block[index];
  }
  if (actual !== expected) throw archiveError('PAGES_ARCHIVE_CHECKSUM_INVALID', 'Invalid tar header checksum');
}

export function normalizeArchivePath(raw: string, maxPathBytes: number): string {
  const hasControlCharacter = [...raw].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!raw || raw.includes('\\') || hasControlCharacter) {
    throw archiveError('PAGES_ARCHIVE_PATH_INVALID', 'Archive contains an invalid path');
  }
  if (Buffer.byteLength(raw, 'utf8') > maxPathBytes) {
    throw archiveError('PAGES_ARCHIVE_PATH_TOO_LONG', 'Archive path is too long');
  }
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
    throw archiveError('PAGES_ARCHIVE_PATH_ABSOLUTE', 'Archive contains an absolute path');
  }
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) {
    throw archiveError('PAGES_ARCHIVE_PATH_TRAVERSAL', 'Archive path escapes the site root');
  }
  const normalized = posix.normalize(parts.join('/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw archiveError('PAGES_ARCHIVE_PATH_TRAVERSAL', 'Archive path escapes the site root');
  }
  return normalized;
}

function parsePaxPath(data: Buffer): string | null {
  let offset = 0;
  let path: string | null = null;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    if (space < 0) throw archiveError('PAGES_ARCHIVE_PAX_INVALID', 'Invalid PAX header');
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length) {
      throw archiveError('PAGES_ARCHIVE_PAX_INVALID', 'Invalid PAX record length');
    }
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const separator = record.indexOf('=');
    if (separator <= 0) throw archiveError('PAGES_ARCHIVE_PAX_INVALID', 'Invalid PAX record');
    const key = record.slice(0, separator);
    if (key === 'path') path = record.slice(separator + 1);
    if (key === 'linkpath') throw archiveError('PAGES_ARCHIVE_LINK_FORBIDDEN', 'Archive links are not allowed');
    offset += length;
  }
  return path;
}

function isArchiveRootDirectory(raw: string): boolean {
  return raw === '.' || /^\.\/+$/u.test(raw);
}

export async function validatePageArchive(
  archivePath: string,
  limits: PageArchiveLimits
): Promise<PageArchiveValidationResult> {
  const paths = new Set<string>();
  const regularFiles = new Set<string>();
  let buffer = Buffer.alloc(0);
  let pending: PendingEntry | null = null;
  let nextPath: string | null = null;
  let zeroBlocks = 0;
  let ended = false;
  let fileCount = 0;
  let entryCount = 0;
  let expandedSizeBytes = 0;
  let uncompressedBytes = 0;
  let hasRootEntrypoint = false;
  const maxTarBytes = limits.maxExpandedBytes + (limits.maxFiles + 4) * TAR_BLOCK_SIZE + MAX_METADATA_BYTES;

  const input = createReadStream(archivePath);
  const gunzip = createGunzip();
  input.on('error', (error) => gunzip.destroy(error));
  input.pipe(gunzip);

  try {
    for await (const rawChunk of gunzip) {
      const chunk = Buffer.from(rawChunk as Uint8Array);
      uncompressedBytes += chunk.length;
      if (uncompressedBytes > maxTarBytes) {
        throw archiveError('PAGES_ARCHIVE_EXPANDED_TOO_LARGE', 'Expanded archive exceeds the configured limit');
      }
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

      while (buffer.length > 0) {
        if (ended) {
          if (buffer.some((byte) => byte !== 0)) {
            throw archiveError('PAGES_ARCHIVE_TRAILING_DATA', 'Archive contains data after its end marker');
          }
          buffer = Buffer.alloc(0);
          break;
        }

        if (pending) {
          if (pending.remaining > 0) {
            const consumed = Math.min(pending.remaining, buffer.length);
            if (pending.metadata) pending.metadataChunks.push(buffer.subarray(0, consumed));
            pending.remaining -= consumed;
            buffer = buffer.subarray(consumed);
            if (pending.remaining > 0) break;
          }
          if (pending.padding > 0) {
            const consumed = Math.min(pending.padding, buffer.length);
            pending.padding -= consumed;
            buffer = buffer.subarray(consumed);
            if (pending.padding > 0) break;
          }
          if (pending.metadata) {
            const metadata = Buffer.concat(pending.metadataChunks, pending.size);
            if (pending.metadata === 'pax') nextPath = parsePaxPath(metadata);
            else nextPath = metadata.toString('utf8').replace(/\0.*$/s, '').replace(/\n$/, '');
          }
          pending = null;
          continue;
        }

        if (buffer.length < TAR_BLOCK_SIZE) break;
        const header = buffer.subarray(0, TAR_BLOCK_SIZE);
        buffer = buffer.subarray(TAR_BLOCK_SIZE);
        if (header.every((byte) => byte === 0)) {
          zeroBlocks += 1;
          if (zeroBlocks >= 2) ended = true;
          continue;
        }
        zeroBlocks = 0;
        verifyChecksum(header);
        const size = readOctal(header, 124, 12, 'size');
        const type = String.fromCharCode(header[156] || 48);
        const name = readTarString(header, 0, 100);
        const prefix = readTarString(header, 345, 155);
        const headerPath = prefix ? `${prefix}/${name}` : name;

        if (['1', '2', '3', '4', '6', '7'].includes(type)) {
          throw archiveError('PAGES_ARCHIVE_ENTRY_FORBIDDEN', 'Links, devices, and special files are not allowed');
        }
        if (type === 'g' || type === 'K') {
          throw archiveError(
            'PAGES_ARCHIVE_METADATA_UNSUPPORTED',
            'Global PAX and GNU long-link headers are not allowed'
          );
        }
        const isMetadata = type === 'x' || type === 'L';
        if (!isMetadata && type !== '0' && type !== '5') {
          throw archiveError('PAGES_ARCHIVE_ENTRY_UNSUPPORTED', 'Archive contains an unsupported entry type');
        }
        if (isMetadata) {
          if (size > MAX_METADATA_BYTES) {
            throw archiveError('PAGES_ARCHIVE_METADATA_TOO_LARGE', 'Archive metadata is too large');
          }
        } else {
          const rawPath = nextPath ?? headerPath;
          nextPath = null;
          if (type === '5' && isArchiveRootDirectory(rawPath)) {
            if (size !== 0) {
              throw archiveError('PAGES_ARCHIVE_DIRECTORY_INVALID', 'Archive directory has a payload');
            }
          } else {
            const path = normalizeArchivePath(rawPath, limits.maxPathBytes);
            if (paths.has(path)) throw archiveError('PAGES_ARCHIVE_DUPLICATE_PATH', 'Archive contains duplicate paths');
            const parts = path.split('/');
            for (let index = 1; index < parts.length; index += 1) {
              if (regularFiles.has(parts.slice(0, index).join('/'))) {
                throw archiveError('PAGES_ARCHIVE_PATH_CONFLICT', 'Archive path has a file as its parent');
              }
            }
            if (type === '0' && [...paths].some((existing) => existing.startsWith(`${path}/`))) {
              throw archiveError('PAGES_ARCHIVE_PATH_CONFLICT', 'Archive file conflicts with an existing child path');
            }
            paths.add(path);
            entryCount += 1;
            if (entryCount > limits.maxFiles) {
              throw archiveError('PAGES_ARCHIVE_TOO_MANY_FILES', 'Archive contains too many files');
            }
            if (type === '5' && size !== 0) {
              throw archiveError('PAGES_ARCHIVE_DIRECTORY_INVALID', 'Archive directory has a payload');
            }
            if (type === '0') {
              regularFiles.add(path);
              if (path === 'index.html' || path === 'index.htm') hasRootEntrypoint = true;
              fileCount += 1;
              if (size > limits.maxFileBytes) {
                throw archiveError('PAGES_ARCHIVE_FILE_TOO_LARGE', 'Archive contains a file that is too large');
              }
              expandedSizeBytes += size;
              if (expandedSizeBytes > limits.maxExpandedBytes) {
                throw archiveError('PAGES_ARCHIVE_EXPANDED_TOO_LARGE', 'Expanded archive exceeds the configured limit');
              }
            }
          }
        }
        pending = {
          size,
          remaining: size,
          padding: (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE,
          metadata: type === 'x' ? 'pax' : type === 'L' ? 'longname' : null,
          metadataChunks: [],
        };
      }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw archiveError('PAGES_ARCHIVE_INVALID_GZIP', 'Artifact must be a valid gzip-compressed tar archive');
  }

  if (pending || buffer.length > 0 || !ended) {
    throw archiveError('PAGES_ARCHIVE_TRUNCATED', 'Archive is truncated or missing its end marker');
  }
  if (nextPath) throw archiveError('PAGES_ARCHIVE_METADATA_ORPHANED', 'Archive metadata has no following entry');
  if (fileCount === 0) throw archiveError('PAGES_ARCHIVE_EMPTY', 'Archive contains no files');
  if (!hasRootEntrypoint) {
    throw archiveError('PAGES_ARCHIVE_ENTRYPOINT_MISSING', 'Archive must contain index.html or index.htm at its root');
  }
  return { fileCount, expandedSizeBytes };
}
