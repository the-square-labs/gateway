import { describe, expect, it, vi } from 'vitest';
import { HealthCheckJob } from '@/jobs/health-check.job.js';
import {
  loadAvailabilityRouteProbeLinks,
  probeSecureLinkRoute,
  SECURE_LINK_PROBE_BUSY_ERROR,
} from './proxy-secure-link-health-probe.js';

const LISTENER_UNAVAILABLE = 'proxy secure-link listener is unavailable';

function route(overrides: Record<string, unknown> = {}) {
  return {
    id: 'orders-route',
    domainNames: ['orders.example.com'],
    enabled: true,
    maintenanceEnabled: false,
    healthCheckEnabled: true,
    healthStatus: 'offline',
    healthHistory: [],
    healthCheckInterval: 30,
    lastHealthCheckAt: null,
    healthCheckSlowThreshold: 0,
    healthCheckExpectedStatus: null,
    healthCheckExpectedBody: null,
    healthCheckBodyMatchMode: null,
    healthCheckUrl: '/healthz',
    forwardScheme: 'http',
    upstreamKind: 'docker_deployment',
    secureLinkMigratedAt: new Date(),
    nodeId: 'ingress-1',
    ...overrides,
  };
}

function member(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    proxyHostId: 'orders-route',
    availabilityOwnerKey: 'proxy-host:orders-route',
    dormant: false,
    ...overrides,
  };
}

/** Serves only the listed sockets, like an nginx daemon that opened just those members. */
function daemon(open: Record<string, { ok: boolean; httpStatus?: number; error?: string }>) {
  return {
    probeProxySecureLink: vi.fn(async (_nodeId: string, input: { linkId: string }) =>
      open[input.linkId] ? { responseMs: 4, ...open[input.linkId]! } : { ok: false, error: LISTENER_UNAVAILABLE }
    ),
  };
}

describe('probeSecureLinkRoute', () => {
  it('probes the route socket when the route has no Availability members', async () => {
    const dispatch = daemon({ 'orders-route': { ok: true, httpStatus: 200 } });

    const result = await probeSecureLinkRoute(dispatch, route() as never, undefined, 10);

    expect(result).toMatchObject({ ok: true, httpStatus: 200 });
    expect(dispatch.probeProxySecureLink).toHaveBeenCalledOnce();
    expect(dispatch.probeProxySecureLink.mock.calls[0]![1]).toMatchObject({ linkId: 'orders-route', path: '/healthz' });
  });

  it('is healthy when any member answers, even though the route socket is closed', async () => {
    // Lease mode: only the holder's socket is open; the first member belongs to a dormant standby.
    const dispatch = daemon({ 'member-b': { ok: true, httpStatus: 200 } });

    const result = await probeSecureLinkRoute(dispatch, route() as never, ['member-a', 'member-b', 'member-c'], 10);

    expect(result.ok).toBe(true);
    expect(dispatch.probeProxySecureLink.mock.calls.map((call) => call[1].linkId)).toEqual(['member-a', 'member-b']);
    expect(result.failures).toEqual([{ linkId: 'member-a', error: LISTENER_UNAVAILABLE }]);
  });

  it('is unhealthy only when every member fails, and reports each failure', async () => {
    const dispatch = daemon({ 'member-a': { ok: false, httpStatus: 503 } });
    dispatch.probeProxySecureLink.mockImplementationOnce(async () => ({ ok: false, httpStatus: 503, responseMs: 4 }));
    dispatch.probeProxySecureLink.mockImplementationOnce(async () => {
      throw new Error('Node ingress-1 is not connected');
    });

    const result = await probeSecureLinkRoute(dispatch, route() as never, ['member-a', 'member-b'], 10);

    expect(result.ok).toBe(false);
    expect(result.busy).toBe(false);
    expect(result.failures.map((failure) => failure.linkId)).toEqual(['member-a', 'member-b']);
    expect(result.failures[1]!.error).toBe('Node ingress-1 is not connected');
  });

  it('stops at a busy daemon so the sample is deferred rather than failed', async () => {
    const dispatch = daemon({});
    dispatch.probeProxySecureLink.mockResolvedValueOnce({ ok: false, error: SECURE_LINK_PROBE_BUSY_ERROR });

    const result = await probeSecureLinkRoute(dispatch, route() as never, ['member-a', 'member-b'], 10);

    expect(result).toMatchObject({ ok: false, busy: true });
    expect(dispatch.probeProxySecureLink).toHaveBeenCalledOnce();
  });
});

describe('loadAvailabilityRouteProbeLinks', () => {
  it('keeps only the route-owned members and orders dormant members last', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        member('standby', { dormant: true }),
        member('additional', { availabilityOwnerKey: 'additional-secure-link:x' }),
        member('serving'),
      ]);

    const links = await loadAvailabilityRouteProbeLinks(
      { query: { proxyAdditionalSecureLinks: { findMany } } } as never,
      ['orders-route']
    );

    expect(links.get('orders-route')).toEqual(['serving', 'standby']);
  });
});

describe('HealthCheckJob for Availability routes', () => {
  function database(hosts: ReturnType<typeof route>[], members: ReturnType<typeof member>[]) {
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      query: {
        proxyHosts: { findMany: vi.fn().mockResolvedValue(hosts) },
        proxyAdditionalSecureLinks: { findMany: vi.fn().mockResolvedValue(members) },
      },
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          writes.push(values);
          return { where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'persisted' }]) })) };
        }),
      })),
    } as any;
    return { db, writes };
  }

  it('marks an HA route online through its member socket instead of the unused route socket', async () => {
    const { db, writes } = database([route()], [member('member-a', { dormant: true }), member('member-b')]);
    const dispatch = daemon({ 'member-b': { ok: true, httpStatus: 200 } });

    await new HealthCheckJob(db, dispatch as never).run();

    expect(dispatch.probeProxySecureLink.mock.calls.map((call) => call[1].linkId)).toEqual(['member-b']);
    expect(writes).toEqual([expect.objectContaining({ healthStatus: 'online' })]);
  });

  it('marks an HA route offline when no member answers', async () => {
    const { db, writes } = database([route()], [member('member-a'), member('member-b')]);
    const dispatch = daemon({});

    await new HealthCheckJob(db, dispatch as never).run();

    expect(dispatch.probeProxySecureLink).toHaveBeenCalledTimes(2);
    expect(writes).toEqual([expect.objectContaining({ healthStatus: 'offline' })]);
  });
});
