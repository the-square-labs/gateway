import { describe, expect, it, vi } from 'vitest';
import { RelayResumeRegistry } from '@/grpc/relay-resume.js';
import {
  GATEWAY_RETURN_COOLDOWN_MS,
  GATEWAY_RETURN_INTERVAL_MS,
  GATEWAY_RETURN_STABLE_MS,
  type GatewayRelayCandidate,
  GatewayRelayPaths,
  gatewayReturnTarget,
  orderGatewayRelayCandidates,
} from './gateway-relay-paths.js';
import type { LocalRelayOutage } from './local-relay-outage.js';
import { RelayPolicyService } from './relay-policy.service.js';

const T0 = Date.UTC(2026, 9, 8, 14, 0);
/** A candidate as an assignment carries it: its grant and the relay's identity (the tunnel worker opens the path). */
const assigned = (candidate: GatewayRelayCandidate) => ({
  ...candidate,
  certificateIdentity: candidate.relayInstanceId,
  certificateFingerprint: 'sha256:00',
  grant: { keyId: 'grant', payload: Buffer.from('payload'), signature: Buffer.from('signature') },
});

// The stand's endpoints: `local:primary, nl:fallback, uk:fallback`, NL listed before UK.
const local: GatewayRelayCandidate = {
  relayInstanceId: 'relay-local',
  assignmentState: 'active',
  addresses: ['gateway.example'],
  port: 443,
  local: true,
  topology: { role: 'primary' },
};
const nl: GatewayRelayCandidate = {
  relayInstanceId: 'relay-nl',
  assignmentState: 'active',
  addresses: ['198.51.100.2'],
  port: 9443,
  topology: { role: 'standby' },
};
const uk: GatewayRelayCandidate = {
  relayInstanceId: 'relay-uk',
  assignmentState: 'active',
  addresses: ['198.51.100.3'],
  port: 9443,
  topology: { role: 'standby' },
};

function paths(outage: () => LocalRelayOutage | null, now: () => number, pool?: GatewayRelayCandidate[]) {
  const registry = { liveSessions: vi.fn(() => [] as any[]), schedule: vi.fn(), timers: { setTimeout: vi.fn() } };
  const fetchCandidates = vi.fn(async () => [local, nl, uk]);
  // The stand's netem: NL 300 ms, UK 60 ms from Gateway.
  const rtts: Record<string, number> = { '198.51.100.2': 300, '198.51.100.3': 60 };
  const dials: string[] = [];
  const dial = async (address: string) => {
    dials.push(address);
    if (!(address in rtts)) throw new Error('connect ECONNREFUSED');
    return rtts[address]!;
  };
  const poolRelays = pool ? async () => pool : undefined;
  const instance = new GatewayRelayPaths(registry as never, fetchCandidates, { now, dial, poolRelays });
  instance.setLocalRelay({ latestOutage: outage });
  return { instance, registry, fetchCandidates, dials };
}

const ids = (candidates: GatewayRelayCandidate[]) => candidates.map(({ relayInstanceId }) => relayInstanceId);

describe("Gateway's own relayed streams choose relays by distance (O-1)", () => {
  it('takes the nearest standby, not the first listed, while the local relay does not serve', () => {
    let now = T0;
    const outage: LocalRelayOutage = { since: T0, servingAgainAt: null, planned: false };
    const t = paths(
      () => outage,
      () => now
    );
    t.instance.observe('relay-nl', 300);
    t.instance.observe('relay-uk', 60);
    now += 1_000;
    expect(t.instance.order('route-1', [local, nl, uk], null).map(({ relayInstanceId }) => relayInstanceId)).toEqual([
      'relay-uk',
      'relay-nl',
      'relay-local',
    ]);
    // Serving again: the local primary comes first for new streams at once.
    outage.servingAgainAt = now;
    expect(t.instance.order('route-1', [local, nl, uk], null)[0]).toBe(local);
    // The relay being left goes last; staging candidates follow active ones.
    expect(orderGatewayRelayCandidates([local, nl, uk], (c) => t.instance.place(c), 'relay-local')).toEqual([
      uk,
      nl,
      local,
    ]);
    t.instance.stop();
  });

  it('puts relays it cannot reach after the reachable ones, and unmeasured ones after measured ones', () => {
    const t = paths(
      () => null,
      () => T0
    );
    t.instance.observe('relay-uk', null);
    t.instance.observe('relay-nl', 300);
    const third = { ...uk, relayInstanceId: 'relay-new' };
    expect(
      orderGatewayRelayCandidates([uk, third, nl], (c) => t.instance.place(c)).map(
        ({ relayInstanceId }) => relayInstanceId
      )
    ).toEqual(['relay-nl', 'relay-new', 'relay-uk']);
  });

  it('opens the stream on the nearest reachable relay (RelayPolicyService)', async () => {
    const opened: string[] = [];
    const relay = {
      applySnapshot: vi.fn(),
      resumeRegistry: new RelayResumeRegistry(),
      openLocalResumePath: vi.fn(async () => {
        opened.push('relay-local');
        throw new Error('14 UNAVAILABLE');
      }),
      openCandidateResumePath: vi.fn(async (candidate: GatewayRelayCandidate) => {
        opened.push(candidate.relayInstanceId);
        return { relayId: candidate.relayInstanceId, cancel: vi.fn() };
      }),
    };
    const service = new RelayPolicyService({} as never, {} as never, {} as never, relay as never);
    service.setLocalRelayOutage({
      latestOutage: () => ({ since: Date.now() - 10_000, servingAgainAt: null, planned: false }),
    });
    const internals = service as any;
    internals.gatewayPaths().observe('relay-nl', 300);
    internals.gatewayPaths().observe('relay-uk', 60);
    const path = await internals.openGatewayResumePath('route-1', { candidates: [local, nl, uk].map(assigned) }, null);
    expect(path.relayId).toBe('relay-uk');
    expect(opened).toEqual(['relay-uk']);
    internals.gatewayPaths().stop();
  });
});

describe("Gateway's own relayed streams know every relay's distance after a quiet period (F-3)", () => {
  it('measures every remote relay of the pool, not only those its recent assignments named', async () => {
    let now = T0;
    const t = paths(
      () => null,
      () => now,
      [nl, uk]
    );
    // Gateway opened its long-lived streams at T0 and no new path for 31 minutes; the pool was measured meanwhile.
    t.instance.note('route-1', [local, nl, uk]);
    for (; now <= T0 + 31 * 60_000; now += 30_000) await t.instance.sample();
    expect(t.dials.filter((address) => address === '198.51.100.3').length).toBeGreaterThan(60);
    // The local relay stops gracefully: the streams take UK, not NL listed first.
    const draining: LocalRelayOutage = { since: now, servingAgainAt: null, planned: true };
    t.instance.setLocalRelay({ latestOutage: () => draining });
    expect(ids(t.instance.order('route-1', [local, nl, uk], 'relay-local'))).toEqual([
      'relay-uk',
      'relay-nl',
      'relay-local',
    ]);
    t.instance.stop();
  });

  it('orders by the last round trip it measured until a fresher one exists', () => {
    let now = T0;
    const t = paths(
      () => ({ since: T0, servingAgainAt: null, planned: true }),
      () => now
    );
    t.instance.observe('relay-nl', 300);
    t.instance.observe('relay-uk', 60);
    now += 31 * 60_000;
    expect(ids(t.instance.order('route-1', [local, nl, uk], 'relay-local'))).toEqual([
      'relay-uk',
      'relay-nl',
      'relay-local',
    ]);
    // Old round trips make no relay stable for a return.
    expect(t.instance.place(uk)).toMatchObject({ available: true, rttMs: 60, stable: false });
    t.instance.stop();
  });

  it('waits for the first round trip of relays it never measured before ordering a new stream', async () => {
    const t = paths(
      () => ({ since: T0, servingAgainAt: null, planned: false }),
      () => T0
    );
    expect(ids(t.instance.order('route-0', [nl, uk], null))).toEqual(['relay-nl', 'relay-uk']);
    await t.instance.measure('route-1', [local, nl, uk]);
    expect(ids(t.instance.order('route-1', [local, nl, uk], null))).toEqual(['relay-uk', 'relay-nl', 'relay-local']);
    // Measured relays cost the next stream nothing.
    const before = t.dials.length;
    await t.instance.measure('route-1', [local, nl, uk]);
    expect(t.dials.length).toBe(before);
    t.instance.stop();
  });

  it('gives up waiting for an unreachable relay within the bound', async () => {
    const t = paths(
      () => null,
      () => T0
    );
    const silent = { ...uk, relayInstanceId: 'relay-silent', addresses: ['198.51.100.9'] };
    const instance = new GatewayRelayPaths(t.registry as never, t.fetchCandidates, {
      now: () => T0,
      dial: () => new Promise<number>(() => undefined),
    });
    const started = Date.now();
    await instance.measure('route-1', [silent], 50);
    expect(Date.now() - started).toBeLessThan(1_000);
    instance.stop();
    t.instance.stop();
  });

  it("opens a stream on the nearest relay right after Gateway's start (RelayPolicyService)", async () => {
    const opened: string[] = [];
    const relay = {
      applySnapshot: vi.fn(),
      resumeRegistry: new RelayResumeRegistry(),
      openLocalResumePath: vi.fn(async () => {
        opened.push('relay-local');
        throw new Error('14 UNAVAILABLE');
      }),
      openCandidateResumePath: vi.fn(async (candidate: GatewayRelayCandidate) => {
        opened.push(candidate.relayInstanceId);
        return { relayId: candidate.relayInstanceId, cancel: vi.fn() };
      }),
    };
    const service = new RelayPolicyService({} as never, {} as never, {} as never, relay as never);
    const t = paths(() => ({ since: Date.now() - 10_000, servingAgainAt: null, planned: false }), Date.now);
    (service as any).gatewayRelayPaths = t.instance;
    const path = await (service as any).openGatewayResumePath(
      'route-1',
      { candidates: [local, nl, uk].map(assigned) },
      null
    );
    expect(path.relayId).toBe('relay-uk');
    expect(opened).toEqual(['relay-uk']);
    t.instance.stop();
  });
});

describe("Gateway's own relayed streams return to the nearest relay, paced (O-1)", () => {
  it('judges a return target as the daemons do', () => {
    const t = paths(
      () => null,
      () => T0 + 10 * 60_000
    );
    t.instance.observe('relay-uk', 60);
    t.instance.observe('relay-nl', 300);
    const place = (c: GatewayRelayCandidate) => t.instance.place(c);
    // Not stable yet: measured once, just now.
    expect(gatewayReturnTarget([local, nl, uk], place, 'relay-nl')).toBe(local);
    expect(gatewayReturnTarget([nl, uk], place, 'relay-nl')).toBeNull();
    // Already on the nearest.
    expect(gatewayReturnTarget([local, nl, uk], place, 'relay-local')).toBeNull();
    // Not in the assignment (left by its generation): nothing to judge.
    expect(gatewayReturnTarget([local, uk], place, 'relay-nl')).toBeNull();
  });

  it('moves streams back to the local relay only after it served for a while, a batch a pass, spread over the pass', async () => {
    let now = T0;
    const outage: LocalRelayOutage = { since: T0, servingAgainAt: null, planned: false };
    const t = paths(
      () => outage,
      () => now
    );
    t.instance.observe('relay-uk', 60);
    t.instance.note('route-1', [local, nl, uk]);
    const session = (id: number, lastMoveAt: number) => ({
      relayId: 'relay-uk',
      routeId: 'route-1',
      movable: true,
      lastMoveAt,
      migrate: vi.fn(async () => undefined),
      id,
    });
    const sessions = Array.from({ length: 40 }, (_, index) => session(index, T0));
    sessions.push({ ...session(10, T0), relayId: null as never });
    t.registry.liveSessions.mockReturnValue(sessions);
    const delays: number[] = [];
    t.registry.timers.setTimeout.mockImplementation((task: () => void, delay: number) => {
      delays.push(delay);
      task();
    });
    t.registry.schedule.mockImplementation((task: () => Promise<unknown>) => void task());

    // The local relay does not serve: the streams stay on UK.
    now = T0 + 2 * 60_000;
    expect(await t.instance.returnPass()).toBe(0);
    // It serves again, but not for GATEWAY_RETURN_STABLE_MS yet.
    outage.servingAgainAt = now;
    now += GATEWAY_RETURN_STABLE_MS - 1_000;
    expect(await t.instance.returnPass()).toBe(0);
    now += 1_000;
    // A node's worth of streams comes back within two passes (stand rc.7, F-3: 8 a pass took over a minute).
    expect(await t.instance.returnPass()).toBe(32);
    expect(sessions.filter((s) => s.migrate.mock.calls.length > 0)).toHaveLength(32);
    for (const s of sessions) for (const call of s.migrate.mock.calls) expect(call).toEqual(['return']);
    expect(Math.max(...delays)).toBeLessThan(GATEWAY_RETURN_INTERVAL_MS);
    // Judged again on a fresh assignment once the candidates it dialed are old.
    expect(t.fetchCandidates).toHaveBeenCalled();
    t.instance.stop();
  });

  it('leaves a stream that moved within the cooldown where it is', async () => {
    let now = T0 + 10 * 60_000;
    const t = paths(
      () => ({ since: T0, servingAgainAt: T0 + 60_000, planned: false }),
      () => now
    );
    t.instance.observe('relay-uk', 60);
    t.instance.note('route-1', [local, nl, uk]);
    const migrate = vi.fn(async () => undefined);
    t.registry.liveSessions.mockReturnValue([
      {
        relayId: 'relay-uk',
        routeId: 'route-1',
        movable: true,
        lastMoveAt: now - GATEWAY_RETURN_COOLDOWN_MS + 1,
        migrate,
      },
      { relayId: 'relay-uk', routeId: 'route-1', movable: false, lastMoveAt: T0, migrate },
    ]);
    expect(await t.instance.returnPass()).toBe(0);
    now += 1;
    t.registry.timers.setTimeout.mockImplementation((task: () => void) => task());
    t.registry.schedule.mockImplementation((task: () => Promise<unknown>) => void task());
    expect(await t.instance.returnPass()).toBe(1);
    expect(migrate).toHaveBeenCalledWith('return');
    t.instance.stop();
  });

  it('returns a stream to the relay a later placement put back, judged on the current assignment (stand rc.7, F-3)', async () => {
    // The stream moved to UK while the local relay drained in a Relay Pool update and dialed that generation's
    // relays, UK and NL. The placement after the update put the local relay back as the primary.
    let now = T0;
    const t = paths(
      () => ({ since: T0 - 10 * 60_000, servingAgainAt: T0 - 9 * 60_000, planned: true }),
      () => now
    );
    t.instance.observe('relay-uk', 60);
    t.instance.observe('relay-nl', 300);
    t.instance.note('route-1', [{ ...uk, topology: { role: 'primary' } }, nl]);
    t.fetchCandidates.mockResolvedValue([local, uk]);
    const migrate = vi.fn(async () => undefined);
    t.registry.liveSessions.mockReturnValue([
      { relayId: 'relay-uk', routeId: 'route-1', movable: true, lastMoveAt: T0, migrate },
    ]);
    t.registry.timers.setTimeout.mockImplementation((task: () => void) => task());
    t.registry.schedule.mockImplementation((task: () => Promise<unknown>) => void task());
    now += 31_000;
    expect(await t.instance.returnPass()).toBe(1);
    expect(t.fetchCandidates).toHaveBeenCalledWith('route-1');
    expect(migrate).toHaveBeenCalledWith('return');
    t.instance.stop();
  });

  it('judges its streams on a new assignment as soon as it is active (stand rc.8, F-2)', async () => {
    // The local relay drained in a Relay Pool update onto `local:primary, nl:fallback`: the stream went to NL. Then
    // `uk:primary, nl:fallback` became active; Gateway's streams stayed on NL for 80 s, judged on the old assignment.
    let now = T0;
    const t = paths(
      () => null,
      () => now
    );
    t.instance.observe('relay-uk', 60);
    t.instance.observe('relay-nl', 300);
    now += GATEWAY_RETURN_STABLE_MS;
    t.instance.observe('relay-uk', 60);
    t.instance.observe('relay-nl', 300);
    t.instance.note('route-1', [{ ...local, assignmentState: 'draining' }, nl]);
    t.fetchCandidates.mockResolvedValue([{ ...uk, topology: { role: 'primary' } }, nl]);
    const migrate = vi.fn(async () => undefined);
    t.registry.liveSessions.mockReturnValue([
      { relayId: 'relay-nl', routeId: 'route-1', movable: true, lastMoveAt: T0, migrate },
    ]);
    t.registry.timers.setTimeout.mockImplementation((task: () => void) => task());
    t.registry.schedule.mockImplementation((task: () => Promise<unknown>) => void task());
    // The candidates it dialed are a second old: without the activation it would look again only after 30 s.
    now += 1_000;
    expect(await t.instance.returnPass()).toBe(0);
    t.instance.assignmentsChanged();
    expect(await t.instance.returnPass()).toBe(1);
    expect(migrate).toHaveBeenCalledWith('return');
    t.instance.stop();
  });

  it('returns a stream on the far standby to the near one while the local relay stays down', async () => {
    let now = T0;
    const t = paths(
      () => ({ since: T0, servingAgainAt: null, planned: false }),
      () => now
    );
    t.instance.observe('relay-uk', 60);
    t.instance.observe('relay-nl', 300);
    t.instance.note('route-1', [local, nl, uk]);
    now += GATEWAY_RETURN_STABLE_MS;
    t.instance.observe('relay-uk', 60);
    t.instance.observe('relay-nl', 300);
    t.instance.note('route-1', [local, nl, uk]);
    const migrate = vi.fn(async () => undefined);
    t.registry.liveSessions.mockReturnValue([
      { relayId: 'relay-nl', routeId: 'route-1', movable: true, lastMoveAt: T0, migrate },
    ]);
    t.registry.timers.setTimeout.mockImplementation((task: () => void) => task());
    t.registry.schedule.mockImplementation((task: () => Promise<unknown>) => void task());
    expect(await t.instance.returnPass()).toBe(1);
    t.instance.stop();
  });
});
