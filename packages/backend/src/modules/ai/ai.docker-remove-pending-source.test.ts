import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { DockerSourceService } from '@/modules/docker/docker-source.service.js';
import type { User } from '@/types.js';
import { executeDockerTool } from './ai.docker-tools.js';

const NODE = '44444444-4444-4444-8444-444444444444';

function userWith(scopes: string[]): User {
  return { id: 'user-1', isBlocked: false, scopes } as User;
}

function remove(user: User) {
  const docker = { inspectContainer: vi.fn(), removeContainer: vi.fn() };
  const context = { dockerService: docker, ensureToolScope: vi.fn(), ensureToolScopeForResource: vi.fn() } as never;
  return {
    docker,
    run: () => executeDockerTool(context, user, 'remove_docker_container', { nodeId: NODE, containerId: 'shop' }),
  };
}

afterEach(() => container.reset());

describe('remove_docker_container for a Git-source container its first build has not created', () => {
  it('answers 409 SOURCE_CONTAINER_NOT_BUILT like the REST route, without inspecting or removing anything', async () => {
    container.registerInstance(DockerSourceService, {
      getPendingContainer: vi.fn(async (_nodeId: string, name: string) =>
        name === 'shop' ? { containerName: 'shop', scopeResourceId: 'reserved-shop' } : null
      ),
    } as never);
    const { docker, run } = remove(userWith([`docker:containers:delete:${NODE}/reserved-shop`]));

    await expect(run()).rejects.toMatchObject({ statusCode: 409, code: 'SOURCE_CONTAINER_NOT_BUILT' });
    expect(docker.inspectContainer).not.toHaveBeenCalled();
    expect(docker.removeContainer).not.toHaveBeenCalled();
  });

  it('still needs the delete scope on the reserved identity', async () => {
    container.registerInstance(DockerSourceService, {
      getPendingContainer: vi.fn().mockResolvedValue({ containerName: 'shop', scopeResourceId: 'reserved-shop' }),
    } as never);
    const { run } = remove(userWith([`docker:containers:view:${NODE}`]));

    await expect(run()).rejects.toThrow('PERMISSION_DENIED');
  });
});
