import { describe, expect, it } from 'vitest';
import type { relayInstances } from '@/db/schema/index.js';
import { relayLatencyHealth } from '../grpc/services/health-report.js';
import { planRelays, RelayPoolService } from './relay-pool.service.js';
import {
  candidateTopology,
  chooseByRendezvous,
  chooseRelayAssignments,
  type EndpointLatencyPath,
  inDisconnectGrace,
  parseNodeRelayReachability,
  placementInstances,
  RELAY_DISCONNECT_GRACE_MS,
  RELAY_RETURN_HOLD_MS,
  relayDataPlaneFailures,
  samePlannedAssignments,
} from './relay-topology.js';

type RelayInstanceRow = typeof relayInstances.$inferSelect;

const NOW = Date.UTC(2026, 9, 8, 2, 20);

/** A relay of the pool in the incident's shape: local next to the nodes, UK near, NL far. */
function relay(id: string, overrides: Partial<RelayInstanceRow> = {}): RelayInstanceRow {
  return {
    id,
    poolId: 'system',
    kind: id === 'relay-local' ? 'local' : 'remote',
    nodeId: null,
    faultDomainId: `fd-${id}`,
    displayName: id,
    advertisedAddresses: [],
    servicePort: 9443,
    state: 'ready',
    manualDrainStartedAt: null,
    drainForcedAt: null,
    drainDeadlineAt: null,
    certificateIdentity: 'identity',
    certificateFingerprint: 'fingerprint',
    certificateExpiresAt: null,
    policySigningKeyId: null,
    policyPublicKeyFingerprint: null,
    buildVersion: null,
    protocolMajor: 1,
    capabilities: { protocolMajor: 1, features: ['relay_pool_v1'] },
    appliedPolicyRevision: 1,
    policyExpiresAt: null,
    lastSeenAt: new Date(NOW),
    health: { admissionState: 'ready' } as RelayInstanceRow['health'],
    desiredArtifact: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  } as RelayInstanceRow;
}

/** The NL relay whose control stream ended `ago` ms before NOW. */
function disconnected(ago: number, overrides: Partial<RelayInstanceRow> = {}) {
  return relay('relay-nl', { state: 'offline', lastSeenAt: new Date(NOW - ago), ...overrides });
}

/** Round trips (ms) every node measured: the endpoint and one source node. */
const path: EndpointLatencyPath = {
  endpoint: new Map([
    ['relay-local', 0.7],
    ['relay-uk', 62],
    ['relay-nl', 298],
  ]),
  sources: [
    new Map([
      ['relay-local', 0.7],
      ['relay-uk', 62],
      ['relay-nl', 298],
    ]),
  ],
};

const placedOnAll = [
  { relayInstanceId: 'relay-local', role: 'primary' },
  { relayInstanceId: 'relay-uk', role: 'fallback' },
  { relayInstanceId: 'relay-nl', role: 'fallback' },
];

function plan(instances: RelayInstanceRow[], reference = placedOnAll, holdBack?: ReadonlySet<string>) {
  const ready = new Set(instances.filter(({ state }) => state === 'ready').map(({ faultDomainId }) => faultDomainId));
  return planRelays('endpoint-1', instances, ready.size, false, path, reference, false, undefined, holdBack);
}

describe('Relay disconnect grace', () => {
  it('keeps a relay whose control stream ended in placement for 3 minutes', () => {
    const failing = new Set<string>();
    expect(inDisconnectGrace(disconnected(10_000), NOW, failing)).toBe(true);
    expect(inDisconnectGrace(disconnected(RELAY_DISCONNECT_GRACE_MS - 1), NOW, failing)).toBe(true);
    expect(inDisconnectGrace(disconnected(RELAY_DISCONNECT_GRACE_MS), NOW, failing)).toBe(false);
    // Only a relay that served: not one an operator drained, nor one that reported draining, nor the local relay.
    expect(inDisconnectGrace(disconnected(10_000, { manualDrainStartedAt: new Date(NOW) }), NOW, failing)).toBe(false);
    expect(
      inDisconnectGrace(
        disconnected(10_000, { health: { admissionState: 'draining' } as RelayInstanceRow['health'] }),
        NOW,
        failing
      )
    ).toBe(false);
    expect(inDisconnectGrace(relay('relay-local', { state: 'offline' }), NOW, failing)).toBe(false);
    expect(inDisconnectGrace(relay('relay-nl'), NOW, failing)).toBe(false);
  });

  it('changes no plan while the relay is within its grace, and drops it after 3 minutes', () => {
    const grace = new Set(['relay-nl']);
    const keep = new Set(placedOnAll.map(({ relayInstanceId }) => relayInstanceId));
    const flapping = [relay('relay-local'), relay('relay-uk'), disconnected(30_000)];
    const kept = plan(placementInstances(flapping, grace, keep));
    expect(samePlannedAssignments(placedOnAll, kept)).toBe(true);

    const gone = [relay('relay-local'), relay('relay-uk'), disconnected(RELAY_DISCONNECT_GRACE_MS + 1_000)];
    const graceOver = new Set(
      gone.filter((instance) => inDisconnectGrace(instance, NOW, new Set())).map(({ id }) => id)
    );
    const replanned = plan(placementInstances(gone, graceOver, keep));
    expect(replanned.map(({ instance }) => instance.id).sort()).toEqual(['relay-local', 'relay-uk']);
  });

  it('adds no new work to a relay in its grace: it stays only where it already serves', () => {
    const instances = placementInstances(
      [relay('relay-local'), relay('relay-uk'), disconnected(30_000)],
      new Set(['relay-nl']),
      new Set(['relay-local', 'relay-uk'])
    );
    expect(instances.find(({ id }) => id === 'relay-nl')?.state).toBe('offline');
  });

  it('evacuates a relay at once when the daemons that measure it fail to reach it', () => {
    const failing = relayDataPlaneFailures([
      [
        { relayInstanceId: 'relay-nl', failingMs: 20_000 },
        { relayInstanceId: 'relay-uk', failingMs: 0 },
      ],
      [{ relayInstanceId: 'relay-nl', failingMs: 16_000 }],
    ]);
    expect([...failing]).toEqual(['relay-nl']);
    expect(inDisconnectGrace(disconnected(20_000), NOW, failing)).toBe(false);
    const instances = [relay('relay-local'), relay('relay-uk'), disconnected(20_000)];
    const grace = new Set(
      instances.filter((instance) => inDisconnectGrace(instance, NOW, failing)).map(({ id }) => id)
    );
    const evacuated = plan(placementInstances(instances, grace, new Set(['relay-local', 'relay-uk', 'relay-nl'])));
    expect(evacuated.map(({ instance }) => instance.id).sort()).toEqual(['relay-local', 'relay-uk']);
  });

  it('keeps the grace while any node still reaches the relay, or a failure is still short', () => {
    expect(
      relayDataPlaneFailures([
        [{ relayInstanceId: 'relay-nl', failingMs: 60_000 }],
        [{ relayInstanceId: 'relay-nl', failingMs: 0 }],
      ]).size
    ).toBe(0);
    expect(relayDataPlaneFailures([[{ relayInstanceId: 'relay-nl', failingMs: 5_000 }]]).size).toBe(0);
    // A daemon without failure reports always counts as reaching the relay.
    expect(parseNodeRelayReachability([{ relayInstanceId: 'relay-nl', rttMs: 298 }])).toEqual([
      { relayInstanceId: 'relay-nl', failingMs: 0 },
    ]);
  });

  it('stores how long a daemon failed to reach each relay with its health report', () => {
    expect(
      relayLatencyHealth([
        { relayInstanceId: 'relay-nl', rttMicros: 298000, failingMs: 18000 },
        { relayInstanceId: 'relay-uk', rttMicros: 62000 },
      ])
    ).toEqual({
      relayLatencies: [
        { relayInstanceId: 'relay-nl', rttMs: 298, failingMs: 18000 },
        { relayInstanceId: 'relay-uk', rttMs: 62 },
      ],
    });
  });
});

describe('Relay coming back', () => {
  it('fills a free slot only: it neither becomes a primary nor displaces a serving relay', () => {
    const nearerNl: EndpointLatencyPath = {
      endpoint: new Map([
        ['relay-local', 40],
        ['relay-uk', 62],
        ['relay-nl', 1],
      ]),
      sources: [],
    };
    const reference = [
      { relayInstanceId: 'relay-local', role: 'primary' },
      { relayInstanceId: 'relay-uk', role: 'fallback' },
    ];
    const instances = [relay('relay-local'), relay('relay-uk'), relay('relay-nl')];
    const held = chooseRelayAssignments('endpoint-1', instances, 3, nearerNl, reference, new Set(['relay-nl']));
    expect(held.find(({ instance }) => instance.id === 'relay-nl')?.role).toBe('fallback');
    expect(held.find(({ instance }) => instance.id === 'relay-local')?.role).toBe('primary');
    // With two slots it takes none of them while the relays there serve.
    for (const endpointId of ['endpoint-1', 'endpoint-2', 'endpoint-3', 'endpoint-4', 'endpoint-5', 'endpoint-6']) {
      const chosen = chooseByRendezvous(
        endpointId,
        instances,
        2,
        [],
        new Set(['relay-local', 'relay-uk']),
        new Set(['relay-nl'])
      );
      expect(chosen.map(({ id }) => id).sort()).toEqual(['relay-local', 'relay-uk']);
    }
  });

  it('holds back a relay that served again only for a while', () => {
    const service = new RelayPoolService({} as never, {} as never, {} as never, {} as never, {} as never);
    const view = (instances: RelayInstanceRow[], at: number) =>
      (
        service as unknown as {
          placementView(
            instances: RelayInstanceRow[],
            failing: ReadonlySet<string>,
            now: number
          ): {
            grace: Set<string>;
            holdBack: Set<string>;
            readyFaultDomains: Set<string>;
            instancesFor(current: Array<{ relayInstanceId: string }>): RelayInstanceRow[];
          };
        }
      ).placementView(instances, new Set(), at);
    // A short control-stream loss: kept, counted among the fault domains, never held back.
    const flap = view([relay('relay-local'), relay('relay-uk'), disconnected(30_000)], NOW);
    expect([...flap.grace]).toEqual(['relay-nl']);
    expect(flap.readyFaultDomains.size).toBe(3);
    expect(flap.instancesFor([{ relayInstanceId: 'relay-nl' }]).find(({ id }) => id === 'relay-nl')?.state).toBe(
      'ready'
    );
    expect(view([relay('relay-local'), relay('relay-uk'), relay('relay-nl')], NOW + 60_000).holdBack.size).toBe(0);
    // Gone past its grace, then back: held back for RELAY_RETURN_HOLD_MS.
    const gone = view([relay('relay-local'), relay('relay-uk'), disconnected(RELAY_DISCONNECT_GRACE_MS + 1)], NOW);
    expect(gone.grace.size).toBe(0);
    expect(gone.readyFaultDomains.size).toBe(2);
    expect([...view([relay('relay-local'), relay('relay-uk'), relay('relay-nl')], NOW + 1_000).holdBack]).toEqual([
      'relay-nl',
    ]);
    expect(
      view([relay('relay-local'), relay('relay-uk'), relay('relay-nl')], NOW + RELAY_RETURN_HOLD_MS + 1).holdBack.size
    ).toBe(0);
  });
});

describe('Candidate topology', () => {
  it('gives an endpoint placed without latency data primaries, so daemons still order its relays by distance', () => {
    expect(candidateTopology('active')).toEqual({ role: 'primary', endpointRttMicros: 0 });
    expect(candidateTopology('primary')).toEqual({ role: 'primary', endpointRttMicros: 0 });
    expect(candidateTopology('fallback')).toEqual({ role: 'standby', endpointRttMicros: 0 });
  });
});
