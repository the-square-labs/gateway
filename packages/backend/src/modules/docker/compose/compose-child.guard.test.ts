import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { DockerAvailabilityService } from '../availability/docker-availability.service.js';
import { DockerManagementService } from '../docker.service.js';
import { DockerSnapshotService } from '../docker-snapshot.service.js';
import { DockerComposeService } from './compose.service.js';
import {
  assertComposeChildMutationAllowed,
  assertComposeNetworkMutationAllowed,
  assertComposeVolumeMutationAllowed,
} from './compose-child.guard.js';

afterEach(() => container.reset());

describe('Compose child mutation guard', () => {
  it('allows logical Availability container mutations without inspecting the removed source container', async () => {
    const inspectContainer = vi.fn();
    container.registerInstance(DockerAvailabilityService, {
      isContainerManaged: vi.fn().mockResolvedValue(true),
    } as never);
    container.registerInstance(DockerManagementService, { inspectContainer } as never);

    await expect(assertComposeChildMutationAllowed('node-1', 'logical-container')).resolves.toBeUndefined();
    expect(inspectContainer).not.toHaveBeenCalled();
  });

  it('allows standalone container mutations', async () => {
    container.registerInstance(DockerManagementService, {
      inspectContainer: vi.fn().mockResolvedValue({ Config: { Labels: {} } }),
    } as never);
    container.registerInstance(DockerComposeService, { findByName: vi.fn() } as never);

    await expect(assertComposeChildMutationAllowed('node-1', 'container-1')).resolves.toBeUndefined();
  });

  it('rejects Compose-owned child mutations and returns the owning project identity', async () => {
    container.registerInstance(DockerManagementService, {
      inspectContainer: vi.fn().mockResolvedValue({
        Config: { Labels: { 'com.docker.compose.project': 'demo' } },
      }),
    } as never);
    container.registerInstance(DockerComposeService, {
      findByName: vi.fn().mockResolvedValue({ id: 'project-1' }),
    } as never);

    await expect(assertComposeChildMutationAllowed('node-1', 'container-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMPOSE_RESOURCE_MANAGED',
      details: { nodeId: 'node-1', projectId: 'project-1', projectName: 'demo' },
    });
  });

  it.each([
    ['volume', assertComposeVolumeMutationAllowed, 'volumes', 'demo_data', 'com.docker.compose.volume'],
    ['network', assertComposeNetworkMutationAllowed, 'networks', 'demo_default', 'com.docker.compose.network'],
  ] as const)('rejects Compose-owned %s mutations', async (_, guard, kind, resourceId, ownershipLabel) => {
    container.registerInstance(DockerSnapshotService, {
      getList: vi.fn().mockResolvedValue({
        revision: 1,
        refreshStatus: 'ready',
        data: [
          {
            name: resourceId,
            labels: {
              'com.docker.compose.project': 'demo',
              [ownershipLabel]: resourceId,
            },
          },
        ],
      }),
    } as never);

    await expect(guard('node-1', resourceId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMPOSE_RESOURCE_MANAGED',
      details: { nodeId: 'node-1', projectName: 'demo', resourceId },
    });
    expect((container.resolve(DockerSnapshotService) as any).getList).toHaveBeenCalledWith('node-1', kind);
  });

  it('fails closed when resource ownership cannot be verified', async () => {
    container.registerInstance(DockerSnapshotService, {
      getList: vi.fn().mockResolvedValue({ revision: 0, refreshStatus: 'error', data: [] }),
    } as never);

    await expect(assertComposeVolumeMutationAllowed('node-1', 'data')).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOCKER_RESOURCE_OWNERSHIP_UNAVAILABLE',
    });
  });

  it.each([
    ['volume', assertComposeVolumeMutationAllowed, 'volumes'],
    ['network', assertComposeNetworkMutationAllowed, 'networks'],
  ] as const)('fails closed when a ready snapshot is missing the target %s', async (_, guard, kind) => {
    container.registerInstance(DockerSnapshotService, {
      getList: vi.fn().mockResolvedValue({ revision: 2, refreshStatus: 'ready', data: [] }),
    } as never);

    await expect(guard('node-1', 'not-yet-observed')).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOCKER_RESOURCE_OWNERSHIP_UNAVAILABLE',
    });
    expect((container.resolve(DockerSnapshotService) as any).getList).toHaveBeenCalledWith('node-1', kind);
  });
});
