import { describe, expect, it, vi } from 'vitest';
import { assertManagedMountMutation } from './docker-managed-mounts.js';

function managedDb(found = true) {
  const limit = vi.fn().mockResolvedValue(found ? [{ volumeName: 'data' }] : []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { select: vi.fn(() => ({ from })) };
}

const unchangedBind = {
  type: 'bind' as const,
  source: '/srv/legacy',
  target: '/data',
  readOnly: false,
};

describe('assertManagedMountMutation', () => {
  it('preserves an unchanged legacy bind without consulting Docker', async () => {
    const dispatch = { sendDockerVolumeCommand: vi.fn() };
    await expect(
      assertManagedMountMutation({
        db: managedDb(false) as never,
        dispatch: dispatch as never,
        parseResult: vi.fn(),
        nodeId: 'node-1',
        current: [unchangedBind],
        next: [unchangedBind],
      })
    ).resolves.toBeUndefined();
    expect(dispatch.sendDockerVolumeCommand).not.toHaveBeenCalled();
  });

  it('rejects a newly introduced host bind', async () => {
    await expect(
      assertManagedMountMutation({
        db: managedDb(false) as never,
        dispatch: {} as never,
        parseResult: vi.fn(),
        nodeId: 'node-1',
        current: [],
        next: [unchangedBind],
      })
    ).rejects.toMatchObject({ code: 'HOST_BIND_MOUNTS_DISABLED', statusCode: 409 });
  });

  it('accepts a registered local volume only after live Docker inspection', async () => {
    const dispatch = {
      sendDockerVolumeCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify({ Driver: 'local', Scope: 'local', Options: {} }),
      }),
    };
    await expect(
      assertManagedMountMutation({
        db: managedDb() as never,
        dispatch: dispatch as never,
        parseResult: (result) => JSON.parse(result.detail ?? '{}'),
        nodeId: 'node-1',
        current: [],
        next: [{ type: 'volume', source: 'data', target: '/data', readOnly: false }],
      })
    ).resolves.toBeUndefined();
    expect(dispatch.sendDockerVolumeCommand).toHaveBeenCalledWith('node-1', 'inspect', { name: 'data' });
  });
});
