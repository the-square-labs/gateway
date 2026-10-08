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

function paths(outage: () => LocalRelayOutage | null, now: () => number) {
  const registry = { liveSessions: vi.fn(() => [] as any[]), schedule: vi.fn(), timers: { setTimeout: vi.fn() } };
  const fetchCandidates = vi.fn(async () => [local, nl, uk]);
  // The stand's netem: NL 300 ms, UK 60 ms from Gateway.
  const rtts: Record<string, number> = { '198.51.100.2': 300, '198.51.100.3': 60 };
  const dial = async (address: string) => {
    if (!(address in rtts)) throw new Error('connect ECONNREFUSED');
    return rtts[address]!;
  };
  const instance = new GatewayRelayPaths(registry as never, fetchCandidates, { now, dial });
  instance.setLocalRelay({ latestOutage: outage });
  return { instance, registry, fetchCandidates };
}

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
        return { relayId: candidate.relayInstanceId };
      }),
    };
    const service = new RelayPolicyService({} as never, {} as never, {} as never, relay as never);
    service.setLocalRelayOutage({
      latestOutage: () => ({ since: Date.now() - 10_000, servingAgainAt: null, planned: false }),
    });
    const internals = service as any;
    internals.gatewayPaths().observe('relay-nl', 300);
    internals.gatewayPaths().observe('relay-uk', 60);
    const path = await internals.openGatewayResumePath('route-1', { candidates: [local, nl, uk] }, null);
    expect(path.relayId).toBe('relay-uk');
    expect(opened).toEqual(['relay-uk']);
    internals.gatewayPaths().stop();
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

  it('moves streams back to the local relay only after it served for a minute, a batch a pass, spread over the pass', async () => {
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
    const sessions = Array.from({ length: 10 }, (_, index) => session(index, T0));
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
    // It serves again, but not for a minute yet.
    outage.servingAgainAt = now;
    now += GATEWAY_RETURN_STABLE_MS - 1_000;
    expect(await t.instance.returnPass()).toBe(0);
    now += 1_000;
    expect(await t.instance.returnPass()).toBe(8);
    expect(sessions.filter((s) => s.migrate.mock.calls.length > 0)).toHaveLength(8);
    for (const s of sessions) for (const call of s.migrate.mock.calls) expect(call).toEqual(['return']);
    expect(Math.max(...delays)).toBeLessThan(GATEWAY_RETURN_INTERVAL_MS);
    // Judged again on a fresh assignment once the candidates it dialed are old.
    expect(t.fetchCandidates).toHaveBeenCalled();
    t.instance.stop();
  });

  it('leaves a stream that moved within the last minute where it is', async () => {
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
