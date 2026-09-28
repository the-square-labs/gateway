import { describe, expect, it } from 'vitest';
import {
  type RelayPolicySnapshotInput,
  relayPolicySnapshotContent,
  relayPolicySnapshotKey,
} from './relay-policy-snapshot-content.js';

const endpoint = (id: string) =>
  ({
    id,
    generation: 1,
    ownerKind: 'proxy_host_secure_link',
    ownerId: `owner-${id}`,
    subjectKind: 'daemon',
    subjectId: 'node-1',
    certificateSha256: 'sha256:node',
    maxConcurrentSessions: 16,
  }) as RelayPolicySnapshotInput['endpoints'][number];

const route = (id: string, targetEndpointId: string) =>
  ({
    id,
    generation: 1,
    ownerKind: 'managed_database_binding',
    ownerId: `owner-${id}`,
    sourceKind: 'daemon',
    sourceId: 'node-2',
    sourceCertificateSha256: 'sha256:source',
    targetEndpointId,
    maxConcurrentSessions: 16,
    maxFrameBytes: 1024,
  }) as RelayPolicySnapshotInput['routes'][number];

function input(overrides: Partial<RelayPolicySnapshotInput> = {}): RelayPolicySnapshotInput {
  return {
    gatewayInstanceId: 'gateway',
    poolId: 'system',
    relayInstanceId: 'relay-1',
    grantKeys: [
      { keyId: 'grant-b', publicKey: 'Yg==' },
      { keyId: 'grant-a', publicKey: 'YQ==' },
    ],
    assignments: [
      { endpointId: 'endpoint-2', assignmentGeneration: 3 },
      { endpointId: 'endpoint-1', assignmentGeneration: 3 },
    ],
    endpoints: [endpoint('endpoint-2'), endpoint('endpoint-1')],
    routes: [route('route-2', 'endpoint-2'), route('route-1', 'endpoint-1')],
    admission: {
      adaptiveAdmissionEnabled: true,
      proxyTargetPressurePercent: 70,
      databaseReservePercent: 20,
      hardPressurePercent: 95,
    },
    policyKeys: [],
    routePolicy: () => ({ disableIdleTimeout: false, trafficClass: 'database' }),
    leaseGate: null,
    lease: null,
    ...overrides,
  };
}

const key = (overrides: Partial<RelayPolicySnapshotInput> = {}, signer = 'policy-key', leaseSeconds = 900) =>
  relayPolicySnapshotKey(relayPolicySnapshotContent(input(overrides)), signer, leaseSeconds);

describe('relay policy snapshot content key', () => {
  it('does not depend on the order the database returned rows in', () => {
    const base = input();
    expect(
      key({
        grantKeys: [...base.grantKeys].reverse(),
        assignments: [...base.assignments].reverse(),
        endpoints: [...base.endpoints].reverse(),
        routes: [...base.routes].reverse(),
      })
    ).toBe(key());
  });

  it('changes with the lease gate, lease blocks, key chain, signer, lease length and admission policy', () => {
    const baseline = key();
    const variants = [
      key({ leaseGate: { endpoints: new Map(), routes: new Map([['route-1', 'policy-1']]) } }),
      key({ leaseGate: { endpoints: new Map([['endpoint-1', 'policy-1']]), routes: new Map() } }),
      key({ lease: { leaseBlocks: [{ payload: Buffer.from('m1') }], leaseKeyRotations: [] } }),
      key({ lease: { leaseBlocks: [], leaseKeyRotations: [{ keyId: 'next', signature: Buffer.alloc(4) }] } }),
      key({}, 'rotated-key'),
      key({}, 'policy-key', 72 * 60 * 60),
      key({
        admission: {
          adaptiveAdmissionEnabled: false,
          proxyTargetPressurePercent: 70,
          databaseReservePercent: 20,
          hardPressurePercent: 95,
        },
      }),
    ];
    for (const variant of variants) expect(variant).not.toBe(baseline);
    expect(new Set(variants).size).toBe(variants.length);
    // Distinct lease block bytes are distinct content.
    expect(key({ lease: { leaseBlocks: [{ payload: Buffer.from('m1') }], leaseKeyRotations: [] } })).not.toBe(
      key({ lease: { leaseBlocks: [{ payload: Buffer.from('m2') }], leaseKeyRotations: [] } })
    );
  });

  it('carries the lease gate ids in the envelope content', () => {
    const content = relayPolicySnapshotContent(
      input({
        leaseGate: {
          endpoints: new Map([['endpoint-1', 'policy-1']]),
          routes: new Map([['route-1', 'policy-1']]),
        },
      })
    );
    expect(content.endpoints.map((e) => [e.endpointId, (e as { leasePolicyId?: string }).leasePolicyId])).toEqual([
      ['endpoint-1', 'policy-1'],
      ['endpoint-2', undefined],
    ]);
    expect(content.routes.map((r) => [r.routeId, (r as { leasePolicyId?: string }).leasePolicyId])).toEqual([
      ['route-1', 'policy-1'],
      ['route-2', undefined],
    ]);
  });
});
