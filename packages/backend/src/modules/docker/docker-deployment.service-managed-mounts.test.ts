import { describe, expect, it, vi } from 'vitest';
import { DockerDeploymentService } from './docker-deployment.service.js';

describe('DockerDeploymentService managed mounts', () => {
  it('routes a manual slot switch through Availability without touching one physical node', async () => {
    const dispatch = { sendDockerDeploymentCommand: vi.fn() };
    const service = new DockerDeploymentService(
      {} as never,
      { log: vi.fn() } as never,
      dispatch as never,
      {} as never,
      {} as never,
      {} as never
    );
    const switchSlot = vi.fn().mockResolvedValue(true);
    service.setAvailabilityCoordinator({
      isManaged: vi.fn().mockResolvedValue(true),
      updateConfiguration: vi.fn(),
      setRunning: vi.fn(),
      switchSlot,
    });
    const deployment = { id: 'deployment-1', activeSlot: 'green' };
    const internals = service as unknown as {
      loadDeployment(nodeId: string, deploymentId: string): Promise<typeof deployment>;
      validateDockerNode(nodeId: string): Promise<unknown>;
    };
    const loadDeployment = vi.spyOn(internals, 'loadDeployment').mockResolvedValue(deployment);
    const validateDockerNode = vi.spyOn(internals, 'validateDockerNode');

    await expect(
      service.switchToSlot('origin-node', 'deployment-1', { slot: 'green', force: false }, 'user-1')
    ).resolves.toEqual(deployment);

    expect(switchSlot).toHaveBeenCalledWith('deployment-1', 'green', 'user-1');
    expect(loadDeployment).toHaveBeenCalledWith('origin-node', 'deployment-1');
    expect(validateDockerNode).not.toHaveBeenCalled();
    expect(dispatch.sendDockerDeploymentCommand).not.toHaveBeenCalled();
  });

  it('rejects rollback when the inactive slot would reintroduce a host bind mount', async () => {
    const dispatch = { sendDockerDeploymentCommand: vi.fn() };
    const service = new DockerDeploymentService(
      {} as never,
      { log: vi.fn() } as never,
      dispatch as never,
      {} as never,
      {} as never,
      {} as never
    );
    const deployment = {
      id: 'deployment-1',
      nodeId: 'node-1',
      name: 'app',
      status: 'ready',
      activeSlot: 'blue',
      desiredConfig: { image: 'app:v2', runtimeProfile: 'default', mounts: [] },
      healthConfig: { deployTimeoutSeconds: 300 },
      drainSeconds: 0,
      routes: [],
      releases: [],
      slots: [
        { slot: 'blue', containerName: 'app-blue', image: 'app:v2' },
        {
          slot: 'green',
          containerName: 'app-green',
          image: 'app:v1',
          desiredConfig: {
            image: 'app:v1',
            runtimeProfile: 'default',
            mounts: [{ hostPath: '/srv/legacy', containerPath: '/data', readOnly: false }],
          },
        },
      ],
    };
    const internals = service as unknown as {
      loadDeployment(nodeId: string, deploymentId: string): Promise<typeof deployment>;
      validateDockerNode(nodeId: string): Promise<{ id: string; type: string }>;
    };
    vi.spyOn(internals, 'loadDeployment').mockResolvedValue(deployment);
    vi.spyOn(internals, 'validateDockerNode').mockResolvedValue({ id: 'node-1', type: 'docker' });

    await expect(
      service.rollback('node-1', 'deployment-1', false, 'user-1', ['docker:containers:mounts'])
    ).rejects.toMatchObject({ statusCode: 409, code: 'HOST_BIND_MOUNTS_DISABLED' });
    expect(dispatch.sendDockerDeploymentCommand).not.toHaveBeenCalled();
  });
});
