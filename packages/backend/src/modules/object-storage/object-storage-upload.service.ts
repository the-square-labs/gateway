import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { User } from '@/types.js';
import { ObjectMetadataQuerySchema } from './object-storage.schemas.js';
import type { ObjectStorageService } from './object-storage.service.js';

export const STORAGE_UPLOAD_CHUNK_BYTES = 1024 * 1024;
const TTL_MS = 60 * 60 * 1000;
const BeginSchema = ObjectMetadataQuerySchema.extend({
  declaredSizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.string().min(1).max(255).optional(),
});
type State = 'open' | 'finalizing' | 'completed' | 'failed' | 'aborted';
interface Session extends z.infer<typeof BeginSchema> {
  id: string;
  userId: string;
  storageId: string;
  directory: string | null;
  offset: number;
  expiresAt: number;
  state: State;
}

/** MCP carries bounded chunks; only the private spool file reaches provider streaming. */
export class ObjectStorageUploadService {
  private readonly sessions = new Map<string, Session>();
  private readonly busy = new Set<string>();
  private sweep: ReturnType<typeof setInterval> | undefined;
  private pendingBegins = 0;
  private cleaning = false;

  constructor(
    private readonly storage: Pick<ObjectStorageService, 'get' | 'uploadObject'>,
    private readonly settings: Pick<GeneralSettingsService, 'getConfig'>,
    private readonly temporaryRoot = join(tmpdir(), 'gateway-storage-mcp')
  ) {
    this.sweep = setInterval(() => {
      void this.cleanup().catch(() => {});
    }, 60_000);
    this.sweep.unref();
  }

  async execute(user: Pick<User, 'id' | 'scopes'>, args: Record<string, unknown>) {
    const operation = z.enum(['begin', 'chunk', 'status', 'finalize', 'abort']).parse(args.operation);
    const storageId = z.string().uuid().parse(args.storageId);
    if (!hasScopeForResource(user.scopes, 'storage:objects:write', storageId))
      throw new AppError(403, 'FORBIDDEN', 'Missing storage:objects:write permission');
    if (operation === 'begin') return this.begin(user.id, storageId, BeginSchema.parse(args));
    const uploadId = z.string().uuid().parse(args.uploadId);
    const session = this.sessions.get(uploadId);
    // Upload IDs do not grant access, including status/abort and completed receipts.
    if (!session || session.userId !== user.id || session.storageId !== storageId)
      throw new AppError(404, 'STORAGE_UPLOAD_NOT_FOUND', 'Upload session not found');
    if (this.busy.has(uploadId)) throw new AppError(409, 'STORAGE_UPLOAD_BUSY', 'Upload operation is in progress');
    this.busy.add(uploadId);
    try {
      if (session.expiresAt <= Date.now()) {
        await this.removeFile(session);
        this.sessions.delete(uploadId);
        throw new AppError(410, 'STORAGE_UPLOAD_EXPIRED', 'Upload session has expired; begin a new upload');
      }
      if (operation === 'status') return this.view(session);
      if (operation === 'abort') {
        if (session.state === 'completed')
          throw new AppError(409, 'STORAGE_UPLOAD_COMPLETED', 'Completed objects must be deleted explicitly');
        session.state = 'aborted';
        await this.removeFile(session);
        return this.view(session);
      }
      if (operation === 'finalize' && session.state === 'completed') return this.view(session);
      if (session.state !== 'open') throw new AppError(409, 'STORAGE_UPLOAD_NOT_OPEN', 'Upload is not open');
      if (operation === 'chunk') return await this.append(session, args);
      return await this.finalize(session);
    } finally {
      this.busy.delete(uploadId);
      // Retain only bounded recent terminal receipts, independently of active
      // upload admission. Reading a receipt refreshes its LRU position.
      if (this.sessions.has(uploadId) && session.directory === null) {
        this.sessions.delete(uploadId);
        this.sessions.set(uploadId, session);
      }
      this.trimReceipts();
    }
  }

  private async begin(userId: string, storageId: string, input: z.infer<typeof BeginSchema>) {
    // Serialize admission across awaits; otherwise concurrent begins can bypass reservations.
    if (this.pendingBegins) throw new AppError(409, 'STORAGE_UPLOAD_BUSY', 'Retry upload admission');
    this.pendingBegins++;
    let directory: string | undefined;
    try {
      await this.cleanup();
      await this.storage.get(storageId);
      const { fileUploadMaxBytes } = await this.settings.getConfig();
      if (input.declaredSizeBytes > fileUploadMaxBytes)
        throw new AppError(413, 'STORAGE_UPLOAD_TOO_LARGE', 'Object exceeds the Gateway file-upload limit');
      const active = [...this.sessions.values()].filter((s) => s.directory !== null);
      const reserved = active.reduce((total, s) => total + s.declaredSizeBytes, 0);
      if (
        active.length >= 32 ||
        active.filter((s) => s.userId === userId).length >= 4 ||
        reserved + input.declaredSizeBytes > Math.min(20 * 1024 ** 3, fileUploadMaxBytes * 4)
      )
        throw new AppError(
          429,
          'STORAGE_UPLOAD_CAPACITY',
          'Too many uploads or reserved upload bytes; abort unused sessions'
        );
      await mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(this.temporaryRoot, 'upload-'));
      const file = await open(join(directory, 'object'), 'wx', 0o600);
      await file.close();
      const session: Session = {
        ...input,
        id: randomUUID(),
        userId,
        storageId,
        directory,
        offset: 0,
        expiresAt: Date.now() + TTL_MS,
        state: 'open',
      };
      this.sessions.set(session.id, session);
      return this.view(session);
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      this.pendingBegins--;
    }
  }

  private async append(session: Session, args: Record<string, unknown>) {
    const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(args.offset);
    const encoded = z
      .string()
      .min(4)
      .max(4 * Math.ceil(STORAGE_UPLOAD_CHUNK_BYTES / 3))
      .parse(args.contentBase64);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
      throw new AppError(400, 'STORAGE_UPLOAD_INVALID_CHUNK', 'Chunk must be canonical base64');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > STORAGE_UPLOAD_CHUNK_BYTES || bytes.toString('base64') !== encoded)
      throw new AppError(400, 'STORAGE_UPLOAD_INVALID_CHUNK', 'Chunk must contain 1 byte to 1 MiB');
    if (offset !== session.offset)
      throw new AppError(409, 'STORAGE_UPLOAD_OFFSET_MISMATCH', 'Upload offset does not match', {
        expectedOffset: session.offset,
      });
    if (offset + bytes.length > session.declaredSizeBytes)
      throw new AppError(400, 'STORAGE_UPLOAD_SIZE_EXCEEDED', 'Chunk exceeds declared object size');
    const file = await open(join(session.directory!, 'object'), 'r+');
    try {
      let written = 0;
      while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written, offset + written);
        if (result.bytesWritten === 0) throw new Error('Upload spool write made no progress');
        written += result.bytesWritten;
      }
      await file.sync();
      session.offset += bytes.length;
    } catch (error) {
      await file.truncate(offset);
      throw error;
    } finally {
      await file.close();
    }
    return this.view(session);
  }

  private async finalize(session: Session) {
    if (session.offset !== session.declaredSizeBytes)
      throw new AppError(409, 'STORAGE_UPLOAD_INCOMPLETE', 'Upload is incomplete', { expectedOffset: session.offset });
    session.state = 'finalizing';
    const path = join(session.directory!, 'object');
    try {
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(path)) hash.update(bytes);
      if (hash.digest('hex') !== session.sha256)
        throw new AppError(400, 'STORAGE_UPLOAD_HASH_MISMATCH', 'Object SHA-256 does not match');
      const body = createReadStream(path);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          body.destroy();
          reject(new Error('Storage upload timed out'));
        }, TTL_MS);
        timeout.unref();
      });
      try {
        await Promise.race([
          this.storage.uploadObject(
            session.storageId,
            {
              bucket: session.bucket,
              key: session.key,
              contentType: session.contentType,
              body,
            },
            session.userId
          ),
          deadline,
        ]);
      } finally {
        clearTimeout(timeout);
        body.destroy();
      }
      session.state = 'completed';
    } catch (error) {
      session.state = 'failed';
      // Do not replay an ambiguous provider write: caller must inspect the destination.
      if (error instanceof AppError && error.code === 'STORAGE_UPLOAD_HASH_MISMATCH') throw error;
      throw new AppError(
        502,
        'STORAGE_UPLOAD_FAILED',
        'Upload finalization failed; inspect the destination before starting another upload'
      );
    } finally {
      // A cleanup failure must not turn a successful provider upload into a retry.
      await this.removeFile(session).catch(() => {});
    }
    return this.view(session);
  }

  private view(session: Session) {
    return {
      uploadId: session.id,
      storageId: session.storageId,
      bucket: session.bucket,
      key: session.key,
      offset: session.offset,
      declaredSizeBytes: session.declaredSizeBytes,
      status: session.state,
      expiresAt: new Date(session.expiresAt).toISOString(),
      maxChunkBytes: STORAGE_UPLOAD_CHUNK_BYTES,
    };
  }

  private async removeFile(session: Session) {
    if (!session.directory) return;
    await rm(session.directory, { recursive: true, force: true });
    session.directory = null;
  }

  private trimReceipts() {
    let retained = 0;
    const perUser = new Map<string, number>();
    for (const session of [...this.sessions.values()].reverse()) {
      if (session.directory !== null || this.busy.has(session.id)) continue;
      const userCount = perUser.get(session.userId) ?? 0;
      if (retained >= 256 || userCount >= 32) this.sessions.delete(session.id);
      else {
        retained++;
        perUser.set(session.userId, userCount + 1);
      }
    }
  }

  async cleanup() {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      for (const session of this.sessions.values()) {
        if (this.busy.has(session.id)) continue;
        this.busy.add(session.id);
        try {
          if (session.expiresAt <= Date.now()) {
            await this.removeFile(session);
            this.sessions.delete(session.id);
          } else if (['completed', 'failed', 'aborted'].includes(session.state)) {
            await this.removeFile(session);
          }
        } finally {
          this.busy.delete(session.id);
        }
      }
      // The process-local sessions deliberately do not survive a restart. Only
      // aged upload directories in this dedicated namespace are reclaimable;
      // two TTLs cover both admission lifetime and a finalization in progress.
      const live = new Set([...this.sessions.values()].map((session) => session.directory));
      const entries = await readdir(this.temporaryRoot, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^upload-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
        const path = join(this.temporaryRoot, entry.name);
        if (live.has(path)) continue;
        const info = await stat(path).catch(() => null);
        if (info && info.mtimeMs < Date.now() - 2 * TTL_MS) await rm(path, { recursive: true, force: true });
      }
    } finally {
      this.cleaning = false;
      this.trimReceipts();
    }
  }

  async destroy() {
    if (this.sweep) clearInterval(this.sweep);
    for (const session of this.sessions.values()) if (!this.busy.has(session.id)) await this.removeFile(session);
    this.sessions.clear();
  }
}
