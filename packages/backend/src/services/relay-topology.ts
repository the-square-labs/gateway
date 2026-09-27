import { createHash } from 'node:crypto';
import type { relayInstances } from '@/db/schema/index.js';

type RelayInstanceRow = typeof relayInstances.$inferSelect;

/** How an assignment serves: `active` when Gateway placed it without latency data. */
export type RelayAssignmentRole = 'primary' | 'fallback' | 'active';

export interface PlannedRelayAssignment {
  instance: RelayInstanceRow;
  role: RelayAssignmentRole;
}

/** Round-trip times one node measured, in milliseconds by relay instance id. */
export type NodeRelayLatencies = ReadonlyMap<string, number>;

/** The measured distances around one endpoint: its own node and every source node of a route to it. */
export interface EndpointLatencyPath {
  endpoint: NodeRelayLatencies | undefined;
  /** Only sources that report latencies at all; an old daemon must not hide the rest. */
  sources: NodeRelayLatencies[];
}

/**
 * Relays whose path cost is within this band of the best one are equally near: all become
 * primaries and share the load. The daemons order candidates with the same band.
 */
const PRIMARY_BAND_RATIO = 1.2;
const PRIMARY_BAND_MS = 3;
/**
 * Moving primaries means a new generation and a drain, so a nearer relay replaces the current
 * primaries only when it is clearly nearer, both relatively and absolutely.
 */
const SWITCH_COST_RATIO = 0.7;
const SWITCH_MIN_GAIN_MS = 5;

export function rendezvousScore(endpointId: string, instance: RelayInstanceRow): bigint {
  const digest = createHash('sha256').update(`${endpointId}:${instance.id}`).digest();
  const raw = digest.readBigUInt64BE(0);
  const pressure = BigInt(Math.max(0, Math.min(99, instance.health?.pressurePercent ?? 0)));
  return raw * (100n - pressure);
}

function byRendezvous(endpointId: string) {
  return (left: RelayInstanceRow, right: RelayInstanceRow) => {
    const delta = rendezvousScore(endpointId, right) - rendezvousScore(endpointId, left);
    return delta > 0n ? 1 : delta < 0n ? -1 : left.id.localeCompare(right.id);
  };
}

/**
 * Fills the slots left after `taken` from ready relays by rendezvous score, one relay per fault
 * domain, until `desiredCount` relays are placed in total.
 */
export function chooseByRendezvous(
  endpointId: string,
  instances: RelayInstanceRow[],
  desiredCount: number,
  taken: RelayInstanceRow[] = []
): RelayInstanceRow[] {
  const takenIds = new Set(taken.map(({ id }) => id));
  const faultDomains = new Set(taken.map(({ faultDomainId }) => faultDomainId));
  const selected: RelayInstanceRow[] = [];
  const ranked = instances
    .filter(({ state, id }) => state === 'ready' && !takenIds.has(id))
    .sort(byRendezvous(endpointId));
  for (const instance of ranked) {
    if (taken.length + selected.length >= desiredCount) break;
    if (faultDomains.has(instance.faultDomainId)) continue;
    faultDomains.add(instance.faultDomainId);
    selected.push(instance);
  }
  return selected;
}

/**
 * Cost of carrying the endpoint's traffic through a relay: the relay's round trip to the endpoint
 * node plus the average round trip from the source nodes. Unknown unless the endpoint node and
 * every reporting source measured the relay.
 */
export function relayPathCost(path: EndpointLatencyPath, instanceId: string): number | undefined {
  const endpointRtt = path.endpoint?.get(instanceId);
  if (endpointRtt === undefined) return undefined;
  if (!path.sources.length) return endpointRtt;
  let total = 0;
  for (const source of path.sources) {
    const rtt = source.get(instanceId);
    if (rtt === undefined) return undefined;
    total += rtt;
  }
  return endpointRtt + total / path.sources.length;
}

function withinPrimaryBand(cost: number, best: number): boolean {
  return cost <= Math.max(best * PRIMARY_BAND_RATIO, best + PRIMARY_BAND_MS);
}

/**
 * Places one endpoint on `desiredCount` relays. With latency data, the nearest relays (within the
 * primary band) are primaries and the remaining slots are standbys by rendezvous score. Without
 * it, every relay is active by rendezvous score, as before latency placement existed. The current
 * primaries stay while they serve unless a relay is clearly nearer, so measurement noise never
 * moves an endpoint.
 */
export function chooseRelayAssignments(
  endpointId: string,
  instances: RelayInstanceRow[],
  desiredCount: number,
  path: EndpointLatencyPath | undefined,
  current: ReadonlyArray<{ relayInstanceId: string; role: string }> = []
): PlannedRelayAssignment[] {
  const ready = instances.filter(({ state }) => state === 'ready');
  const costs = new Map<string, number>();
  for (const instance of path ? ready : []) {
    const cost = relayPathCost(path!, instance.id);
    if (cost !== undefined) costs.set(instance.id, cost);
  }
  const currentPrimaryIds = new Set(current.filter(({ role }) => role === 'primary').map((row) => row.relayInstanceId));
  const keptPrimaries = ready.filter(({ id }) => currentPrimaryIds.has(id));
  let primaries: RelayInstanceRow[];
  if (!costs.size) {
    // Latency reports lapsed (a daemon restarts, a node goes quiet): keep a latency placement
    // whose primaries all still serve instead of flapping back to hashing and forth again.
    if (!currentPrimaryIds.size || keptPrimaries.length !== currentPrimaryIds.size) {
      return chooseByRendezvous(endpointId, instances, desiredCount).map((instance) => ({ instance, role: 'active' }));
    }
    primaries = keptPrimaries;
  } else {
    const best = Math.min(...costs.values());
    const keptCosts = keptPrimaries.flatMap(({ id }) => (costs.has(id) ? [costs.get(id)!] : []));
    const currentCost = keptCosts.length ? Math.min(...keptCosts) : undefined;
    const clearlyNearer =
      currentCost === undefined || (best < currentCost * SWITCH_COST_RATIO && currentCost - best >= SWITCH_MIN_GAIN_MS);
    primaries = clearlyNearer ? nearestRelays(endpointId, ready, costs, best) : keptPrimaries;
  }
  primaries = primaries.slice(0, desiredCount);
  const standbys = chooseByRendezvous(endpointId, instances, desiredCount, primaries);
  return [
    ...primaries.map((instance) => ({ instance, role: 'primary' as const })),
    ...standbys.map((instance) => ({ instance, role: 'fallback' as const })),
  ];
}

function nearestRelays(
  endpointId: string,
  ready: RelayInstanceRow[],
  costs: ReadonlyMap<string, number>,
  best: number
): RelayInstanceRow[] {
  const rendezvous = byRendezvous(endpointId);
  const faultDomains = new Set<string>();
  return ready
    .filter(({ id }) => costs.has(id) && withinPrimaryBand(costs.get(id)!, best))
    .sort((left, right) => costs.get(left.id)! - costs.get(right.id)! || rendezvous(left, right))
    .filter(({ faultDomainId }) => {
      if (faultDomains.has(faultDomainId)) return false;
      faultDomains.add(faultDomainId);
      return true;
    });
}

/** Whether a generation's assignments already are the planned relays in the planned roles. */
export function samePlannedAssignments(
  assignments: ReadonlyArray<{ relayInstanceId: string; role: string }>,
  planned: ReadonlyArray<{ instance: { id: string }; role: RelayAssignmentRole }>
): boolean {
  if (assignments.length !== planned.length) return false;
  const roles = new Map(planned.map(({ instance, role }) => [instance.id, role]));
  return assignments.every(
    ({ relayInstanceId, role }) => roles.has(relayInstanceId) && roles.get(relayInstanceId) === role
  );
}

/** Parses the relay latencies stored with a node's health report. */
export function parseNodeRelayLatencies(value: unknown): Map<string, number> {
  const result = new Map<string, number>();
  if (!Array.isArray(value)) return result;
  for (const sample of value) {
    const { relayInstanceId, rttMs } = (sample ?? {}) as { relayInstanceId?: unknown; rttMs?: unknown };
    if (typeof relayInstanceId === 'string' && typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs > 0) {
      result.set(relayInstanceId, rttMs);
    }
  }
  return result;
}

/** The candidate role daemons see: a fallback assignment is a standby. */
export function candidateTopology(
  role: string
): { role: 'primary' | 'standby'; endpointRttMicros: number } | undefined {
  if (role === 'primary') return { role: 'primary', endpointRttMicros: 0 };
  if (role === 'fallback') return { role: 'standby', endpointRttMicros: 0 };
  return undefined;
}

/** Whole microseconds, never 0: daemons read 0 as unknown. */
export function toRttMicros(rttMs: number): number {
  return Math.max(1, Math.round(rttMs * 1000));
}

interface GrantWithCandidates {
  endpointId?: string;
  targetEndpointId?: string;
  candidates?: Array<{ relayInstanceId: string; topology?: { endpointRttMicros: number } }>;
}

/** The endpoint node each grant's candidates lead to. */
export function grantEndpointNodeId(
  grant: GrantWithCandidates,
  endpointNodes: ReadonlyMap<string, string>
): string | undefined {
  return endpointNodes.get(grant.endpointId ?? grant.targetEndpointId ?? '');
}

/** Gives every placed candidate the last known round trip between its relay and the endpoint node. */
export function attachEndpointRtts(
  grants: GrantWithCandidates[],
  endpointNodes: ReadonlyMap<string, string>,
  latencies: ReadonlyMap<string, NodeRelayLatencies>
): void {
  for (const grant of grants) {
    const nodeId = grantEndpointNodeId(grant, endpointNodes);
    const measured = nodeId ? latencies.get(nodeId) : undefined;
    for (const candidate of grant.candidates ?? []) {
      const rtt = measured?.get(candidate.relayInstanceId);
      if (candidate.topology && rtt !== undefined) candidate.topology.endpointRttMicros = toRttMicros(rtt);
    }
  }
}
