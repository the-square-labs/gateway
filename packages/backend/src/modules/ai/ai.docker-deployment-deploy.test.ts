import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import type { User } from '@/types.js';
import { executeDockerTool } from './ai.docker-tools.js';

const NODE = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT = '22222222-2222-4222-8222-222222222222';
const TARGET = `${NODE}/${DEPLOYMENT}`;
const SAVED_ENV = { APP_MODE: 'production', LOG_LEVEL: 'info', LEGACY_FLAG: '1' };

afterEach(() => container.reset());

function registerDeployments() {
  const deployments = {
    get: vi.fn().mockResolvedValue({ id: DEPLOYMENT, desiredConfig: { image: 'app:1', env: SAVED_ENV } }),
    deploy: vi.fn().mockResolvedValue({ id: DEPLOYMENT, desiredConfig: { image: 'app:1' } }),
  };
  container.registerInstance(DockerDeploymentService, deployments as never);
  return deployments;
}

const context = {
  dockerService: {} as never,
  ensureToolScope: vi.fn(),
  ensureToolScopeForResource(user: User, scope: string, resourceId: string) {
    if (!user.scopes.includes(`${scope}:${resourceId}`)) {
      throw new Error(`PERMISSION_DENIED: Missing required scope ${scope}:${resourceId}`);
    }
  },
};

function userWith(scopes: string[]): User {
  return { id: 'user-1', scopes: scopes.map((scope) => `${scope}:${TARGET}`) } as User;
}

describe('deploy_docker_deployment env', () => {
  it('sets env over the saved environment and removes removeEnv keys', async () => {
    const deployments = registerDeployments();
    const user = userWith(['docker:containers:manage', 'docker:containers:environment']);

    await executeDockerTool(context, user, 'deploy_docker_deployment', {
      nodeId: NODE,
      deploymentId: DEPLOYMENT,
      env: { LOG_LEVEL: 'debug', FEATURE_X: 'on' },
      removeEnv: ['LEGACY_FLAG'],
    });

    expect(deployments.deploy).toHaveBeenCalledWith(
      NODE,
      DEPLOYMENT,
      { env: { APP_MODE: 'production', LOG_LEVEL: 'debug', FEATURE_X: 'on' } },
      'user-1',
      'manual',
      user.scopes
    );
  });

  it('removes keys with removeEnv alone and keeps the rest', async () => {
    const deployments = registerDeployments();
    const user = userWith(['docker:containers:manage', 'docker:containers:environment']);

    await executeDockerTool(context, user, 'deploy_docker_deployment', {
      nodeId: NODE,
      deploymentId: DEPLOYMENT,
      removeEnv: ['LEGACY_FLAG'],
    });

    expect(deployments.deploy.mock.calls[0][2]).toEqual({ env: { APP_MODE: 'production', LOG_LEVEL: 'info' } });
  });

  it('redeploys the saved environment untouched when neither env nor removeEnv is given', async () => {
    const deployments = registerDeployments();
    const user = userWith(['docker:containers:manage']);

    await executeDockerTool(context, user, 'deploy_docker_deployment', { nodeId: NODE, deploymentId: DEPLOYMENT });

    expect(deployments.get).not.toHaveBeenCalled();
    expect(deployments.deploy.mock.calls[0][2]).toEqual({});
  });

  it('needs docker:containers:environment for removeEnv, before reading the saved environment', async () => {
    const deployments = registerDeployments();
    const user = userWith(['docker:containers:manage']);

    await expect(
      executeDockerTool(context, user, 'deploy_docker_deployment', {
        nodeId: NODE,
        deploymentId: DEPLOYMENT,
        removeEnv: ['LEGACY_FLAG'],
      })
    ).rejects.toThrow(`docker:containers:environment:${TARGET}`);
    expect(deployments.get).not.toHaveBeenCalled();
    expect(deployments.deploy).not.toHaveBeenCalled();
  });
});
