import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthCheckJob } from './health-check.job.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('HealthCheckJob maintenance race', () => {
  it('does not publish or evaluate a completed check when conditional persistence is rejected', async () => {
    const host = {
      id: 'host-1',
      domainNames: ['example.com'],
      enabled: true,
      maintenanceEnabled: false,
      healthCheckEnabled: true,
      healthStatus: 'online',
      healthHistory: [],
      healthCheckSlowThreshold: 3,
      healthCheckExpectedStatus: null,
      healthCheckExpectedBody: null,
      healthCheckUrl: '/',
      forwardScheme: 'http',
      forwardHost: '127.0.0.1',
      forwardPort: 8080,
    };
    const returning = vi.fn().mockResolvedValue([]);
    const db = {
      query: { proxyHosts: { findMany: vi.fn().mockResolvedValue([host]) } },
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
      })),
    } as any;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, text: vi.fn().mockResolvedValue('ok') }));
    const publish = vi.fn();
    const observeStatefulEvent = vi.fn();
    const job = new HealthCheckJob(db);
    job.setEventBus({ publish } as any);
    job.setEvaluator({ observeStatefulEvent } as any);

    await job.run();

    expect(returning).toHaveBeenCalledOnce();
    expect(observeStatefulEvent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('checks an active Docker Secure Link through its Nginx daemon instead of the Gateway process', async () => {
    const host = {
      id: 'host-secure',
      domainNames: ['secure.example.com'],
      enabled: true,
      maintenanceEnabled: false,
      healthCheckEnabled: true,
      healthStatus: 'unknown',
      healthHistory: [],
      healthCheckSlowThreshold: 3,
      healthCheckExpectedStatus: 204,
      healthCheckExpectedBody: null,
      healthCheckBodyMatchMode: null,
      healthCheckUrl: '/health',
      forwardScheme: 'http',
      forwardHost: '127.0.0.1',
      forwardPort: 43123,
      upstreamKind: 'docker_container',
      secureLinkStatus: 'active',
      secureLinkMigratedAt: new Date(),
      nodeId: 'nginx-node',
    };
    const returning = vi.fn().mockResolvedValue([{ id: host.id }]);
    const db = {
      query: { proxyHosts: { findMany: vi.fn().mockResolvedValue([host]) } },
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
      })),
    } as any;
    const probeProxySecureLink = vi.fn().mockResolvedValue({ ok: true, httpStatus: 204, responseMs: 7 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await new HealthCheckJob(db, { probeProxySecureLink } as any).run();

    expect(probeProxySecureLink).toHaveBeenCalledWith('nginx-node', {
      linkId: host.id,
      scheme: 'http',
      path: '/health',
      expectedStatus: 204,
      expectedBody: null,
      bodyMatchMode: null,
      timeoutSeconds: 10,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(returning).toHaveBeenCalledOnce();
  });

  it('does not fall back to the legacy endpoint after Secure Link cutover is committed', async () => {
    const host = {
      id: 'host-cutover',
      domainNames: ['cutover.example.com'],
      enabled: true,
      maintenanceEnabled: false,
      healthCheckEnabled: true,
      healthStatus: 'unknown',
      healthHistory: [],
      healthCheckSlowThreshold: 3,
      healthCheckExpectedStatus: null,
      healthCheckExpectedBody: null,
      healthCheckUrl: '/',
      forwardScheme: 'http',
      forwardHost: '10.0.0.8',
      forwardPort: 8080,
      upstreamKind: 'docker_container',
      secureLinkStatus: 'cutover_ready',
      secureLinkMigratedAt: new Date(),
      nodeId: 'nginx-node',
    };
    const db = {
      query: { proxyHosts: { findMany: vi.fn().mockResolvedValue([host]) } },
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: host.id }]) })) })),
      })),
    } as any;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await new HealthCheckJob(db).run();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks a Pages Route through its node-local nginx probe on the regular schedule', async () => {
    const host = {
      id: 'pages-host',
      domainNames: ['docs.example.com'],
      enabled: true,
      maintenanceEnabled: false,
      healthCheckEnabled: true,
      healthStatus: 'unknown',
      healthHistory: [],
      healthCheckSlowThreshold: 3,
      healthCheckExpectedStatus: 200,
      healthCheckExpectedBody: null,
      healthCheckUrl: '/health.html',
      sslEnabled: true,
      forwardScheme: 'http',
      forwardHost: null,
      forwardPort: null,
      upstreamKind: 'pages',
      secureLinkMigratedAt: null,
      nodeId: 'nginx-node',
    };
    const db = {
      query: { proxyHosts: { findMany: vi.fn().mockResolvedValue([host]) } },
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: host.id }]) })),
        })),
      })),
    } as any;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const probePagesRoute = vi.fn().mockResolvedValue({ ok: true, httpStatus: 200, responseMs: 8 });

    await new HealthCheckJob(db, { probePagesRoute } as any).run();

    expect(probePagesRoute).toHaveBeenCalledWith('nginx-node', {
      routeId: 'pages-host',
      domain: 'docs.example.com',
      tls: true,
      path: '/health.html',
      expectedStatus: 200,
      expectedBody: null,
      bodyMatchMode: undefined,
      timeoutSeconds: 10,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks a previously healthy Pages Route unknown when the node lacks probe capability', async () => {
    const host = {
      id: 'pages-host',
      domainNames: ['docs.example.com'],
      enabled: true,
      maintenanceEnabled: false,
      healthCheckEnabled: true,
      healthStatus: 'online',
      healthHistory: [],
      healthCheckInterval: 30,
      lastHealthCheckAt: null,
      healthCheckUrl: '/',
      sslEnabled: false,
      upstreamKind: 'pages',
      nodeId: 'nginx-node',
    };
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      query: { proxyHosts: { findMany: vi.fn().mockResolvedValue([host]) } },
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          writes.push(values);
          return {
            where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: host.id }]) })),
          };
        }),
      })),
    } as any;

    await new HealthCheckJob(db, {
      probePagesRoute: vi.fn().mockResolvedValue({ ok: false, skipped: true, error: 'update required' }),
    } as any).run();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(
      expect.objectContaining({
        healthStatus: 'unknown',
        lastHealthCheckAt: expect.any(Date),
        healthHistory: [expect.objectContaining({ status: 'unknown' })],
      })
    );
  });
});
