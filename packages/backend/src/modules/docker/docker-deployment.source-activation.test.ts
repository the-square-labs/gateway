import { describe, expect, it, vi } from 'vitest';
import { DockerDeploymentService } from './docker-deployment.service.js';

describe('DockerDeploymentService source activation', () => {
  it('keeps a first-build deployment pending and emits an auditable failure when daemon activation fails', async () => {
    const db = { transaction: vi.fn() };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const dispatch = {
      sendDockerDeploymentCommand: vi.fn().mockResolvedValue({ success: false, error: 'image pull failed' }),
    };
    const registry = {
      resolveAuthCandidatesForImagePull: vi.fn().mockResolvedValue([]),
      rememberImageRegistry: vi.fn(),
    };
    const events = { publish: vi.fn() };
    const service = new DockerDeploymentService(
      db as never,
      audit as never,
      dispatch as never,
      registry as never,
      {} as never,
      {} as never
    );
    service.setEventBus(events as never);
    const internals = service as unknown as {
      validateDockerNode: (nodeId: string) => Promise<unknown>;
      loadDeployment: (nodeId: string, deploymentId: string) => Promise<unknown>;
      assertRuntimeProfile: (...args: unknown[]) => Promise<void>;
      desiredConfigWithSecrets: (
        nodeId: string,
        deploymentId: string,
        config: Record<string, unknown>
      ) => Promise<Record<string, unknown>>;
    };

    vi.spyOn(internals, 'validateDockerNode').mockResolvedValue({ id: 'node-1' });
    vi.spyOn(internals, 'loadDeployment').mockResolvedValue({
      id: 'deployment-1',
      nodeId: 'node-1',
      name: 'payments-api',
      status: 'creating',
      desiredConfig: { image: 'gateway.invalid/pending-source-build:latest', runtimeProfile: 'default' },
      routerName: 'router',
      routerImage: 'nginx:alpine',
      networkName: 'network',
      healthConfig: {},
      routes: [{ hostPort: 8080, containerPort: 80, isPrimary: true }],
      slots: [
        { slot: 'blue', containerName: 'blue', containerId: null },
        { slot: 'green', containerName: 'green', containerId: null },
      ],
      releases: [],
    });
    vi.spyOn(internals, 'assertRuntimeProfile').mockResolvedValue(undefined);
    vi.spyOn(internals, 'desiredConfigWithSecrets').mockImplementation(
      async (_nodeId: string, _id: string, config: Record<string, unknown>) => config
    );

    const image = `127.0.0.1:5443/gateway/builds/source@sha256:${'a'.repeat(64)}`;
    await expect(service.activatePending('node-1', 'deployment-1', image, 'user-1')).rejects.toMatchObject({
      code: 'DISPATCH_ERROR',
    });

    expect(db.transaction).not.toHaveBeenCalled();
    expect(registry.rememberImageRegistry).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'docker.deployment.activate_source_failed',
        details: expect.objectContaining({ failureCode: 'DISPATCH_ERROR' }),
      })
    );
    expect(events.publish).toHaveBeenCalledWith(
      'docker.deployment.changed',
      expect.objectContaining({
        action: 'failed',
        deploymentId: 'deployment-1',
        operation: 'source_activation',
        failureCode: 'DISPATCH_ERROR',
      })
    );
  });
});
