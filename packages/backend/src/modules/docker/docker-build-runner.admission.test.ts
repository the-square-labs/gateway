import { describe, expect, it, vi } from 'vitest';
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
  it('rejects new builds when no online worker advertises the complete dedicated worker profile', async () => {
    const service = serviceWithBuilders([
      {
        capabilities: {
          architecture: 'amd64',
          capabilities: ['docker_builder_execution_v1', 'docker_builder_dedicated_runtime_v1'],
        },
      },
    ]);

    await expect(service.assertBuildAdmission()).rejects.toMatchObject({
      code: 'NO_BUILD_WORKER_AVAILABLE',
      statusCode: 503,
    });
  });

  it('accepts an amd64 or arm64 worker only when the dedicated builder capabilities are complete', async () => {
    const service = serviceWithBuilders([
      {
        capabilities: {
          architecture: 'arm64',
          capabilities: [
            'docker_builder_execution_v1',
            'docker_builder_dedicated_runtime_v1',
            'docker_builder_resource_limits_v1',
          ],
        },
      },
    ]);

    await expect(service.assertBuildAdmission()).resolves.toBeUndefined();
  });

  it('keeps rolling compatibility with existing gVisor workers', async () => {
    const service = serviceWithBuilders([
      {
        capabilities: {
          architecture: 'amd64',
          capabilities: [
            'docker_builder_execution_v1',
            'docker_builder_isolation_v1',
            'docker_builder_resource_limits_v1',
          ],
        },
      },
    ]);

    await expect(service.assertBuildAdmission()).resolves.toBeUndefined();
  });

  it('persists a system log and failure reason when dispatch fails before worker execution', async () => {
    const build = {
      id: 'build-1',
      sourceBindingId: 'source-1',
      sourceConfigGeneration: 1,
      repositoryRemoteId: 'repo-1',
      repositoryFullPath: 'acme/site',
      ref: 'refs/heads/main',
      commitSha: 'a'.repeat(40),
      serviceName: null,
      dockerfilePath: 'Dockerfile',
      contextPath: '.',
      buildArgs: {},
      applicationRoot: '.',
      packageManager: 'npm',
      packageManagerVersion: null,
      nodeVersion: '24',
      buildScript: 'build',
      artifactDirectory: 'dist',
    };
    const source = {
      id: 'source-1',
      configGeneration: 1,
      connectorId: 'connector-1',
      repositoryCloneUrl: 'https://example.com/acme/site.git',
      repositoryRemoteId: 'repo-1',
      policy: {},
      targetKind: 'pages_project',
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [source]) })),
        })),
      })),
    };
    const builds = {
      claimNext: vi.fn(async () => build),
      appendLog: vi.fn(async () => undefined),
      transition: vi.fn(async () => undefined),
    };
    const dispatch = {
      dispatchDockerBuildCommand: vi.fn(async () => {
        throw new Error('relay grant revision 3 is older than 177');
      }),
    };
    const integrations = {
      resolveDockerBuildCheckoutCredential: vi.fn(async () => ({ token: 'test' })),
    };
    const registry = { ensureBinding: vi.fn(async () => undefined) };
    const service = new DockerBuildRunnerService(
      db as never,
      builds as never,
      dispatch as never,
      integrations as never,
      registry as never
    );
    service.setSourceService({ getDecryptedBuildSecrets: vi.fn(async () => []) } as never);

    await (
      service as unknown as {
        claimAndDispatch(builderNodeId: string, platform: 'linux/amd64'): Promise<void>;
      }
    ).claimAndDispatch('builder-1', 'linux/amd64');

    expect(builds.appendLog).toHaveBeenCalledWith(
      'build-1',
      0,
      '[system] Build dispatch failed: relay grant revision 3 is older than 177\n'
    );
    expect(builds.transition).toHaveBeenCalledWith('build-1', expect.any(String), 'failed', {
      errorCode: 'BUILD_DISPATCH_FAILED',
      errorMessage: 'relay grant revision 3 is older than 177',
    });
    expect(builds.appendLog.mock.invocationCallOrder[0]).toBeLessThan(builds.transition.mock.invocationCallOrder[0]!);
  });

  it('returns a capacity-rejected claim to the queue instead of failing the build', async () => {
    const build = {
      id: 'build-1',
      sourceBindingId: 'source-1',
      sourceConfigGeneration: 1,
      repositoryRemoteId: 'repo-1',
      repositoryFullPath: 'acme/site',
      ref: 'refs/heads/main',
      commitSha: 'a'.repeat(40),
      serviceName: null,
      dockerfilePath: 'Dockerfile',
      contextPath: '.',
      buildArgs: {},
      applicationRoot: '.',
      packageManager: 'npm',
      packageManagerVersion: null,
      nodeVersion: '24',
      buildScript: 'build',
      artifactDirectory: 'dist',
    };
    const source = {
      id: 'source-1',
      configGeneration: 1,
      connectorId: 'connector-1',
      repositoryCloneUrl: 'https://example.com/acme/site.git',
      repositoryRemoteId: 'repo-1',
      policy: {},
      targetKind: 'pages_project',
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [source]) })),
        })),
      })),
    };
    const builds = {
      claimNext: vi.fn(async () => build),
      appendLog: vi.fn(async () => undefined),
      transition: vi.fn(async () => undefined),
      returnClaimToQueue: vi.fn(async () => undefined),
    };
    const dispatch = {
      dispatchDockerBuildCommand: vi.fn(async () => ({
        accepted: Promise.resolve(),
        result: Promise.resolve({
          success: false,
          error: 'builder is at its isolated job capacity',
        }),
      })),
    };
    const service = new DockerBuildRunnerService(
      db as never,
      builds as never,
      dispatch as never,
      {
        resolveDockerBuildCheckoutCredential: vi.fn(async () => ({ token: 'test' })),
      } as never,
      { ensureBinding: vi.fn(async () => undefined) } as never
    );
    service.setSourceService({ getDecryptedBuildSecrets: vi.fn(async () => []) } as never);

    await (
      service as unknown as {
        claimAndDispatch(builderNodeId: string, platform: 'linux/amd64'): Promise<boolean>;
      }
    ).claimAndDispatch('builder-1', 'linux/amd64');

    expect(builds.returnClaimToQueue).toHaveBeenCalledWith(
      'build-1',
      expect.any(String),
      'Build Worker capacity changed before dispatch'
    );
    expect(builds.appendLog).not.toHaveBeenCalled();
    expect(builds.transition).not.toHaveBeenCalled();
  });

  it('preserves the claim when an accepted build has an ambiguous command result', async () => {
    const build = {
      id: 'build-1',
      sourceBindingId: 'source-1',
      sourceConfigGeneration: 1,
      repositoryRemoteId: 'repo-1',
      repositoryFullPath: 'acme/site',
      ref: 'refs/heads/main',
      commitSha: 'a'.repeat(40),
      serviceName: null,
      dockerfilePath: 'Dockerfile',
      contextPath: '.',
      buildArgs: {},
      applicationRoot: '.',
      packageManager: 'npm',
      packageManagerVersion: null,
      nodeVersion: '24',
      buildScript: 'build',
      artifactDirectory: 'dist',
    };
    const source = {
      id: 'source-1',
      configGeneration: 1,
      connectorId: 'connector-1',
      repositoryCloneUrl: 'https://example.com/acme/site.git',
      repositoryRemoteId: 'repo-1',
      policy: {},
      targetKind: 'pages_project',
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [source]) })),
        })),
      })),
    };
    const builds = {
      claimNext: vi.fn(async () => build),
      appendLog: vi.fn(async () => undefined),
      transition: vi.fn(async () => undefined),
      returnClaimToQueue: vi.fn(async () => undefined),
    };
    const service = new DockerBuildRunnerService(
      db as never,
      builds as never,
      {
        dispatchDockerBuildCommand: vi.fn(async () => ({
          accepted: Promise.resolve(),
          result: Promise.reject(new Error('Command timed out after 30000ms')),
        })),
      } as never,
      {
        resolveDockerBuildCheckoutCredential: vi.fn(async () => ({ token: 'test' })),
      } as never,
      { ensureBinding: vi.fn(async () => undefined) } as never
    );
    service.setSourceService({ getDecryptedBuildSecrets: vi.fn(async () => []) } as never);

    const dispatched = await (
      service as unknown as {
        claimAndDispatch(builderNodeId: string, platform: 'linux/amd64'): Promise<boolean>;
      }
    ).claimAndDispatch('builder-1', 'linux/amd64');

    expect(dispatched).toBe(true);
    expect(builds.returnClaimToQueue).not.toHaveBeenCalled();
    expect(builds.appendLog).not.toHaveBeenCalled();
    expect(builds.transition).not.toHaveBeenCalled();
  });
});
