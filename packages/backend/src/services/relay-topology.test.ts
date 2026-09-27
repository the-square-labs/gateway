import { describe, expect, it } from 'vitest';
import { relayLatencyHealth } from '@/grpc/services/health-report.js';
import {
  attachEndpointRtts,
  chooseByRendezvous,
  chooseRelayAssignments,
  type EndpointLatencyPath,
  relayPathCost,
  samePlannedAssignments,
} from './relay-topology.js';

const ENDPOINT = '20000000-0000-4000-8000-000000000001';

function relay(name: string, state = 'ready') {
  return { id: name, faultDomainId: `domain-${name}`, state, health: { pressurePercent: 0 } } as any;
}

const [nearA, nearB, far, farther] = ['near-a', 'near-b', 'far', 'farther'].map((name) => relay(name));
const pool = [nearA, nearB, far, farther];

/** Endpoint and source both sit next to near-a and near-b. */
function path(overrides: Record<string, number> = {}): EndpointLatencyPath {
  const rtts = { 'near-a': 0.4, 'near-b': 0.9, far: 18, farther: 35, ...overrides };
  return { endpoint: new Map(Object.entries(rtts)), sources: [new Map(Object.entries(rtts))] };
}

function plan(assignments: ReturnType<typeof chooseRelayAssignments>) {
  return assignments.map(({ instance, role }) => `${instance.id}:${role}`);
}

describe('relay path cost', () => {
  it('adds the endpoint side to the average source side', () => {
    const measured: EndpointLatencyPath = {
      endpoint: new Map([['r', 2]]),
      sources: [new Map([['r', 4]]), new Map([['r', 10]])],
    };
    expect(relayPathCost(measured, 'r')).toBe(9);
  });

  it('is unknown when the endpoint or any reporting source did not measure the relay', () => {
    expect(relayPathCost({ endpoint: undefined, sources: [] }, 'r')).toBeUndefined();
    expect(relayPathCost({ endpoint: new Map([['r', 1]]), sources: [new Map()] }, 'r')).toBeUndefined();
    expect(relayPathCost({ endpoint: new Map([['r', 1]]), sources: [] }, 'r')).toBe(1);
  });
});

describe('relay placement by network distance', () => {
  it('places by rendezvous score, all active, without latency data', () => {
    const expected = chooseByRendezvous(ENDPOINT, pool, 2).map(({ id }) => `${id}:active`);
    expect(plan(chooseRelayAssignments(ENDPOINT, pool, 2, undefined))).toEqual(expected);
    expect(plan(chooseRelayAssignments(ENDPOINT, pool, 2, { endpoint: undefined, sources: [] }))).toEqual(expected);
  });

  it('makes every equally near relay primary and fills the other slots with standbys', () => {
    const planned = chooseRelayAssignments(ENDPOINT, pool, 3, path());
    expect(plan(planned).slice(0, 2)).toEqual(['near-a:primary', 'near-b:primary']);
    expect(planned).toHaveLength(3);
    expect(planned[2]?.role).toBe('fallback');
    expect(['far', 'farther']).toContain(planned[2]?.instance.id);
  });

  it('keeps the spread count when more relays are equally near than slots', () => {
    expect(plan(chooseRelayAssignments(ENDPOINT, pool, 1, path()))).toEqual(['near-a:primary']);
  });

  it('counts a relay as equally near within 20% or 3 ms of the best', () => {
    // 0.8 ms against 3.6 ms: within 3 ms.
    const planned = chooseRelayAssignments(ENDPOINT, pool, 2, path({ 'near-a': 0.4, 'near-b': 1.8 }));
    expect(plan(planned)).toEqual(['near-a:primary', 'near-b:primary']);
    // 60 ms against 70 ms: within 20%.
    const distant = chooseRelayAssignments(ENDPOINT, pool, 2, path({ 'near-a': 30, 'near-b': 35, far: 50 }));
    expect(plan(distant)).toEqual(['near-a:primary', 'near-b:primary']);
    // 20 ms against 30 ms: outside both.
    const apart = chooseRelayAssignments(ENDPOINT, [nearA, nearB], 2, path({ 'near-a': 10, 'near-b': 15 }));
    expect(plan(apart)).toEqual(['near-a:primary', 'near-b:fallback']);
  });

  it('leaves unmeasured relays out of the primaries', () => {
    const measured: EndpointLatencyPath = { endpoint: new Map([['far', 18]]), sources: [] };
    const planned = chooseRelayAssignments(ENDPOINT, pool, 2, measured);
    expect(plan(planned)[0]).toBe('far:primary');
    expect(planned[1]?.role).toBe('fallback');
  });

  it('keeps the current primaries unless a relay is clearly nearer', () => {
    const current = [
      { relayInstanceId: 'far', role: 'primary' },
      { relayInstanceId: 'farther', role: 'fallback' },
    ];
    // far costs 2 × 18 = 36 ms; near-a 2 × 14 = 28 ms is nearer, but not below 0.7 × 36.
    const slightly = chooseRelayAssignments(ENDPOINT, pool, 2, path({ 'near-a': 14, 'near-b': 30 }), current);
    expect(plan(slightly)[0]).toBe('far:primary');
    // Below 0.7 × but less than 5 ms better: stays too.
    const tiny = chooseRelayAssignments(
      ENDPOINT,
      pool,
      2,
      path({ 'near-a': 0.5, 'near-b': 9, far: 2, farther: 9 }),
      current
    );
    expect(plan(tiny)[0]).toBe('far:primary');
    // Clearly nearer: the primaries move.
    const clearly = chooseRelayAssignments(ENDPOINT, pool, 2, path(), current);
    expect(plan(clearly)).toEqual(['near-a:primary', 'near-b:primary']);
  });

  it('replaces current primaries that no longer serve', () => {
    const current = [{ relayInstanceId: 'far', role: 'primary' }];
    const offlineFar = relay('far', 'offline');
    const planned = chooseRelayAssignments(ENDPOINT, [nearA, nearB, offlineFar, farther], 2, path(), current);
    expect(plan(planned)).toEqual(['near-a:primary', 'near-b:primary']);
  });

  it('keeps a latency placement while reports lapse, and hashes once its primaries are gone', () => {
    const current = [
      { relayInstanceId: 'near-a', role: 'primary' },
      { relayInstanceId: 'far', role: 'fallback' },
    ];
    const kept = chooseRelayAssignments(ENDPOINT, pool, 2, undefined, current);
    expect(plan(kept)[0]).toBe('near-a:primary');
    expect(kept.map(({ role }) => role)).toEqual(['primary', 'fallback']);
    const gone = chooseRelayAssignments(ENDPOINT, [relay('near-a', 'offline'), nearB, far], 2, undefined, current);
    expect(gone.every(({ role }) => role === 'active')).toBe(true);
  });
});

describe('relay placement comparison', () => {
  it('sees a role change as a new placement', () => {
    const planned = [
      { instance: nearA, role: 'primary' as const },
      { instance: far, role: 'fallback' as const },
    ];
    const asPlanned = [
      { relayInstanceId: 'far', role: 'fallback' },
      { relayInstanceId: 'near-a', role: 'primary' },
    ];
    expect(samePlannedAssignments(asPlanned, planned)).toBe(true);
    expect(
      samePlannedAssignments(
        asPlanned.map((row) => ({ ...row, role: 'active' })),
        planned
      )
    ).toBe(false);
    expect(samePlannedAssignments(asPlanned.slice(0, 1), planned)).toBe(false);
  });
});

describe('relay latency reporting', () => {
  it('gives placed candidates the endpoint side of their path', () => {
    const grants = [
      {
        targetEndpointId: 'endpoint',
        candidates: [
          { relayInstanceId: 'near-a', topology: { role: 'primary', endpointRttMicros: 0 } },
          { relayInstanceId: 'unmeasured', topology: { role: 'standby', endpointRttMicros: 0 } },
          { relayInstanceId: 'near-b' },
        ],
      },
    ];
    attachEndpointRtts(
      grants,
      new Map([['endpoint', 'node']]),
      new Map([
        [
          'node',
          new Map([
            ['near-a', 0.4],
            ['near-b', 1],
          ]),
        ],
      ])
    );
    expect(grants[0]?.candidates).toEqual([
      { relayInstanceId: 'near-a', topology: { role: 'primary', endpointRttMicros: 400 } },
      { relayInstanceId: 'unmeasured', topology: { role: 'standby', endpointRttMicros: 0 } },
      { relayInstanceId: 'near-b' },
    ]);
  });

  it('stores reported round trips in milliseconds and omits an empty report', () => {
    expect(
      relayLatencyHealth([
        { relayInstanceId: 'near-a', rttMicros: 412 },
        { relayInstanceId: '', rttMicros: 5 },
        { relayInstanceId: 'bad', rttMicros: 0 },
      ])
    ).toEqual({ relayLatencies: [{ relayInstanceId: 'near-a', rttMs: 0.412 }] });
    expect(relayLatencyHealth([])).toEqual({});
    expect(relayLatencyHealth(undefined)).toEqual({});
  });
});
