import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObjectStorageUploadService, STORAGE_UPLOAD_CHUNK_BYTES } from './object-storage-upload.service.js';

const storageId = '11111111-1111-4111-8111-111111111111';
const user = { id: 'alice', scopes: [`storage:objects:write:${storageId}`] };
const roots: string[] = [];
const services: ObjectStorageUploadService[] = [];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function setup(limit = 8 * 1024 ** 2) {
  const root = await mkdtemp(join(tmpdir(), 'test-storage-mcp-'));
  roots.push(root);
  const storage = {
    get: vi.fn().mockResolvedValue({ id: storageId }),
    uploadObject: vi.fn().mockResolvedValue(undefined),
  };
  const settings = { getConfig: vi.fn().mockResolvedValue({ fileUploadMaxBytes: limit }) };
  const service = new ObjectStorageUploadService(storage as never, settings as never, root);
  services.push(service);
  const call = (args: Record<string, unknown>, principal = user) => service.execute(principal, { storageId, ...args });
  const begin = (bytes = Buffer.from('hello')) =>
    call({
      operation: 'begin',
      bucket: 'assets',
      key: 'file.bin',
      declaredSizeBytes: bytes.length,
      sha256: sha(bytes),
    });
  return { root, storage, settings, service, call, begin };
}
afterEach(async () => {
  vi.useRealTimers();
  for (const service of services.splice(0)) await service.destroy();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('MCP object upload', () => {
  it('spools ordered bounded chunks privately and streams the verified object once', async () => {
    const { begin, call, storage, root } = await setup();
    const bytes = Buffer.alloc(STORAGE_UPLOAD_CHUNK_BYTES * 2 + 17, 7);
    const { uploadId } = await begin(bytes);
    const directory = join(root, (await readdir(root))[0]!);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, 'object'))).mode & 0o777).toBe(0o600);
    for (let offset = 0; offset < bytes.length; offset += STORAGE_UPLOAD_CHUNK_BYTES) {
      const part = bytes.subarray(offset, offset + STORAGE_UPLOAD_CHUNK_BYTES);
      expect(
        await call({ operation: 'chunk', uploadId, offset, contentBase64: part.toString('base64') })
      ).toMatchObject({ offset: offset + part.length });
    }
    storage.uploadObject.mockImplementation(async (_id, params) => {
      expect(params.body).toBeInstanceOf(Readable);
      const hash = createHash('sha256');
      let received = 0;
      for await (const part of params.body) {
        hash.update(part);
        received += part.length;
      }
      expect(received).toBe(bytes.length);
      expect(hash.digest('hex')).toBe(sha(bytes));
    });
    expect(await call({ operation: 'finalize', uploadId })).toMatchObject({ status: 'completed' });
    expect(await readdir(root)).toEqual([]);
    expect(await call({ operation: 'finalize', uploadId })).toMatchObject({ status: 'completed' });
    expect(storage.uploadObject).toHaveBeenCalledTimes(1);
    await expect(call({ operation: 'abort', uploadId })).rejects.toMatchObject({ code: 'STORAGE_UPLOAD_COMPLETED' });
  });

  it('checks ownership and current scope on every operation, including receipts', async () => {
    const { begin, call } = await setup();
    const { uploadId } = await begin();
    for (const operation of ['chunk', 'status', 'finalize', 'abort']) {
      await expect(call({ operation, uploadId }, { ...user, id: 'bob' })).rejects.toMatchObject({ statusCode: 404 });
      await expect(call({ operation, uploadId }, { ...user, scopes: [] })).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        call(
          { operation, uploadId, storageId: '22222222-2222-4222-8222-222222222222' },
          { ...user, scopes: ['storage:objects:write'] }
        )
      ).rejects.toMatchObject({ statusCode: 404 });
    }
  });

  it('rejects incomplete uploads, invalid chunks, oversize chunks, and duplicate offsets without consuming bytes', async () => {
    const { begin, call } = await setup();
    const { uploadId } = await begin();
    await expect(call({ operation: 'finalize', uploadId })).rejects.toMatchObject({
      code: 'STORAGE_UPLOAD_INCOMPLETE',
    });
    for (const contentBase64 of [
      '!!!=',
      'aG VsbG8=',
      'aG==',
      Buffer.alloc(STORAGE_UPLOAD_CHUNK_BYTES + 1).toString('base64'),
    ])
      await expect(call({ operation: 'chunk', uploadId, offset: 0, contentBase64 })).rejects.toBeDefined();
    await expect(call({ operation: 'chunk', uploadId, offset: 1, contentBase64: 'aGVsbG8=' })).rejects.toMatchObject({
      code: 'STORAGE_UPLOAD_OFFSET_MISMATCH',
    });
    await expect(
      call({ operation: 'chunk', uploadId, offset: 0, contentBase64: Buffer.from('toolong').toString('base64') })
    ).rejects.toMatchObject({ code: 'STORAGE_UPLOAD_SIZE_EXCEEDED' });
    await call({ operation: 'chunk', uploadId, offset: 0, contentBase64: 'aGVsbG8=' });
    await expect(call({ operation: 'chunk', uploadId, offset: 0, contentBase64: 'aGVsbG8=' })).rejects.toMatchObject({
      code: 'STORAGE_UPLOAD_OFFSET_MISMATCH',
    });
    expect(await call({ operation: 'status', uploadId })).toMatchObject({ offset: 5 });
  });

  it('rejects a bad hash before provider mutation and cleans the spool', async () => {
    const { begin, call, storage, root } = await setup();
    const { uploadId } = await begin();
    await call({ operation: 'chunk', uploadId, offset: 0, contentBase64: Buffer.from('other').toString('base64') });
    await expect(call({ operation: 'finalize', uploadId })).rejects.toMatchObject({
      code: 'STORAGE_UPLOAD_HASH_MISMATCH',
    });
    expect(storage.uploadObject).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('does not replay an ambiguous provider failure', async () => {
    const { begin, call, storage } = await setup();
    const { uploadId } = await begin(Buffer.alloc(0));
    storage.uploadObject.mockRejectedValue(new Error('provider connection lost after commit'));
    await expect(call({ operation: 'finalize', uploadId })).rejects.toMatchObject({ code: 'STORAGE_UPLOAD_FAILED' });
    expect(await call({ operation: 'status', uploadId })).toMatchObject({ status: 'failed' });
    await expect(call({ operation: 'finalize', uploadId })).rejects.toMatchObject({ code: 'STORAGE_UPLOAD_NOT_OPEN' });
    expect(storage.uploadObject).toHaveBeenCalledTimes(1);
  });

  it('serializes chunk mutation and excludes finalization/abort while uploading', async () => {
    const { begin, call, storage } = await setup();
    const { uploadId } = await begin(Buffer.alloc(0));
    let done!: () => void;
    storage.uploadObject.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        })
    );
    const finalize = call({ operation: 'finalize', uploadId });
    await vi.waitFor(() => expect(storage.uploadObject).toHaveBeenCalled());
    for (const operation of ['finalize', 'abort', 'chunk'])
      await expect(call({ operation, uploadId })).rejects.toMatchObject({ code: 'STORAGE_UPLOAD_BUSY' });
    done();
    await finalize;
  });

  it('enforces size/session admission and releases reservations on abort', async () => {
    const { begin, call } = await setup(5);
    await expect(begin(Buffer.alloc(6))).rejects.toMatchObject({ code: 'STORAGE_UPLOAD_TOO_LARGE' });
    const sessions = [];
    for (let n = 0; n < 4; n++) sessions.push(await begin());
    await expect(begin()).rejects.toMatchObject({ code: 'STORAGE_UPLOAD_CAPACITY' });
    expect(await call({ operation: 'abort', uploadId: sessions[0]!.uploadId })).toMatchObject({ status: 'aborted' });
    await expect(begin()).resolves.toMatchObject({ status: 'open' });
  });

  it('expires sessions and reclaims old orphan spool directories without touching unrelated files', async () => {
    const { begin, call, root, service } = await setup();
    const { uploadId } = await begin();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_001);
    await expect(call({ operation: 'status', uploadId })).rejects.toMatchObject({ code: 'STORAGE_UPLOAD_EXPIRED' });
    vi.restoreAllMocks();
    const orphan = await mkdtemp(join(root, 'upload-'));
    const unrelated = await mkdtemp(join(root, 'keep-'));
    await utimes(orphan, new Date(0), new Date(0));
    await service.cleanup();
    expect(await readdir(root)).toEqual([unrelated.split('/').at(-1)]);
  });

  it('evicts terminal receipts without blocking active admission or another user receipts', async () => {
    const { begin, call } = await setup();
    const bob = { ...user, id: 'bob' };
    const other = await call(
      { operation: 'begin', bucket: 'assets', key: 'bob', declaredSizeBytes: 0, sha256: sha(Buffer.alloc(0)) },
      bob
    );
    await call({ operation: 'finalize', uploadId: other.uploadId }, bob);
    const active = await begin();
    const first = await begin();
    await call({ operation: 'abort', uploadId: first.uploadId });
    let latest = first;
    for (let index = 0; index < 260; index++) {
      latest = await begin();
      await call({ operation: 'abort', uploadId: latest.uploadId });
    }
    await expect(call({ operation: 'status', uploadId: first.uploadId })).rejects.toMatchObject({ statusCode: 404 });
    expect(await call({ operation: 'status', uploadId: latest.uploadId })).toMatchObject({ status: 'aborted' });
    expect(await call({ operation: 'status', uploadId: active.uploadId })).toMatchObject({ status: 'open' });
    expect(await call({ operation: 'finalize', uploadId: other.uploadId }, bob)).toMatchObject({ status: 'completed' });
    await expect(begin()).resolves.toMatchObject({ status: 'open' });
  });
});
