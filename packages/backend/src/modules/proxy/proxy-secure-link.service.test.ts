import { describe, expect, it, vi } from 'vitest';
import { ProxySecureLinkService } from './proxy-secure-link.service.js';

describe('ProxySecureLinkService migration rollback', () => {
  it('stages a replacement route binding without deprovisioning the active binding', async () => {
    const host = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'proxy',
      rawConfigEnabled: false,
      nodeId: 'nginx-node',
    } as any;
    const current = {
      id: '22222222-2222-4222-8222-222222222222',
      proxyHostId: host.id,
      purpose: 'additional_route',
      referenceId: 'route-1',
      status: 'active',
      generation: 3,
      sourceNodeId: host.nodeId,
      upstreamKind: 'docker_container',
      forwardScheme: 'http',
      dockerNodeId: 'docker-node',
      dockerContainerName: 'old-app',
      dockerDeploymentId: null,
      dockerContainerPort: 8080,
      dockerHostPort: 8080,
      targetNetwork: 'app-net',
      targetContainer: 'old-app',
      createdAt: new Date('2026-08-18T00:00:00Z'),
    } as any;
    const staged = {
      ...current,
      id: '33333333-3333-4333-8333-333333333333',
      name: 'route_route1_r4',
      status: 'provisioning',
      generation: 4,
      dockerContainerName: 'new-app',
      targetContainer: 'new-app',
      createdAt: new Date('2026-08-18T00:01:00Z'),
    } as any;
    const ready = { ...staged, status: 'active' };
    const db = {
      query: { proxyAdditionalSecureLinks: { findMany: vi.fn().mockResolvedValue([current]) } },
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([staged]) })),
      })),
    } as any;
    const service = new ProxySecureLinkService(db, {} as any, {} as any, 'connector@sha256:test');
    vi.spyOn(service as any, 'nodesSupportSecureLinks').mockResolvedValue(true);
    vi.spyOn(service as any, 'resolveAdditionalTarget').mockResolvedValue({
      nodeId: 'docker-node',
      network: 'app-net',
      container: 'new-app',
      targetPort: 8080,
    });
    const provision = vi.spyOn(service as any, 'createAdditionalFromExisting').mockResolvedValue(ready);
    const deprovision = vi.spyOn(service as any, 'deprovisionAdditionalRuntime').mockResolvedValue(undefined);

    await expect(
      service.createManagedRoute(host, 'route-1', {
        name: 'route-1',
        upstreamKind: 'docker_container',
        forwardScheme: 'http',
        dockerNodeId: 'docker-node',
        dockerContainerName: 'new-app',
        dockerContainerPort: 8080,
      })
    ).resolves.toBe(ready);

    expect(provision).toHaveBeenCalledWith(host, staged.id);
    expect(deprovision).not.toHaveBeenCalled();
  });

  it('reconciles active Docker targets with a connector image supplied by a Relay update', async () => {
    const db = {
      query: {
        proxyHosts: {
          findMany: vi.fn().mockResolvedValue([
            {
              dockerNodeId: 'docker-node',
              upstreamKind: 'docker_container',
              secureLinkStatus: 'active',
              secureLinkGeneration: 1,
            },
          ]),
        },
        proxyAdditionalSecureLinks: { findMany: vi.fn().mockResolvedValue([]) },
      },
    } as any;
    const service = new ProxySecureLinkService(db, {} as any, {} as any, 'connector@sha256:old');
    const syncTarget = vi.spyOn(service as any, 'syncTargetNode').mockResolvedValue(undefined);

    await service.updateConnectorImage('connector@sha256:new');

    expect(syncTarget).toHaveBeenCalledWith('docker-node');
    expect((service as any).connectorImage).toBe('connector@sha256:new');
  });

  it('returns a newly created binding while provisioning continues in the background', async () => {
    const host = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'proxy',
      rawConfigEnabled: false,
      nodeId: 'nginx-node',
      domainNames: ['example.test'],
    } as any;
    const created = {
      id: '22222222-2222-4222-8222-222222222222',
      proxyHostId: host.id,
      name: 'api',
      status: 'provisioning',
      sourceNodeId: host.nodeId,
      dockerNodeId: 'docker-node',
    } as any;
    const db = {
      query: { proxyAdditionalSecureLinks: { findFirst: vi.fn().mockResolvedValue(null) } },
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([created]) })),
      })),
    } as any;
    const service = new ProxySecureLinkService(db, {} as any, {} as any, 'connector@sha256:test');
    vi.spyOn(service as any, 'nodesSupportSecureLinks').mockResolvedValue(true);
    vi.spyOn(service as any, 'resolveAdditionalTarget').mockResolvedValue({
      nodeId: 'docker-node',
      network: 'application-net',
      container: 'api',
      targetPort: 8080,
    });
    const background = new Promise(() => undefined);
    const provision = vi.spyOn(service as any, 'createAdditionalFromExisting').mockReturnValue(background);
    const publish = vi.fn();
    service.setEventBus({ publish } as any);

    const result = await service.createAdditional(host, {
      name: 'api',
      upstreamKind: 'docker_container',
      forwardScheme: 'http',
      dockerNodeId: 'docker-node',
      dockerContainerName: 'api',
      dockerContainerPort: 8080,
    });

    expect(result).toBe(created);
    expect(result.status).toBe('provisioning');
    expect(provision).toHaveBeenCalledWith(host, created.id);
    expect(publish).toHaveBeenCalledWith(
      'proxy.secure-link.changed',
      expect.objectContaining({ bindingId: created.id, action: 'provisioning' })
    );
  });

  it('acknowledges deletion after marking cleanup pending without waiting for de-provisioning', async () => {
    const host = {
      id: '11111111-1111-4111-8111-111111111111',
      advancedConfig: null,
      domainNames: ['example.test'],
    } as any;
    const binding = {
      id: '22222222-2222-4222-8222-222222222222',
      proxyHostId: host.id,
      name: 'api',
      status: 'active',
    } as any;
    const pending = { ...binding, status: 'cleanup_pending' };
    const db = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([pending]) })),
        })),
      })),
    } as any;
    const service = new ProxySecureLinkService(db, {} as any, {} as any, 'connector@sha256:test');
    vi.spyOn(service as any, 'requireAdditional').mockResolvedValue(binding);
    const background = new Promise(() => undefined);
    const cleanup = vi.spyOn(service as any, 'finishAdditionalDeletion').mockReturnValue(background);
    const publish = vi.fn();
    service.setEventBus({ publish } as any);

    await expect(service.deleteAdditional(host, binding.id)).resolves.toBeUndefined();

    expect(cleanup).toHaveBeenCalledWith(host, binding);
    expect(publish).toHaveBeenCalledWith(
      'proxy.secure-link.changed',
      expect.objectContaining({ bindingId: binding.id, action: 'cleanup_pending' })
    );
    expect(publish).toHaveBeenCalledWith(
      'proxy.host.changed',
      expect.objectContaining({
        id: host.id,
        action: 'additional_secure_link_changed',
        bindingAction: 'cleanup_pending',
      })
    );
  });

  it('accepts only active additional binding variables', async () => {
    const service = new ProxySecureLinkService({} as any, {} as any, {} as any, 'connector@sha256:test');
    vi.spyOn(service, 'getActiveAdditional').mockResolvedValue([{ name: 'api' }] as any);

    await expect(
      service.assertAdditionalReferences('host-1', 'location /api { proxy_pass {{additionalSecureLinks.api}}; }')
    ).resolves.toBeUndefined();
    await expect(
      service.assertAdditionalReferences('host-1', 'location /admin { proxy_pass {{additionalSecureLinks.admin}}; }')
    ).rejects.toMatchObject({ code: 'INVALID_SECURE_LINK_REFERENCE' });
  });

  it('emits the canonical proxy host invalidation alongside the secure-link notification', () => {
    const service = new ProxySecureLinkService({} as any, {} as any, {} as any, 'connector@sha256:test') as any;
    const publish = vi.fn();
    service.setEventBus({ publish });

    service.emitLinkState(
      { id: 'host-1', domainNames: ['example.test'] },
      'reconciliation',
      'failed',
      new Error('relay unavailable')
    );

    expect(publish).toHaveBeenCalledWith(
      'proxy.secure-link.changed',
      expect.objectContaining({ id: 'host-1', state: 'failed' })
    );
    expect(publish).toHaveBeenCalledWith(
      'proxy.host.changed',
      expect.objectContaining({ id: 'host-1', action: 'secure_link_changed', state: 'failed' })
    );
  });

  it('retries a transient relay registration race before failing provisioning', async () => {
    const dispatch = {
      probeProxySecureLink: vi
        .fn()
        .mockRejectedValueOnce(new Error('connection reset by peer'))
        .mockResolvedValueOnce({ httpStatus: 200, responseMs: 4 }),
    } as any;
    const service = new ProxySecureLinkService({} as any, dispatch, {} as any, 'connector@sha256:test');

    await expect(
      (service as any).probeSecureLink('nginx-node', {
        linkId: '11111111-1111-4111-8111-111111111111',
        scheme: 'http',
        path: '/',
        timeoutSeconds: 10,
      })
    ).resolves.toEqual({ httpStatus: 200, responseMs: 4 });
    expect(dispatch.probeProxySecureLink).toHaveBeenCalledTimes(2);
  });

  it('clears a transient runtime error after an active link reconciles successfully', async () => {
    const host = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'proxy',
      upstreamKind: 'docker_container',
      nodeId: 'nginx-node',
      dockerNodeId: 'docker-node',
      dockerContainerName: 'application',
      dockerContainerPort: 8080,
      dockerHostPort: 8080,
      forwardScheme: 'http',
      healthCheckUrl: '/id',
      secureLinkGeneration: 2,
      secureLinkStatus: 'active',
      secureLinkMigratedAt: new Date(),
      secureLinkLastError: 'relay unavailable',
      secureLinkTargetNetwork: 'application-net',
      secureLinkTargetContainer: 'application',
      secureLinkTargetHost: null,
    } as any;
    const updatedValues: Array<Record<string, unknown>> = [];
    const db = {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(host) } },
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updatedValues.push(values);
          return {
            where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ ...host, secureLinkLastError: null }]) })),
          };
        }),
      })),
    } as any;
    const dispatch = { probeProxySecureLink: vi.fn().mockResolvedValue({ httpStatus: 200 }) } as any;
    const relayPolicy = { ensureProxySecureLink: vi.fn().mockResolvedValue(undefined) } as any;
    const service = new ProxySecureLinkService(db, dispatch, relayPolicy, 'connector@sha256:test');
    vi.spyOn(service as any, 'nodesSupportSecureLinks').mockResolvedValue(true);
    vi.spyOn(service as any, 'resolveTarget').mockResolvedValue({
      nodeId: 'docker-node',
      network: 'application-net',
      container: 'application',
      applicationPort: 8080,
      targetPort: 8080,
    });
    vi.spyOn(service as any, 'syncTargetNode').mockResolvedValue(undefined);
    vi.spyOn(service as any, 'syncSourceNode').mockResolvedValue(undefined);

    const result = await service.reconcileExisting(host);

    expect(result.secureLinkLastError).toBeNull();
    expect(updatedValues).toContainEqual(expect.objectContaining({ secureLinkLastError: null }));
  });

  it('preserves a prepared cutover when queued reconciliation starts from a stale legacy snapshot', async () => {
    const stale = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'proxy',
      upstreamKind: 'docker_container',
      nodeId: 'nginx-node',
      dockerNodeId: 'docker-node',
      dockerContainerName: 'application',
      dockerContainerPort: 8080,
      dockerHostPort: 18080,
      secureLinkGeneration: 0,
      secureLinkStatus: 'legacy',
      secureLinkMigratedAt: null,
      secureLinkTargetNetwork: null,
      secureLinkTargetContainer: null,
      secureLinkTargetHost: null,
    } as any;
    const prepared = {
      ...stale,
      dockerHostPort: 8080,
      secureLinkGeneration: 1,
      secureLinkStatus: 'cutover_ready',
      secureLinkTargetNetwork: 'application-net',
      secureLinkTargetContainer: 'application',
      secureLinkListenerPort: 41001,
      secureLinkConnectorPort: 42001,
    } as any;
    const db = {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(prepared) } },
      update: vi.fn(),
    } as any;
    const dispatch = { probeProxySecureLink: vi.fn() } as any;
    const relayPolicy = { ensureProxySecureLink: vi.fn(), revokeOwner: vi.fn() } as any;
    const service = new ProxySecureLinkService(db, dispatch, relayPolicy, 'connector@sha256:test');
    vi.spyOn(service as any, 'nodesSupportSecureLinks').mockResolvedValue(true);
    vi.spyOn(service as any, 'resolveTarget').mockResolvedValue({
      nodeId: 'docker-node',
      network: 'application-net',
      container: 'application',
      applicationPort: 8080,
      targetPort: 8080,
    });

    const result = await service.reconcileExisting(stale);

    expect(result).toBe(prepared);
    expect(db.update).not.toHaveBeenCalled();
    expect(dispatch.probeProxySecureLink).not.toHaveBeenCalled();
    expect(relayPolicy.ensureProxySecureLink).not.toHaveBeenCalled();
  });

  it('takes the production route and listener out of service before applying an active target candidate', async () => {
    const host = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'proxy',
      upstreamKind: 'docker_container',
      nodeId: 'nginx-node',
      dockerNodeId: 'docker-node',
      dockerContainerName: 'replacement',
      dockerContainerPort: 9090,
      dockerHostPort: 8080,
      forwardScheme: 'http',
      healthCheckUrl: '/',
      secureLinkGeneration: 4,
      secureLinkStatus: 'active',
      secureLinkMigratedAt: new Date(),
      secureLinkTargetNetwork: 'application-net',
      secureLinkTargetContainer: 'old-application',
      secureLinkTargetHost: null,
    } as any;
    const updatedValues: Array<Record<string, unknown>> = [];
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updatedValues.push(values);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
      query: {
        proxyHosts: {
          findFirst: vi.fn().mockResolvedValue({
            ...host,
            secureLinkStatus: 'updating',
            secureLinkListenerPort: 41002,
          }),
        },
      },
    } as any;
    const dispatch = { probeProxySecureLink: vi.fn().mockResolvedValue({ httpStatus: 200 }) } as any;
    const relayPolicy = {
      revokeOwner: vi.fn().mockResolvedValue(undefined),
      ensureProxySecureLink: vi.fn().mockResolvedValue(undefined),
    } as any;
    const service = new ProxySecureLinkService(db, dispatch, relayPolicy, 'connector@sha256:test');
    vi.spyOn(service as any, 'nodesSupportSecureLinks').mockResolvedValue(true);
    vi.spyOn(service as any, 'resolveTarget').mockResolvedValue({
      nodeId: 'docker-node',
      network: 'replacement-net',
      container: 'replacement',
      applicationPort: 9090,
      targetPort: 9090,
    });
    const syncSource = vi.spyOn(service as any, 'syncSourceNode').mockResolvedValue(undefined);
    const syncTarget = vi.spyOn(service as any, 'syncTargetNode').mockResolvedValue(undefined);

    await service.prepare(host, true);

    expect(updatedValues[0]).toEqual(expect.objectContaining({ secureLinkStatus: 'updating' }));
    expect(syncSource).toHaveBeenCalledWith('nginx-node', host.id);
    expect(relayPolicy.revokeOwner.mock.invocationCallOrder[0]).toBeLessThan(syncSource.mock.invocationCallOrder[0]);
    expect(syncSource.mock.invocationCallOrder[0]).toBeLessThan(syncTarget.mock.invocationCallOrder[0]);
    expect(syncTarget.mock.invocationCallOrder[0]).toBeLessThan(
      relayPolicy.ensureProxySecureLink.mock.invocationCallOrder[0]
    );
    expect(relayPolicy.ensureProxySecureLink.mock.invocationCallOrder[0]).toBeLessThan(
      dispatch.probeProxySecureLink.mock.invocationCallOrder[0]
    );
  });

  it('never restores legacy state after the no-fallback cutover marker is durable', async () => {
    const host = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'proxy',
      upstreamKind: 'docker_container',
      nodeId: 'nginx-node',
      dockerNodeId: 'docker-node',
      dockerContainerName: 'application',
      dockerContainerPort: 8080,
      dockerHostPort: 8080,
      secureLinkGeneration: 2,
      secureLinkStatus: 'provisioning',
      secureLinkMigratedAt: new Date(),
      secureLinkTargetNetwork: 'application-net',
      secureLinkTargetContainer: 'application',
      secureLinkTargetHost: null,
    } as any;
    const updatedValues: Array<Record<string, unknown>> = [];
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updatedValues.push(values);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    } as any;
    const relayPolicy = { revokeOwner: vi.fn() } as any;
    const service = new ProxySecureLinkService(db, {} as any, relayPolicy, 'connector@sha256:test');
    vi.spyOn(service as any, 'nodesSupportSecureLinks').mockResolvedValue(true);
    vi.spyOn(service as any, 'resolveTarget').mockResolvedValue({
      nodeId: 'docker-node',
      network: 'application-net',
      container: 'application',
      applicationPort: 8080,
      targetPort: 8080,
    });
    vi.spyOn(service as any, 'syncTargetNode').mockRejectedValue(new Error('docker unavailable'));

    await expect(service.prepare(host, false)).rejects.toThrow('docker unavailable');

    expect(updatedValues).not.toContainEqual(expect.objectContaining({ secureLinkGeneration: 0 }));
    expect(updatedValues).not.toContainEqual(expect.objectContaining({ secureLinkStatus: 'legacy' }));
    expect(relayPolicy.revokeOwner).not.toHaveBeenCalled();
  });

  it('restores the legacy endpoint when the end-to-end probe fails before cutover', async () => {
    const host = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'proxy',
      upstreamKind: 'docker_container',
      nodeId: 'nginx-node',
      dockerNodeId: 'docker-node',
      dockerContainerName: 'application',
      dockerContainerPort: 8080,
      dockerHostPort: 18080,
      dockerProtocol: 'tcp',
      dockerDeploymentId: null,
      forwardHost: '10.0.0.12',
      forwardPort: 18080,
      forwardScheme: 'http',
      healthCheckUrl: '/',
      secureLinkGeneration: 0,
      secureLinkStatus: 'legacy',
      secureLinkLastError: null,
      secureLinkTargetNetwork: null,
      secureLinkTargetContainer: null,
      secureLinkTargetHost: null,
      secureLinkListenerPort: null,
      secureLinkConnectorPort: null,
    } as any;
    const updatedValues: Array<Record<string, unknown>> = [];
    const desiredSets = [
      [{ ...host, secureLinkGeneration: 1, secureLinkTargetContainer: 'application', dockerHostPort: 8080 }],
      [{ ...host, secureLinkGeneration: 1, secureLinkTargetContainer: 'application', dockerHostPort: 8080 }],
      [],
      [],
    ];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([
            { id: 'nginx-node', capabilities: { capabilities: ['proxy_secure_links_v1'] } },
            { id: 'docker-node', capabilities: { capabilities: ['proxy_secure_links_v1'] } },
          ]),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updatedValues.push(values);
          return {
            where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: host.id }]) })),
          };
        }),
      })),
      query: {
        proxyHosts: {
          findMany: vi.fn(() => Promise.resolve(desiredSets.shift() ?? [])),
          findFirst: vi.fn().mockResolvedValue(host),
        },
      },
    } as any;
    const dispatch = {
      sendProxySecureLinks: vi.fn(async (_nodeId: string, bindings: Array<{ linkId: string; role: string }>) => ({
        success: true,
        detail: JSON.stringify({
          bindings: bindings.map((binding) => ({
            linkId: binding.linkId,
            generation: 1,
            port: binding.role === 'source' ? 41001 : 42001,
            ...(binding.role === 'target' ? { targetNetwork: 'application-net' } : {}),
          })),
        }),
      })),
      probeProxySecureLink: vi.fn().mockRejectedValue(new Error('relay unavailable')),
    } as any;
    const relayPolicy = {
      ensureProxySecureLink: vi.fn().mockResolvedValue(undefined),
      revokeOwner: vi.fn().mockResolvedValue(undefined),
    } as any;
    const service = new ProxySecureLinkService(
      db,
      dispatch,
      relayPolicy,
      `registry.example/gateway/secure-link-connector@sha256:${'a'.repeat(64)}`
    );

    const result = await service.prepare(host, false);

    expect(result).toBe(host);
    expect(relayPolicy.revokeOwner).toHaveBeenCalledWith('proxy_host_secure_link', host.id);
    expect(updatedValues).toContainEqual(
      expect.objectContaining({
        secureLinkStatus: 'legacy',
        secureLinkGeneration: 0,
        forwardHost: '10.0.0.12',
        forwardPort: 18080,
        dockerHostPort: 18080,
        secureLinkConnectorPort: null,
      })
    );
    expect(updatedValues).toContainEqual(expect.objectContaining({ secureLinkListenerPort: 41001 }));
    expect(updatedValues).not.toContainEqual(expect.objectContaining({ forwardHost: '127.0.0.1' }));
    expect(dispatch.sendProxySecureLinks).toHaveBeenCalledTimes(5);
    expect(dispatch.sendProxySecureLinks.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        generation: 1,
        targetNetwork: '',
        allowNetworkReselection: true,
      }),
    ]);
    expect(dispatch.sendProxySecureLinks.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({ generation: 2, targetNetwork: 'application-net' }),
    ]);
    expect(dispatch.sendProxySecureLinks.mock.calls[3]?.[1]).toEqual([]);
    expect(dispatch.sendProxySecureLinks.mock.calls[4]?.[1]).toEqual([]);
  });

  it('reloads the desired set instead of dispatching a stale network generation after a lost CAS', async () => {
    const baseHost = {
      id: '11111111-1111-4111-8111-111111111111',
      upstreamKind: 'docker_container',
      dockerNodeId: 'docker-node',
      dockerContainerPort: 8080,
      dockerHostPort: 8080,
      secureLinkGeneration: 1,
      secureLinkTargetNetwork: null,
      secureLinkTargetContainer: 'application',
      secureLinkTargetHost: null,
    } as any;
    const concurrentHost = {
      ...baseHost,
      secureLinkGeneration: 2,
      secureLinkTargetNetwork: 'concurrent-net',
      secureLinkTargetContainer: 'replacement',
    };
    const db = {
      query: {
        proxyHosts: {
          findMany: vi.fn().mockResolvedValueOnce([baseHost]).mockResolvedValueOnce([concurrentHost]),
        },
      },
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
        })),
      })),
    } as any;
    const dispatch = {
      sendProxySecureLinks: vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          detail: JSON.stringify({
            bindings: [{ linkId: baseHost.id, generation: 1, port: 42001, targetNetwork: 'discovered-net' }],
          }),
        })
        .mockResolvedValueOnce({
          success: true,
          detail: JSON.stringify({
            bindings: [{ linkId: baseHost.id, generation: 2, port: 42002, targetNetwork: 'concurrent-net' }],
          }),
        }),
    } as any;
    const service = new ProxySecureLinkService(
      db,
      dispatch,
      {} as any,
      `registry.example/gateway/secure-link-connector@sha256:${'a'.repeat(64)}`
    );

    await service.reconcileTargetNode('docker-node');

    expect(dispatch.sendProxySecureLinks).toHaveBeenCalledTimes(2);
    expect(dispatch.sendProxySecureLinks.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({
        generation: 2,
        targetNetwork: 'concurrent-net',
        targetContainer: 'replacement',
      }),
    ]);
    expect(dispatch.sendProxySecureLinks.mock.calls).not.toContainEqual([
      'docker-node',
      [expect.objectContaining({ generation: 2, targetNetwork: 'discovered-net' })],
    ]);
  });

  it('serializes source full-set snapshots per Nginx node', async () => {
    const firstHost = {
      id: '11111111-1111-4111-8111-111111111111',
      nodeId: 'nginx-node',
      upstreamKind: 'docker_container',
      secureLinkGeneration: 1,
      secureLinkListenerPort: 41001,
    } as any;
    const secondHost = {
      ...firstHost,
      id: '22222222-2222-4222-8222-222222222222',
      secureLinkListenerPort: 41002,
    };
    const additionalBinding = {
      id: '33333333-3333-4333-8333-333333333333',
      sourceNodeId: 'nginx-node',
      generation: 1,
      listenerPort: 41003,
      status: 'active',
    } as any;
    let releaseFirst!: (value: { success: true; detail: string }) => void;
    const firstDispatch = new Promise<{ success: true; detail: string }>((resolve) => {
      releaseFirst = resolve;
    });
    const db = {
      query: {
        proxyHosts: {
          findMany: vi.fn().mockResolvedValueOnce([firstHost]).mockResolvedValueOnce([firstHost, secondHost]),
        },
        proxyAdditionalSecureLinks: {
          findMany: vi.fn().mockResolvedValue([additionalBinding]),
        },
      },
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      })),
    } as any;
    const dispatch = {
      sendProxySecureLinks: vi
        .fn()
        .mockReturnValueOnce(firstDispatch)
        .mockImplementationOnce(async (_nodeId: string, bindings: Array<{ linkId: string; generation: number }>) => ({
          success: true,
          detail: JSON.stringify({
            bindings: bindings.map((binding, index) => ({ ...binding, port: 41001 + index })),
          }),
        })),
    } as any;
    const service = new ProxySecureLinkService(db, dispatch, {} as any, 'connector@sha256:test');

    const firstSync = (service as any).syncSourceNode('nginx-node');
    await vi.waitFor(() => expect(dispatch.sendProxySecureLinks).toHaveBeenCalledTimes(1));
    const secondSync = (service as any).syncSourceNode('nginx-node');
    await Promise.resolve();

    expect(dispatch.sendProxySecureLinks).toHaveBeenCalledTimes(1);
    releaseFirst({
      success: true,
      detail: JSON.stringify({ bindings: [{ linkId: firstHost.id, generation: 1, port: 41001 }] }),
    });
    await Promise.all([firstSync, secondSync]);

    expect(dispatch.sendProxySecureLinks).toHaveBeenCalledTimes(2);
    expect(dispatch.sendProxySecureLinks.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({ linkId: firstHost.id }),
      expect.objectContaining({ linkId: secondHost.id }),
      expect.objectContaining({ linkId: additionalBinding.id, sourceConfigManaged: false }),
    ]);
  });

  it('sends default and additional bindings in one target desired-state snapshot', async () => {
    const defaultHost = {
      id: '11111111-1111-4111-8111-111111111111',
      secureLinkGeneration: 2,
      secureLinkTargetNetwork: 'app-net',
      secureLinkTargetContainer: 'frontend',
      secureLinkTargetHost: null,
      dockerHostPort: 8080,
      upstreamKind: 'docker_container',
    } as any;
    const additionalBinding = {
      id: '22222222-2222-4222-8222-222222222222',
      generation: 1,
      targetNetwork: 'app-net',
      targetContainer: 'api',
      dockerHostPort: 9000,
      upstreamKind: 'docker_container',
    } as any;
    const db = {
      query: {
        proxyHosts: { findMany: vi.fn().mockResolvedValue([defaultHost]) },
        proxyAdditionalSecureLinks: { findMany: vi.fn().mockResolvedValue([additionalBinding]) },
      },
    } as any;
    const dispatch = {
      sendProxySecureLinks: vi.fn().mockResolvedValue({ success: true, detail: '{"bindings":[]}' }),
    } as any;
    const service = new ProxySecureLinkService(db, dispatch, {} as any, 'connector@sha256:test');

    await service.reconcileTargetNode('docker-node');

    expect(dispatch.sendProxySecureLinks).toHaveBeenCalledWith('docker-node', [
      expect.objectContaining({ linkId: defaultHost.id, targetContainer: 'frontend' }),
      expect.objectContaining({ linkId: additionalBinding.id, targetContainer: 'api' }),
    ]);
  });

  it('keeps a durable cleanup marker when teardown fails', async () => {
    const host = {
      id: '11111111-1111-4111-8111-111111111111',
      nodeId: 'nginx-node',
      dockerNodeId: 'docker-node',
      secureLinkGeneration: 4,
    } as any;
    const updatedValues: Array<Record<string, unknown>> = [];
    const db = {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(host) } },
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updatedValues.push(values);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    } as any;
    const relayPolicy = {
      revokeOwner: vi.fn().mockRejectedValue(new Error('relay unavailable')),
    } as any;
    const dispatch = { sendProxySecureLinks: vi.fn() } as any;
    const service = new ProxySecureLinkService(db, dispatch, relayPolicy, 'connector@sha256:test');

    await expect(service.cleanup(host)).rejects.toThrow('relay unavailable');

    expect(updatedValues[0]).toEqual(
      expect.objectContaining({ dockerNodeId: 'docker-node', secureLinkStatus: 'cleanup_pending' })
    );
    expect(updatedValues.at(-1)).toEqual(
      expect.objectContaining({ secureLinkStatus: 'cleanup_pending', secureLinkLastError: 'relay unavailable' })
    );
    expect(updatedValues).not.toContainEqual(expect.objectContaining({ secureLinkGeneration: 0 }));
    expect(dispatch.sendProxySecureLinks).not.toHaveBeenCalled();
  });

  it('serializes a cleanup retry before a new lifecycle prepare for the same link', async () => {
    const oldHost = {
      id: '11111111-1111-4111-8111-111111111111',
      secureLinkGeneration: 4,
    } as any;
    const newHost = { ...oldHost, upstreamKind: 'docker_container', secureLinkStatus: 'cleanup_pending' } as any;
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const service = new ProxySecureLinkService({} as any, {} as any, {} as any, 'connector@sha256:test');
    const events: string[] = [];
    const cleanupLocked = vi.spyOn(service as any, 'cleanupLocked').mockImplementation(async () => {
      events.push('cleanup:start');
      await cleanupGate;
      events.push('cleanup:end');
    });
    const prepareLocked = vi.spyOn(service as any, 'prepareLocked').mockImplementation(async () => {
      events.push('prepare');
      return newHost;
    });

    const cleanup = service.cleanup(oldHost);
    await vi.waitFor(() => expect(cleanupLocked).toHaveBeenCalledOnce());
    const prepare = service.prepare(newHost, true);
    await Promise.resolve();

    expect(prepareLocked).not.toHaveBeenCalled();
    releaseCleanup();
    await Promise.all([cleanup, prepare]);
    expect(events).toEqual(['cleanup:start', 'cleanup:end', 'prepare']);
  });

  it('does not let a stale cleanup revoke a newer link generation', async () => {
    const staleHost = {
      id: '11111111-1111-4111-8111-111111111111',
      secureLinkGeneration: 4,
    } as any;
    const db = {
      query: {
        proxyHosts: {
          findFirst: vi.fn().mockResolvedValue({ ...staleHost, secureLinkGeneration: 5, secureLinkStatus: 'active' }),
        },
      },
      update: vi.fn(),
    } as any;
    const relayPolicy = { revokeOwner: vi.fn() } as any;
    const dispatch = { sendProxySecureLinks: vi.fn() } as any;
    const service = new ProxySecureLinkService(db, dispatch, relayPolicy, 'connector@sha256:test');

    await service.cleanup(staleHost);

    expect(db.update).not.toHaveBeenCalled();
    expect(relayPolicy.revokeOwner).not.toHaveBeenCalled();
    expect(dispatch.sendProxySecureLinks).not.toHaveBeenCalled();
  });

  it('uses retained target-node provenance when retrying cleanup after manual cutover', async () => {
    const host = {
      id: '11111111-1111-4111-8111-111111111111',
      upstreamKind: 'manual',
      nodeId: 'nginx-node',
      dockerNodeId: 'docker-node',
      secureLinkGeneration: 4,
      secureLinkStatus: 'cleanup_pending',
    } as any;
    const updatedValues: Array<Record<string, unknown>> = [];
    const db = {
      query: {
        proxyHosts: {
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi.fn().mockResolvedValue(host),
        },
      },
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updatedValues.push(values);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    } as any;
    const dispatch = {
      sendProxySecureLinks: vi.fn().mockResolvedValue({ success: true, detail: '{"bindings":[]}' }),
    } as any;
    const relayPolicy = { revokeOwner: vi.fn().mockResolvedValue(undefined) } as any;
    const service = new ProxySecureLinkService(db, dispatch, relayPolicy, 'connector@sha256:test');

    await service.cleanup(host);

    expect(dispatch.sendProxySecureLinks).toHaveBeenCalledWith('nginx-node', []);
    expect(dispatch.sendProxySecureLinks).toHaveBeenCalledWith('docker-node', []);
    expect(updatedValues.at(-1)).toEqual(
      expect.objectContaining({ dockerNodeId: null, secureLinkGeneration: 0, secureLinkStatus: 'legacy' })
    );
  });
});
