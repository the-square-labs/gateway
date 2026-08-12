import { describe, expect, it, vi } from 'vitest';
import { ProxyService } from './proxy.service.js';

vi.mock('@/db/schema/access-lists.js', () => ({ accessLists: { id: 'access_lists.id' } }));
vi.mock('@/db/schema/certificates.js', () => ({ certificates: { id: 'certificates.id' } }));
vi.mock('@/db/schema/ssl-certificates.js', () => ({ sslCertificates: { id: 'ssl_certificates.id' } }));
vi.mock('@/db/schema/index.js', () => ({
  nodes: {
    id: 'nodes.id',
    hostname: 'nodes.hostname',
    displayName: 'nodes.display_name',
    status: 'nodes.status',
  },
  proxyHosts: {
    id: 'proxy_hosts.id',
    enabled: 'proxy_hosts.enabled',
    isSystem: 'proxy_hosts.is_system',
    nodeId: 'proxy_hosts.node_id',
    upstreamKind: 'proxy_hosts.upstream_kind',
    secureLinkStatus: 'proxy_hosts.secure_link_status',
    type: 'proxy_hosts.type',
  },
}));

function makeActiveSecureHost(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'proxy',
    domainNames: ['example.com'],
    slug: 'example-com',
    enabled: true,
    isSystem: false,
    nodeId: 'nginx-node',
    upstreamKind: 'docker_container',
    dockerNodeId: 'docker-a',
    dockerContainerName: 'application',
    dockerDeploymentId: null,
    dockerContainerPort: 8080,
    dockerHostPort: 8080,
    dockerProtocol: 'tcp',
    forwardHost: '127.0.0.1',
    forwardPort: 41001,
    forwardScheme: 'http',
    secureLinkGeneration: 1,
    secureLinkStatus: 'active',
    secureLinkLastError: null,
    secureLinkTargetNetwork: 'application-net',
    secureLinkTargetContainer: 'application',
    secureLinkTargetHost: null,
    secureLinkListenerPort: 41001,
    secureLinkConnectorPort: 42001,
    secureLinkMigratedAt: new Date(),
    sslEnabled: false,
    sslForced: false,
    http2Support: true,
    websocketSupport: true,
    sslCertificateId: null,
    internalCertificateId: null,
    redirectUrl: null,
    redirectStatusCode: 301,
    customHeaders: [],
    cacheEnabled: false,
    cacheOptions: null,
    rateLimitEnabled: false,
    rateLimitOptions: null,
    customRewrites: [],
    advancedConfig: null,
    rawConfig: null,
    rawConfigEnabled: false,
    accessListId: null,
    nginxTemplateId: null,
    templateVariables: {},
    maintenanceEnabled: false,
    healthCheckEnabled: false,
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  } as any;
}

describe('ProxyService legacy Docker link compatibility', () => {
  it('returns cached Link Runtime telemetry without waiting for a focused live sample', async () => {
    const runtime = {
      routeId: 'route-1',
      activeStreams: 1,
      openedTotal: '3',
      completedTotal: '2',
      failedTotal: '0',
      throttledTotal: '0',
      sourceToTargetBytes: '100',
      targetToSourceBytes: '200',
      setupLatencyP95Ms: 1,
      averageDurationMs: 2,
      lastActivityAt: '2026-08-12T00:00:00.000Z',
      metricsSince: '2026-08-11T23:00:00.000Z',
    };
    const history = [{ timestamp: '2026-08-12T00:00:00.000Z', runtime, traffic: null }];
    const host = makeActiveSecureHost();
    const db = {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(host) } },
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: 'nginx-node', hostname: 'nginx', displayName: null, status: 'online' },
            { id: 'docker-a', hostname: 'docker', displayName: null, status: 'online' },
          ]),
        }),
      }),
    } as any;
    const cache = { get: vi.fn().mockResolvedValue(history), set: vi.fn().mockResolvedValue(undefined) };
    const service = new ProxyService(
      db,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      cache as any
    );
    const focusedSample = new Promise(() => undefined);
    const sample = vi.spyOn(service as any, 'sampleSecureLinkRuntime').mockReturnValue(focusedSample);

    const status = await service.getProxySecureLinkStatus(host.id);

    expect(status.runtime).toEqual(runtime);
    expect(status.history).toEqual(history);
    expect(cache.get).toHaveBeenCalledWith(`proxy-secure-link-runtime:${host.id}`);
    expect(sample).toHaveBeenCalledWith(host, 10_000);
  });

  it('collects runtime history in the background and coalesces overlapping rounds', async () => {
    let releaseRuntime!: (value: Record<string, unknown>) => void;
    const runtimePending = new Promise<Record<string, unknown>>((resolve) => {
      releaseRuntime = resolve;
    });
    const findMany = vi.fn().mockResolvedValue([{ id: 'host-1', nodeId: 'nginx-node' }]);
    const getRuntime = vi.fn().mockReturnValue(runtimePending);
    const requestTrafficStats = vi.fn().mockResolvedValue({ success: true, detail: null });
    const service = new ProxyService(
      { query: { proxyHosts: { findMany } } } as any,
      {} as any,
      {} as any,
      {} as any,
      { requestTrafficStats } as any,
      {} as any,
      {} as any,
      { getRuntime } as any
    );

    const first = service.collectSecureLinkRuntimeSnapshots();
    const overlapping = service.collectSecureLinkRuntimeSnapshots();

    expect(overlapping).toBe(first);
    await vi.waitFor(() => expect(getRuntime).toHaveBeenCalledOnce());
    expect(findMany).toHaveBeenCalledOnce();
    expect(getRuntime).toHaveBeenCalledOnce();
    expect(requestTrafficStats).toHaveBeenCalledWith('nginx-node', 200, {
      hostId: 'host-1',
      windowSeconds: 15,
    });

    releaseRuntime({
      routeId: 'route-1',
      activeStreams: 0,
      openedTotal: '0',
      completedTotal: '0',
      failedTotal: '0',
      throttledTotal: '0',
      sourceToTargetBytes: '0',
      targetToSourceBytes: '0',
      setupLatencyP95Ms: 0,
      averageDurationMs: 0,
      lastActivityAt: null,
      metricsSince: '2026-08-11T11:00:00.000Z',
    });
    await first;

    expect((service as any).secureLinkRuntimeHistory.get('host-1')).toHaveLength(1);
  });

  it('does not compete with Docker reconciliation for daemon telemetry commands', async () => {
    const findMany = vi.fn();
    const service = new ProxyService(
      { query: { proxyHosts: { findMany } } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    (service as any).dockerReconcileRunning = true;

    await service.collectSecureLinkRuntimeSnapshots();

    expect(findMany).not.toHaveBeenCalled();
  });

  it('keeps a bounded backend runtime history and resets it on a Relay epoch change', () => {
    const service = new ProxyService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const runtime = (metricsSince: string, openedTotal: string) => ({
      routeId: 'route-1',
      activeStreams: 0,
      openedTotal,
      completedTotal: openedTotal,
      failedTotal: '0',
      throttledTotal: '0',
      sourceToTargetBytes: '100',
      targetToSourceBytes: '200',
      setupLatencyP95Ms: 1,
      averageDurationMs: 2,
      lastActivityAt: null,
      metricsSince,
    });
    const record = (service as any).recordSecureLinkRuntimeSnapshot.bind(service);

    expect(
      record('host-1', {
        timestamp: '2026-08-11T12:00:00.000Z',
        runtime: runtime('2026-08-11T11:00:00.000Z', '1'),
        traffic: null,
      })
    ).toHaveLength(1);
    expect(
      record('host-1', {
        timestamp: '2026-08-11T12:00:00.250Z',
        runtime: runtime('2026-08-11T11:00:00.000Z', '2'),
        traffic: null,
      })
    ).toMatchObject([{ runtime: { openedTotal: '2' } }]);
    expect(
      record('host-1', {
        timestamp: '2026-08-11T12:00:02.000Z',
        runtime: runtime('2026-08-11T11:00:00.000Z', '3'),
        traffic: null,
      })
    ).toHaveLength(2);
    expect(
      record('host-1', {
        timestamp: '2026-08-11T12:00:05.000Z',
        runtime: runtime('2026-08-11T11:00:00.000Z', '4'),
        traffic: null,
      })
    ).toHaveLength(3);
    expect(
      record('host-1', {
        timestamp: '2026-08-11T12:00:10.000Z',
        runtime: runtime('2026-08-11T12:00:09.000Z', '0'),
        traffic: null,
      })
    ).toHaveLength(1);
  });

  it('does not restore a stale legacy upstream when node resync races Secure Link cutover', async () => {
    const active = makeActiveSecureHost();
    const staleLegacy = makeActiveSecureHost({
      forwardHost: '10.0.0.12',
      forwardPort: 18080,
      secureLinkGeneration: 0,
      secureLinkStatus: 'legacy',
      secureLinkListenerPort: null,
      secureLinkConnectorPort: null,
      secureLinkMigratedAt: null,
    });
    const db = {
      query: {
        proxyHosts: {
          findMany: vi.fn().mockResolvedValue([staleLegacy]),
          findFirst: vi.fn().mockResolvedValue(active),
        },
      },
    } as any;
    const renderForHost = vi.fn().mockResolvedValue('secure config');
    const applyConfig = vi.fn().mockResolvedValue({ success: true });
    const service = new ProxyService(
      db,
      { renderForHost } as any,
      { log: vi.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      { resolveNodeId: vi.fn().mockResolvedValue('nginx-node'), applyConfig } as any,
      { supportsNode: vi.fn().mockResolvedValue(true) } as any,
      { resolve: vi.fn().mockRejectedValue(new Error('stale reconciliation')) } as any,
      {} as any
    );

    await service.resyncAllHostsOnNode('nginx-node');

    expect(renderForHost).toHaveBeenCalledWith(
      expect.objectContaining({
        forwardHost: '127.0.0.1',
        forwardPort: active.secureLinkListenerPort,
        secureLinkUpstream: true,
      }),
      null
    );
    expect(applyConfig).toHaveBeenCalledWith('nginx-node', active.id, 'secure config', false, 'managed_secure_link');
  });

  it('does not replace the legacy endpoint when a complete edit form repeats the same Docker target', async () => {
    const resolve = vi.fn();
    const service = new ProxyService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { resolve } as any,
      {} as any
    );
    const existing = {
      type: 'proxy',
      upstreamKind: 'docker_container',
      dockerNodeId: 'docker-node',
      dockerContainerName: 'application',
      dockerDeploymentId: null,
      dockerContainerPort: 8080,
      dockerHostPort: 18080,
      dockerProtocol: 'tcp',
      forwardHost: '10.0.0.12',
      forwardPort: 18080,
      secureLinkGeneration: 0,
    } as any;

    const result = await (service as any).prepareUpdateUpstream(
      existing,
      {
        upstreamKind: 'docker_container',
        dockerNodeId: 'docker-node',
        dockerContainerName: 'application',
        dockerDeploymentId: null,
        dockerContainerPort: 8080,
        dockerHostPort: null,
        dockerProtocol: 'tcp',
        forwardHost: null,
        forwardPort: null,
      },
      {}
    );

    expect(result).toEqual({});
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps the legacy endpoint durable when a Docker target change is staged', async () => {
    const resolve = vi.fn().mockResolvedValue({
      upstreamKind: 'docker_container',
      forwardHost: '127.0.0.1',
      forwardPort: 1,
      dockerNodeId: 'docker-node',
      dockerContainerName: 'replacement',
      dockerDeploymentId: null,
      dockerContainerPort: 9090,
      dockerHostPort: null,
      dockerProtocol: 'tcp',
    });
    const service = new ProxyService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { resolve } as any,
      {} as any
    );
    const existing = makeActiveSecureHost({
      forwardHost: '10.0.0.12',
      forwardPort: 18080,
      secureLinkGeneration: 0,
      secureLinkStatus: 'legacy',
    });

    const result = await (service as any).prepareUpdateUpstream(
      existing,
      { dockerContainerName: 'replacement', dockerContainerPort: 9090 },
      {}
    );

    expect(result).toEqual(
      expect.objectContaining({
        dockerContainerName: 'replacement',
        dockerContainerPort: 9090,
      })
    );
    expect(result).not.toHaveProperty('forwardHost');
    expect(result).not.toHaveProperty('forwardPort');
  });

  it('applies raw config before tearing down the dormant Docker Secure Link', async () => {
    const existing = makeActiveSecureHost();
    const rawConfig = 'server { listen 80; location / { proxy_pass http://127.0.0.1:9000; } }';
    const updated = { ...existing, rawConfigEnabled: true, rawConfig, healthCheckEnabled: false };
    const db = {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(existing) } },
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([updated]) })) })),
      })),
    } as any;
    const secureLinks = {
      prepare: vi.fn(),
      activate: vi.fn(),
      cleanup: vi.fn().mockResolvedValue(undefined),
    } as any;
    const applyConfig = vi.fn().mockResolvedValue({ success: true });
    const service = new ProxyService(
      db,
      { renderForHost: vi.fn() } as any,
      { log: vi.fn().mockResolvedValue(undefined) } as any,
      { validateAdvancedConfig: vi.fn().mockReturnValue({ valid: true, errors: [] }) } as any,
      { resolveNodeId: vi.fn().mockResolvedValue('nginx-node'), applyConfig } as any,
      {} as any,
      undefined,
      secureLinks
    );

    await service.updateProxyHost(existing.id, { rawConfigEnabled: true, rawConfig } as any, 'user-id');

    expect(secureLinks.prepare).not.toHaveBeenCalled();
    expect(secureLinks.activate).not.toHaveBeenCalled();
    expect(applyConfig).toHaveBeenCalledWith('nginx-node', existing.id, rawConfig, false, 'user_owned');
    expect(applyConfig.mock.invocationCallOrder[0]).toBeLessThan(secureLinks.cleanup.mock.invocationCallOrder[0]);
  });

  it('tears down a Secure Link left active by a crash after raw cutover', async () => {
    const raw = makeActiveSecureHost({ rawConfigEnabled: true, rawConfig: 'server {}', healthCheckEnabled: false });
    const db = {
      query: { proxyHosts: { findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([raw]) } },
    } as any;
    const secureLinks = { cleanup: vi.fn().mockResolvedValue(undefined) } as any;
    const dockerUpstreams = { resolve: vi.fn() } as any;
    const service = new ProxyService(
      db,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      dockerUpstreams,
      secureLinks
    );

    await (service as any).reconcileDockerUpstreams();

    expect(secureLinks.cleanup).toHaveBeenCalledWith(raw);
    expect(dockerUpstreams.resolve).not.toHaveBeenCalled();
  });

  it('does not force an E2E probe for an unchanged active link on a Docker snapshot', async () => {
    const active = makeActiveSecureHost();
    const db = {
      query: { proxyHosts: { findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([active]) } },
    } as any;
    const dockerUpstreams = {
      resolve: vi.fn().mockResolvedValue({
        upstreamKind: active.upstreamKind,
        dockerNodeId: active.dockerNodeId,
        dockerContainerName: active.dockerContainerName,
        dockerDeploymentId: active.dockerDeploymentId,
        dockerContainerPort: active.dockerContainerPort,
        dockerProtocol: active.dockerProtocol,
      }),
    } as any;
    const secureLinks = { reconcileExisting: vi.fn() } as any;
    const service = new ProxyService(
      db,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      dockerUpstreams,
      secureLinks
    );

    await (service as any).reconcileDockerUpstreams(false);

    expect(dockerUpstreams.resolve).toHaveBeenCalledWith(active, { allowPortRebind: true });
    expect(secureLinks.reconcileExisting).not.toHaveBeenCalled();
  });

  it('resumes an unchanged provisioning cutover after a Gateway restart', async () => {
    const provisioning = makeActiveSecureHost({
      forwardHost: '10.0.0.12',
      forwardPort: 18080,
      secureLinkStatus: 'provisioning',
      secureLinkMigratedAt: null,
    });
    const db = {
      query: {
        proxyHosts: {
          findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([provisioning]),
          findFirst: vi.fn().mockResolvedValue({
            ...provisioning,
            secureLinkStatus: 'cutover_ready',
            secureLinkMigratedAt: new Date(),
          }),
        },
      },
    } as any;
    const dockerUpstreams = {
      resolve: vi.fn().mockResolvedValue({
        upstreamKind: provisioning.upstreamKind,
        dockerNodeId: provisioning.dockerNodeId,
        dockerContainerName: provisioning.dockerContainerName,
        dockerDeploymentId: provisioning.dockerDeploymentId,
        dockerContainerPort: provisioning.dockerContainerPort,
        dockerProtocol: provisioning.dockerProtocol,
      }),
    } as any;
    const secureLinks = {
      reconcileExisting: vi.fn().mockResolvedValue({ ...provisioning, secureLinkStatus: 'cutover_ready' }),
      commitCutover: vi.fn().mockResolvedValue(undefined),
      activate: vi.fn().mockResolvedValue(undefined),
    } as any;
    const applyConfig = vi.fn().mockResolvedValue({ success: true });
    const renderForHost = vi.fn().mockResolvedValue('secure config');
    const service = new ProxyService(
      db,
      { renderForHost } as any,
      { log: vi.fn() } as any,
      { validateAdvancedConfig: vi.fn() } as any,
      { resolveNodeId: vi.fn().mockResolvedValue('nginx-node'), applyConfig } as any,
      {} as any,
      dockerUpstreams,
      secureLinks
    );

    await (service as any).reconcileDockerUpstreams();

    expect(applyConfig).toHaveBeenCalledOnce();
    expect(secureLinks.activate).toHaveBeenCalledWith(provisioning.id);
    expect(renderForHost).toHaveBeenCalledWith(
      expect.objectContaining({
        forwardHost: '127.0.0.1',
        forwardPort: provisioning.secureLinkListenerPort,
        secureLinkUpstream: true,
      }),
      null
    );
  });

  it('retires the former Docker node only after a successful secure-link cutover', async () => {
    const existing = makeActiveSecureHost();
    const updated = { ...existing, dockerNodeId: 'docker-b', updatedAt: new Date('2026-08-02T00:00:00Z') };
    const prepared = {
      ...updated,
      secureLinkGeneration: 2,
      secureLinkTargetNetwork: 'replacement-net',
      secureLinkConnectorPort: 42002,
    };
    const db = {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(existing) } },
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([updated]) })) })),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ id: 'docker-b', appearanceColor: null }]),
        })),
      })),
    } as any;
    const dockerUpstreams = {
      resolve: vi.fn().mockResolvedValue({
        upstreamKind: 'docker_container',
        dockerNodeId: 'docker-b',
        dockerContainerName: 'application',
        dockerDeploymentId: null,
        dockerContainerPort: 8080,
        dockerHostPort: 8080,
        dockerProtocol: 'tcp',
      }),
    } as any;
    const secureLinks = {
      prepare: vi.fn().mockResolvedValue(prepared),
      activate: vi.fn().mockResolvedValue(undefined),
      reconcileTargetNode: vi.fn().mockResolvedValue(undefined),
    } as any;
    const service = new ProxyService(
      db,
      { renderForHost: vi.fn().mockResolvedValue('secure config') } as any,
      { log: vi.fn().mockResolvedValue(undefined) } as any,
      { validateAdvancedConfig: vi.fn() } as any,
      {
        resolveNodeId: vi.fn().mockResolvedValue('nginx-node'),
        applyConfig: vi.fn().mockResolvedValue({ success: true }),
      } as any,
      {} as any,
      dockerUpstreams,
      secureLinks
    );

    await service.updateProxyHost(
      existing.id,
      { dockerNodeId: 'docker-b', dockerContainerName: 'application', dockerContainerPort: 8080 } as any,
      '33333333-3333-4333-8333-333333333333'
    );

    expect(secureLinks.activate).toHaveBeenCalledWith(existing.id);
    expect(secureLinks.reconcileTargetNode).toHaveBeenCalledWith('docker-a');
    expect(secureLinks.activate.mock.invocationCallOrder[0]).toBeLessThan(
      secureLinks.reconcileTargetNode.mock.invocationCallOrder[0]
    );
  });

  it('restores an active same-node target with a generation newer than the failed candidate', async () => {
    const existing = makeActiveSecureHost();
    const updated = {
      ...existing,
      dockerContainerName: 'replacement',
      secureLinkTargetContainer: 'replacement',
      updatedAt: new Date('2026-08-02T00:00:00Z'),
    };
    const candidate = { ...updated, secureLinkGeneration: 2, secureLinkConnectorPort: 42002 };
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(existing) } },
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          writes.push(values);
          return { where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([updated]) })) };
        }),
      })),
    } as any;
    const dockerUpstreams = {
      resolve: vi.fn().mockResolvedValue({
        upstreamKind: 'docker_container',
        dockerNodeId: existing.dockerNodeId,
        dockerContainerName: 'replacement',
        dockerDeploymentId: null,
        dockerContainerPort: 8080,
        dockerHostPort: 8080,
        dockerProtocol: 'tcp',
      }),
    } as any;
    const secureLinks = {
      prepare: vi.fn().mockResolvedValue(candidate),
      reconcileExisting: vi.fn().mockResolvedValue(existing),
    } as any;
    const service = new ProxyService(
      db,
      { renderForHost: vi.fn().mockResolvedValue('candidate config') } as any,
      { log: vi.fn().mockResolvedValue(undefined) } as any,
      { validateAdvancedConfig: vi.fn() } as any,
      {
        resolveNodeId: vi.fn().mockResolvedValue('nginx-node'),
        applyConfig: vi.fn().mockResolvedValue({ success: false, error: 'reload failed' }),
      } as any,
      {} as any,
      dockerUpstreams,
      secureLinks
    );

    await expect(
      service.updateProxyHost(
        existing.id,
        { dockerContainerName: 'replacement', dockerContainerPort: 8080 } as any,
        '33333333-3333-4333-8333-333333333333'
      )
    ).rejects.toMatchObject({ code: 'NGINX_CONFIG_FAILED' });

    expect(writes.at(-1)).toEqual(
      expect.objectContaining({
        dockerContainerName: 'application',
        secureLinkTargetContainer: 'application',
        secureLinkGeneration: 3,
      })
    );
    expect(secureLinks.reconcileExisting).toHaveBeenCalledWith(
      expect.objectContaining({
        dockerContainerName: 'application',
        secureLinkTargetContainer: 'application',
        secureLinkGeneration: 3,
      })
    );
  });

  it('keeps the active Secure Link intact when Docker-to-manual config apply fails', async () => {
    const existing = makeActiveSecureHost();
    const updated = {
      ...existing,
      upstreamKind: 'manual',
      forwardHost: 'manual.internal',
      forwardPort: 9000,
      dockerNodeId: null,
      dockerContainerName: null,
      dockerContainerPort: null,
      dockerHostPort: null,
      dockerProtocol: null,
    };
    const db = {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(existing) } },
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([updated]) })) })),
      })),
    } as any;
    const secureLinks = {
      cleanup: vi.fn().mockResolvedValue(undefined),
      reconcileExisting: vi.fn().mockResolvedValue(existing),
    } as any;
    const applyConfig = vi.fn().mockResolvedValue({ success: false, error: 'reload failed' });
    const service = new ProxyService(
      db,
      { renderForHost: vi.fn().mockResolvedValue('manual config') } as any,
      { log: vi.fn().mockResolvedValue(undefined) } as any,
      { validateAdvancedConfig: vi.fn() } as any,
      { resolveNodeId: vi.fn().mockResolvedValue('nginx-node'), applyConfig } as any,
      {} as any,
      undefined,
      secureLinks
    );

    await expect(
      service.updateProxyHost(
        existing.id,
        { upstreamKind: 'manual', forwardHost: 'manual.internal', forwardPort: 9000 } as any,
        '33333333-3333-4333-8333-333333333333'
      )
    ).rejects.toMatchObject({ code: 'NGINX_CONFIG_FAILED' });

    expect(applyConfig).toHaveBeenCalledOnce();
    expect(secureLinks.cleanup).not.toHaveBeenCalled();
    expect(secureLinks.reconcileExisting).toHaveBeenCalled();
  });

  it('cleans the former Secure Link only after Docker-to-manual config apply succeeds', async () => {
    const existing = makeActiveSecureHost();
    const updated = {
      ...existing,
      upstreamKind: 'manual',
      forwardHost: 'manual.internal',
      forwardPort: 9000,
      dockerNodeId: null,
      dockerContainerName: null,
      dockerDeploymentId: null,
      dockerContainerPort: null,
      dockerHostPort: null,
      dockerProtocol: null,
    };
    const db = {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(existing) } },
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([updated]) })) })),
      })),
    } as any;
    const secureLinks = { cleanup: vi.fn().mockResolvedValue(undefined) } as any;
    const applyConfig = vi.fn().mockResolvedValue({ success: true });
    const service = new ProxyService(
      db,
      { renderForHost: vi.fn().mockResolvedValue('manual config') } as any,
      { log: vi.fn().mockResolvedValue(undefined) } as any,
      { validateAdvancedConfig: vi.fn() } as any,
      { resolveNodeId: vi.fn().mockResolvedValue('nginx-node'), applyConfig } as any,
      {} as any,
      undefined,
      secureLinks
    );

    await service.updateProxyHost(
      existing.id,
      { upstreamKind: 'manual', forwardHost: 'manual.internal', forwardPort: 9000 } as any,
      '33333333-3333-4333-8333-333333333333'
    );

    expect(secureLinks.cleanup).toHaveBeenCalledWith(existing);
    expect(applyConfig.mock.invocationCallOrder[0]).toBeLessThan(secureLinks.cleanup.mock.invocationCallOrder[0]);
  });

  it('keeps the committed manual config and queues durable cleanup retry when teardown fails', async () => {
    const existing = makeActiveSecureHost();
    const updated = {
      ...existing,
      upstreamKind: 'manual',
      forwardHost: 'manual.internal',
      forwardPort: 9000,
      dockerNodeId: null,
      dockerContainerName: null,
      dockerDeploymentId: null,
      dockerContainerPort: null,
      dockerHostPort: null,
      dockerProtocol: null,
    };
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(existing) } },
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          writes.push(values);
          return { where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([updated]) })) };
        }),
      })),
    } as any;
    const secureLinks = {
      cleanup: vi.fn().mockRejectedValue(new Error('relay unavailable')),
      reconcileExisting: vi.fn(),
    } as any;
    const applyConfig = vi.fn().mockResolvedValue({ success: true });
    const service = new ProxyService(
      db,
      { renderForHost: vi.fn().mockResolvedValue('manual config') } as any,
      { log: vi.fn().mockResolvedValue(undefined) } as any,
      { validateAdvancedConfig: vi.fn() } as any,
      { resolveNodeId: vi.fn().mockResolvedValue('nginx-node'), applyConfig } as any,
      {} as any,
      undefined,
      secureLinks
    );
    const queueRetry = vi.spyOn(service as any, 'queueDockerReconciliation').mockImplementation(() => undefined);

    const result = await service.updateProxyHost(
      existing.id,
      { upstreamKind: 'manual', forwardHost: 'manual.internal', forwardPort: 9000 } as any,
      '33333333-3333-4333-8333-333333333333'
    );

    expect(result.upstreamKind).toBe('manual');
    expect(applyConfig).toHaveBeenCalledOnce();
    expect(secureLinks.cleanup).toHaveBeenCalledWith(existing);
    expect(queueRetry).toHaveBeenCalledOnce();
    expect(secureLinks.reconcileExisting).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
  });
});
