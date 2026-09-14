import { createHash, timingSafeEqual } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import SftpClient from 'ssh2-sftp-client';
import { AppError } from '@/middleware/error-handler.js';
import { guessContentType, MAX_RECURSIVE_DEPTH, MAX_RECURSIVE_ENTRIES, splitKey } from './file-protocol-shared.js';
import type { FileProtocolConnectionConfig } from './object-storage-connection-view.js';
import { joinKey, normalizeBasePath, resolveBucketPath, resolveRemotePath } from './object-storage-protocol.js';
import type {
  ListObjectsParams,
  ObjectStreamResult,
  PresignParams,
  S3BucketInfo,
  S3ObjectListing,
  S3ObjectMetadata,
  StorageBackend,
  UploadObjectParams,
} from './storage-backend.js';

const CONNECT_TIMEOUT_MS = 15_000;

/** A directory entry as ssh2-sftp-client reports it. */
interface SftpEntry {
  type: string;
  name: string;
  size: number;
  modifyTime: number;
}

/**
 * SFTP backend (SSH file transfer, unrelated to FTPS).
 *
 * Like the FTP backend, each operation gets its own connection. An SSH
 * handshake is pricier than an FTP one, but it keeps concurrent browser
 * requests from sharing mutable session state, and it means a dropped
 * connection can never leave a cached client in a broken state.
 */
export class SftpStorageBackend implements StorageBackend {
  constructor(private readonly config: FileProtocolConnectionConfig) {}

  private async connect(): Promise<SftpClient> {
    const client = new SftpClient();
    if (!this.config.password && !this.config.privateKey) {
      throw new AppError(400, 'STORAGE_SECRET_REQUIRED', 'SFTP requires either a password or a private key');
    }
    const fingerprint = this.config.hostKeyFingerprint;
    if (!fingerprint || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(fingerprint)) {
      throw new AppError(400, 'STORAGE_HOST_KEY_REQUIRED', 'A verified SSH host key fingerprint is required');
    }
    const expected = Buffer.from(fingerprint.slice(7), 'base64');
    await client.connect({
      hostVerifier: (key: Buffer) => {
        const actual = createHash('sha256').update(key).digest();
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      },
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      ...(this.config.password ? { password: this.config.password } : {}),
      ...(this.config.privateKey ? { privateKey: this.config.privateKey } : {}),
      ...(this.config.passphrase ? { passphrase: this.config.passphrase } : {}),
      readyTimeout: CONNECT_TIMEOUT_MS,
    });
    return client;
  }

  private async withClient<T>(fn: (client: SftpClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => {});
    }
  }

  private async listEntries(client: SftpClient, path: string): Promise<SftpEntry[]> {
    return (await client.list(path)) as unknown as SftpEntry[];
  }

  async listBuckets(): Promise<S3BucketInfo[]> {
    const base = normalizeBasePath(this.config.basePath);
    return this.withClient(async (client) => {
      const entries = await this.listEntries(client, base === '' ? '/' : base);
      return entries
        .filter((entry) => entry.type === 'd')
        .map((entry) => ({
          name: entry.name,
          creationDate: entry.modifyTime ? new Date(entry.modifyTime).toISOString() : null,
        }));
    });
  }

  async createBucket(bucket: string): Promise<void> {
    const path = resolveBucketPath(this.config.basePath, bucket);
    await this.withClient((client) => client.mkdir(path, true));
  }

  async deleteBucket(bucket: string): Promise<void> {
    const path = resolveBucketPath(this.config.basePath, bucket);
    // Non-recursive: deleting a bucket must not silently discard its contents.
    await this.withClient((client) => client.rmdir(path, false));
  }

  async listObjects(params: ListObjectsParams): Promise<S3ObjectListing> {
    const prefix = params.prefix ?? '';
    const maxKeys = params.maxKeys ?? 200;
    const recursive = params.delimiter === '';

    return this.withClient(async (client) => {
      if (!recursive) {
        const dir = resolveRemotePath(this.config.basePath, params.bucket, prefix);
        const entries = await this.listEntries(client, dir);
        return this.toListing(entries, prefix, maxKeys);
      }

      const limit = Math.min(maxKeys, MAX_RECURSIVE_ENTRIES);
      const objects: S3ObjectListing['objects'] = [];
      const walk = async (currentPrefix: string, depth: number): Promise<void> => {
        if (depth > MAX_RECURSIVE_DEPTH || objects.length >= limit) return;
        const dir = resolveRemotePath(this.config.basePath, params.bucket, currentPrefix);
        for (const entry of await this.listEntries(client, dir)) {
          if (objects.length >= limit) return;
          const key = joinKey(currentPrefix, entry.name);
          if (entry.type === 'd') {
            await walk(key, depth + 1);
          } else if (entry.type === '-') {
            objects.push(this.toObject(entry, key));
          }
        }
      };
      await walk(prefix, 0);
      return { prefixes: [], objects, nextContinuationToken: null, isTruncated: false };
    });
  }

  private toListing(entries: SftpEntry[], prefix: string, maxKeys: number): S3ObjectListing {
    const prefixes: string[] = [];
    const objects: S3ObjectListing['objects'] = [];
    for (const entry of entries) {
      if (entry.type === 'd') {
        prefixes.push(`${joinKey(prefix, entry.name)}/`);
      } else if (entry.type === '-') {
        objects.push(this.toObject(entry, joinKey(prefix, entry.name)));
      }
    }
    const truncated = objects.length > maxKeys;
    return {
      prefixes,
      objects: truncated ? objects.slice(0, maxKeys) : objects,
      nextContinuationToken: null,
      isTruncated: truncated,
    };
  }

  private toObject(entry: SftpEntry, key: string): S3ObjectListing['objects'][number] {
    return {
      key,
      size: entry.size,
      lastModified: entry.modifyTime ? new Date(entry.modifyTime).toISOString() : null,
      etag: null,
      storageClass: null,
    };
  }

  async headObject(bucket: string, key: string): Promise<S3ObjectMetadata> {
    const path = resolveRemotePath(this.config.basePath, bucket, key);
    return this.withClient(async (client) => {
      const stats = await client.stat(path);
      return {
        contentType: guessContentType(key),
        contentLength: stats.size,
        lastModified: stats.modifyTime ? new Date(stats.modifyTime).toISOString() : null,
        etag: null,
        metadata: {},
      };
    });
  }

  async presignObject(_params: PresignParams): Promise<string | null> {
    // SFTP has no capability URLs — callers stream through Gateway instead.
    return null;
  }

  async uploadObject(params: UploadObjectParams): Promise<void> {
    const { parent, name } = splitKey(params.key);
    if (name === '') throw new AppError(400, 'STORAGE_INVALID_PATH', 'Object key must not end with a slash');
    const dir = resolveRemotePath(this.config.basePath, params.bucket, parent);
    const target = resolveRemotePath(this.config.basePath, params.bucket, params.key);
    const source = Buffer.isBuffer(params.body)
      ? params.body
      : params.body instanceof Uint8Array
        ? Buffer.from(params.body)
        : params.body;

    await this.withClient(async (client) => {
      if (!(await client.exists(dir))) {
        await client.mkdir(dir, true);
      }
      await client.put(source as Buffer | Readable, target);
    });
  }

  async getObjectStream(bucket: string, key: string): Promise<ObjectStreamResult> {
    const path = resolveRemotePath(this.config.basePath, bucket, key);
    const client = await this.connect();
    let contentLength: number | null = null;
    try {
      contentLength = (await client.stat(path)).size;
    } catch {
      // Size is advisory; the transfer below is what actually matters.
    }

    // The transfer outlives this function, so the connection is closed by the
    // completion handlers rather than a finally block.
    const stream = new PassThrough();
    client
      .get(path, stream)
      .catch((error: unknown) => stream.destroy(error instanceof Error ? error : new Error(String(error))))
      .finally(() => {
        client.end().catch(() => {});
      });

    return { body: stream, contentType: guessContentType(key), contentLength };
  }

  async createPrefix(bucket: string, prefix: string): Promise<void> {
    const path = resolveRemotePath(this.config.basePath, bucket, prefix);
    await this.withClient((client) => client.mkdir(path, true));
  }

  async deleteObjects(bucket: string, keys: string[]): Promise<void> {
    await this.withClient(async (client) => {
      for (const key of keys) {
        const path = resolveRemotePath(this.config.basePath, bucket, key);
        if (key.endsWith('/')) {
          await client.rmdir(path, true);
        } else {
          await client.delete(path);
        }
      }
    });
  }

  async probe(): Promise<void> {
    const base = normalizeBasePath(this.config.basePath);
    await this.withClient((client) => client.list(base === '' ? '/' : base));
  }

  destroy(): void {
    // Connections are per-operation; nothing is held open between calls.
  }
}
