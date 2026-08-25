import { describe, expect, it, vi } from 'vitest';
import { AdditionalRouteService } from './additional-route.service.js';

describe('AdditionalRouteService Docker reconciliation', () => {
  it('switches the route to the ready binding before retiring stale bindings', async () => {
    const current = {
      id: '11111111-1111-4111-8111-111111111111',
      proxyHostId: '22222222-2222-4222-8222-222222222222',
      enabled: true,
      status: 'ready',
      generation: 2,
      targetKind: 'docker_container',
      forwardScheme: 'http',
      dockerNodeId: '33333333-3333-4333-8333-333333333333',
      dockerContainerName: 'compose-web-old',
      dockerComposeProjectId: '44444444-4444-4444-8444-444444444444',
      dockerComposeServiceName: 'web',
      dockerDeploymentId: null,
      dockerContainerPort: 80,
      secureLinkId: '55555555-5555-4555-8555-555555555555',
    } as any;
    const ready = {
      id: '66666666-6666-4666-8666-666666666666',
      status: 'active',
      dockerContainerName: 'compose-web-new',
    } as any;
    const stale = { id: current.secureLinkId };
    let persistedSet: Record<string, unknown> | undefined;
    const updateChain: Record<string, any> = {};
    updateChain.set = vi.fn((value) => {
      persistedSet = value;
      return updateChain;
    });
    updateChain.where = vi.fn(() => updateChain);
    updateChain.returning = vi.fn(async () => [{ id: current.id }]);
    const db = {
      query: {
        proxyAdditionalRoutes: {
          findMany: vi.fn().mockResolvedValue([current]),
          findFirst: vi.fn().mockResolvedValue(current),
        },
        proxyAdditionalSecureLinks: { findMany: vi.fn().mockResolvedValue([stale]) },
      },
      update: vi.fn(() => updateChain),
    } as any;
    const secureLinks = {
      getManagedRoute: vi.fn().mockResolvedValue({ id: current.secureLinkId, status: 'active' }),
      createManagedRoute: vi.fn().mockResolvedValue(ready),
      deleteManagedRouteBinding: vi.fn(async () => undefined),
    };
    const service = new AdditionalRouteService(db, { log: vi.fn() } as any, undefined, secureLinks as any);
    vi.spyOn(service, 'requireHost').mockResolvedValue({ id: current.proxyHostId } as any);
    vi.spyOn(service as any, 'normalizeTarget').mockReturnValue({
      targetKind: 'docker_container',
      forwardScheme: 'http',
      dockerNodeId: current.dockerNodeId,
      dockerComposeProjectId: current.dockerComposeProjectId,
      dockerComposeServiceName: current.dockerComposeServiceName,
      dockerContainerPort: 80,
    });
    const reconcileAdditionalRouteHost = vi.fn(async () => undefined);
    service.setHostRuntime({ reconcileAdditionalRouteHost });

    await expect(service.reconcileDockerTargets()).resolves.toBe(false);

    expect(persistedSet).toMatchObject({
      secureLinkId: ready.id,
      dockerContainerName: ready.dockerContainerName,
    });
    expect(reconcileAdditionalRouteHost).toHaveBeenCalledWith(current.proxyHostId);
    expect(secureLinks.deleteManagedRouteBinding).toHaveBeenCalledWith(
      expect.objectContaining({ id: current.proxyHostId }),
      stale.id
    );
    expect(reconcileAdditionalRouteHost.mock.invocationCallOrder[0]).toBeLessThan(
      secureLinks.deleteManagedRouteBinding.mock.invocationCallOrder[0]!
    );
  });
});
