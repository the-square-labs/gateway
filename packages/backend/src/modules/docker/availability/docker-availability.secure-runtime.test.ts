import { describe, expect, it, vi } from 'vitest';
import { availabilityContainerRuntimeSpec, deploymentPlacementSnapshot } from './docker-availability.adapters.js';
import { DockerAvailabilityService } from './docker-availability.service.js';

describe('HA secure runtime propagation', () => {
  it('preserves secure profile when creating a mirrored container replica', () => {
    expect(
      availabilityContainerRuntimeSpec({
        image: 'internal@sha256:abc',
        sourceImageReference: 'app:latest',
        runtimeProfile: 'secure',
      })
    ).toEqual({ image: 'internal@sha256:abc', runtimeProfile: 'secure' });
  });

  it('preserves secure profile in the deployment replica snapshot', () => {
    const snapshot = deploymentPlacementSnapshot(
      {},
      {
        deploymentId: 'replica',
        routerName: 'router',
        networkName: 'network',
        slots: { blue: 'blue', green: 'green' },
      },
      { image: 'internal@sha256:abc', runtimeProfile: 'secure' },
      {}
    );
    expect(snapshot.desiredConfig.runtimeProfile).toBe('secure');
  });

  it.each(['container', 'deployment'])('excludes nodes without healthy runsc for %s placements', async (kind) => {
    const rows = ['secure-node', 'ordinary-node'].map((id) => ({ id, type: 'docker', status: 'online' }));
    const db = { select: () => ({ from: () => ({ where: async () => rows }) }) };
    const registry = {
      getNode: () => ({}),
      isNodeUpdateInProgress: () => false,
      hasCapability: (id: string, capability: string) =>
        capability === 'docker_availability_v1' || id === 'secure-node',
    };
    const service = new DockerAvailabilityService(
      db as never,
      registry as never,
      {} as never,
      {} as never,
      {} as never
    ) as any;
    service.nodeArchitecture = vi.fn().mockReturnValue('amd64');
    service.candidateRank = vi.fn().mockReturnValue(1);
    service.candidateCapacity = vi.fn().mockReturnValue(1);
    const portableSpec =
      kind === 'container' ? { runtimeProfile: 'secure' } : { desiredConfig: { runtimeProfile: 'secure' } };
    const candidates = await service.resolveCandidateNodes(
      { selectedNodeIds: [], nodeSelectionMode: 'all_compatible' },
      { currentNodeId: 'secure-node', portableSpec }
    );
    expect(candidates.find((node: any) => node.id === 'secure-node')).toMatchObject({ compatible: true });
    expect(candidates.find((node: any) => node.id === 'ordinary-node')).toMatchObject({
      compatible: false,
      reasonCode: 'SECURE_RUNTIME_UNAVAILABLE',
    });
  });
});
