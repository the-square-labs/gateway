import { describe, expect, it, vi } from 'vitest';
import {
  adoptVolume,
  createVolume,
  exportVolume,
  getVolumeMetrics,
  listVolumes,
  resizeVolume,
} from './docker-volume-network-operations.js';

describe('exportVolume', () => {
  it('returns daemon bytes unchanged instead of decoding them as UTF-8 detail text', async () => {
    const archive = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00]);
    const context = {
      nodeDispatch: {
        sendDockerVolumeCommand: vi.fn().mockResolvedValue({ success: true, data: archive }),
      },
      auditService: {},
      parseResult: vi.fn(),
    };

    await expect(exportVolume(context as never, 'node-1', 'data')).resolves.toEqual(archive);
    expect(context.parseResult).not.toHaveBeenCalled();
  });

  it('fails explicitly against legacy daemons that return binary archives in detail', async () => {
    const context = {
      nodeDispatch: {
        sendDockerVolumeCommand: vi.fn().mockResolvedValue({ success: true, detail: 'H4sI' }),
      },
      auditService: {},
      parseResult: vi.fn(),
    };

    await expect(exportVolume(context as never, 'node-1', 'data')).rejects.toMatchObject({
      code: 'DOCKER_DAEMON_PROTOCOL_MISMATCH',
    });
  });
});

describe('managed volume inventory', () => {
  it('creates a disk-image volume with fixed-capacity metadata', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const sendDockerVolumeCommand = vi.fn().mockResolvedValue({ success: true, detail: '{}' });
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const context = {
      db: { insert: vi.fn(() => ({ values })) },
      nodeDispatch: { sendDockerVolumeCommand },
      auditService,
      eventBus: { publish: vi.fn() },
      parseResult: (result: { detail?: string }) => JSON.parse(result.detail ?? 'null'),
    };

    await createVolume(
      context as never,
      'node-1',
      { name: 'bounded', storageKind: 'disk-image', capacityBytes: 5 * 1024 ** 3 },
      'user-1'
    );

    expect(sendDockerVolumeCommand).toHaveBeenCalledWith('node-1', 'create', {
      name: 'bounded',
      storageKind: 'disk-image',
      capacityBytes: 5 * 1024 ** 3,
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        volumeName: 'bounded',
        storageKind: 'disk-image',
        capacityBytes: 5 * 1024 ** 3,
      })
    );
  });

  it('returns direct daemon metrics without snapshot conversion', async () => {
    const metrics = { storageKind: 'regular', usedBytes: 42, runningAttachmentCount: 1 };
    const sendDockerVolumeCommand = vi.fn().mockResolvedValue({ success: true, detail: JSON.stringify(metrics) });
    const context = {
      nodeDispatch: { sendDockerVolumeCommand },
      parseResult: (result: { detail?: string }) => JSON.parse(result.detail ?? 'null'),
    };

    await expect(getVolumeMetrics(context as never, 'node-1', 'data')).resolves.toEqual(metrics);
    expect(sendDockerVolumeCommand).toHaveBeenCalledWith('node-1', 'metrics', { name: 'data' }, 60_000);
  });

  it('grows only registered disk-image volumes and persists the new capacity', async () => {
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const sendDockerVolumeCommand = vi.fn().mockResolvedValue({ success: true });
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const eventBus = { publish: vi.fn() };
    const context = {
      db: {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ storageKind: 'disk-image', capacityBytes: 1024 ** 3 }]),
            })),
          })),
        })),
        update: vi.fn(() => ({ set: updateSet })),
      },
      nodeDispatch: { sendDockerVolumeCommand },
      auditService,
      eventBus,
      parseResult: vi.fn(),
    };

    await resizeVolume(context as never, 'node-1', 'bounded', 2 * 1024 ** 3, 'user-1');

    expect(sendDockerVolumeCommand).toHaveBeenCalledWith(
      'node-1',
      'resize',
      { name: 'bounded', capacityBytes: 2 * 1024 ** 3 },
      10 * 60_000
    );
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ capacityBytes: 2 * 1024 ** 3 }));
    expect(eventBus.publish).toHaveBeenCalledWith('docker.volume.changed', {
      nodeId: 'node-1',
      name: 'bounded',
      action: 'resized',
    });
  });

  it('rejects resize for ordinary volumes before dispatch', async () => {
    const sendDockerVolumeCommand = vi.fn();
    const context = {
      db: {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ storageKind: 'regular', capacityBytes: null }]),
            })),
          })),
        })),
      },
      nodeDispatch: { sendDockerVolumeCommand },
    };

    await expect(resizeVolume(context as never, 'node-1', 'data', 2 * 1024 ** 3, 'user-1')).rejects.toMatchObject({
      code: 'VOLUME_NOT_RESIZABLE',
    });
    expect(sendDockerVolumeCommand).not.toHaveBeenCalled();
  });

  it('reports a managed volume name conflict without claiming registry failure', async () => {
    const duplicate = Object.assign(new Error('duplicate'), {
      code: '23505',
      constraint: 'docker_managed_volumes_pkey',
    });
    const values = vi.fn().mockRejectedValue(duplicate);
    const sendDockerVolumeCommand = vi.fn().mockResolvedValue({ success: true, detail: '{}' });
    const context = {
      db: { insert: vi.fn(() => ({ values })) },
      nodeDispatch: { sendDockerVolumeCommand },
      auditService: { log: vi.fn() },
      parseResult: (result: { detail?: string }) => JSON.parse(result.detail ?? 'null'),
    };

    await expect(createVolume(context as never, 'node-1', { name: 'data' }, 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'NAME_IN_USE',
      message: 'A managed volume named "data" already exists on this node',
    });
    expect(sendDockerVolumeCommand).toHaveBeenCalledTimes(1);
  });

  it('preserves a newly created volume when registry persistence fails', async () => {
    const values = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const sendDockerVolumeCommand = vi.fn().mockResolvedValue({ success: true, detail: '{}' });
    const context = {
      db: { insert: vi.fn(() => ({ values })) },
      nodeDispatch: { sendDockerVolumeCommand },
      auditService: { log: vi.fn() },
      parseResult: (result: { detail?: string }) => JSON.parse(result.detail ?? 'null'),
    };

    await expect(createVolume(context as never, 'node-1', { name: 'data' }, 'user-1')).rejects.toMatchObject({
      code: 'MANAGED_VOLUME_REGISTRY_FAILED',
    });
    expect(sendDockerVolumeCommand).toHaveBeenCalledTimes(1);
    expect(sendDockerVolumeCommand).toHaveBeenCalledWith('node-1', 'create', { name: 'data' });
  });

  it('shows managed and user-attached legacy volumes while hiding orphaned and internal-only legacy volumes', async () => {
    const where = vi.fn().mockResolvedValue([{ volumeName: 'managed' }, { volumeName: 'missing' }]);
    const context = {
      db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })) },
      nodeDispatch: {
        sendDockerVolumeCommand: vi.fn().mockResolvedValue({
          success: true,
          detail: JSON.stringify([
            { Name: 'managed', Driver: 'local', Scope: 'local', Options: {}, UsedBy: [] },
            { Name: 'legacy-attached', Driver: 'local', Scope: 'local', Options: {}, UsedBy: ['app'] },
            { Name: 'legacy-orphan', Driver: 'local', Scope: 'local', Options: {}, UsedBy: [] },
            { Name: 'legacy-internal', Driver: 'local', Scope: 'local', Options: {}, UsedBy: ['sandbox'] },
          ]),
        }),
        sendDockerContainerCommand: vi.fn().mockResolvedValue({
          success: true,
          detail: JSON.stringify([
            { Name: '/app', Labels: {} },
            { Name: '/sandbox', Labels: { 'gateway.sandbox': 'true' } },
          ]),
        }),
      },
      auditService: {},
      parseResult: (result: { detail?: string }) => JSON.parse(result.detail ?? 'null'),
    };

    const result = await listVolumes(context as never, 'node-1');

    expect(result).toEqual([
      expect.objectContaining({ Name: 'managed', managementState: 'managed', adoptable: false }),
      expect.objectContaining({ Name: 'legacy-attached', managementState: 'legacy', adoptable: true }),
      expect.objectContaining({
        Name: 'missing',
        managementState: 'managed',
        availability: 'unavailable',
      }),
    ]);
  });

  it('adopts only a live local volume without driver options', async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const auditService = { log: vi.fn().mockResolvedValue(undefined) };
    const eventBus = { publish: vi.fn() };
    const context = {
      db: { insert: vi.fn(() => ({ values })) },
      nodeDispatch: {
        sendDockerVolumeCommand: vi.fn().mockResolvedValue({
          success: true,
          detail: JSON.stringify({ Name: 'data', Driver: 'local', Scope: 'local', Options: {} }),
        }),
      },
      auditService,
      eventBus,
      parseResult: (result: { detail?: string }) => JSON.parse(result.detail ?? 'null'),
    };

    await expect(adoptVolume(context as never, 'node-1', 'data', 'user-1')).resolves.toEqual({
      name: 'data',
      managementState: 'managed',
    });
    expect(values).toHaveBeenCalledWith({
      nodeId: 'node-1',
      volumeName: 'data',
      origin: 'adopted',
      createdById: 'user-1',
    });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'docker.volume.adopt',
        details: expect.objectContaining({ copiedData: false }),
      })
    );
    expect(eventBus.publish).toHaveBeenCalledWith('docker.volume.changed', {
      nodeId: 'node-1',
      name: 'data',
      action: 'adopted',
    });
  });

  it('rejects adoption when the local driver has options', async () => {
    const insert = vi.fn();
    const context = {
      db: { insert },
      nodeDispatch: {
        sendDockerVolumeCommand: vi.fn().mockResolvedValue({
          success: true,
          detail: JSON.stringify({ Driver: 'local', Scope: 'local', Options: { type: 'nfs' } }),
        }),
      },
      auditService: { log: vi.fn() },
      parseResult: (result: { detail?: string }) => JSON.parse(result.detail ?? 'null'),
    };

    await expect(adoptVolume(context as never, 'node-1', 'data', 'user-1')).rejects.toMatchObject({
      code: 'VOLUME_NOT_ADOPTABLE',
    });
    expect(insert).not.toHaveBeenCalled();
  });
});
