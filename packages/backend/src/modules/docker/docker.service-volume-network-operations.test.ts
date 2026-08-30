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
  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values }));
  const mutationWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFrom = vi.fn(() => ({ where: mutationWhere }));
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));
  return { select, insert, delete: deleteFrom, update };
}

function createService(dispatch: {
  sendDockerVolumeCommand?: ReturnType<typeof vi.fn>;
  sendDockerNetworkCommand?: ReturnType<typeof vi.fn>;
  sendDockerContainerCommand?: ReturnType<typeof vi.fn>;
}) {
  const effectiveDispatch = {
    sendDockerContainerCommand: vi.fn().mockResolvedValue({
      success: true,
      detail: JSON.stringify({ Config: { Labels: {} } }),
    }),
    ...dispatch,
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new DockerManagementService(
    dbWithOnlineDockerNode() as never,
    audit as never,
    effectiveDispatch as never,
    { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
  );
  const eventBus = { publish: vi.fn() };
  service.setEventBus(eventBus as never);
  return { service, audit, eventBus };
}

describe('DockerManagementService volume and network operations', () => {
  it('returns exported volume bytes without decoding them a second time', async () => {
    const archive = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00]);
    const dispatch = {
      sendDockerVolumeCommand: vi.fn().mockResolvedValue({ success: true, data: archive }),
    };
    const { service } = createService(dispatch);

    await expect(service.exportVolume('node-1', 'data')).resolves.toEqual(archive);
    expect(dispatch.sendDockerVolumeCommand).toHaveBeenCalledWith('node-1', 'export', { name: 'data' });
  });

  it('creates volumes with audit and volume change events', async () => {
    const dispatch = {
      sendDockerVolumeCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify({ Name: 'data' }),
      }),
    };
    const { service, audit, eventBus } = createService(dispatch);

    await expect(service.createVolume('node-1', { name: 'data' }, 'user-1')).resolves.toEqual({
      Name: 'data',
    });

    expect(dispatch.sendDockerVolumeCommand).toHaveBeenCalledWith('node-1', 'create', {
      name: 'data',
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.volume.create',
      userId: 'user-1',
      resourceType: 'docker-volume',
      details: { nodeId: 'node-1', name: 'data' },
    });
    expect(eventBus.publish).toHaveBeenCalledWith('docker.volume.changed', {
      nodeId: 'node-1',
      name: 'data',
      action: 'created',
    });
  });

  it('requires Personal or higher before creating a disk-image volume', async () => {
    const dispatch = { sendDockerVolumeCommand: vi.fn() };
    const { service } = createService(dispatch);
    const denial = new Error('Personal plan required');
    const requireMinimumPlan = vi.fn().mockRejectedValue(denial);
    service.setLicensePolicyService({ requireMinimumPlan } as never);

    await expect(
      service.createVolume('node-1', { name: 'bounded', storageKind: 'disk-image', capacityBytes: 1024 ** 3 }, 'user-1')
    ).rejects.toBe(denial);
    expect(requireMinimumPlan).toHaveBeenCalledWith('personal');
    expect(dispatch.sendDockerVolumeCommand).not.toHaveBeenCalled();
  });

  it('removes volumes with force flag, audit, and change events', async () => {
    const dispatch = {
      sendDockerVolumeCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const { service, audit, eventBus } = createService(dispatch);

    await service.removeVolume('node-1', 'data', true, 'user-1');

    expect(dispatch.sendDockerVolumeCommand).toHaveBeenCalledWith('node-1', 'remove', {
      name: 'data',
      force: true,
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.volume.remove',
      userId: 'user-1',
      resourceType: 'docker-volume',
      resourceId: 'data',
      details: { nodeId: 'node-1' },
    });
    expect(eventBus.publish).toHaveBeenCalledWith('docker.volume.changed', {
      nodeId: 'node-1',
      name: 'data',
      action: 'removed',
    });
  });

  it('renames volumes with audit and change events', async () => {
    const dispatch = {
      sendDockerVolumeCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const { service, audit, eventBus } = createService(dispatch);

    await service.renameVolume('node-1', 'old-data', 'new-data', 'user-1');

    expect(dispatch.sendDockerVolumeCommand).toHaveBeenCalledWith('node-1', 'rename', {
      name: 'old-data',
      newName: 'new-data',
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.volume.rename',
      userId: 'user-1',
      resourceType: 'docker-volume',
      resourceId: 'new-data',
      details: { nodeId: 'node-1', oldName: 'old-data', name: 'new-data' },
    });
    expect(eventBus.publish).toHaveBeenCalledWith('docker.volume.changed', {
      nodeId: 'node-1',
      name: 'new-data',
      action: 'renamed',
      oldName: 'old-data',
    });
  });

  it('updates volume labels with audit and change events', async () => {
    const dispatch = {
      sendDockerVolumeCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const { service, audit, eventBus } = createService(dispatch);

    await service.updateVolumeLabels('node-1', 'data', { env: 'dev' }, 'user-1');

    expect(dispatch.sendDockerVolumeCommand).toHaveBeenCalledWith('node-1', 'update-labels', {
      name: 'data',
      labels: { env: 'dev' },
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.volume.labels.update',
      userId: 'user-1',
      resourceType: 'docker-volume',
      resourceId: 'data',
      details: { nodeId: 'node-1', name: 'data' },
    });
    expect(eventBus.publish).toHaveBeenCalledWith('docker.volume.changed', {
      nodeId: 'node-1',
      name: 'data',
      action: 'labels-updated',
    });
  });

  it('routes volume file operations with audit and change events', async () => {
    const jpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const dispatch = {
      sendDockerVolumeCommand: vi
        .fn()
        .mockResolvedValueOnce({ success: true, data: jpgHeader.toString('base64') })
        .mockResolvedValue({ success: true }),
    };
    const { service, audit, eventBus } = createService(dispatch);
    const content = Buffer.from([0, 1, 2]);

    await expect(service.readVolumeFile('node-1', 'data', '/app.txt')).resolves.toEqual(jpgHeader);
    await service.writeVolumeFile('node-1', 'data', '/app.txt', content, 'user-1');
    await service.createVolumeFile('node-1', 'data', '/new.txt', '', 'user-1');
    await service.createVolumeDirectory('node-1', 'data', '/dir', 'user-1');
    await service.deleteVolumeFile('node-1', 'data', '/old.txt', 'user-1');
    await service.moveVolumeFile('node-1', 'data', '/dir', '/dir2', 'user-1');

    expect(dispatch.sendDockerVolumeCommand).toHaveBeenNthCalledWith(1, 'node-1', 'read-file', {
      name: 'data',
      path: '/app.txt',
      maxBytes: 104857600,
    });
    expect(dispatch.sendDockerVolumeCommand).toHaveBeenNthCalledWith(2, 'node-1', 'write-file', {
      name: 'data',
      path: '/app.txt',
      content,
    });
    expect(dispatch.sendDockerVolumeCommand).toHaveBeenNthCalledWith(3, 'node-1', 'create-file', {
      name: 'data',
      path: '/new.txt',
      content: '',
    });
    expect(dispatch.sendDockerVolumeCommand).toHaveBeenNthCalledWith(4, 'node-1', 'create-dir', {
      name: 'data',
      path: '/dir',
    });
    expect(dispatch.sendDockerVolumeCommand).toHaveBeenNthCalledWith(5, 'node-1', 'delete', {
      name: 'data',
      path: '/old.txt',
    });
    expect(dispatch.sendDockerVolumeCommand).toHaveBeenNthCalledWith(6, 'node-1', 'move', {
      name: 'data',
      path: '/dir',
      targetPath: '/dir2',
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.volume.file.write',
      userId: 'user-1',
      resourceType: 'docker-volume',
      resourceId: 'data',
      details: { nodeId: 'node-1', path: '/app.txt' },
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.volume.file.create',
      userId: 'user-1',
      resourceType: 'docker-volume',
      resourceId: 'data',
      details: { nodeId: 'node-1', path: '/new.txt' },
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.volume.file.create_directory',
      userId: 'user-1',
      resourceType: 'docker-volume',
      resourceId: 'data',
      details: { nodeId: 'node-1', path: '/dir' },
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.volume.file.delete',
      userId: 'user-1',
      resourceType: 'docker-volume',
      resourceId: 'data',
      details: { nodeId: 'node-1', path: '/old.txt' },
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.volume.file.move',
      userId: 'user-1',
      resourceType: 'docker-volume',
      resourceId: 'data',
      details: { nodeId: 'node-1', fromPath: '/dir', toPath: '/dir2' },
    });
    expect(eventBus.publish).toHaveBeenCalledWith('docker.volume.file.changed', {
      nodeId: 'node-1',
      volumeName: 'data',
      action: 'updated',
      path: '/app.txt',
      kind: 'file',
      parentPath: '/',
      fromParentPath: undefined,
      toParentPath: undefined,
    });
  });

  it('routes chunked volume file uploads with audit and change events', async () => {
    const dispatch = {
      sendDockerVolumeCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const { service, audit, eventBus } = createService(dispatch);
    const content = Buffer.from('hello');

    const upload = await service.initVolumeFileUpload('node-1', 'data', '/big.bin', content.length, 'user-1');
    await service.appendVolumeFileUploadChunk('node-1', 'data', upload.uploadId, 0, content);
    await service.completeVolumeFileUpload('node-1', 'data', upload.uploadId, '/big.bin', content.length);

    expect(upload.chunkSize).toBeGreaterThan(0);
    expect(dispatch.sendDockerVolumeCommand).toHaveBeenNthCalledWith(1, 'node-1', 'upload-init', {
      name: 'data',
      path: upload.uploadId,
      targetPath: '/big.bin',
      maxBytes: content.length,
    });
    expect(dispatch.sendDockerVolumeCommand).toHaveBeenNthCalledWith(2, 'node-1', 'upload-chunk', {
      name: 'data',
      path: upload.uploadId,
      targetPath: '/big.bin',
      maxBytes: 0,
      content,
    });
    expect(dispatch.sendDockerVolumeCommand).toHaveBeenNthCalledWith(3, 'node-1', 'upload-complete', {
      name: 'data',
      path: upload.uploadId,
      targetPath: '/big.bin',
      maxBytes: content.length,
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.volume.file.create',
      userId: 'user-1',
      resourceType: 'docker-volume',
      resourceId: 'data',
      details: { nodeId: 'node-1', path: '/big.bin' },
    });
    expect(eventBus.publish).toHaveBeenCalledWith('docker.volume.file.changed', {
      nodeId: 'node-1',
      volumeName: 'data',
      action: 'created',
      path: '/big.bin',
      kind: 'file',
      parentPath: '/',
      fromParentPath: undefined,
      toParentPath: undefined,
    });
  });

  it('aborts chunked volume file uploads', async () => {
    const dispatch = {
      sendDockerVolumeCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const { service } = createService(dispatch);

    const upload = await service.initVolumeFileUpload('node-1', 'data', '/big.bin', 5, 'user-1');
    await service.abortVolumeFileUpload('node-1', 'data', upload.uploadId);

    expect(dispatch.sendDockerVolumeCommand).toHaveBeenNthCalledWith(2, 'node-1', 'upload-abort', {
      name: 'data',
      path: upload.uploadId,
      targetPath: '/big.bin',
    });
  });

  it('creates networks with daemon field mapping, audit, and change events', async () => {
    const dispatch = {
      sendDockerNetworkCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify({ Id: 'network-1' }),
      }),
    };
    const { service, audit, eventBus } = createService(dispatch);

    await expect(
      service.createNetwork(
        'node-1',
        { name: 'frontend', driver: 'bridge', subnet: '10.10.0.0/24', gateway: '10.10.0.1' },
        'user-1'
      )
    ).resolves.toEqual({ Id: 'network-1' });

    expect(dispatch.sendDockerNetworkCommand).toHaveBeenCalledWith('node-1', 'create', {
      networkId: 'frontend',
      driver: 'bridge',
      subnet: '10.10.0.0/24',
      gatewayAddr: '10.10.0.1',
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.network.create',
      userId: 'user-1',
      resourceType: 'docker-network',
      details: { nodeId: 'node-1', name: 'frontend' },
    });
    expect(eventBus.publish).toHaveBeenCalledWith('docker.network.changed', {
      nodeId: 'node-1',
      name: 'frontend',
      action: 'created',
    });
  });

  it('rejects removing built-in networks after resolving network names', async () => {
    const dispatch = {
      sendDockerNetworkCommand: vi.fn(async (_nodeId: string, action: string) => {
        if (action === 'list') {
          return { success: true, detail: JSON.stringify([{ Id: 'builtin-1', Name: 'bridge' }]) };
        }
        return { success: true };
      }),
    };
    const { service } = createService(dispatch);

    await expect(service.removeNetwork('node-1', 'builtin-1', 'user-1')).rejects.toMatchObject({
      statusCode: 400,
      code: 'BUILTIN_NETWORK',
    });
    expect(dispatch.sendDockerNetworkCommand).not.toHaveBeenCalledWith('node-1', 'remove', expect.anything());
  });

  it('hides and protects every Gateway-managed network', async () => {
    const dispatch = {
      sendDockerNetworkCommand: vi.fn(async (_nodeId: string, action: string) => {
        if (action === 'list') {
          return {
            success: true,
            detail: JSON.stringify([
              { Id: 'custom-1', Name: 'frontend' },
              { Id: 'managed-1234567890ab', Name: 'gateway-db-79c029a3cedc4af1' },
              { Id: 'secure-links-1234567890ab', Name: 'gateway-secure-links' },
            ]),
          };
        }
        return { success: true };
      }),
    };
    const { service } = createService(dispatch);

    await expect(service.listNetworks('node-1')).resolves.toEqual([{ Id: 'custom-1', Name: 'frontend' }]);
    await expect(
      service.disconnectContainerFromNetwork('node-1', 'managed-1234', 'container-1', 'user-1')
    ).rejects.toMatchObject({ statusCode: 409, code: 'MANAGED_NETWORK' });
    await expect(service.removeNetwork('node-1', 'secure-links-1234', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'MANAGED_NETWORK',
    });
    expect(dispatch.sendDockerNetworkCommand).not.toHaveBeenCalledWith('node-1', 'disconnect', expect.anything());
  });

  it('disconnects containers from custom networks with audit', async () => {
    const dispatch = {
      sendDockerNetworkCommand: vi.fn(async (_nodeId: string, action: string) => {
        if (action === 'list') {
          return {
            success: true,
            detail: JSON.stringify([{ Id: 'custom-1234567890ab', Name: 'frontend' }]),
          };
        }
        return { success: true };
      }),
    };
    const { service, audit } = createService(dispatch);

    await service.disconnectContainerFromNetwork('node-1', 'custom-1234', 'container-1', 'user-1');

    expect(dispatch.sendDockerNetworkCommand).toHaveBeenCalledWith('node-1', 'disconnect', {
      networkId: 'custom-1234567890ab',
      containerId: 'container-1',
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.network.disconnect',
      userId: 'user-1',
      resourceType: 'docker-network',
      resourceId: 'custom-1234567890ab',
      details: { nodeId: 'node-1', containerId: 'container-1', networkName: 'frontend' },
    });
  });
});
