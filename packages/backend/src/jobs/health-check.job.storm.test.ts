import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthCheckJob } from './health-check.job.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function host(overrides: Record<string, unknown> = {}) {
  return {
    id: 'host-1',
    domainNames: ['example.com'],
    enabled: true,
    maintenanceEnabled: false,
    healthCheckEnabled: true,
    healthStatus: 'online',
    healthHistory: [],
    healthCheckInterval: 30,
    lastHealthCheckAt: null,
    healthCheckSlowThreshold: 3,
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
    ...overrides,
  };
}

/** Direct probes go through the outbound policy; tests allow the target and stub the pinned request. */
function probeDeps(request: (...args: any[]) => Promise<unknown>) {
  return {
    checkTarget: async (url: string) => ({ url, allowed: true, resolvedAddresses: ['203.0.113.10'] }),
    request: request as any,
  };
}

function database(hosts: ReturnType<typeof host>[]) {
  const writes: Array<Record<string, unknown>> = [];
  const whereResult = Object.assign(Promise.resolve(undefined), {
    returning: vi.fn().mockResolvedValue([{ id: 'persisted' }]),
  });
  const db = {
    query: { proxyHosts: { findMany: vi.fn().mockResolvedValue(hosts) } },
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        writes.push(values);
        return {
          where: vi.fn(() => whereResult),
        };
      }),
    })),
  } as any;
  return { db, writes };
}

describe('HealthCheckJob storm protection', () => {
  it('checks only hosts whose configured interval is due', async () => {
    const now = Date.now();
    const due = host({ id: 'due', lastHealthCheckAt: new Date(now - 31_000) });
    const waiting = host({ id: 'waiting', lastHealthCheckAt: new Date(now - 5_000) });
    const { db, writes } = database([due, waiting]);
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, text: vi.fn().mockResolvedValue('ok') });

    await new HealthCheckJob(db, undefined, probeDeps(fetchMock)).run();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(1);
  });

  it('limits concurrent probes', async () => {
    const hosts = Array.from({ length: 20 }, (_, index) => host({ id: `host-${index}` }));
    const { db } = database(hosts);
    let active = 0;
    let maximum = 0;
    const request = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          active++;
          maximum = Math.max(maximum, active);
          setTimeout(() => {
            active--;
            resolve({ status: 200, text: vi.fn().mockResolvedValue('ok') });
          }, 2);
        })
    );

    await new HealthCheckJob(db, undefined, probeDeps(request)).run();

    expect(maximum).toBeLessThanOrEqual(8);
  });

  it('reserves one daemon command slot while checking Secure Links', async () => {
    const hosts = Array.from({ length: 20 }, (_, index) =>
      host({
        id: `secure-${index}`,
        upstreamKind: 'docker_container',
        secureLinkMigratedAt: new Date(),
        nodeId: 'nginx-node',
      })
    );
    const { db } = database(hosts);
    let active = 1; // unrelated daemon command already occupies one shared slot
    let maximum = active;
    let busyResults = 0;
    const probeProxySecureLink = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          active++;
          maximum = Math.max(maximum, active);
          if (active > 4) {
            active--;
            busyResults++;
            resolve({ ok: false, error: 'daemon is busy handling long-running commands; retry shortly' });
            return;
          }
          setTimeout(() => {
            active--;
            resolve({ ok: true, httpStatus: 200, responseMs: 2 });
          }, 2);
        })
    );

    await new HealthCheckJob(db, { probeProxySecureLink } as any).run();

    expect(probeProxySecureLink).toHaveBeenCalledTimes(20);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(busyResults).toBe(0);
  });

  it('does not count daemon capacity pressure as an offline probe', async () => {
    const secure = host({
      upstreamKind: 'docker_container',
      secureLinkMigratedAt: new Date(),
      nodeId: 'nginx-node',
      healthHistory: [{ ts: new Date(Date.now() - 30_000).toISOString(), status: 'offline' }],
    });
    const { db, writes } = database([secure]);
    const probeProxySecureLink = vi.fn().mockResolvedValue({
      ok: false,
      error: 'daemon is busy handling long-running commands; retry shortly',
    });

    await new HealthCheckJob(db, { probeProxySecureLink } as any).run();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ lastHealthCheckAt: expect.any(Date) });
  });

  it('does not mark low-latency Secure Link jitter as degraded', async () => {
    const healthHistory = Array.from({ length: 5 }, (_, index) => ({
      ts: new Date(Date.now() - (index + 1) * 30_000).toISOString(),
      status: 'online',
      responseMs: 4,
    }));
    const secure = host({
      upstreamKind: 'docker_container',
      secureLinkMigratedAt: new Date(),
      nodeId: 'nginx-node',
      healthHistory,
    });
    const { db, writes } = database([secure]);
    const probeProxySecureLink = vi.fn().mockResolvedValue({ ok: true, httpStatus: 200, responseMs: 30 });

    await new HealthCheckJob(db, { probeProxySecureLink } as any).run();

    expect(writes[0]?.healthStatus).toBe('online');
    expect((writes[0]?.healthHistory as Array<{ slow?: boolean }>).at(-1)?.slow).toBeUndefined();
  });

  it('still marks materially slow Secure Link responses as degraded', async () => {
    const healthHistory = Array.from({ length: 5 }, (_, index) => ({
      ts: new Date(Date.now() - (index + 1) * 30_000).toISOString(),
      status: 'online',
      responseMs: 4,
    }));
    const secure = host({
      upstreamKind: 'docker_container',
      secureLinkMigratedAt: new Date(),
      nodeId: 'nginx-node',
      healthHistory,
    });
    const { db, writes } = database([secure]);
    const probeProxySecureLink = vi.fn().mockResolvedValue({ ok: true, httpStatus: 200, responseMs: 300 });

    await new HealthCheckJob(db, { probeProxySecureLink } as any).run();

    expect(writes[0]?.healthStatus).toBe('degraded');
    expect((writes[0]?.healthHistory as Array<{ slow?: boolean }>).at(-1)?.slow).toBe(true);
  });

  it.each([
    { responseMs: 249, expectedStatus: 'online', expectedSlow: undefined },
    { responseMs: 250, expectedStatus: 'degraded', expectedSlow: true },
  ])('uses the absolute slow-response boundary at $responseMs ms', async (testCase) => {
    const healthHistory = Array.from({ length: 5 }, (_, index) => ({
      ts: new Date(Date.now() - (index + 1) * 30_000).toISOString(),
      status: 'online',
      responseMs: 4,
    }));
    const secure = host({
      upstreamKind: 'docker_container',
      secureLinkMigratedAt: new Date(),
      nodeId: 'nginx-node',
      healthHistory,
    });
    const { db, writes } = database([secure]);
    const probeProxySecureLink = vi
      .fn()
      .mockResolvedValue({ ok: true, httpStatus: 200, responseMs: testCase.responseMs });

    await new HealthCheckJob(db, { probeProxySecureLink } as any).run();

    expect(writes[0]?.healthStatus).toBe(testCase.expectedStatus);
    expect((writes[0]?.healthHistory as Array<{ slow?: boolean }>).at(-1)?.slow).toBe(testCase.expectedSlow);
  });

  it('keeps the relative slow threshold when it is higher than the absolute floor', async () => {
    const healthHistory = Array.from({ length: 5 }, (_, index) => ({
      ts: new Date(Date.now() - (index + 1) * 30_000).toISOString(),
      status: 'online',
      responseMs: 200,
    }));
    const secure = host({
      upstreamKind: 'docker_container',
      secureLinkMigratedAt: new Date(),
      nodeId: 'nginx-node',
      healthHistory,
    });
    const { db, writes } = database([secure]);
    const probeProxySecureLink = vi.fn().mockResolvedValue({ ok: true, httpStatus: 200, responseMs: 300 });

    await new HealthCheckJob(db, { probeProxySecureLink } as any).run();

    expect(writes[0]?.healthStatus).toBe('online');
    expect((writes[0]?.healthHistory as Array<{ slow?: boolean }>).at(-1)?.slow).toBeUndefined();
  });

  it('requires two consecutive failures before a healthy host becomes offline', async () => {
    const first = host();
    const firstRun = database([first]);
    const failing = probeDeps(vi.fn().mockRejectedValue(new Error('timeout')));
    const firstObserve = vi.fn();
    const firstPublish = vi.fn();
    const firstJob = new HealthCheckJob(firstRun.db, undefined, failing);
    firstJob.setEvaluator({ observeStatefulEvent: firstObserve } as any);
    firstJob.setEventBus({ publish: firstPublish } as any);

    await firstJob.run();

    expect(firstRun.writes[0]?.healthStatus).toBe('online');
    expect(firstObserve).not.toHaveBeenCalled();
    expect(firstPublish).toHaveBeenCalledWith(
      'proxy.host.changed',
      expect.objectContaining({ id: first.id, action: 'health.sampled', health_status: 'online' })
    );

    const second = host({ healthHistory: [{ ts: new Date(Date.now() - 30_000).toISOString(), status: 'offline' }] });
    const secondRun = database([second]);
    const secondObserve = vi.fn();
    const secondPublish = vi.fn();
    const secondJob = new HealthCheckJob(secondRun.db, undefined, failing);
    secondJob.setEvaluator({ observeStatefulEvent: secondObserve } as any);
    secondJob.setEventBus({ publish: secondPublish } as any);

    await secondJob.run();

    expect(secondRun.writes[0]?.healthStatus).toBe('offline');
    expect(secondObserve).toHaveBeenCalledOnce();
    expect(secondPublish).toHaveBeenCalledOnce();
  });

  it('publishes same-state samples and distinguishes the later online recovery', async () => {
    const failed = host({
      healthStatus: 'offline',
      healthHistory: [{ ts: new Date(Date.now() - 30_000).toISOString(), status: 'offline' }],
    });
    const failedRun = database([failed]);
    const failedPublish = vi.fn();
    const failedJob = new HealthCheckJob(
      failedRun.db,
      undefined,
      probeDeps(vi.fn().mockRejectedValue(new Error('timeout')))
    );
    failedJob.setEventBus({ publish: failedPublish } as any);

    await failedJob.run();

    expect(failedRun.writes[0]?.healthStatus).toBe('offline');
    expect(failedPublish).toHaveBeenCalledWith(
      'proxy.host.changed',
      expect.objectContaining({ id: failed.id, action: 'health.sampled', health_status: 'offline' })
    );

    const recoveredRun = database([failed]);
    const recoveredPublish = vi.fn();
    const recoveredJob = new HealthCheckJob(
      recoveredRun.db,
      undefined,
      probeDeps(vi.fn().mockResolvedValue({ status: 200, text: vi.fn().mockResolvedValue('ok') }))
    );
    recoveredJob.setEventBus({ publish: recoveredPublish } as any);

    await recoveredJob.run();

    expect(recoveredRun.writes[0]?.healthStatus).toBe('online');
    expect(recoveredPublish).toHaveBeenCalledOnce();
    expect(recoveredPublish).toHaveBeenCalledWith(
      'proxy.host.changed',
      expect.objectContaining({ id: failed.id, action: 'health.online', health_status: 'online' })
    );
  });

  it('preserves host status and skips probes during a relay-wide critical outage', async () => {
    const secure = host({
      upstreamKind: 'docker_container',
      secureLinkMigratedAt: new Date(),
      nodeId: 'nginx-node',
    });
    const { db, writes } = database([secure]);
    const probeProxySecureLink = vi.fn();
    const publish = vi.fn();
    const observeStatefulEvent = vi.fn();
    let relayHealthChanged: ((payload: unknown) => void) | undefined;
    const job = new HealthCheckJob(db, { probeProxySecureLink } as any);
    job.setEventBus({
      publish,
      subscribe: vi.fn((channel: string, handler: (payload: unknown) => void) => {
        if (channel === 'system.relay.health.changed') relayHealthChanged = handler;
      }),
    } as any);
    job.setEvaluator({ observeStatefulEvent } as any);
    relayHealthChanged?.({ state: 'critical' });

    await job.run();

    expect(probeProxySecureLink).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toHaveProperty('healthStatus');
    expect(publish).toHaveBeenCalledWith(
      'proxy.host.changed',
      expect.objectContaining({ id: secure.id, action: 'health.sampled', health_status: 'online' })
    );
    expect(observeStatefulEvent).not.toHaveBeenCalled();
  });
  it('records a policy-blocked upstream as unknown without probing or alerting', async () => {
    const blocked = host({ forwardHost: '169.254.169.254', forwardPort: 80 });
    const { db, writes } = database([blocked]);
    const request = vi.fn();
    const observeStatefulEvent = vi.fn();
    const job = new HealthCheckJob(db, undefined, {
      checkTarget: async (url) => ({ url, allowed: false, reason: 'metadata', resolvedAddresses: ['169.254.169.254'] }),
      request,
    });
    job.setEvaluator({ observeStatefulEvent } as any);

    await job.run();

    expect(request).not.toHaveBeenCalled();
    expect(writes[0]?.healthStatus).toBe('unknown');
    expect(observeStatefulEvent).not.toHaveBeenCalled();
  });

  it('applies the configured body match mode like the immediate check does', async () => {
    const exact = host({
      healthStatus: 'offline',
      healthHistory: [{ ts: new Date(Date.now() - 30_000).toISOString(), status: 'offline' }],
      healthCheckExpectedBody: 'ok',
      healthCheckBodyMatchMode: 'exact',
    });
    const { db, writes } = database([exact]);
    const request = vi.fn().mockResolvedValue({ status: 200, text: vi.fn().mockResolvedValue('not ok') });

    await new HealthCheckJob(db, undefined, probeDeps(request)).run();

    expect(writes[0]?.healthStatus).toBe('offline');
  });
});
