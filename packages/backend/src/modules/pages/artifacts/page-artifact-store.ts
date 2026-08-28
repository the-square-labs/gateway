import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, rename, rm, stat, truncate } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { AppError } from '@/middleware/error-handler.js';

const OPAQUE_ID = /^[0-9a-f-]{8,64}$/i;
const PRODUCTION_STORAGE_DIR = '/var/lib/gateway/pages';

export function resolvePageStorageDir(
  configuredDirectory: string,
  nodeEnvironment: string | undefined,
  temporaryDirectory = os.tmpdir()
): string {
  if (nodeEnvironment === 'production' || configuredDirectory !== PRODUCTION_STORAGE_DIR) return configuredDirectory;
  return join(temporaryDirectory, 'gateway-pages');
}

function assertOpaqueId(value: string, label: string): void {
  if (!OPAQUE_ID.test(value)) throw new AppError(400, 'PAGES_INVALID_STORAGE_ID', `Invalid ${label}`);
}

export class PageArtifactStore {
  private readonly root: string;
  private readonly uploadsRoot: string;
  private readonly artifactsRoot: string;
  private readonly appendLocks = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = resolve(root);
    this.uploadsRoot = join(this.root, 'uploads');
    this.artifactsRoot = join(this.root, 'artifacts');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.uploadsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.artifactsRoot, { recursive: true, mode: 0o700 }),
    ]);
  }

  uploadKey(uploadId: string): string {
    assertOpaqueId(uploadId, 'upload ID');
    return `uploads/${uploadId}.part`;
  }

  artifactKey(projectId: string, deploymentId: string): string {
    assertOpaqueId(projectId, 'Project ID');
    assertOpaqueId(deploymentId, 'Deployment ID');
    return `artifacts/${projectId}/${deploymentId}.tar.gz`;
  }

  resolveKey(key: string): string {
    if (!/^(?:uploads\/[0-9a-f-]{8,64}\.part|artifacts\/[0-9a-f-]{8,64}\/[0-9a-f-]{8,64}\.tar\.gz)$/i.test(key)) {
      throw new AppError(400, 'PAGES_INVALID_STORAGE_KEY', 'Invalid Pages storage key');
    }
    const target = resolve(this.root, key);
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) {
      throw new AppError(400, 'PAGES_STORAGE_ESCAPE', 'Pages storage path escaped its root');
    }
    return target;
  }

  async appendChunk(key: string, expectedOffset: number, bytes: Uint8Array): Promise<number> {
    if (!Number.isSafeInteger(expectedOffset) || expectedOffset < 0) {
      throw new AppError(400, 'PAGES_UPLOAD_OFFSET_INVALID', 'Upload offset must be a non-negative integer');
    }
    if (bytes.byteLength === 0) throw new AppError(400, 'PAGES_UPLOAD_CHUNK_EMPTY', 'Upload chunk is empty');
    return this.withAppendLock(key, async () => {
      const path = this.resolveKey(key);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      let handle: FileHandle;
      try {
        handle = await open(path, 'r+');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || expectedOffset !== 0) throw error;
        handle = await open(path, 'wx');
      }
      try {
        const storedSize = (await handle.stat()).size;
        if (storedSize !== expectedOffset) {
          throw new AppError(409, 'PAGES_UPLOAD_OFFSET_MISMATCH', 'Upload offset does not match stored bytes', {
            expectedOffset: storedSize,
          });
        }
        await handle.write(bytes, 0, bytes.byteLength, expectedOffset);
        await handle.sync();
        return expectedOffset + bytes.byteLength;
      } finally {
        await handle.close();
      }
    });
  }

  async rollbackChunk(key: string, expectedOffset: number, writtenEndOffset: number): Promise<void> {
    await this.withAppendLock(key, async () => {
      const path = this.resolveKey(key);
      try {
        const storedSize = (await stat(path)).size;
        if (storedSize === writtenEndOffset) await truncate(path, expectedOffset);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
  }

  async size(key: string): Promise<number> {
    try {
      return (await stat(this.resolveKey(key))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  async sha256(key: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(this.resolveKey(key))) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }

  read(key: string) {
    return createReadStream(this.resolveKey(key));
  }

  async commitUpload(uploadKey: string, artifactKey: string): Promise<void> {
    const source = this.resolveKey(uploadKey);
    const target = this.resolveKey(artifactKey);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await rename(source, target);
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true });
  }

  private async withAppendLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.appendLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const queued = previous.then(() => current);
    this.appendLocks.set(key, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.appendLocks.get(key) === queued) this.appendLocks.delete(key);
    }
  }
}
