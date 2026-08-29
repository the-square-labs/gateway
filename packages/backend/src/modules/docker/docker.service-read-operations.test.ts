import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';

function dbWithOnlineDockerNode() {
  const limit = vi.fn().mockResolvedValue([
    {
      id: 'node-1',
      type: 'docker',
    },
  ]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

function createService(dispatch: {
  sendDockerContainerCommand?: ReturnType<typeof vi.fn>;
  sendDockerFileCommand?: ReturnType<typeof vi.fn>;
  sendDockerLogsCommand?: ReturnType<typeof vi.fn>;
}) {
  const effectiveDispatch = {
    sendDockerContainerCommand: vi.fn().mockResolvedValue({
      success: true,
      detail: JSON.stringify({ Config: { Labels: {} } }),
    }),
    ...dispatch,
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const eventBus = { publish: vi.fn() };
  const service = new DockerManagementService(
    dbWithOnlineDockerNode() as never,
    audit as never,
    effectiveDispatch as never,
    { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
  );
  service.setEventBus(eventBus as never);
  return { service, audit, eventBus };
}

describe('DockerManagementService read and file operations', () => {
  it('clamps log tail requests before dispatching', async () => {
    const dispatch = {
      sendDockerLogsCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify(['line-1']),
      }),
    };
    const { service } = createService(dispatch);

    await expect(service.getContainerLogs('node-1', 'container-1', 999999, true)).resolves.toEqual(['line-1']);
    expect(dispatch.sendDockerLogsCommand).toHaveBeenCalledWith('node-1', 'container-1', {
      tailLines: 1000,
      timestamps: true,
    });
  });

  it('routes stats and top requests through container commands', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi
        .fn()
        .mockResolvedValueOnce({ success: true, detail: JSON.stringify({ cpu: 12 }) })
        .mockResolvedValueOnce({
          success: true,
          detail: JSON.stringify({ Titles: ['PID', 'COMMAND'], Processes: [['1', 'node']] }),
        }),
    };
    const { service } = createService(dispatch);

    await expect(service.getContainerStats('node-1', 'container-1')).resolves.toEqual({ cpu: 12 });
    await expect(service.getContainerTop('node-1', 'container-1')).resolves.toEqual({
      Titles: ['PID', 'COMMAND'],
      Processes: [['1', 'node']],
    });
    expect(dispatch.sendDockerContainerCommand).toHaveBeenNthCalledWith(1, 'node-1', 'stats', {
      containerId: 'container-1',
    });
    expect(dispatch.sendDockerContainerCommand).toHaveBeenNthCalledWith(2, 'node-1', 'top', {
      containerId: 'container-1',
    });
  });

  it('routes file browse reads with the existing max read size', async () => {
    const dispatch = {
      sendDockerFileCommand: vi
        .fn()
        .mockResolvedValueOnce({ success: true, detail: JSON.stringify([{ name: 'app.log' }]) })
        .mockResolvedValueOnce({ success: true, data: Buffer.from('hello') }),
    };
    const { service } = createService(dispatch);

    await expect(service.listDirectory('node-1', 'container-1', '/var/log')).resolves.toEqual([{ name: 'app.log' }]);
    await expect(service.readFile('node-1', 'container-1', '/var/log/app.log')).resolves.toEqual(Buffer.from('hello'));
    expect(dispatch.sendDockerFileCommand).toHaveBeenNthCalledWith(1, 'node-1', 'list', {
      containerId: 'container-1',
      path: '/var/log',
    });
    expect(dispatch.sendDockerFileCommand).toHaveBeenNthCalledWith(2, 'node-1', 'read', {
      containerId: 'container-1',
      path: '/var/log/app.log',
      maxBytes: 104857600,
    });
  });

  it('returns empty bytes when reading an empty file', async () => {
    const dispatch = {
      sendDockerFileCommand: vi.fn().mockResolvedValue({ success: true, data: Buffer.alloc(0) }),
    };
    const { service } = createService(dispatch);

    await expect(service.readFile('node-1', 'container-1', '/tmp/empty.txt')).resolves.toEqual(Buffer.alloc(0));
    expect(dispatch.sendDockerFileCommand).toHaveBeenCalledWith('node-1', 'read', {
      containerId: 'container-1',
      path: '/tmp/empty.txt',
      maxBytes: 104857600,
    });
  });

  it('decodes protobuf bytes strings when reading files', async () => {
    const jpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const dispatch = {
      sendDockerFileCommand: vi.fn().mockResolvedValue({ success: true, data: jpgHeader.toString('base64') }),
    };
    const { service } = createService(dispatch);

    await expect(service.readFile('node-1', 'container-1', '/tmp/image.jpg')).resolves.toEqual(jpgHeader);
  });

  it('writes files and records an audit event', async () => {
    const dispatch = {
      sendDockerFileCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const { service, audit, eventBus } = createService(dispatch);

    await service.writeFile('node-1', 'container-1', '/etc/app.conf', 'enabled=true', 'user-1');

    expect(dispatch.sendDockerFileCommand).toHaveBeenCalledWith('node-1', 'write', {
      containerId: 'container-1',
      path: '/etc/app.conf',
      content: 'enabled=true',
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.file.write',
      userId: 'user-1',
      resourceType: 'docker-container',
      resourceId: 'container-1',
      details: { nodeId: 'node-1', path: '/etc/app.conf' },
    });
    expect(eventBus.publish).toHaveBeenCalledWith('docker.file.changed', {
      nodeId: 'node-1',
      containerId: 'container-1',
      action: 'updated',
      path: '/etc/app.conf',
      kind: 'file',
      parentPath: '/etc',
    });
  });

  it('passes binary file writes through without base64 conversion', async () => {
    const dispatch = {
      sendDockerFileCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const { service } = createService(dispatch);
    const content = Buffer.from([0, 1, 2, 3]);

    await service.writeFile('node-1', 'container-1', '/tmp/blob.bin', content, 'user-1');

    expect(dispatch.sendDockerFileCommand).toHaveBeenCalledWith('node-1', 'write', {
      containerId: 'container-1',
      path: '/tmp/blob.bin',
      content,
    });
  });

  it('creates and deletes files through explicit file actions', async () => {
    const dispatch = {
      sendDockerFileCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const { service, audit, eventBus } = createService(dispatch);

    await service.createFile('node-1', 'container-1', '/tmp/new.txt', 'Hello', 'user-1');
    await service.createDirectory('node-1', 'container-1', '/tmp/new-dir', 'user-1');
    await service.deleteFile('node-1', 'container-1', '/tmp/new.txt', 'user-1');
    await service.moveFile('node-1', 'container-1', '/tmp/new-dir', '/var/new-dir', 'user-1');

    expect(dispatch.sendDockerFileCommand).toHaveBeenNthCalledWith(1, 'node-1', 'create-file', {
      containerId: 'container-1',
      path: '/tmp/new.txt',
      content: 'Hello',
    });
    expect(dispatch.sendDockerFileCommand).toHaveBeenNthCalledWith(2, 'node-1', 'create-dir', {
      containerId: 'container-1',
      path: '/tmp/new-dir',
    });
    expect(dispatch.sendDockerFileCommand).toHaveBeenNthCalledWith(3, 'node-1', 'delete', {
      containerId: 'container-1',
      path: '/tmp/new.txt',
    });
    expect(dispatch.sendDockerFileCommand).toHaveBeenNthCalledWith(4, 'node-1', 'move', {
      containerId: 'container-1',
      path: '/tmp/new-dir',
      targetPath: '/var/new-dir',
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.file.create',
      userId: 'user-1',
      resourceType: 'docker-container',
      resourceId: 'container-1',
      details: { nodeId: 'node-1', path: '/tmp/new.txt' },
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.file.create_directory',
      userId: 'user-1',
      resourceType: 'docker-container',
      resourceId: 'container-1',
      details: { nodeId: 'node-1', path: '/tmp/new-dir' },
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.file.delete',
      userId: 'user-1',
      resourceType: 'docker-container',
      resourceId: 'container-1',
      details: { nodeId: 'node-1', path: '/tmp/new.txt' },
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.file.move',
      userId: 'user-1',
      resourceType: 'docker-container',
      resourceId: 'container-1',
      details: { nodeId: 'node-1', fromPath: '/tmp/new-dir', toPath: '/var/new-dir' },
    });
    expect(eventBus.publish).toHaveBeenCalledWith('docker.file.changed', {
      nodeId: 'node-1',
      containerId: 'container-1',
      action: 'created',
      path: '/tmp/new.txt',
      kind: 'file',
      parentPath: '/tmp',
    });
    expect(eventBus.publish).toHaveBeenCalledWith('docker.file.changed', {
      nodeId: 'node-1',
      containerId: 'container-1',
      action: 'created',
      path: '/tmp/new-dir',
      kind: 'directory',
      parentPath: '/tmp',
    });
    expect(eventBus.publish).toHaveBeenCalledWith('docker.file.changed', {
      nodeId: 'node-1',
      containerId: 'container-1',
      action: 'deleted',
      path: '/tmp/new.txt',
      kind: 'unknown',
      parentPath: '/tmp',
    });
    expect(eventBus.publish).toHaveBeenCalledWith('docker.file.changed', {
      nodeId: 'node-1',
      containerId: 'container-1',
      action: 'moved',
      path: '/var/new-dir',
      kind: 'unknown',
      fromPath: '/tmp/new-dir',
      toPath: '/var/new-dir',
      fromParentPath: '/tmp',
      toParentPath: '/var',
      parentPath: '/var',
    });
  });

  it('coordinates chunked file uploads without buffering the full file in gateway', async () => {
    const dispatch = {
      sendDockerFileCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const { service, audit, eventBus } = createService(dispatch);
    const firstChunk = Buffer.from('hello ');
    const secondChunk = Buffer.from('world');

    const upload = await service.initFileUpload('node-1', 'container-1', '/tmp/big.bin', 11, 'user-1');
    await expect(
      service.appendFileUploadChunk('node-1', 'container-1', upload.uploadId, 0, firstChunk)
    ).resolves.toEqual({ receivedBytes: 6, totalBytes: 11 });
    await expect(
      service.appendFileUploadChunk('node-1', 'container-1', upload.uploadId, 6, secondChunk)
    ).resolves.toEqual({ receivedBytes: 11, totalBytes: 11 });
    await service.completeFileUpload('node-1', 'container-1', upload.uploadId, '/tmp/big.bin', 11);

    expect(upload.chunkSize).toBeGreaterThan(0);
    expect(dispatch.sendDockerFileCommand).toHaveBeenNthCalledWith(1, 'node-1', 'upload-init', {
      containerId: 'container-1',
      path: upload.uploadId,
      targetPath: '/tmp/big.bin',
      maxBytes: 11,
    });
    expect(dispatch.sendDockerFileCommand).toHaveBeenNthCalledWith(2, 'node-1', 'upload-chunk', {
      containerId: 'container-1',
      path: upload.uploadId,
      targetPath: '/tmp/big.bin',
      maxBytes: 0,
      content: firstChunk,
    });
    expect(dispatch.sendDockerFileCommand).toHaveBeenNthCalledWith(3, 'node-1', 'upload-chunk', {
      containerId: 'container-1',
      path: upload.uploadId,
      targetPath: '/tmp/big.bin',
      maxBytes: 6,
      content: secondChunk,
    });
    expect(dispatch.sendDockerFileCommand).toHaveBeenNthCalledWith(4, 'node-1', 'upload-complete', {
      containerId: 'container-1',
      path: upload.uploadId,
      targetPath: '/tmp/big.bin',
      maxBytes: 11,
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.file.create',
      userId: 'user-1',
      resourceType: 'docker-container',
      resourceId: 'container-1',
      details: { nodeId: 'node-1', path: '/tmp/big.bin' },
    });
    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    expect(eventBus.publish).toHaveBeenCalledWith('docker.file.changed', {
      nodeId: 'node-1',
      containerId: 'container-1',
      action: 'created',
      path: '/tmp/big.bin',
      kind: 'file',
      parentPath: '/tmp',
    });
  });

  it('rejects out-of-order chunked upload offsets', async () => {
    const dispatch = {
      sendDockerFileCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const { service } = createService(dispatch);

    const upload = await service.initFileUpload('node-1', 'container-1', '/tmp/big.bin', 11, 'user-1');

    await expect(
      service.appendFileUploadChunk('node-1', 'container-1', upload.uploadId, 6, Buffer.from('world'))
    ).rejects.toThrow('Unexpected upload offset');
  });
});
