import { describe, expect, it, vi } from 'vitest';
import { adoptVolume, exportVolume, listVolumes } from './docker-volume-network-operations.js';

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
