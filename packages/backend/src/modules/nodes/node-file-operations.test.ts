import { describe, expect, it, vi } from 'vitest';
import {
  DOCKER_FILE_READ_MAX_BYTES,
  DOCKER_FILE_READ_REQUEST_BYTES,
  dockerFileTransferTimeoutMs,
} from '@/modules/docker/docker-read-operations.js';
import {
  appendNodeFileUploadChunk,
  initNodeFileUpload,
  listNodeFiles,
  readNodeFile,
  writeNodeFile,
} from './node-file-operations.js';

function createContext(dispatchResult: unknown) {
  const nodeDispatch = {
    sendNodeFileCommand: vi.fn().mockResolvedValue(dispatchResult),
  };
  const auditService = { log: vi.fn().mockResolvedValue(undefined) };
  const eventBus = { publish: vi.fn() };
  const parseResult = vi.fn((result: { success: boolean; error?: string; detail?: string }) => {
    if (!result.success) throw new Error(result.error ?? 'Command failed on daemon');
    return result.detail ? JSON.parse(result.detail) : null;
  });

  return {
    context: { nodeDispatch, auditService, eventBus, parseResult },
    nodeDispatch,
    auditService,
    eventBus,
    parseResult,
  };
}

describe('node file operations', () => {
  it('lists node root files from daemon detail payload', async () => {
    const entries = [
      { name: 'etc', isDir: true, size: 4096, permissions: 'drwxr-xr-x', modified: 'Jun 23 12:00' },
      { name: 'var', isDir: true, size: 4096, permissions: 'drwxr-xr-x', modified: 'Jun 23 12:00' },
    ];
    const { context, nodeDispatch } = createContext({
      success: true,
      detail: JSON.stringify(entries),
    });

    await expect(listNodeFiles(context as never, 'node-1', '/')).resolves.toEqual(entries);
    expect(nodeDispatch.sendNodeFileCommand).toHaveBeenCalledWith('node-1', 'list', { path: '/' });
  });

  it('reads node files from binary daemon payload, including empty files', async () => {
    const { context, nodeDispatch } = createContext({
      success: true,
      data: Buffer.alloc(0),
    });

    await expect(readNodeFile(context as never, 'node-1', '/tmp/empty.txt')).resolves.toEqual(Buffer.alloc(0));
    expect(nodeDispatch.sendNodeFileCommand).toHaveBeenCalledWith(
      'node-1',
      'read',
      { path: '/tmp/empty.txt', maxBytes: DOCKER_FILE_READ_MAX_BYTES + 1 },
      dockerFileTransferTimeoutMs(DOCKER_FILE_READ_REQUEST_BYTES)
    );
  });

  it('decodes protobuf bytes strings when reading node files', async () => {
    const jpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const { context } = createContext({
      success: true,
      data: jpgHeader.toString('base64'),
    });

    await expect(readNodeFile(context as never, 'node-1', '/tmp/image.jpg')).resolves.toEqual(jpgHeader);
  });

  it('passes node file writes through as binary content and emits update events', async () => {
    const { context, nodeDispatch, auditService, eventBus } = createContext({ success: true });
    const content = Buffer.from('hello');

    await writeNodeFile(context as never, 'node-1', '/tmp/hello.txt', content, 'user-1');

    expect(nodeDispatch.sendNodeFileCommand).toHaveBeenCalledWith(
      'node-1',
      'write',
      { path: '/tmp/hello.txt', content },
      dockerFileTransferTimeoutMs(content.byteLength)
    );
    expect(auditService.log).toHaveBeenCalledWith({
      action: 'node.file.write',
      userId: 'user-1',
      resourceType: 'node',
      resourceId: 'node-1',
      details: { path: '/tmp/hello.txt' },
    });
    expect(eventBus.publish).toHaveBeenCalledWith('node.file.changed', {
      nodeId: 'node-1',
      action: 'updated',
      path: '/tmp/hello.txt',
      kind: 'file',
      parentPath: '/tmp',
      fromParentPath: undefined,
      toParentPath: undefined,
    });
  });

  // Regression: reads over 100 MB were silently truncated to the limit.
  it('rejects a file over the read limit with 413 instead of returning it truncated', async () => {
    const { context } = createContext({ success: true, data: Buffer.alloc(DOCKER_FILE_READ_REQUEST_BYTES) });

    await expect(readNodeFile(context as never, 'node-1', '/var/big.img')).rejects.toMatchObject({
      statusCode: 413,
      code: 'FILE_TOO_LARGE',
    });
  });

  it('returns a file exactly at the read limit', async () => {
    const { context } = createContext({ success: true, data: Buffer.alloc(DOCKER_FILE_READ_MAX_BYTES) });

    await expect(readNodeFile(context as never, 'node-1', '/var/at-limit.img')).resolves.toHaveLength(
      DOCKER_FILE_READ_MAX_BYTES
    );
  });

  it('sizes the dispatch timeout by the payload instead of a fixed 30 seconds', async () => {
    const { context, nodeDispatch } = createContext({ success: true });
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    const { uploadId } = await initNodeFileUpload(context as never, 'node-1', '/tmp/up.bin', chunk.length, 'user-1');

    await appendNodeFileUploadChunk(context as never, 'node-1', uploadId, 0, chunk);

    const timeout = nodeDispatch.sendNodeFileCommand.mock.calls.at(-1)?.[3];
    expect(timeout).toBe(dockerFileTransferTimeoutMs(chunk.length));
    expect(timeout).toBeGreaterThan(30_000);
  });
});
