import { describe, expect, it } from 'vitest';
import { availabilityStandbyCount, evaluateLeaseGating, type LeaseGatingInput } from './lease-gating.js';
import {
  holdsEveryMajority,
  type LeaseVoterCandidate,
  leaseVoterMargin,
  quorumSize,
  selectLeaseVoters,
} from './lease-voters.js';

const NOW = Date.parse('2026-09-28T00:00:00Z');

function relay(id: string, extra: Partial<LeaseVoterCandidate> = {}): LeaseVoterCandidate {
  return { id, role: 'relay', hostKey: `host-${id}`, capable: true, publicKey: `pk-${id}`, online: true, ...extra };
}

function daemon(id: string, extra: Partial<LeaseVoterCandidate> = {}): LeaseVoterCandidate {
  return { id, role: 'daemon', hostKey: `host-${id}`, capable: true, publicKey: `pk-${id}`, online: true, ...extra };
}

describe('availability lease voter selection (D2, A9, A10)', () => {
  it('lets every capable relay vote and keeps the total odd by dropping the local relay', () => {
    const selection = selectLeaseVoters(
      [relay('r-local', { local: true }), relay('r-1'), daemon('d-1'), daemon('d-2')],
      [],
      NOW
    );
    expect(selection.voterIds).toEqual(['d-1', 'd-2', 'r-1']);
    expect(selection.localRelayDropped).toBe(true);
  });

  it('drops the last daemon chosen when no local relay votes and the total is even', () => {
    const selection = selectLeaseVoters(
      [relay('r-1'), daemon('d-3', { hostsCandidate: true }), daemon('d-1'), daemon('d-2')],
      [],
      NOW
    );
    expect(selection.voterIds).toEqual(['d-1', 'd-3', 'r-1']);
    expect(selection.voterIds.length % 2).toBe(1);
  });

  it('spreads daemons over distinct hosts, at most twelve, preferring candidate and ingress hosts', () => {
    const daemons = Array.from({ length: 20 }, (_, index) =>
      daemon(`d-${String(index).padStart(2, '0')}`, { hostsIngress: index >= 15 })
    );
    const sameHost = daemon('d-shared', { hostKey: 'host-r-1', hostsCandidate: true });
    const selection = selectLeaseVoters([relay('r-1'), sameHost, ...daemons], [], NOW);
    const chosenDaemons = selection.voterIds.filter((id) => id.startsWith('d-'));
    expect(chosenDaemons).not.toContain('d-shared');
    expect(chosenDaemons).toHaveLength(12);
    for (const id of ['d-15', 'd-16', 'd-17', 'd-18', 'd-19']) expect(chosenDaemons).toContain(id);
    expect(selection.voterIds.length % 2).toBe(1);
  });

  it('keeps current voters instead of churning to a better spread', () => {
    const selection = selectLeaseVoters(
      [relay('r-1'), daemon('d-old'), daemon('d-new', { hostsCandidate: true }), daemon('d-other')],
      ['r-1', 'd-old', 'd-other'],
      NOW
    );
    expect(selection.voterIds).toEqual(['d-old', 'd-other', 'r-1']);
  });

  it('replaces a daemon voter only after it stayed offline long enough', () => {
    const briefly = selectLeaseVoters(
      [relay('r-1'), daemon('d-1', { online: false, offlineSince: NOW - 60_000 }), daemon('d-2'), daemon('d-3')],
      ['r-1', 'd-1', 'd-2'],
      NOW
    );
    expect(briefly.voterIds).toContain('d-1');
    const long = selectLeaseVoters(
      [relay('r-1'), daemon('d-1', { online: false, offlineSince: NOW - 3_600_000 }), daemon('d-2'), daemon('d-3')],
      ['r-1', 'd-1', 'd-2'],
      NOW
    );
    expect(long.voterIds).toEqual(['d-2', 'd-3', 'r-1']);
  });

  it('counts relays that cannot vote against the capable majority', () => {
    const selection = selectLeaseVoters([relay('r-1'), relay('r-old', { capable: false, publicKey: null })], [], NOW);
    expect(selection.voterIds).toEqual(['r-1']);
    expect(selection.incapableRelayIds).toEqual(['r-old']);
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
    clusterReady: true,
    candidates: [
      { nodeId: '11111111-1111-4111-8111-111111111111', capable: true },
      { nodeId: '22222222-2222-4222-8222-222222222222', capable: true },
    ],
    ingress: [{ nodeId: '33333333-3333-4333-8333-333333333333', capable: true }],
    capableVoters: 3,
    totalVoters: 5,
  };

  it('runs lease mode only when candidates, ingress and a voter majority are capable', () => {
    expect(evaluateLeaseGating(eligible)).toEqual({ eligible: true });
    const oldCandidate = evaluateLeaseGating({
      ...eligible,
      candidates: [eligible.candidates[0]!, { ...eligible.candidates[1]!, capable: false }],
    });
    expect(oldCandidate).toMatchObject({
      eligible: false,
      reason: { code: 'candidates_not_capable', nodeIds: ['22222222-2222-4222-8222-222222222222'] },
    });
    expect(
      evaluateLeaseGating({ ...eligible, ingress: [{ nodeId: eligible.ingress[0]!.nodeId, capable: false }] })
    ).toMatchObject({ eligible: false, reason: { code: 'ingress_not_capable' } });
    expect(evaluateLeaseGating({ ...eligible, capableVoters: 2, totalVoters: 4 })).toMatchObject({
      eligible: false,
      reason: { code: 'voters_not_capable' },
    });
    expect(evaluateLeaseGating({ ...eligible, clusterReady: false })).toMatchObject({
      eligible: false,
      reason: { code: 'voter_config_pending' },
    });
    expect(evaluateLeaseGating({ ...eligible, controllerSupportsLease: false })).toMatchObject({
      eligible: false,
      reason: { code: 'controller_unsupported' },
    });
  });

  it('fixes the standby count at min(2, candidates - slots) (D7)', () => {
    expect(availabilityStandbyCount(5, 1)).toBe(2);
    expect(availabilityStandbyCount(2, 1)).toBe(1);
    expect(availabilityStandbyCount(3, 3)).toBe(0);
    expect(availabilityStandbyCount(1, 2)).toBe(0);
  });
});
