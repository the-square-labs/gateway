import { describe, expect, it } from 'vitest';
import { DockerBuildRunnerService } from './docker-build-runner.service.js';

function serviceWithBuilders(builders: Array<{ capabilities: unknown }>) {
  const db = {
    select: () => ({
      from: () => ({
        where: async () => builders,
      }),
    }),
  };
  return new DockerBuildRunnerService(db as never, {} as never, {} as never, {} as never, {} as never);
}

describe('DockerBuildRunnerService admission', () => {
  it('rejects new builds when no online worker advertises both execution and runsc isolation', async () => {
    const service = serviceWithBuilders([
      {
        capabilities: {
          architecture: 'amd64',
          capabilities: ['docker_builder_execution_v1', 'docker_builder_runsc_v1'],
        },
      },
    ]);

    await expect(service.assertBuildAdmission()).rejects.toMatchObject({
      code: 'NO_BUILD_WORKER_AVAILABLE',
      statusCode: 503,
    });
  });

  it('accepts an amd64 or arm64 worker only when the isolated builder capabilities are complete', async () => {
    const service = serviceWithBuilders([
      {
        capabilities: {
          architecture: 'arm64',
          capabilities: ['docker_builder_execution_v1', 'docker_builder_runsc_v1', 'docker_builder_resource_limits_v1'],
        },
      },
    ]);

    await expect(service.assertBuildAdmission()).resolves.toBeUndefined();
  });
});
