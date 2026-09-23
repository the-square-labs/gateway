import { afterEach, describe, expect, it, vi } from 'vitest';

// Compose-style DNS: service names resolve to container addresses on the Gateway network.
vi.mock('node:dns/promises', () => {
  const records: Record<string, string> = {
    postgres: '172.18.0.3',
    registry: '172.18.0.4',
    relay: '172.18.0.5',
    redis: '172.18.0.6',
    'db-alias.example.test': '172.18.0.3',
    localhost: '127.0.0.1',
  };
  const lookup = vi.fn(async (name: string) => {
    const address = records[name];
    if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
    return [{ address, family: 4 }];
  });
  return { lookup, default: { lookup } };
});

import { DEFAULT_OUTBOUND_WEBHOOK_POLICY } from '@/modules/settings/outbound-webhook-policy.service.js';
import {
  checkProxyHealthTarget,
  evaluateProxyHealthResponse,
  PROXY_HEALTH_CHECK_POLICY,
  probeDirectProxyUpstream,
  runImmediateProxyHealthCheck,
} from './proxy-health-check.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('runImmediateProxyHealthCheck', () => {
  it('persists and publishes the first health sample after enabling checks', async () => {
    vi.useFakeTimers();
    const host = {
      id: 'host-1',
      domainNames: ['example.com'],
      enabled: true,
      maintenanceEnabled: false,
      healthCheckEnabled: true,
      healthHistory: [],
      healthCheckExpectedStatus: null,
      healthCheckExpectedBody: null,
      healthCheckBodyMatchMode: null,
      healthCheckUrl: '/',
      forwardScheme: 'http',
      forwardHost: '127.0.0.1',
      forwardPort: 8080,
      upstreamKind: 'manual',
      secureLinkMigratedAt: null,
      nodeId: null,
    };
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(host) } },
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          writes.push(values);
          return {
            where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: host.id }]) })),
          };
        }),
      })),
    } as any;
    const request = vi.fn().mockResolvedValue({ status: 200, text: vi.fn().mockResolvedValue('ok') });
    const publish = vi.fn();

    runImmediateProxyHealthCheck({
      db,
      hostId: host.id,
      logger: { debug: vi.fn() },
      eventBus: { publish } as any,
      probeDeps: { checkTarget: async (url) => ({ url, allowed: true, resolvedAddresses: ['203.0.113.10'] }), request },
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(
      expect.objectContaining({
        healthStatus: 'online',
        lastHealthCheckAt: expect.any(Date),
        healthHistory: [expect.objectContaining({ status: 'online' })],
      })
    );
    expect(publish).toHaveBeenCalledWith(
      'proxy.host.changed',
      expect.objectContaining({ id: host.id, action: 'health.online', health_status: 'online' })
    );
  });

  it('checks a Pages Route through the node-local nginx probe', async () => {
    vi.useFakeTimers();
    const host = {
      id: 'pages-host',
      domainNames: ['docs.example.com'],
      enabled: true,
      maintenanceEnabled: false,
      healthCheckEnabled: true,
      healthHistory: [],
      healthCheckExpectedStatus: 200,
      healthCheckExpectedBody: null,
      healthCheckBodyMatchMode: null,
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
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(host) } },
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: host.id }]) })),
        })),
      })),
    } as any;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const probePagesRoute = vi.fn().mockResolvedValue({ ok: true, httpStatus: 200, responseMs: 12 });

    runImmediateProxyHealthCheck({
      db,
      hostId: host.id,
      logger: { debug: vi.fn() },
      nodeDispatch: { probePagesRoute } as any,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(probePagesRoute).toHaveBeenCalledWith('nginx-node', {
      routeId: 'pages-host',
      domain: 'docs.example.com',
      tls: true,
      path: '/health.html',
      expectedStatus: 200,
      expectedBody: null,
      bodyMatchMode: null,
      timeoutSeconds: 10,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledOnce();
  });

  it('writes an explicit unknown sample when the Pages probe capability is unavailable', async () => {
    vi.useFakeTimers();
    const host = {
      id: 'pages-host',
      domainNames: ['docs.example.com'],
      enabled: true,
      maintenanceEnabled: false,
      healthCheckEnabled: true,
      healthHistory: [],
      healthCheckExpectedStatus: null,
      healthCheckExpectedBody: null,
      healthCheckBodyMatchMode: null,
      healthCheckUrl: '/',
      sslEnabled: false,
      upstreamKind: 'pages',
      nodeId: 'nginx-node',
    };
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      query: { proxyHosts: { findFirst: vi.fn().mockResolvedValue(host) } },
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          writes.push(values);
          return {
            where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: host.id }]) })),
          };
        }),
      })),
    } as any;

    runImmediateProxyHealthCheck({
      db,
      hostId: host.id,
      logger: { debug: vi.fn() },
      nodeDispatch: {
        probePagesRoute: vi.fn().mockResolvedValue({ ok: false, skipped: true, error: 'update required' }),
      } as any,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(writes).toEqual([
      expect.objectContaining({
        healthStatus: 'unknown',
        healthHistory: [expect.objectContaining({ status: 'unknown' })],
      }),
    ]);
  });
});

describe('proxy health outcome rules', () => {
  const host = (overrides: Record<string, unknown> = {}) => ({
    healthCheckExpectedStatus: null,
    healthCheckExpectedBody: null,
    healthCheckBodyMatchMode: null,
    ...overrides,
  });

  it('treats 4xx and body mismatches as failures regardless of which check runs', () => {
    expect(evaluateProxyHealthResponse(host(), 204, null)).toBe(true);
    expect(evaluateProxyHealthResponse(host(), 404, null)).toBe(false);
    expect(evaluateProxyHealthResponse(host({ healthCheckExpectedStatus: 401 }), 401, null)).toBe(true);
    expect(
      evaluateProxyHealthResponse(
        host({ healthCheckExpectedBody: 'ok', healthCheckBodyMatchMode: 'exact' }),
        200,
        'status: ok'
      )
    ).toBe(false);
    expect(
      evaluateProxyHealthResponse(
        host({ healthCheckExpectedBody: 'ok', healthCheckBodyMatchMode: 'ends_with' }),
        200,
        'status: ok'
      )
    ).toBe(true);
  });
});

describe('proxy health target policy', () => {
  const env = {
    BIND_HOST: '0.0.0.0',
    APP_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://gateway:secret@postgres:5432/gateway',
    REDIS_URL: 'redis://redis:6379',
    GATEWAY_RELAY_TARGET: 'relay:9443',
    GATEWAY_RELAY_SERVICE_NAME: 'relay',
  } as any;

  it.each([
    'http://127.0.0.1:8080/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:8080/',
    'http://postgres:5432/',
    'http://registry:5000/v2/',
    // A different name for an internal service's address is refused by address, not by name.
    'http://db-alias.example.test:8080/',
  ])('refuses %s', async (url) => {
    const result = await checkProxyHealthTarget(url, env);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('refuses internal compose services even though their network is allowlisted', async () => {
    await expect(checkProxyHealthTarget('http://registry:5000/v2/', env)).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('internal service'),
    });
    await expect(checkProxyHealthTarget('http://172.30.99.9:8080/', env)).resolves.toMatchObject({ allowed: true });
  });

  it('keeps allowlisted private LAN upstreams and public upstreams reachable', async () => {
    await expect(checkProxyHealthTarget('http://10.20.30.40:8080/health', env)).resolves.toMatchObject({
      allowed: true,
      resolvedAddresses: ['10.20.30.40'],
    });
    await expect(checkProxyHealthTarget('http://203.0.113.10/', env)).resolves.toMatchObject({ allowed: true });
  });

  // Regression: health checks used the webhook allowlist (10/8, 172.16/12 only), so 192.168.x.x
  // and CGNAT upstreams reported "unknown".
  it.each([
    ['http://192.168.1.10:8080/', '192.168.1.10'],
    ['http://100.64.1.1/', '100.64.1.1'],
    ['http://[fd00::10]:8080/', 'fd00::10'],
  ])('allows the private upstream %s', async (url, ip) => {
    await expect(checkProxyHealthTarget(url, env)).resolves.toMatchObject({
      allowed: true,
      resolvedAddresses: [ip],
    });
  });

  it.each([
    'http://127.0.0.1/',
    'http://169.254.169.254/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://224.0.0.1/',
    'http://0.0.0.0/',
  ])('always blocks %s even with every private range allowed', async (url) => {
    await expect(checkProxyHealthTarget(url, env)).resolves.toMatchObject({ allowed: false });
  });

  it('does not loosen the outbound webhook policy', () => {
    expect(DEFAULT_OUTBOUND_WEBHOOK_POLICY.allowedPrivateCidrs).not.toContain('192.168.0.0/16');
    expect(PROXY_HEALTH_CHECK_POLICY.allowedPrivateCidrs).toEqual(
      expect.arrayContaining(['192.168.0.0/16', '100.64.0.0/10', 'fc00::/7'])
    );
  });

  it('reports a blocked target without sending a request', async () => {
    const request = vi.fn();
    const result = await probeDirectProxyUpstream(
      { forwardScheme: 'http', forwardHost: '169.254.169.254', forwardPort: 80, healthCheckUrl: '/' },
      {
        checkTarget: async (url) => ({
          url,
          allowed: false,
          reason: 'metadata',
          resolvedAddresses: ['169.254.169.254'],
        }),
        request,
      }
    );
    expect(result).toEqual({ status: 'blocked', reason: 'metadata' });
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps reporting an unresolvable upstream as offline rather than policy-blocked', async () => {
    const request = vi.fn();
    const result = await probeDirectProxyUpstream(
      { forwardScheme: 'http', forwardHost: 'gone.example.test', forwardPort: 80, healthCheckUrl: '/' },
      {
        checkTarget: async (url) => ({ url, allowed: false, reason: 'did not resolve', resolvedAddresses: [] }),
        request,
      }
    );
    expect(result).toMatchObject({ status: 'offline' });
    expect(request).not.toHaveBeenCalled();
  });

  it('pins requests to the validated address and does not follow redirects to another target', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: 302, headers: { location: '/login' }, text: async () => '' })
      .mockResolvedValueOnce({ status: 302, headers: { location: 'http://169.254.169.254/' }, text: async () => '' });
    const result = await probeDirectProxyUpstream(
      { forwardScheme: 'http', forwardHost: 'app.lan', forwardPort: 8080, healthCheckUrl: '/' },
      { checkTarget: async (url) => ({ url, allowed: true, resolvedAddresses: ['10.0.0.9'] }), request }
    );

    expect(request.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ['http://app.lan:8080/', ['10.0.0.9']],
      ['http://app.lan:8080/login', ['10.0.0.9']],
    ]);
    expect(result).toMatchObject({ status: 'offline', httpStatus: 302 });
  });
});
