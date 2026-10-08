import { describe, expect, it, vi } from 'vitest';
import { withMemberIngressHealth } from '@/modules/proxy/proxy-group-health.js';
import { HealthCheckJob } from './health-check.job.js';

function setup() {
  const host: any = {
    id: 'route-1',
    enabled: true,
    healthCheckEnabled: true,
    maintenanceEnabled: false,
    healthStatus: 'online',
    healthHistory: [],
    healthCheckInterval: 30,
    healthCheckSlowThreshold: 3,
    lastHealthCheckAt: null,
    upstreamKind: 'proxy',
    secureLinkMigratedAt: null,
    ingressGroupId: null,
    nodeId: null,
    domainNames: ['app.test'],
  };
  const updates: Array<Record<string, unknown>> = [];
  const db: any = {
    query: { proxyHosts: { findMany: async () => [{ ...host }] } },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updates.push(values);
            Object.assign(host, values);
            // The job runs again at once in these tests; the interval gate is not under test.
            host.lastHealthCheckAt = null;
            return [{ id: host.id }];
          },
        }),
      }),
    }),
  };
  const job = new HealthCheckJob(db);
  const checkHost = vi.fn();
  (job as any).checkHost = checkHost;
  const evaluator = { observeStatefulEvent: vi.fn(async () => undefined) };
  job.setEvaluator(evaluator as any);
  const handlers = new Map<string, (payload: unknown) => void>();
  job.setEventBus({
    subscribe: (topic: string, handler: (payload: unknown) => void) => handlers.set(topic, handler),
    publish: vi.fn(),
  } as any);
  return { job, host, updates, checkHost, evaluator, handlers };
}

/** The listing's rule: an online route with an offline or degraded sample in the last 5 minutes is "recovering". */
const recovering = (host: { healthStatus: string; healthHistory: Array<{ ts: string; status: string }> }) =>
  host.healthStatus === 'online' &&
  host.healthHistory.some(
    (entry) =>
      new Date(entry.ts).getTime() >= Date.now() - 5 * 60_000 &&
      (entry.status === 'offline' || entry.status === 'degraded')
  );

describe('route health job: absorbed failures', () => {
  it('stores no offline sample for a failure it keeps the route up through', async () => {
    const t = setup();
    t.checkHost.mockResolvedValueOnce({ status: 'offline' });
    await t.job.run();
    expect(t.updates).toEqual([]);
    expect(t.evaluator.observeStatefulEvent).not.toHaveBeenCalled();

    t.checkHost.mockResolvedValueOnce({ status: 'online', responseMs: 5 });
    await t.job.run();
    expect(t.host.healthStatus).toBe('online');
    expect(t.host.healthHistory.map((entry: { status: string }) => entry.status)).toEqual(['online']);
    // Nothing is left for the 5-minute rule, so the route is not "recovering" once the probe passes.
    expect(recovering(t.host)).toBe(false);
  });

  it('still takes the route offline on the second failure in a row', async () => {
    const t = setup();
    t.checkHost.mockResolvedValue({ status: 'offline' });
    await t.job.run();
    await t.job.run();
    expect(t.host.healthStatus).toBe('offline');
    expect(t.host.healthHistory.map((entry: { status: string }) => entry.status)).toEqual(['offline']);
    expect(t.evaluator.observeStatefulEvent).toHaveBeenCalledWith(
      'proxy',
      'health.offline',
      expect.anything(),
      expect.anything(),
      undefined,
      expect.any(Number)
    );
  });

  it('a relay event without a state does not clear a critical relay', () => {
    const t = setup();
    const emit = t.handlers.get('system.relay.health.changed')!;
    emit({ state: 'critical' });
    emit({ reason: 'rebalance' });
    expect((t.job as any).relayUnavailable).toBe(true);
    emit({ state: 'healthy' });
    expect((t.job as any).relayUnavailable).toBe(false);
  });
});

// A local relay restart drops every node's control stream at once (O-b): a route must not go offline or degraded
// because its ingress members are reconnecting.
describe('route health job: ingress members that reconnect', () => {
  it('records no sample while every member is expected back, and still judges one that is gone', async () => {
    const reconnecting = new Set(['ingress-1']);
    const dispatch = { isNodeConnected: () => false, isNodeReconnecting: (id: string) => reconnecting.has(id) };
    const job = new HealthCheckJob({} as never, dispatch as never);
    // Past the startup grace, which defers every probe of a node that is not connected.
    (job as any).startedAt = Date.now() - 10 * 60_000;
    const host = { id: 'route-1', upstreamKind: 'pages', ingressGroupId: 'group-1', nodeId: null };
    const check = (members: string[]) => (job as any).checkHost(host, undefined, members);

    expect((await check(['ingress-1'])).status).toBe('deferred');
    expect((await check(['ingress-1', 'ingress-2'])).status).toBe('offline');
  });

  it('keeps a route probed from Gateway online while its members reconnect', () => {
    const member = (nodeId: string, extra: { connected: boolean; reconnecting?: boolean }) => ({
      nodeId,
      serving: null,
      ...extra,
    });
    expect(withMemberIngressHealth('online', [member('ingress-1', { connected: false, reconnecting: true })])).toEqual(
      expect.objectContaining({ status: 'deferred' })
    );
    expect(
      withMemberIngressHealth('online', [
        member('ingress-1', { connected: false, reconnecting: true }),
        member('ingress-2', { connected: true }),
      ]).status
    ).toBe('online');
    expect(withMemberIngressHealth('online', [member('ingress-1', { connected: false })]).status).toBe('offline');
  });
});
