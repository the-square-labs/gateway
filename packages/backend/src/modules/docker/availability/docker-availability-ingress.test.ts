import { describe, expect, it, vi } from 'vitest';
import { DockerAvailabilityIngressProjector } from './docker-availability-ingress.js';

describe('DockerAvailabilityIngressProjector adoption', () => {
  it('recovers a drifted container proxy host through its existing Availability member', async () => {
    const driftedHost = {
      id: 'host-1',
      enabled: true,
      type: 'proxy',
      upstreamKind: 'docker_container',
      dockerNodeId: 'old-survivor-node',
      dockerContainerName: 'api',
    };
    const findHosts = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([driftedHost]);
    const db = {
      query: {
        proxyHosts: { findMany: findHosts },
        dockerAvailabilityPlacements: { findMany: vi.fn().mockResolvedValue([{ id: 'placement-1' }]) },
        proxyAdditionalSecureLinks: {
          findMany: vi.fn().mockResolvedValue([
            {
              proxyHostId: 'host-1',
              referenceId: 'placement-1',
              availabilityOwnerKey: 'proxy-host:host-1',
            },
          ]),
        },
      },
    };
    const projector = new DockerAvailabilityIngressProjector(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    ) as any;

    await expect(
      projector.hosts(
        {
          kind: 'container',
          currentNodeId: 'current-origin-node',
          displayName: 'api',
        },
        'policy-1'
      )
    ).resolves.toEqual([driftedHost]);
  });

  it('retargets a Compose proxy host to the ordinary surviving container before secure-link reconciliation', async () => {
    const host = {
      id: 'host-1',
      enabled: true,
      type: 'proxy',
      upstreamKind: 'docker_container',
      dockerNodeId: 'old-node',
      dockerContainerName: 'gwav-compose-policy-placement-web-1',
      dockerComposeProjectId: 'project-1',
      dockerComposeServiceName: 'web',
      dockerContainerPort: 8080,
      dockerHostPort: 8080,
    };
    const set = vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ ...host, dockerNodeId: 'survivor-node' }]) })),
    }));
    const db = {
      query: { proxyHosts: { findMany: vi.fn().mockResolvedValue([host]) } },
      update: vi.fn(() => ({ set })),
    };
    const secureLinks = { reconcileExisting: vi.fn().mockResolvedValue(host) };
    const docker = {
      listContainers: vi.fn().mockResolvedValue([
        {
          Names: ['/availability-compose-web-1'],
          Labels: {
            'com.docker.compose.project': 'availability-compose',
            'com.docker.compose.service': 'web',
          },
        },
      ]),
    };
    const projector = new DockerAvailabilityIngressProjector(
      db as never,
      {} as never,
      docker as never,
      secureLinks as never,
      {} as never
    );

    await projector.prepareFinalAdoption({
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'survivor-node',
      generation: 2,
      idempotencyKey: 'disable-2',
      resource: {
        kind: 'compose',
        resourceId: 'project-1',
        currentNodeId: 'old-node',
        displayName: 'availability-compose',
        specFingerprint: 'fingerprint',
        portableSpec: {},
      },
    } as never);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        dockerNodeId: 'survivor-node',
        dockerContainerName: 'availability-compose-web-1',
        dockerHostPort: 8080,
        secureLinkTargetNetwork: '',
        secureLinkTargetContainer: 'availability-compose-web-1',
      })
    );
    expect(secureLinks.reconcileExisting).toHaveBeenCalledOnce();
  });
});
