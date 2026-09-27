import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { assertWorkloadBindingTargetAccess } from '@/modules/ai/ai.binding-target-access.js';
import { DockerManagementService } from './docker.service.js';
import { resolveBindingTargetContainerIdentity } from './docker-binding-target-identity.js';
import { DockerSourceService } from './docker-source.service.js';

const NODE = 'node-1';

function services(inspect: () => Promise<unknown>, pending: unknown) {
  const docker = { inspectContainer: vi.fn(inspect) };
  const source = { getPendingContainer: vi.fn().mockResolvedValue(pending) };
  vi.spyOn(container, 'isRegistered').mockReturnValue(true);
  vi.spyOn(container, 'resolve').mockImplementation(((token: unknown) =>
    token === DockerManagementService ? docker : token === DockerSourceService ? source : {}) as never);
  return { docker, source };
}

const missing = () => Promise.reject(new Error('Error response from daemon: No such container: api'));

afterEach(() => vi.restoreAllMocks());

describe('access identity of a managed link target container', () => {
  it('is the container identity when the container exists', async () => {
    const { source } = services(() => Promise.resolve({ Name: '/api', scopeResourceId: 'runtime-identity' }), {
      scopeResourceId: 'reservation',
    });

    await expect(resolveBindingTargetContainerIdentity(NODE, 'api')).resolves.toBe('runtime-identity');
    expect(source.getPendingContainer).not.toHaveBeenCalled();
  });

  it("is the Git source's reserved identity while its first build has not created the container", async () => {
    const { source } = services(missing, { containerName: 'api', scopeResourceId: 'reservation' });

    await expect(resolveBindingTargetContainerIdentity(NODE, 'api')).resolves.toBe('reservation');
    expect(source.getPendingContainer).toHaveBeenCalledWith(NODE, 'api');
  });

  it('is refused for a missing container no source reserves', async () => {
    services(missing, null);

    await expect(resolveBindingTargetContainerIdentity(NODE, 'api')).rejects.toMatchObject({
      code: 'CONTAINER_NOT_FOUND',
    });
  });

  it('does not fall back to the reservation when the daemon fails for another reason', async () => {
    const { source } = services(() => Promise.reject(new Error('Binding target node is offline')), {
      scopeResourceId: 'reservation',
    });

    await expect(resolveBindingTargetContainerIdentity(NODE, 'api')).rejects.toThrow('offline');
    expect(source.getPendingContainer).not.toHaveBeenCalled();
  });
});

describe('agent permission to link a pending Git-source container', () => {
  const target = { targetNodeId: NODE, targetType: 'container' as const, targetResourceId: 'api' };

  it('needs environment and secrets permission on the reserved identity', async () => {
    services(missing, { containerName: 'api', scopeResourceId: 'reservation' });

    await expect(
      assertWorkloadBindingTargetAccess(
        [`docker:containers:environment:${NODE}/reservation`, `docker:containers:secrets:${NODE}/reservation`],
        target
      )
    ).resolves.toBeUndefined();
    await expect(
      assertWorkloadBindingTargetAccess([`docker:containers:environment:${NODE}/reservation`], target)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      assertWorkloadBindingTargetAccess(
        [`docker:containers:environment:${NODE}/other`, `docker:containers:secrets:${NODE}/other`],
        target
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
