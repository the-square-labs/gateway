import { describe, expect, it, vi } from 'vitest';
import { exportVolume } from './docker-volume-network-operations.js';

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
