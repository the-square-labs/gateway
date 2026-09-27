import { describe, expect, it } from 'vitest';
import { availabilityStandbyCount, evaluateLeaseGating, type LeaseGatingInput } from './lease-gating.js';
import {
  holdsEveryMajority,
  type LeaseVoterCandidateNode,
  type LeaseWitnessCandidate,
  leaseVoterMargin,
  quorumSize,
  selectPolicyVoters,
} from './lease-voters.js';

function candidate(id: string, hostKey = `host-${id}`, faultDomains: string[] = []): LeaseVoterCandidateNode {
  return { id, hostKey, faultDomains, publicKey: `pk-${id}` };
}

function witness(
  id: string,
  extra: Partial<Omit<LeaseWitnessCandidate, 'rttFrom'>> & { rtt?: Record<string, number> } = {}
): LeaseWitnessCandidate {
  const { rtt, ...rest } = extra;
  return {
    id,
    kind: 'relay',
    hostKey: `host-${id}`,
    faultDomain: `fd-${id}`,
    capable: true,
    publicKey: `pk-${id}`,
    rttFrom: (candidateId) => rtt?.[candidateId],
    ...rest,
  };
}

describe('per-policy lease voters (A18, A20)', () => {
  it('takes the distinct candidate hosts in rank order and needs no witness for an odd count of three', () => {
    const selection = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2'), candidate('d3')],
      pool: [witness('r1')],
      configuredWitness: null,
    });
    expect(selection).toEqual({ voterIds: ['d1', 'd2', 'd3'], witnesses: [], warning: null });
  });

  it('gives one vote per physical host across daemons and relays', () => {
    const selection = selectPolicyVoters({
      // Two candidate daemons on one VM count once.
      candidates: [candidate('d1', 'vm-a'), candidate('d1b', 'vm-a'), candidate('d2', 'vm-b')],
      pool: [
        // Two relays on one VM give one vote; a relay on a candidate's VM gives none.
        witness('r1', { hostKey: 'vm-c' }),
        witness('r2', { hostKey: 'vm-c' }),
        witness('r3', { hostKey: 'vm-a' }),
      ],
      configuredWitness: null,
    });
    expect(selection.voterIds).toEqual(['d1', 'd2', 'r1']);
  });

  it('caps the voters at seven; candidates beyond the cap do not vote', () => {
    const candidates = Array.from({ length: 9 }, (_, index) => candidate(`d${index}`));
    const selection = selectPolicyVoters({ candidates, pool: [witness('r1')], configuredWitness: null });
    expect(selection.voterIds).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6']);
    expect(selection.witnesses).toEqual([]);
  });
});

describe('lease witness (A19)', () => {
  it('picks the member with the largest minimum round trip to every candidate', () => {
    const selection = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2')],
      pool: [
        witness('near', { rtt: { d1: 1.2, d2: 80 } }),
        witness('far', { rtt: { d1: 35, d2: 42 } }),
        witness('half', { rtt: { d1: 60 } }),
      ],
      configuredWitness: null,
    });
    expect(selection.voterIds).toEqual(['d1', 'd2', 'far']);
    expect(selection.witnesses).toEqual([{ memberId: 'far', kind: 'relay', auto: true, minRttMs: 35 }]);
    expect(selection.warning).toBeNull();
  });

  it('warns when the only witness is within 2 ms of a candidate', () => {
    const selection = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2')],
      pool: [witness('near', { rtt: { d1: 1.2, d2: 80 } })],
      configuredWitness: null,
    });
    expect(selection.witnesses[0]).toMatchObject({ memberId: 'near', minRttMs: 1.2 });
    expect(selection.warning).toBe('witness_near_candidate');
  });

  it('falls back to a relay in a fault domain no candidate host shares, then to docker nodes', () => {
    const selection = selectPolicyVoters({
      candidates: [candidate('d1', 'host-d1', ['site-a']), candidate('d2', 'host-d2', ['site-b'])],
      pool: [
        witness('docker-w', { kind: 'docker', faultDomain: null }),
        witness('same-site', { faultDomain: 'site-a' }),
        witness('other-site', { faultDomain: 'site-c' }),
      ],
      configuredWitness: null,
    });
    expect(selection.voterIds).toEqual(['d1', 'd2', 'other-site']);
    expect(
      selectPolicyVoters({
        candidates: [candidate('d1'), candidate('d2')],
        pool: [witness('docker-w', { kind: 'docker', faultDomain: null })],
        configuredWitness: null,
      }).voterIds
    ).toEqual(['d1', 'd2', 'docker-w']);
  });

  it('uses a configured witness first and falls back to auto with a warning when it is not eligible', () => {
    const pool = [witness('far', { rtt: { d1: 40, d2: 40 } }), witness('chosen', { rtt: { d1: 5, d2: 5 } })];
    const configured = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2')],
      pool,
      configuredWitness: 'chosen',
    });
    expect(configured.witnesses).toEqual([{ memberId: 'chosen', kind: 'relay', auto: false, minRttMs: 5 }]);
    const notCapable = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2')],
      pool: [...pool.slice(0, 1), witness('chosen', { capable: false })],
      configuredWitness: 'chosen',
    });
    expect(notCapable.voterIds).toEqual(['d1', 'd2', 'far']);
    expect(notCapable.warning).toBe('configured_witness_unavailable');
    const onCandidateHost = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2')],
      pool: [witness('chosen', { hostKey: 'host-d1' })],
      configuredWitness: 'chosen',
    });
    expect(onCandidateHost.voterIds).toEqual(['d1', 'd2']);
    expect(onCandidateHost.warning).toBe('configured_witness_unavailable');
  });

  it('keeps the count odd when a witness is configured for three candidates', () => {
    const selection = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2'), candidate('d3')],
      pool: [witness('chosen'), witness('extra')],
      configuredWitness: 'chosen',
    });
    expect(selection.voterIds).toEqual(['d1', 'd2', 'd3', 'chosen', 'extra']);
  });

  it('warns that failover needs a candidate majority when no eligible witness exists', () => {
    const selection = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2')],
      pool: [witness('old', { capable: false }), witness('keyless', { publicKey: null })],
      configuredWitness: null,
    });
    expect(selection).toEqual({ voterIds: ['d1', 'd2'], witnesses: [], warning: 'no_eligible_witness' });
  });

  it('keeps a current automatic witness instead of churning to a farther one', () => {
    const selection = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2')],
      pool: [witness('current', { rtt: { d1: 10, d2: 10 } }), witness('farther', { rtt: { d1: 90, d2: 90 } })],
      configuredWitness: null,
      currentAutoWitnesses: ['current'],
    });
    expect(selection.voterIds).toEqual(['d1', 'd2', 'current']);
  });

  it('survives the loss of any one site in the invoise layout: two candidate sites plus a witness site', () => {
    // Site A: yuna VM (docker d1 and relay r1). Site B: CloudBlast Birmingham (docker d2 and relay r2). Site C: witness.
    const selection = selectPolicyVoters({
      candidates: [candidate('d1', 'vm-yuna', ['fd-a']), candidate('d2', 'vm-birmingham', ['fd-b'])],
      pool: [
        witness('r1', { hostKey: 'vm-yuna', faultDomain: 'fd-a', rtt: { d1: 0.3, d2: 21 } }),
        witness('r2', { hostKey: 'vm-birmingham', faultDomain: 'fd-b', rtt: { d1: 21, d2: 0.4 } }),
        witness('r3', { hostKey: 'vm-witness', faultDomain: 'fd-c', rtt: { d1: 14, d2: 18 } }),
      ],
      configuredWitness: null,
    });
    expect(selection.voterIds).toEqual(['d1', 'd2', 'r3']);
    expect(selection.warning).toBeNull();
    for (const site of [['d1'], ['d2'], ['r3']]) {
      const survivors = new Set(selection.voterIds.filter((id) => !site.includes(id)));
      expect(holdsEveryMajority([selection.voterIds], survivors)).toBe(true);
    }
  });
});

describe('availability lease quorum math', () => {
  it('needs a majority of every quorum set while joint', () => {
    expect(quorumSize(['a', 'b', 'c'])).toBe(2);
    const sets = [
      ['a', 'b', 'c'],
      ['c', 'd', 'e'],
    ];
    expect(holdsEveryMajority(sets, new Set(['a', 'b', 'c']))).toBe(false);
    expect(holdsEveryMajority(sets, new Set(['a', 'c', 'd']))).toBe(true);
    expect(holdsEveryMajority([], new Set(['a']))).toBe(false);
  });

  it('reports the smallest reachability margin over the quorum sets', () => {
    const margin = leaseVoterMargin(
      7,
      [
        ['a', 'b', 'c'],
        ['c', 'd', 'e', 'f', 'g'],
      ],
      new Set(['a', 'b', 'c', 'd', 'e'])
    );
    expect(margin).toEqual({ epoch: 7, joint: true, voters: 5, reachable: 3, required: 3, margin: 0 });
    expect(leaseVoterMargin(1, [], new Set())).toBeNull();
  });
});

describe('availability lease capability gating (D10)', () => {
  const eligible: LeaseGatingInput = {
    controllerSupportsLease: true,
    policyMode: 'failover',
    signingReady: true,
    candidates: [
      { nodeId: '11111111-1111-4111-8111-111111111111', capable: true },
      { nodeId: '22222222-2222-4222-8222-222222222222', capable: true },
    ],
    ingress: [{ nodeId: '33333333-3333-4333-8333-333333333333', capable: true }],
  };

  it('runs lease mode only when candidates and ingress are capable and a key can sign', () => {
    expect(evaluateLeaseGating(eligible)).toEqual({ eligible: true });
    expect(
      evaluateLeaseGating({
        ...eligible,
        candidates: [eligible.candidates[0]!, { ...eligible.candidates[1]!, capable: false }],
      })
    ).toMatchObject({
      eligible: false,
      reason: { code: 'candidates_not_capable', nodeIds: ['22222222-2222-4222-8222-222222222222'] },
    });
    expect(
      evaluateLeaseGating({ ...eligible, ingress: [{ nodeId: eligible.ingress[0]!.nodeId, capable: false }] })
    ).toMatchObject({ eligible: false, reason: { code: 'ingress_not_capable' } });
    expect(evaluateLeaseGating({ ...eligible, signingReady: false })).toMatchObject({
      eligible: false,
      reason: { code: 'signing_key_pending' },
    });
    expect(evaluateLeaseGating({ ...eligible, controllerSupportsLease: false })).toMatchObject({
      eligible: false,
      reason: { code: 'controller_unsupported' },
    });
    expect(evaluateLeaseGating({ ...eligible, legacyRequested: true })).toMatchObject({
      eligible: false,
      reason: { code: 'legacy_requested' },
    });
  });

  it('fixes the standby count at min(2, candidates - slots) (D7)', () => {
    expect(availabilityStandbyCount(5, 1)).toBe(2);
    expect(availabilityStandbyCount(2, 1)).toBe(1);
    expect(availabilityStandbyCount(3, 3)).toBe(0);
    expect(availabilityStandbyCount(1, 2)).toBe(0);
  });
});
