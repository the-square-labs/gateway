import { describe, expect, it } from 'vitest';
import { relayPoolInternals } from './relay-pool.service.js';

function instance(id: string, faultDomainId: string, state: 'ready' | 'offline' = 'ready') {
  return {
    id,
    poolId: 'system',
    kind: 'remote',
    nodeId: id,
    faultDomainId,
    displayName: id,
    advertisedAddresses: ['127.0.0.1'],
    servicePort: 9443,
    state,
    health: { pressurePercent: 0 },
  } as any;
}

describe('RelayPoolService assignment selection', () => {
  it('selects the requested number of active candidates from separate physical hosts', () => {
    const first = instance('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
    const colocated = instance('00000000-0000-4000-8000-000000000002', first.faultDomainId);
    const remote = instance('00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003');
    const selected = relayPoolInternals.chooseCandidates(
      '20000000-0000-4000-8000-000000000001',
      [first, colocated, remote],
      2
    );
    expect(selected).toHaveLength(2);
    expect(new Set(selected.map(({ faultDomainId }) => faultDomainId)).size).toBe(2);
  });

  it('never fabricates redundant capacity from colocated or offline relay identities', () => {
    const first = instance('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
    const colocated = instance('00000000-0000-4000-8000-000000000002', first.faultDomainId);
    const offline = instance('00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'offline');
    const selected = relayPoolInternals.chooseCandidates(
      '20000000-0000-4000-8000-000000000001',
      [first, colocated, offline],
      10
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.id).toBe(first.id);
  });

  it('keeps provisional Relay enrollment records out of the visible pool', () => {
    const provisional = instance('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
    provisional.state = 'joining';
    provisional.certificateIdentity = null;
    provisional.certificateFingerprint = null;
    const enrolled = instance('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002');
    enrolled.certificateIdentity = 'relay-enrolled';
    enrolled.certificateFingerprint = `sha256:${'a'.repeat(64)}`;

    expect(relayPoolInternals.isEnrolledRelayInstance(provisional)).toBe(false);
    expect(relayPoolInternals.isEnrolledRelayInstance(enrolled)).toBe(true);
  });
});
