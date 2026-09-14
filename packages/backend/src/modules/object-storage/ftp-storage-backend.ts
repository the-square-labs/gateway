import { PassThrough, Readable } from 'node:stream';
import { Client, type FileInfo } from 'basic-ftp';
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

/**
 * FTP and FTPS backend.
 *
 * FTP control connections are stateful and single-session: one command runs at
 * a time, and a half-finished transfer poisons the session for everyone else.
 * Rather than pool and police that, every operation opens its own short-lived
 * connection and closes it in a finally block. It costs a handshake per call
 * and makes concurrent browser requests independent.
 */
export class FtpStorageBackend implements StorageBackend {
  constructor(private readonly config: FileProtocolConnectionConfig) {}

  private async connect(): Promise<Client> {
    const client = new Client(CONNECT_TIMEOUT_MS);
    const secure = this.config.provider === 'ftps' ? (this.config.implicitTls ? 'implicit' : true) : false;
    try {
      await client.access({
        host: this.config.host,
        port: this.config.port,
        user: this.config.username || 'anonymous',
        password: this.config.password ?? '',
        secure,
        // A pinned CA narrows the trust anchor for servers using a private CA.
        // Verification is never turned off: without a pinned CA the system
        // trust store applies, exactly as it does for S3 over TLS.
        ...(this.config.caPem ? { secureOptions: { ca: this.config.caPem } } : {}),
      });
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await fn(client);
    } finally {
      client.close();
    }
  }

  async listBuckets(): Promise<S3BucketInfo[]> {
    const base = normalizeBasePath(this.config.basePath);
    return this.withClient(async (client) => {
      const entries = await client.list(base === '' ? '/' : base);
      return entries
        .filter((entry) => entry.isDirectory)
        .map((entry) => ({
          name: entry.name,
          creationDate: entry.modifiedAt?.toISOString() ?? null,
        }));
    });
  }

  async createBucket(bucket: string): Promise<void> {
    const path = resolveBucketPath(this.config.basePath, bucket);
    await this.withClient((client) => client.ensureDir(path));
  }

  async deleteBucket(bucket: string): Promise<void> {
    const path = resolveBucketPath(this.config.basePath, bucket);
    await this.withClient((client) => client.removeDir(path));
  }

  async listObjects(params: ListObjectsParams): Promise<S3ObjectListing> {
    const prefix = params.prefix ?? '';
    const maxKeys = params.maxKeys ?? 200;
    // An empty delimiter means "flatten everything below the prefix", which on
    // a file server can only be answered by walking the tree.
    const recursive = params.delimiter === '';

    return this.withClient(async (client) => {
      if (!recursive) {
        const dir = resolveRemotePath(this.config.basePath, params.bucket, prefix);
        const entries = await client.list(dir);
        return this.toListing(entries, prefix, maxKeys);
      }

      const objects: S3ObjectListing['objects'] = [];
      const walk = async (currentPrefix: string, depth: number): Promise<void> => {
        if (depth > MAX_RECURSIVE_DEPTH || objects.length >= Math.min(maxKeys, MAX_RECURSIVE_ENTRIES)) return;
        const dir = resolveRemotePath(this.config.basePath, params.bucket, currentPrefix);
        const entries = await client.list(dir);
        for (const entry of entries) {
          if (objects.length >= Math.min(maxKeys, MAX_RECURSIVE_ENTRIES)) return;
          const key = joinKey(currentPrefix, entry.name);
          if (entry.isDirectory) {
            await walk(key, depth + 1);
          } else if (entry.isFile) {
            objects.push(this.toObject(entry, key));
          }
        }
      };
      await walk(prefix, 0);
      return { prefixes: [], objects, nextContinuationToken: null, isTruncated: false };
    });
  }

  private toListing(entries: FileInfo[], prefix: string, maxKeys: number): S3ObjectListing {
    const prefixes: string[] = [];
    const objects: S3ObjectListing['objects'] = [];
    for (const entry of entries) {
      if (entry.isDirectory) {
        prefixes.push(`${joinKey(prefix, entry.name)}/`);
      } else if (entry.isFile) {
        objects.push(this.toObject(entry, joinKey(prefix, entry.name)));
      }
    }
    const truncated = objects.length > maxKeys;
    return {
      prefixes,
      objects: truncated ? objects.slice(0, maxKeys) : objects,
      nextContinuationToken: null,
      // File listings are returned whole, so a truncated page cannot be resumed
      // with a token — the flag tells the UI the view is incomplete.
      isTruncated: truncated,
    };
  }

  private toObject(entry: FileInfo, key: string): S3ObjectListing['objects'][number] {
    return {
      key,
      size: entry.size,
      lastModified: entry.modifiedAt?.toISOString() ?? null,
      etag: null,
      storageClass: null,
    };
  }

  async headObject(bucket: string, key: string): Promise<S3ObjectMetadata> {
    const path = resolveRemotePath(this.config.basePath, bucket, key);
    return this.withClient(async (client) => {
      const size = await client.size(path);
      let lastModified: string | null = null;
      try {
        lastModified = (await client.lastMod(path)).toISOString();
      } catch {
        // MDTM is optional in RFC 3659; servers without it still serve the file.
      }
      return {
        contentType: guessContentType(key),
        contentLength: size,
        lastModified,
        etag: null,
        metadata: {},
      };
    });
  }

  async presignObject(_params: PresignParams): Promise<string | null> {
    // FTP has no capability URLs — callers stream through Gateway instead.
    return null;
  }

  async uploadObject(params: UploadObjectParams): Promise<void> {
    const { parent, name } = splitKey(params.key);
    if (name === '') throw new AppError(400, 'STORAGE_INVALID_PATH', 'Object key must not end with a slash');
    const dir = resolveRemotePath(this.config.basePath, params.bucket, parent);
    const source = Buffer.isBuffer(params.body)
      ? Readable.from(params.body)
      : params.body instanceof Uint8Array
        ? Readable.from(Buffer.from(params.body))
        : params.body;

    await this.withClient(async (client) => {
      // ensureDir creates missing parents and leaves the session in that
      // directory, so the upload targets a bare file name.
      await client.ensureDir(dir);
      await client.uploadFrom(source, name);
    });
  }

  async getObjectStream(bucket: string, key: string): Promise<ObjectStreamResult> {
    const path = resolveRemotePath(this.config.basePath, bucket, key);
    const client = await this.connect();
    let contentLength: number | null = null;
    try {
      contentLength = await client.size(path);
    } catch {
      // Size is advisory; a server that refuses SIZE can still send the file.
    }

    // The transfer outlives this function, so the connection is closed by the
    // completion handlers below rather than a finally block.
    const stream = new PassThrough();
    client
      .downloadTo(stream, path)
      .then(() => stream.end())
      .catch((error: unknown) => stream.destroy(error instanceof Error ? error : new Error(String(error))))
      .finally(() => client.close());

    return { body: stream, contentType: guessContentType(key), contentLength };
  }

  async createPrefix(bucket: string, prefix: string): Promise<void> {
    const path = resolveRemotePath(this.config.basePath, bucket, prefix);
    await this.withClient((client) => client.ensureDir(path));
  }

  async deleteObjects(bucket: string, keys: string[]): Promise<void> {
    await this.withClient(async (client) => {
      for (const key of keys) {
        const path = resolveRemotePath(this.config.basePath, bucket, key);
        // A trailing slash marks a directory in the browser's selection.
        if (key.endsWith('/')) {
          await client.removeDir(path);
        } else {
          await client.remove(path);
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
