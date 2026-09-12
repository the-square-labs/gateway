import { describe, expect, it, vi } from 'vitest';
import { assertManagedMountMutation } from './docker-managed-mounts.js';

function managedDb(found = true, storageKind = 'regular') {
  const limit = vi.fn().mockResolvedValue(found ? [{ volumeName: 'data', storageKind }] : []);
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
  it.each([
    { name: 'verified disk image', storageKind: 'disk-image', verified: true, allowed: true },
    { name: 'unverified disk image', storageKind: 'disk-image', verified: false, allowed: false },
    { name: 'older daemon without verification', storageKind: 'disk-image', verified: undefined, allowed: false },
    { name: 'regular volume replaced with a bind', storageKind: 'regular', verified: true, allowed: false },
  ])('$name', async ({ storageKind, verified, allowed }) => {
    const inspection = {
      Driver: 'local',
      Scope: 'local',
      Options: { type: 'none', device: '/managed/mounts/data', o: 'bind' },
      ManagedDiskImage: verified,
    };
    const mutation = assertManagedMountMutation({
      db: managedDb(true, storageKind) as never,
      dispatch: { sendDockerVolumeCommand: vi.fn().mockResolvedValue({ success: true }) } as never,
      parseResult: () => inspection,
      nodeId: 'node-1',
      current: [],
      next: [{ type: 'volume', source: 'data', target: '/data', readOnly: false }],
    });
    if (allowed) await expect(mutation).resolves.toBeUndefined();
    else await expect(mutation).rejects.toMatchObject({ code: 'MANAGED_VOLUME_UNSAFE' });
  });

  it('rejects an unregistered volume before inspecting it', async () => {
    const dispatch = { sendDockerVolumeCommand: vi.fn() };
    await expect(
      assertManagedMountMutation({
        db: managedDb(false) as never,
        dispatch: dispatch as never,
        parseResult: vi.fn(),
        nodeId: 'node-1',
        current: [],
        next: [{ type: 'volume', source: 'data', target: '/data', readOnly: false }],
      })
    ).rejects.toMatchObject({ code: 'MANAGED_VOLUME_REQUIRED' });
    expect(dispatch.sendDockerVolumeCommand).not.toHaveBeenCalled();
  });
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
