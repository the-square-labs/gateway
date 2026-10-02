import { describe, expect, it, vi } from 'vitest';
import { ProxyService } from './proxy.service.js';
import { ProxySecureLinkService } from './proxy-secure-link.service.js';

const HOST_ID = '11111111-1111-4111-8111-111111111111';

/** A committed, active Route link whose Route now names the target node of a migrated container. */
function migratedRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: HOST_ID,
    type: 'proxy',
    domainNames: ['app.example.com'],
    enabled: true,
    nodeId: 'nginx-node',
    ingressGroupId: null,
    rawConfigEnabled: false,
    upstreamKind: 'docker_container',
    dockerNodeId: 'target-node',
    dockerContainerName: 'api',
    dockerComposeProjectId: null,
    dockerComposeServiceName: null,
    dockerDeploymentId: null,
    dockerContainerPort: 8080,
    dockerHostPort: 8080,
    dockerProtocol: 'tcp',
    forwardScheme: 'http',
    healthCheckUrl: null,
    secureLinkGeneration: 3,
    secureLinkStatus: 'active',
    secureLinkLastError: null,
    secureLinkTargetNetwork: 'app-net',
    secureLinkTargetContainer: 'api',
    secureLinkTargetHost: null,
    secureLinkMigratedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  } as any;
}

/** The Secure Link service over fakes; `linkedNodeId` is the node the link's relay endpoint reaches now. */
function secureLinkHarness(linkedNodeId: string | null) {
  const route = migratedRoute();
  const db = {
    query: { proxyHosts: { findFirst: vi.fn(async () => route) } },
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [route]) })) })),
    })),
  };
  const calls: string[] = [];
  const relayPolicy = {
    proxySecureLinkTargetNodeId: vi.fn(async () => linkedNodeId),
    ensureProxySecureLink: vi.fn(async (_link: string, _sources: unknown, nodeId: string) => {
      calls.push(`endpoint ${nodeId}`);
      return 'relay-route';
    }),
    revokeOwner: vi.fn(async () => undefined),
  };
  const service = new ProxySecureLinkService(db as never, {} as never, relayPolicy as never, 'connector@sha256:test');
  vi.spyOn(service as any, 'nodesSupportSecureLinks').mockResolvedValue(true);
  vi.spyOn(service as any, 'hostSources').mockResolvedValue(['nginx-node']);
  vi.spyOn(service as any, 'syncTargetNode').mockImplementation(async (nodeId: unknown, _network, required) => {
    calls.push(`target ${nodeId}${required ? ' with the link' : ''}`);
  });
  vi.spyOn(service as any, 'syncSourceNodes').mockImplementation(async () => {
    calls.push('sources');
  });
  vi.spyOn(service as any, 'probeSources').mockImplementation(async () => {
    calls.push('probe');
    return { httpStatus: 200 };
  });
  return { service, route, relayPolicy, calls };
}

describe('Route Secure Link of a migrated container', () => {
  it('follows the target in place: binding there, endpoint moved, former node released', async () => {
    const { service, route, relayPolicy, calls } = secureLinkHarness('source-node');

    await expect(service.targetMoved(route)).resolves.toBe(true);
    await service.reconcileExisting(route);

    expect(calls).toEqual([
      'target target-node with the link',
      'endpoint target-node',
      'sources',
      'probe',
      // Only once the target answers through the link.
      'target source-node',
    ]);
    // The serving path is never torn down: no revocation, no new generation, no Nginx re-delivery.
    expect(relayPolicy.revokeOwner).not.toHaveBeenCalled();
  });

  it('follows the target when the Route is saved, without a forced reconciliation', async () => {
    const { service, route, calls } = secureLinkHarness('source-node');

    await service.prepare(route, false, false);

    expect(calls).toContain('endpoint target-node');
    expect(calls).toContain('target source-node');
  });

  it('leaves a link that reaches its target alone', async () => {
    const { service, route, calls } = secureLinkHarness('target-node');

    await expect(service.targetMoved(route)).resolves.toBe(false);
    await service.prepare(route, false, false);

    expect(calls).toEqual([]);
  });
});

function proxyHarness(moved: boolean) {
  const route = migratedRoute();
  const secureLinks = {
    targetMoved: vi.fn(async () => moved),
    reconcileExisting: vi.fn(async (host: unknown) => host),
  };
  const dockerUpstreams = {
    resolve: vi.fn(async () => ({
      upstreamKind: 'docker_container',
      dockerNodeId: 'target-node',
      dockerContainerName: 'api',
      dockerComposeProjectId: null,
      dockerComposeServiceName: null,
      dockerDeploymentId: null,
      dockerContainerPort: 8080,
      dockerProtocol: 'tcp',
    })),
  };
  const service = new ProxyService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    dockerUpstreams as never,
    secureLinks as never
  );
  return { service: service as any, route, secureLinks };
}

describe('Docker Route reconciliation after a migration', () => {
  it('re-points a moved link even when the Route row itself did not change', async () => {
    const moved = proxyHarness(true);
    await moved.service.resolveStoredDockerUpstream(moved.route, false);
    expect(moved.secureLinks.reconcileExisting).toHaveBeenCalledWith(moved.route);

    const unmoved = proxyHarness(false);
    await unmoved.service.resolveStoredDockerUpstream(unmoved.route, false);
    expect(unmoved.secureLinks.reconcileExisting).not.toHaveBeenCalled();
  });

  it('reconciles the Routes of a migrated workload at once and retries those that did not follow', async () => {
    const { service } = proxyHarness(true);
    const reconciled: string[] = [];
    vi.spyOn(service, 'reconcileDockerHost').mockImplementation(async (hostId: unknown) => {
      reconciled.push(String(hostId));
      if (hostId === 'route-2') throw new Error('target node is reconnecting');
      return true;
    });
    // Additional Secure Links and Additional Routes follow in the background pass.
    const background = vi.spyOn(service, 'queueDockerReconciliation').mockReturnValue(undefined);
    const retry = vi.spyOn(service, 'scheduleDockerReconciliationRetry').mockReturnValue(undefined);

    await expect(service.followMigratedDockerRoutes(['route-1'])).resolves.toBe(true);
    expect(background).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();

    await expect(service.followMigratedDockerRoutes(['route-1', 'route-2'])).resolves.toBe(false);
    expect(reconciled).toEqual(['route-1', 'route-1', 'route-2']);
    expect(retry).toHaveBeenCalledOnce();
  });
});
