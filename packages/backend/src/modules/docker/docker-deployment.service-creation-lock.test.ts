import { describe, expect, it, vi } from 'vitest';
import { DockerDeploymentService } from './docker-deployment.service.js';

function dbWithLockedDockerNode() {
  const limit = vi.fn().mockResolvedValue([
    {
      id: 'node-1',
      type: 'docker',
      serviceCreationLocked: true,
      capabilities: { dockerDeploymentsV1: true },
    },
  ]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

function dbWithOfflineDockerNode() {
  let call = 0;
  return {
    select: vi.fn(() => {
      call += 1;
      if (call === 1) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: 'node-1',
                  type: 'docker',
                  capabilities: { dockerDeploymentsV1: true },
                },
              ]),
            })),
          })),
        };
      }
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({ orderBy: vi.fn().mockResolvedValue([]) })),
        })),
      };
    }),
  };
}

describe('DockerDeploymentService service creation lock', () => {
  it('rejects deployment creation on a locked Docker node before dispatching', async () => {
    const dispatch = { sendDockerContainerCommand: vi.fn(), sendDockerDeploymentCommand: vi.fn() };
    const service = new DockerDeploymentService(
      dbWithLockedDockerNode() as never,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      dispatch as never,
      {} as never,
      {} as never,
      { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
    );

    await expect(
      service.create(
        'node-1',
        {
          name: 'app',
          image: 'nginx:latest',
          routerImage: 'nginx:latest',
          routes: [{ hostPort: 8080, containerPort: 80, isPrimary: true }],
          health: {
            path: '/',
            statusMin: 200,
            statusMax: 399,
            timeoutSeconds: 5,
            intervalSeconds: 5,
            successThreshold: 2,
            startupGraceSeconds: 5,
            deployTimeoutSeconds: 300,
          },
          drainSeconds: 30,
          restartPolicy: 'unless-stopped',
          runtimeProfile: 'default',
        },
        'user-1'
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'NODE_SERVICE_CREATION_LOCKED' });
    expect(dispatch.sendDockerDeploymentCommand).not.toHaveBeenCalled();
  });

  it('keeps DB-backed deployment reads available while the Docker node is offline', async () => {
    const nodeRegistry = { getNode: vi.fn().mockReturnValue(undefined) };
    const service = new DockerDeploymentService(
      dbWithOfflineDockerNode() as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      nodeRegistry as never
    );

    await expect(service.listSummary('node-1')).resolves.toEqual([]);
    expect(nodeRegistry.getNode).not.toHaveBeenCalled();
  });
});
