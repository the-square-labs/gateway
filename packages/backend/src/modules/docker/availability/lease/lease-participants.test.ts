import { describe, expect, it } from 'vitest';
import {
  classifyDockerLeaseNode,
  keepsLeaseVoterPlace,
  LeaseCapabilityTracker,
  type LeaseParticipant,
  type LeaseParticipants,
  leaseProtocolOf,
  manifestCandidateAllowed,
} from './lease-participants.js';
import type { LeaseMemberRow } from './lease-store.js';

const NOW = Date.UTC(2026, 8, 28, 12);

function member(extra: Partial<LeaseMemberRow> = {}): LeaseMemberRow {
  return {
    memberId: 'node',
    kind: 'docker',
    nodeId: 'node',
    relayInstanceId: null,
    identityPublicKey: 'pk',
    previousIdentityPublicKey: null,
    identityRotatedAt: null,
    watchdogReady: true,
    incarnation: 1,
    epochAck: 0,
    trustedKeyIds: [],
    manifestAcks: {},
    leaseRevision: 0,
    abstaining: false,
    reportedAt: new Date(NOW - 5_000),
    updatedAt: new Date(NOW),
    ...extra,
  };
}

const caps =
  (...list: string[]) =>
  (capability: string) =>
    list.includes(capability);

function participant(extra: Partial<LeaseParticipant> = {}): LeaseParticipant {
  return {
    id: 'node',
    role: 'daemon',
    kind: 'docker',
    nodeId: 'node',
    hostKey: 'host',
    faultDomain: null,
    protocol: 'v2',
    voterCapable: true,
    capable: true,
    exclusion: null,
    withinGrace: false,
    online: true,
    local: false,
    ready: true,
    offlineLong: false,
    publicKey: 'pk',
    ...extra,
  };
}

describe('lease capability v2 (D3, B-10)', () => {
  it('reads the newest advertised protocol; v1 is outdated', () => {
    expect(leaseProtocolOf(caps('availability_lease_v1', 'availability_lease_v2'))).toBe('v2');
    expect(leaseProtocolOf(caps('availability_lease_v1'))).toBe('v1');
    expect(leaseProtocolOf(caps('docker_v1'))).toBeNull();
  });

  it('classifies why a docker candidate cannot hold', () => {
    const classify = (connected: boolean, has: (capability: string) => boolean, row?: LeaseMemberRow) =>
      classifyDockerLeaseNode({ connected, has, member: row, now: NOW });
    expect(classify(true, caps('availability_lease_v2'), member())).toBeNull();
    expect(classify(false, caps('availability_lease_v2'), member())).toBe('offline');
    expect(classify(true, caps('availability_lease_v2'), member({ identityPublicKey: null }))).toBe('identity_pending');
    expect(classify(true, caps('availability_lease_v2'), member({ watchdogReady: false }))).toBe('watchdog_missing');
    expect(classify(true, caps('availability_lease_v2', 'availability_lease_watchdog_missing_v1'), member())).toBe(
      'watchdog_missing'
    );
    // An rc.18/rc.19 daemon, and a pre-lease daemon (rc.4) that still has an old identity row.
    expect(classify(true, caps('availability_lease_v1'), member())).toBe('daemon_outdated');
    expect(classify(true, caps(), member({ reportedAt: new Date(NOW - 3_600_000) }))).toBe('daemon_outdated');
    expect(classify(true, caps(), undefined)).toBe('daemon_outdated');
    // A daemon that stops advertising the capability while its watchdog is down still reports its lease runtime.
    expect(classify(true, caps(), member({ watchdogReady: false }))).toBe('watchdog_missing');
    expect(classify(true, caps('availability_lease_watchdog_missing_v1'), undefined)).toBe('watchdog_missing');
  });
});

describe('2-minute grace for voters and manifest candidates (D3)', () => {
  const participants = (list: LeaseParticipant[]): LeaseParticipants => ({
    relays: list.filter((entry) => entry.kind === 'relay'),
    daemons: list.filter((entry) => entry.kind !== 'relay'),
    byId: new Map(list.map((entry) => [entry.id, entry])),
    hostFaultDomains: new Map(),
    relayRtt: () => undefined,
  });

  it('keeps a member that just lost the capability for 2 minutes, then lets it go', () => {
    const tracker = new LeaseCapabilityTracker();
    const outdated = () =>
      participant({ protocol: 'v1', voterCapable: false, capable: false, exclusion: 'daemon_outdated' });
    let current = outdated();
    tracker.observe(participants([current]), NOW);
    expect(current.withinGrace).toBe(true);
    expect(keepsLeaseVoterPlace(current)).toBe(true);
    current = outdated();
    tracker.observe(participants([current]), NOW + 119_000);
    expect(keepsLeaseVoterPlace(current)).toBe(true);
    current = outdated();
    tracker.observe(participants([current]), NOW + 120_000);
    expect(current.withinGrace).toBe(false);
    expect(keepsLeaseVoterPlace(current)).toBe(false);
    // Back on v2: the clock restarts from zero next time.
    current = participant();
    tracker.observe(participants([current]), NOW + 121_000);
    current = outdated();
    tracker.observe(participants([current]), NOW + 122_000);
    expect(current.withinGrace).toBe(true);
  });

  it('does not start the clock on the persisted capabilities of an offline daemon', () => {
    const tracker = new LeaseCapabilityTracker();
    const offline = participant({ protocol: 'v1', voterCapable: false, online: false, exclusion: 'offline' });
    tracker.observe(participants([offline]), NOW);
    const later = participant({ protocol: 'v1', voterCapable: false, online: false, exclusion: 'offline' });
    tracker.observe(participants([later]), NOW + 600_000);
    expect(later.withinGrace).toBe(true);
    // A daemon offline for 10 minutes never keeps a voter place.
    expect(keepsLeaseVoterPlace({ ...later, offlineLong: true })).toBe(false);
  });

  it('lists a candidate in the manifest unless its daemon is outdated or unidentified, never cutting a holder', () => {
    expect(manifestCandidateAllowed(participant(), { active: false, listed: false })).toBe(true);
    for (const exclusion of ['offline', 'watchdog_missing'] as const) {
      expect(manifestCandidateAllowed(participant({ exclusion }), { active: false, listed: false })).toBe(true);
    }
    const outdated = participant({ protocol: 'v1', exclusion: 'daemon_outdated' });
    expect(manifestCandidateAllowed(outdated, { active: false, listed: false })).toBe(false);
    expect(manifestCandidateAllowed(outdated, { active: true, listed: false })).toBe(true);
    expect(manifestCandidateAllowed({ ...outdated, withinGrace: true }, { active: false, listed: true })).toBe(true);
    expect(manifestCandidateAllowed({ ...outdated, withinGrace: false }, { active: false, listed: true })).toBe(false);
    expect(manifestCandidateAllowed(participant({ publicKey: null }), { active: true, listed: true })).toBe(false);
    expect(manifestCandidateAllowed(undefined, { active: true, listed: true })).toBe(false);
  });
});
