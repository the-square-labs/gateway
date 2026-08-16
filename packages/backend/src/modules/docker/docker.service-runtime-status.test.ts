import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';

const INSTALLABLE_STATUS = {
  state: 'installable',
  targetVersion: 'release-test',
  message: 'Ready to install',
  checkedAt: '2026-08-16T00:00:00.000Z',
  remoteInstallable: true,
};

const HEALTHY_STATUS = {
  state: 'healthy',
  installedVersion: 'release-test',
  targetVersion: 'release-test',
  message: 'Secure Runtime is healthy',
  checkedAt: '2026-08-16T00:01:00.000Z',
  remoteInstallable: true,
};

function createService(runtimeStatus: Record<string, unknown>, sendDockerRuntimeCommand: ReturnType<typeof vi.fn>) {
  const node = {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'docker',
    hostname: 'docker-node',
    capabilities: { dockerRuntimeStatus: runtimeStatus },
  };
  const limit = vi.fn().mockResolvedValue([node]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const updates: Array<Record<string, unknown>> = [];
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn((value: Record<string, unknown>) => {
    updates.push(value);
    return { where: updateWhere };
  });
  const update = vi.fn(() => ({ set }));
  const registry = {
    getNode: vi.fn().mockReturnValue({ id: node.id }),
    publishNodeChanged: vi.fn(),
    publishDockerRuntimeChanged: vi.fn(),
  };
  const service = new DockerManagementService(
    { select, update } as never,
    {} as never,
    { sendDockerRuntimeCommand } as never,
    registry as never
  );
  return { service, updates, registry };
}

describe('DockerManagementService Secure Runtime status', () => {
  it('persists installing before waiting for the daemon and then stores the final status', async () => {
    let resolveCommand!: (value: { success: boolean; detail: string }) => void;
    const sendDockerRuntimeCommand = vi.fn(
      () =>
        new Promise<{ success: boolean; detail: string }>((resolve) => {
          resolveCommand = resolve;
        })
    );
    const { service, updates, registry } = createService(INSTALLABLE_STATUS, sendDockerRuntimeCommand);

    const operation = service.manageRunsc('11111111-1111-4111-8111-111111111111', 'install');

    await vi.waitFor(() => expect(sendDockerRuntimeCommand).toHaveBeenCalledOnce());
    expect(updates).toHaveLength(1);
    expect(updates[0]?.capabilities).toMatchObject({
      dockerRuntimeStatus: {
        state: 'installing',
        targetVersion: 'release-test',
        message: 'Installing and verifying Secure Runtime',
      },
    });
    expect(registry.publishDockerRuntimeChanged).toHaveBeenCalledOnce();

    resolveCommand({ success: true, detail: JSON.stringify(HEALTHY_STATUS) });
    await expect(operation).resolves.toEqual(HEALTHY_STATUS);
    expect(updates).toHaveLength(2);
    expect(updates[1]?.capabilities).toMatchObject({
      dockerRuntimeStatus: HEALTHY_STATUS,
    });
  });

  it('persists a failed status when daemon setup fails', async () => {
    const sendDockerRuntimeCommand = vi.fn().mockRejectedValue(new Error('download failed'));
    const { service, updates } = createService(INSTALLABLE_STATUS, sendDockerRuntimeCommand);

    await expect(service.manageRunsc('11111111-1111-4111-8111-111111111111', 'install')).rejects.toThrow(
      'download failed'
    );

    expect(updates).toHaveLength(2);
    expect(updates[1]?.capabilities).toMatchObject({
      dockerRuntimeStatus: {
        state: 'failed',
        reasonCode: 'INSTALL_FAILED',
        message: 'download failed',
      },
    });
  });

  it('rejects a duplicate setup while the persisted operation is installing', async () => {
    const sendDockerRuntimeCommand = vi.fn();
    const { service, updates } = createService(
      { ...INSTALLABLE_STATUS, state: 'installing' },
      sendDockerRuntimeCommand
    );

    await expect(service.manageRunsc('11111111-1111-4111-8111-111111111111', 'install')).rejects.toThrow(
      'already in progress'
    );
    expect(sendDockerRuntimeCommand).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});
