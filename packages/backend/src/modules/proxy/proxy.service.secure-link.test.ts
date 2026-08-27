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
    nginxTemplateId: 'proxy_hosts.nginx_template_id',
    upstreamKind: 'proxy_hosts.upstream_kind',
    secureLinkStatus: 'proxy_hosts.secure_link_status',
    type: 'proxy_hosts.type',
  },
  proxyAdditionalSecureLinks: {
    status: 'proxy_additional_secure_links.status',
  },
}));

describe('ProxyService Nginx template reconciliation', () => {
  it('regenerates every enabled route using an updated template and isolates failures', async () => {
    const db = {
      query: {
        proxyHosts: {
          findMany: vi.fn().mockResolvedValue([
            { id: 'host-1', nodeId: 'node-1' },
            { id: 'host-2', nodeId: 'node-2' },
          ]),
        },
      },
    } as any;
    const service = new ProxyService(db, {} as any, {} as any, {} as any, {} as any, {} as any);
    const reconcile = vi
      .spyOn(service, 'reconcileAdditionalRouteHost')
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('node offline'));

    const result = await service.reconcileTemplateHosts('template-1');

    expect(reconcile).toHaveBeenNthCalledWith(1, 'host-1');
    expect(reconcile).toHaveBeenNthCalledWith(2, 'host-2');
    expect(result).toEqual({ total: 2, succeeded: 1, failed: 1 });
  });

  it('starts route reconciliation when template rendering changes', async () => {
    const subscriptions = new Map<string, (payload: unknown) => void>();
    const bus = {
      subscribe: vi.fn((channel: string, handler: (payload: unknown) => void) => {
        subscriptions.set(channel, handler);
        return vi.fn();
      }),
    } as any;
    const service = new ProxyService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    vi.spyOn(service as any, 'queueDockerReconciliation').mockImplementation(() => undefined);
    vi.spyOn(service as any, 'collectSecureLinkRuntimeSnapshots').mockImplementation(() => undefined);
    const reconcile = vi.spyOn(service, 'reconcileTemplateHosts').mockResolvedValue({
      total: 1,
      succeeded: 1,
      failed: 0,
    });

    service.setEventBus(bus);
    subscriptions.get('nginx.template.changed')?.({
      id: 'template-1',
      action: 'updated',
      renderingChanged: true,
    });

    await vi.waitFor(() =>
      expect(reconcile).toHaveBeenCalledWith('template-1', {
        type: undefined,
        isBuiltin: false,
      })
    );
  });
});

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
    const traffic = {
      hostId: 'legacy-host',
      statusCodes: { s2xx: 1, s3xx: 0, s4xx: 0, s5xx: 0 },
      avgResponseTime: 0.01,
      p95ResponseTime: 0.02,
      totalRequests: 1,
      totalBytes: 100,
      requestsPerSecond: 0.1,
      bytesPerSecond: 10,
      busiestClientRps: 0.1,
      windowSeconds: 120,
      sampleTruncated: false,
    };
    const history = [{ timestamp: '2026-08-12T00:00:00.000Z', runtime, traffic }];
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
    const binding = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'api',
      status: 'active',
      generation: 1,
      targetContainer: 'api-container',
      forwardScheme: 'http',
      lastError: null,
    };
    const additionalRuntime = { ...runtime, routeId: binding.id };
    const cache = {
      get: vi.fn().mockImplementation((key: string) => Promise.resolve(key.endsWith(host.id) ? history : [])),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const secureLinks = {
      listAdditional: vi.fn().mockResolvedValue([binding]),
      getRuntime: vi.fn().mockResolvedValue(additionalRuntime),
    };
    const service = new ProxyService(
      db,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      secureLinks as any,
      cache as any
    );
    const focusedSample = new Promise(() => undefined);
    const sample = vi.spyOn(service as any, 'sampleSecureLinkRuntime').mockReturnValue(focusedSample);

    const status = await service.getProxySecureLinkStatus(host.id);

    expect(status.runtime).toEqual(runtime);
    expect(status.history).toEqual(history);
    expect(status.additionalLinks).toMatchObject([
      {
        id: binding.id,
        name: 'api',
        runtime: additionalRuntime,
        history: [{ runtime: additionalRuntime }],
      },
    ]);
    expect(cache.get).toHaveBeenCalledWith(`proxy-secure-link-runtime:${host.id}`);
    expect(cache.get).toHaveBeenCalledWith(`proxy-secure-link-runtime:additional:${binding.id}`);
    expect(secureLinks.getRuntime).toHaveBeenCalledWith(binding.id);
    expect(sample).toHaveBeenCalledWith(host, 10_000);
  });

  it('returns a complete focused snapshot on the first read when cached HTTP telemetry is missing', async () => {
    const host = makeActiveSecureHost();
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
    const traffic = {
      hostId: host.id,
      statusCodes: { s2xx: 1, s3xx: 0, s4xx: 0, s5xx: 0 },
      avgResponseTime: 0.01,
      p95ResponseTime: 0.02,
      totalRequests: 1,
      totalBytes: 100,
      requestsPerSecond: 0.1,
      bytesPerSecond: 10,
      busiestClientRps: 0.1,
      windowSeconds: 120,
      sampleTruncated: false,
    };
    const cachedHistory = [{ timestamp: '2026-08-12T00:00:00.000Z', runtime, traffic: null }];
    const refreshedSnapshot = {
      timestamp: '2026-08-12T00:00:01.000Z',
      runtime,
      traffic,
    };
    const refreshedHistory = [...cachedHistory, refreshedSnapshot];
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
    const cache = {
      get: vi.fn().mockResolvedValue(cachedHistory),
      set: vi.fn().mockResolvedValue(undefined),
    };
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
    const sample = vi.spyOn(service as any, 'sampleSecureLinkRuntime').mockResolvedValue({
      snapshot: refreshedSnapshot,
      history: refreshedHistory,
    });

    const status = await service.getProxySecureLinkStatus(host.id);

    expect(status.runtime).toEqual(runtime);
    expect(status.traffic).toEqual(traffic);
    expect(status.history).toEqual(refreshedHistory);
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
      windowSeconds: 120,
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
      { getActiveAdditional: vi.fn().mockResolvedValue([]) } as any
    );
    (service as any).dockerReconcileRunning = true;

    await service.collectSecureLinkRuntimeSnapshots();

    expect(findMany).not.toHaveBeenCalled();
    expect((service as any).secureLinkRuntimeCollectionPending).toBe(true);
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
      {
        getActiveAdditional: vi.fn().mockResolvedValue([]),
        assertAdditionalReferences: vi.fn().mockResolvedValue(undefined),
      } as any
    );

    await service.resyncAllHostsOnNode('nginx-node');

    expect(renderForHost).toHaveBeenCalledWith(
      expect.objectContaining({
        forwardHost: '127.0.0.1',
        forwardPort: active.secureLinkListenerPort,
        secureLinkUpstream: true,
      }),
      null,
      false
    );
    expect(applyConfig).toHaveBeenCalledWith('nginx-node', active.id, 'secure config', false, 'managed_secure_link');
  });

  it('restores basic auth credentials before applying host config during node resync', async () => {
    const host = makeActiveSecureHost({ accessListId: 'access-list-1' });
    const db = {
      query: {
        proxyHosts: {
          findMany: vi.fn().mockResolvedValue([host]),
        },
        accessLists: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'access-list-1',
            basicAuthEnabled: true,
            basicAuthUsers: [{ username: 'pd', passwordHash: 'bcrypt-hash' }],
            ipRules: [],
          }),
        },
      },
    } as any;
    const deployHtpasswd = vi.fn().mockResolvedValue({ success: true });
    const applyConfig = vi.fn().mockResolvedValue({ success: true });
    const service = new ProxyService(
      db,
      { renderForHost: vi.fn().mockResolvedValue('secure config') } as any,
      { log: vi.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      { resolveNodeId: vi.fn().mockResolvedValue('nginx-node'), deployHtpasswd, applyConfig } as any,
      { supportsNode: vi.fn().mockResolvedValue(false) } as any,
      undefined,
      {
        getActiveAdditional: vi.fn().mockResolvedValue([]),
        assertAdditionalReferences: vi.fn().mockResolvedValue(undefined),
      } as any
    );

    await service.resyncAllHostsOnNode('nginx-node');

    expect(deployHtpasswd).toHaveBeenCalledWith('nginx-node', 'access-list-1', 'pd:bcrypt-hash\n');
    expect(deployHtpasswd.mock.invocationCallOrder[0]).toBeLessThan(applyConfig.mock.invocationCallOrder[0]!);
  });

  it('does not apply a host config when credential deployment fails', async () => {
    const host = makeActiveSecureHost({ accessListId: 'access-list-1' });
    const db = {
      query: {
        proxyHosts: { findMany: vi.fn().mockResolvedValue([host]) },
        accessLists: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'access-list-1',
            basicAuthEnabled: true,
            basicAuthUsers: [{ username: 'pd', passwordHash: 'bcrypt-hash' }],
            ipRules: [],
          }),
        },
      },
    } as any;
    const applyConfig = vi.fn().mockResolvedValue({ success: true });
    const service = new ProxyService(
      db,
      { renderForHost: vi.fn().mockResolvedValue('secure config') } as any,
      { log: vi.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      {
        resolveNodeId: vi.fn().mockResolvedValue('nginx-node'),
        deployHtpasswd: vi.fn().mockResolvedValue({ success: false, error: 'daemon busy' }),
        applyConfig,
      } as any,
      { supportsNode: vi.fn().mockResolvedValue(false) } as any,
      undefined,
      {
        getActiveAdditional: vi.fn().mockResolvedValue([]),
        assertAdditionalReferences: vi.fn().mockResolvedValue(undefined),
      } as any
    );

    await service.resyncAllHostsOnNode('nginx-node');

    expect(applyConfig).not.toHaveBeenCalled();
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
      commitCutover: vi.fn().mockResolvedValue({
        ...provisioning,
        secureLinkStatus: 'cutover_ready',
        secureLinkMigratedAt: new Date(),
      }),
      activate: vi.fn().mockResolvedValue(undefined),
      getActiveAdditional: vi.fn().mockResolvedValue([]),
      assertAdditionalReferences: vi.fn().mockResolvedValue(undefined),
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
      null,
      false
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
      getActiveAdditional: vi.fn().mockResolvedValue([]),
      assertAdditionalReferences: vi.fn().mockResolvedValue(undefined),
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
      getActiveAdditional: vi.fn().mockResolvedValue([]),
      assertAdditionalReferences: vi.fn().mockResolvedValue(undefined),
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
    const secureLinks = {
      cleanup: vi.fn().mockResolvedValue(undefined),
      getActiveAdditional: vi.fn().mockResolvedValue([]),
      assertAdditionalReferences: vi.fn().mockResolvedValue(undefined),
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
      getActiveAdditional: vi.fn().mockResolvedValue([]),
      assertAdditionalReferences: vi.fn().mockResolvedValue(undefined),
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

describe('ProxyService offline Nginx abandonment', () => {
  function setup(connected: boolean, overrides: Record<string, unknown> = {}) {
    const existing = makeActiveSecureHost(overrides);
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(existing) } },
      delete: vi.fn(() => ({ where: deleteWhere })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updates.push(values);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    } as any;
    const auditService = { log: vi.fn().mockResolvedValue(undefined) } as any;
    const nodeDispatch = { isNodeConnected: vi.fn(() => connected) } as any;
    const certificateDistribution = { deactivateHost: vi.fn().mockResolvedValue(undefined) } as any;
    const secureLinks = {
      abandonOfflineSource: vi.fn().mockResolvedValue(undefined),
      cleanupAdditionalForHost: vi.fn(),
      cleanup: vi.fn(),
    } as any;
    const service = new ProxyService(
      db,
      {} as any,
      auditService,
      {} as any,
      nodeDispatch,
      certificateDistribution,
      undefined,
      secureLinks
    );
    return {
      service,
      existing,
      deleteWhere,
      updates,
      auditService,
      nodeDispatch,
      certificateDistribution,
      secureLinks,
    };
  }

  it('removes Gateway state without contacting an abandoned offline Nginx source', async () => {
    const { service, existing, deleteWhere, auditService, certificateDistribution, secureLinks } = setup(false, {
      isSystem: true,
    });

    await service.deleteProxyHost(existing.id, 'user-1', { abandonOfflineNode: true });

    expect(certificateDistribution.deactivateHost).toHaveBeenCalledWith(existing.id, existing.nodeId);
    expect(secureLinks.abandonOfflineSource).toHaveBeenCalledWith(existing);
    expect(secureLinks.cleanupAdditionalForHost).not.toHaveBeenCalled();
    expect(secureLinks.cleanup).not.toHaveBeenCalled();
    expect(deleteWhere).toHaveBeenCalledOnce();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'proxy_host.delete',
        details: expect.objectContaining({ abandonedOfflineNode: true, orphanedNginxConfigPossible: true }),
      })
    );
  });

  it('refuses to abandon proxy config while the Nginx source is connected', async () => {
    const { service, existing, deleteWhere, certificateDistribution, secureLinks } = setup(true);

    await expect(service.deleteProxyHost(existing.id, 'user-1', { abandonOfflineNode: true })).rejects.toMatchObject({
      code: 'NGINX_NODE_CONNECTED',
      statusCode: 409,
    });
    expect(certificateDistribution.deactivateHost).not.toHaveBeenCalled();
    expect(secureLinks.abandonOfflineSource).not.toHaveBeenCalled();
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('retains a disabled Pages host and its claimed target when host-row deletion fails', async () => {
    const { service, existing, deleteWhere, updates, nodeDispatch, certificateDistribution } = setup(false, {
      upstreamKind: 'pages',
    });
    const deleteError = new Error('proxy host delete failed');
    deleteWhere.mockRejectedValueOnce(deleteError);
    nodeDispatch.resolveNodeId = vi.fn().mockResolvedValue(existing.nodeId);
    nodeDispatch.removeConfig = vi.fn().mockResolvedValue({ success: true });
    certificateDistribution.deactivateHost = vi.fn().mockResolvedValue(undefined);
    const pageRoutes = { removeHost: vi.fn().mockResolvedValue(undefined) };
    service.setPageRoutes(pageRoutes as never);

    await expect(service.deleteProxyHost(existing.id, 'user-1')).rejects.toBe(deleteError);

    expect(pageRoutes.removeHost).toHaveBeenCalledWith(existing.id, existing.nodeId, false);
    expect(deleteWhere).toHaveBeenCalledOnce();
    expect(updates).toContainEqual(expect.objectContaining({ enabled: false }));
  });
});
