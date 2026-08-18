import { describe, expect, it, vi } from 'vitest';
import { AdditionalRouteService } from './additional-route.service.js';

function updateDb(staged: Record<string, unknown>) {
  const chain: Record<string, any> = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(async () => [staged]);
  return { update: vi.fn(() => chain) };
}

describe('AdditionalRouteService retargeting', () => {
  it('switches a Pages route to a manual target before cleaning the old Pages runtime', async () => {
    const existing = {
      id: 'route-1',
      proxyHostId: 'host-1',
      path: '/app',
      enabled: true,
      targetKind: 'pages',
      pageProjectId: 'project-1',
      pageTagId: 'tag-1',
      activeDeploymentId: 'deployment-1',
      includePath: '/pages/routes/route-1.inc',
      runtimeConfigPath: '/pages/runtime-configs/route/route-1/current.js',
      runtimeConfigGeneration: 2,
      status: 'ready',
      generation: 4,
      advancedConfig: null,
      stripPrefix: true,
      websocketSupport: false,
      requestBuffering: false,
      responseBuffering: false,
      connectTimeoutSeconds: 60,
      readTimeoutSeconds: 60,
      sendTimeoutSeconds: 60,
      forwardHost: null,
      forwardPort: null,
      forwardScheme: null,
      dockerNodeId: null,
      dockerContainerName: null,
      dockerDeploymentId: null,
      dockerContainerPort: null,
      dockerHostPort: null,
      dockerProtocol: null,
    };
    const target = {
      targetKind: 'manual',
      forwardHost: '127.0.0.1',
      forwardPort: 8080,
      forwardScheme: 'http',
      dockerNodeId: null,
      dockerContainerName: null,
      dockerDeploymentId: null,
      dockerContainerPort: null,
      dockerHostPort: null,
      dockerProtocol: null,
      pageProjectId: null,
      pageTagId: null,
    };
    const staged = { ...existing, ...target, generation: 5, status: 'staging' };
    const ready = { ...staged, generation: 6, status: 'ready' };
    const db = updateDb(staged);
    const audit = { log: vi.fn(async () => undefined) };
    const service = new AdditionalRouteService(db as never, audit as never);
    const host = { id: 'host-1', type: 'proxy', rawConfigEnabled: false, nginxTemplateId: null, nodeId: 'node-1' };
    const reconcileAdditionalRouteHost = vi.fn(async () => undefined);
    service.setHostRuntime({ reconcileAdditionalRouteHost } as never);

    vi.spyOn(service, 'requireHost').mockResolvedValue(host as never);
    vi.spyOn(service, 'assertHostCanUse').mockResolvedValue(undefined);
    vi.spyOn(service, 'get').mockResolvedValue(existing as never);
    vi.spyOn(service as any, 'normalizeTarget').mockReturnValue(target);
    vi.spyOn(service as any, 'validateTarget').mockResolvedValue(undefined);
    vi.spyOn(service as any, 'routeOptions').mockReturnValue({
      stripPrefix: false,
      websocketSupport: false,
      requestBuffering: true,
      responseBuffering: true,
      connectTimeoutSeconds: 60,
      readTimeoutSeconds: 60,
      sendTimeoutSeconds: 60,
    });
    vi.spyOn(service as any, 'provision').mockResolvedValue(ready);
    const cleanupPages = vi.spyOn(service as any, 'cleanupPages').mockRejectedValue(new Error('old runtime offline'));

    await expect(
      service.update(
        'host-1',
        'route-1',
        { targetKind: 'manual', forwardHost: '127.0.0.1', forwardPort: 8080, forwardScheme: 'http' },
        'user-1',
        []
      )
    ).resolves.toMatchObject({ targetKind: 'manual', status: 'ready' });

    expect(reconcileAdditionalRouteHost).toHaveBeenCalledWith('host-1');
    expect(cleanupPages).toHaveBeenCalledWith(existing, 'node-1');
    expect(reconcileAdditionalRouteHost.mock.invocationCallOrder[0]).toBeLessThan(
      cleanupPages.mock.invocationCallOrder[0]!
    );
  });
});
