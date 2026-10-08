import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger.js';
import { RelaySupervisorService } from './relay-supervisor.service.js';

const T0 = Date.UTC(2026, 9, 8, 14, 0);

function relayHealth() {
  return {
    buildVersion: 'relay-1',
    protocolMajor: 1,
    liveness: true,
    readiness: true,
    reason: '',
    registeredEndpoints: '0',
    activeTunnels: '0',
  };
}

/**
 * A local relay behind a gRPC channel that, once it failed, keeps failing until it is replaced: grpc-js waits out its
 * reconnect backoff and keeps the address it resolved, while the relay may come back elsewhere.
 */
function setup(persisted: unknown = null) {
  let relayUp = true;
  let channelFailed = false;
  const published: Array<Record<string, unknown>> = [];
  const getHealth = vi.fn(async () => {
    if (!relayUp) channelFailed = true;
    if (channelFailed) throw Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14 });
    return relayHealth();
  });
  const reconnectIfDown = vi.fn(() => {
    const replaced = channelFailed;
    channelFailed = false;
    return replaced;
  });
  const updateChain = { set: () => ({ where: async () => [] }) };
  const supervisor = new RelaySupervisorService(
    {
      update: () => updateChain,
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    } as never,
    { get: async () => persisted, set: async () => undefined } as never,
    { getHealth, reconnectIfDown } as never,
    null,
    { getConfig: async () => ({ relayAutoRecovery: false }) } as never,
    { publish: (_channel: string, payload: Record<string, unknown>) => published.push(payload) } as never,
    { log: vi.fn() } as never,
    { required: true, managed: false, expectedImage: null, expectedService: 'relay' }
  );
  return {
    supervisor,
    getHealth,
    reconnectIfDown,
    published,
    relay: (up: boolean) => {
      relayUp = up;
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('relay supervisor: a local relay that comes back', () => {
  it('is seen serving within about a second, on a fresh channel, while the regular probe waits 5 s (O-2)', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    await t.supervisor.start();
    t.relay(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.supervisor.getSnapshot(true)?.state).toBe('critical');
    expect(t.supervisor.latestOutage()?.servingAgainAt).toBeNull();

    // Back just after a regular probe: that probe's next turn is almost 5 s away.
    await vi.advanceTimersByTimeAsync(100);
    const backAt = Date.now();
    t.relay(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(t.supervisor.getSnapshot(true)?.state).toBe('healthy');
    expect(t.supervisor.latestOutage()!.servingAgainAt! - backAt).toBeLessThanOrEqual(1_500);
    await t.supervisor.stop();
  });

  it('reconnects Gateway’s other channels to the relay as soon as it serves again (F-2)', async () => {
    const t = setup();
    await t.supervisor.probeNow();
    t.relay(false);
    await t.supervisor.probeNow();
    await t.supervisor.probeNow();
    expect(t.supervisor.getSnapshot(true)?.state).toBe('critical');
    const before = t.reconnectIfDown.mock.calls.length;

    t.relay(true);
    // The supervisor's own channel came back (here: replaced by the return check); the others had not.
    await t.supervisor.watchReturn();
    expect(t.supervisor.getSnapshot(true)?.state).toBe('healthy');
    // Once for the check, once when the outage ended: the tunnel broker and policy channels reconnect now.
    expect(t.reconnectIfDown.mock.calls.length - before).toBe(2);
  });

  it('logs the reconnect of its channels at every return, also when the return watch had replaced them (O-6)', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const t = setup();
    await t.supervisor.probeNow();
    t.relay(false);
    await t.supervisor.probeNow();
    await t.supervisor.probeNow();
    t.relay(true);
    // The return check replaces the failed channel and finds the relay serving: at serving-again no channel is down.
    await t.supervisor.watchReturn();
    expect(t.supervisor.getSnapshot(true)?.state).toBe('healthy');
    const lines = info.mock.calls.filter(
      ([message]) => message === 'Gateway reconnected its channels to the local relay'
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toMatchObject({ replacedNow: false });
  });

  it('checks nothing while the relay serves or an update recreates it', async () => {
    const t = setup();
    await t.supervisor.probeNow();
    await t.supervisor.watchReturn();
    await t.supervisor.setMaintenance(true);
    await t.supervisor.watchReturn();
    expect(t.getHealth).toHaveBeenCalledTimes(1);
    expect(t.reconnectIfDown).not.toHaveBeenCalled();
  });
});

describe('relay supervisor: Gateway start', () => {
  const persistedOutage = {
    state: 'critical',
    reason: 'unreachable',
    attempt: 0,
    maxAttempts: 3,
    attemptHistory: [],
    lastHealthyAt: new Date(T0 - 60_000).toISOString(),
    lastProbeAt: new Date(T0 - 5_000).toISOString(),
    outage: { since: new Date(T0 - 60_000).toISOString(), servingAgainAt: null, planned: false },
  };

  it('restores an outage before its first answer, without probing the relay (O-5)', async () => {
    const t = setup(persistedOutage);
    expect(t.supervisor.getSnapshot(true)?.state).toBe('migration_pending');
    await t.supervisor.restore();
    expect(t.supervisor.getSnapshot(true)?.state).toBe('critical');
    expect(t.supervisor.latestOutage()).toEqual({ since: T0 - 60_000, servingAgainAt: null, planned: false });
    expect(t.supervisor.getSnapshot(false)?.outage?.phase).toBe('restarting');
    expect(t.getHealth).not.toHaveBeenCalled();
  });

  it('publishes its state once at start, so an alert the previous process left firing can resolve (F-1)', async () => {
    const t = setup({ ...persistedOutage, state: 'healthy', reason: null, outage: null });
    await t.supervisor.start();
    // Nothing changed (healthy then, healthy now), yet the evaluator gets the state.
    expect(t.published).toEqual([{ state: 'healthy', reason: null, attempt: 0 }]);
    await t.supervisor.stop();
  });
});
