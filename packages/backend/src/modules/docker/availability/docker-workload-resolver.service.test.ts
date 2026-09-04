import { describe, expect, it, vi } from 'vitest';
import { DockerWorkloadResolverService, matchRuntimeIdentity } from './docker-workload-resolver.service.js';

describe('DockerWorkloadResolverService runtime identity matching', () => {
  it('routes the logical container name to a serving replica when its original placement is unreachable', async () => {
    const resolver = new DockerWorkloadResolverService({} as never) as any;
    const origin = {
      id: 'origin',
      nodeId: 'node-origin',
      serving: false,
      actualState: 'unreachable',
      runtimeIdentity: { containerId: 'old-runtime', containerName: 'api' },
    };
    const replica = {
      id: 'replica',
      nodeId: 'node-replica',
      serving: true,
      actualState: 'serving',
      runtimeIdentity: { containerId: 'healthy-runtime', containerName: 'gwav-api-replica' },
    };
    const workload = {
      policy: { resourceKind: 'container', containerName: 'api', sourceNodeId: 'node-origin' },
      placements: [origin, replica],
      servingPlacements: [replica],
    };
    resolver.findRuntimeOwner = vi.fn().mockResolvedValue({ workload });
    await expect(resolver.resolveContainerRuntimeTarget('node-origin', 'api')).resolves.toMatchObject({
      placementId: 'replica',
      nodeId: 'node-replica',
      containerId: 'healthy-runtime',
    });
  });

  it('preserves an explicitly selected physical placement instead of falling back to the first replica', async () => {
    const resolver = new DockerWorkloadResolverService({} as never) as any;
    const first = {
      id: 'placement-1',
      nodeId: 'node-1',
      generation: 2,
      serving: true,
      actualState: 'serving',
      dependencyState: 'ready',
      applicationHealth: 'healthy',
      runtimeIdentity: { containerId: 'container-1' },
    };
    const selected = {
      ...first,
      id: 'placement-2',
      nodeId: 'node-2',
      runtimeIdentity: { containerId: 'container-2' },
    };
    const workload = {
      policy: { resourceKind: 'container' },
      placements: [first, selected],
      servingPlacements: [first, selected],
    };
    resolver.findRuntimeOwner = vi.fn().mockResolvedValue({ workload });

    await expect(resolver.resolveContainerRuntimeTarget('node-2', 'container-2')).resolves.toMatchObject({
      placementId: 'placement-2',
      nodeId: 'node-2',
      containerId: 'container-2',
    });
  });

  it('matches container placement names and Docker ID prefixes without fuzzy name matching', () => {
    const identity = {
      containerId: '581e545ce348aabbccdd',
      containerName: 'gwav-container-policy-placement',
    };
    expect(matchRuntimeIdentity(identity, '581e545ce348')).toEqual({ matches: true });
    expect(matchRuntimeIdentity(identity, 'gwav-container-policy-placement')).toEqual({ matches: true });
    expect(matchRuntimeIdentity(identity, 'gwav-container-policy')).toEqual({ matches: false });
  });

  it('matches deployment slots', () => {
    expect(
      matchRuntimeIdentity({ slots: { blue: 'blue-container-id', green: 'green-container-id' } }, 'green-container-id')
    ).toEqual({ matches: true });
  });

  it('returns the Compose service owning a physical container', () => {
    expect(
      matchRuntimeIdentity(
        {
          containers: [{ containerId: 'runtime-api', containerName: 'project-api-1', serviceName: 'api' }],
        },
        'runtime-api'
      )
    ).toEqual({ matches: true, composeServiceName: 'api' });
  });
});
