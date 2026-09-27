import { MAX_DAEMON_VOTERS, VOTER_OFFLINE_REPLACE_MS } from './lease-constants.js';

/** A relay or daemon that may vote (D2, A9). The caller passes only relays of operator-owned enrolled pools. */
export interface LeaseVoterCandidate {
  id: string;
  role: 'relay' | 'daemon';
  /** Physical host identity; one vote per host keeps a host failure from taking two votes. */
  hostKey: string;
  /** The local (combined-mode) relay: the one that stops voting when the total would be even. */
  local?: boolean;
  /** Advertises availability_lease_v1, reported an identity key and (daemons) a fresh watchdog. */
  capable: boolean;
  publicKey: string | null;
  online: boolean;
  /** Epoch ms since when the member has been offline, when known. */
  offlineSince?: number | null;
  /** The node runs a candidate placement of some Availability policy. */
  hostsCandidate?: boolean;
  /** The node is an ingress nginx node of some Availability route. */
  hostsIngress?: boolean;
}

export interface LeaseVoterSelection {
  /** Sorted ids of the voters to publish. */
  voterIds: string[];
  /** Relays that are not capable: they belong to the voter set by rule but cannot vote (D10 denominator). */
  incapableRelayIds: string[];
  /** The local relay left the set so the total is odd. */
  localRelayDropped: boolean;
}

function eligible(candidate: LeaseVoterCandidate, now: number): boolean {
  if (!candidate.capable || !candidate.publicKey) return false;
  if (candidate.role === 'relay' || candidate.online) return true;
  return candidate.offlineSince == null || now - candidate.offlineSince < VOTER_OFFLINE_REPLACE_MS;
}

function daemonPriority(candidate: LeaseVoterCandidate, current: ReadonlySet<string>): number[] {
  return [
    current.has(candidate.id) ? 0 : 1,
    candidate.hostsCandidate || candidate.hostsIngress ? 0 : 1,
    candidate.hostsCandidate ? 0 : 1,
    candidate.online ? 0 : 1,
  ];
}

function comparePriority(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

/**
 * Chooses the voter set (D2): every capable relay, plus up to 12 capable daemons on distinct hosts, preferring the
 * current voters (no churn), then hosts that run candidates or ingress. An even total drops the local relay, or the
 * last daemon chosen when no local relay votes, so a quorum never needs a tie break.
 */
export function selectLeaseVoters(
  candidates: LeaseVoterCandidate[],
  currentVoterIds: Iterable<string>,
  now: number
): LeaseVoterSelection {
  const current = new Set(currentVoterIds);
  const relays = candidates.filter((candidate) => candidate.role === 'relay');
  const votingRelays = relays.filter((relay) => eligible(relay, now));
  const incapableRelayIds = relays.filter((relay) => !eligible(relay, now)).map((relay) => relay.id);
  const hosts = new Set(votingRelays.map((relay) => relay.hostKey));
  const daemons = candidates
    .filter((candidate) => candidate.role === 'daemon' && eligible(candidate, now))
    .sort(
      (left, right) =>
        comparePriority(daemonPriority(left, current), daemonPriority(right, current)) ||
        left.id.localeCompare(right.id)
    );
  const votingDaemons: LeaseVoterCandidate[] = [];
  for (const daemon of daemons) {
    if (votingDaemons.length >= MAX_DAEMON_VOTERS) break;
    if (hosts.has(daemon.hostKey)) continue;
    hosts.add(daemon.hostKey);
    votingDaemons.push(daemon);
  }
  let localRelayDropped = false;
  if ((votingRelays.length + votingDaemons.length) % 2 === 0 && votingRelays.length + votingDaemons.length > 0) {
    const localIndex = votingRelays.findIndex((relay) => relay.local);
    if (localIndex >= 0) {
      votingRelays.splice(localIndex, 1);
      localRelayDropped = true;
    } else if (votingDaemons.length > 0) {
      votingDaemons.pop();
    }
  }
  return {
    voterIds: [...votingRelays, ...votingDaemons].map((voter) => voter.id).sort(),
    incapableRelayIds: incapableRelayIds.sort(),
    localRelayDropped,
  };
}

/** Majority of one quorum set. */
export function quorumSize(set: readonly string[]): number {
  return Math.floor(set.length / 2) + 1;
}

/** Whether ids hold a majority of every quorum set (joint consensus needs both, A4). */
export function holdsEveryMajority(sets: readonly (readonly string[])[], ids: ReadonlySet<string>): boolean {
  if (sets.length === 0) return false;
  return sets.every((set) => set.filter((id) => ids.has(id)).length >= quorumSize(set));
}

export interface LeaseVoterMargin {
  epoch: number;
  joint: boolean;
  /** Voters of the newest quorum set. */
  voters: number;
  /** Voters of the newest quorum set whose recent reports show them up and not abstaining. */
  reachable: number;
  /** Majority of the newest quorum set. */
  required: number;
  /** How many more reachable voters may fail before a quorum is lost; negative when it already is. */
  margin: number;
}

/** Reachability margin over every quorum set; the smallest one decides (D2 joint consensus). */
export function leaseVoterMargin(
  epoch: number,
  sets: readonly (readonly string[])[],
  reachable: ReadonlySet<string>
): LeaseVoterMargin | null {
  if (sets.length === 0) return null;
  const margins = sets.map((set) => set.filter((id) => reachable.has(id)).length - quorumSize(set));
  const newest = sets[sets.length - 1]!;
  return {
    epoch,
    joint: sets.length > 1,
    voters: newest.length,
    reachable: newest.filter((id) => reachable.has(id)).length,
    required: quorumSize(newest),
    margin: Math.min(...margins),
  };
}

export function sameVoterSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((id, index) => id === sortedRight[index]);
}
