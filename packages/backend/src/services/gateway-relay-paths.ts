import { connect } from 'node:net';
import type { RelayResumeRegistry, ResumableRelayDuplex } from '@/grpc/relay-resume.js';
import { createChildLogger } from '@/lib/logger.js';
import type { LocalRelayOutageSignal } from './local-relay-outage.js';

const logger = createChildLogger('GatewayRelayPaths');

/**
 * Gateway's own relayed streams (database viewer, storage browser, database monitoring, PG links) choose and leave
 * relays as the daemons do (relaybridge OrderCandidates, ReturnTarget, relayresume.Returner): by measured distance, and
 * back to the nearest relay once it is stable again. Before, they took the assignment's order: during a local relay
 * outage they went to whichever relay came first, a 300-ms one rather than a 60-ms one, and stayed there (stand rc.5,
 * O-1).
 */

/** How often Gateway measures its round trip to each remote relay its streams may use (as daemons). */
export const GATEWAY_RELAY_SAMPLE_INTERVAL_MS = 30_000;
/** A round trip older than this is unknown again, not stale (as daemons). */
const LATENCY_MAX_AGE_MS = 3 * 60_000;
/** The share of a new sample in the moving average (as daemons). */
const LATENCY_WEIGHT = 0.3;
const PROBE_TIMEOUT_MS = 3_000;
/** A relay no assignment named for this long is no longer measured. */
const TARGET_TTL_MS = 10 * 60_000;
/** A relay must have been reached without a break this long before streams return to it (ReturnStableFor). */
export const GATEWAY_RETURN_STABLE_MS = 60_000;
/** A route's candidates are fetched again for a return judgement once they are this old. */
const ROUTE_CANDIDATES_FRESH_MS = 30_000;
/** Returner pacing, as relayresume: a pass every 10 s, at most 8 moves a pass, none for a stream moved within 1 min. */
export const GATEWAY_RETURN_INTERVAL_MS = 10_000;
const GATEWAY_RETURN_BATCH = 8;
export const GATEWAY_RETURN_COOLDOWN_MS = 60_000;

/** Relays of one role within this band of the nearest are equally near (relaybridge costBand). */
const COST_BAND_RATIO = 1.2;
const COST_BAND_FLOOR_MS = 3;
/** A stream returns from a farther relay of its role only beyond this band (relaybridge returnBand). */
const RETURN_BAND_RATIO = 1.5;
const RETURN_BAND_FLOOR_MS = 10;

export interface GatewayRelayCandidate {
  relayInstanceId: string;
  assignmentState: string;
  addresses: string[];
  port: number;
  local?: boolean;
  topology?: { role: 'primary' | 'standby' };
}

/** Where one relay stands for Gateway: reachable now, its measured round trip, reached without a break long enough. */
export interface GatewayRelayPlace {
  available: boolean;
  rttMs?: number;
  stable: boolean;
}

const roleRank = (candidate: GatewayRelayCandidate) => (candidate.topology?.role === 'standby' ? 1 : 0);
const costBand = (nearest: number) => Math.max(nearest * COST_BAND_RATIO, nearest + COST_BAND_FLOOR_MS);
const returnBand = (nearest: number) => Math.max(nearest * RETURN_BAND_RATIO, nearest + RETURN_BAND_FLOOR_MS);

/**
 * The order to try relays for one of Gateway's streams (relaybridge OrderCandidates): the relay being left last, active
 * assignments before staging ones, relays reachable now first, primaries before standbys, then by distance: relays of
 * a role within the band of the nearest reachable one are equally near, farther ones follow by round trip, unmeasured
 * ones last. Ties keep the assignment's order.
 */
export function orderGatewayRelayCandidates<T extends GatewayRelayCandidate>(
  candidates: readonly T[],
  place: (candidate: T) => GatewayRelayPlace,
  avoidRelayId: string | null = null
): T[] {
  const places = new Map(candidates.map((candidate) => [candidate, place(candidate)]));
  const nearest = new Map<number, number>();
  for (const [candidate, at] of places) {
    if (!at.available || at.rttMs === undefined) continue;
    const role = roleRank(candidate);
    nearest.set(role, Math.min(nearest.get(role) ?? Number.POSITIVE_INFINITY, at.rttMs));
  }
  const tier = (candidate: T) => {
    const at = places.get(candidate)!;
    if (at.rttMs === undefined) return { tier: 2, cost: 0 };
    const best = nearest.get(roleRank(candidate));
    return best === undefined || at.rttMs <= costBand(best) ? { tier: 0, cost: 0 } : { tier: 1, cost: at.rttMs };
  };
  return candidates
    .map((candidate, index) => ({ candidate, index, at: places.get(candidate)!, tier: tier(candidate) }))
    .sort(
      (a, b) =>
        Number(a.candidate.relayInstanceId === avoidRelayId) - Number(b.candidate.relayInstanceId === avoidRelayId) ||
        Number(a.candidate.assignmentState === 'staging') - Number(b.candidate.assignmentState === 'staging') ||
        Number(b.at.available) - Number(a.at.available) ||
        roleRank(a.candidate) - roleRank(b.candidate) ||
        a.tier.tier - b.tier.tier ||
        a.tier.cost - b.tier.cost ||
        a.index - b.index
    )
    .map(({ candidate }) => candidate);
}

/**
 * The relay a stream on `currentRelayId` should move back to, if any (relaybridge ReturnTarget): the nearest relay
 * reachable and stable for a while, when it stands clearly better than the current one: a primary while the stream is
 * on a standby, a relay of the same role nearer by more than the return band, or a measured one while the current
 * relay's distance is unknown. A stream whose relay is down is left to its path failure.
 */
export function gatewayReturnTarget<T extends GatewayRelayCandidate>(
  candidates: readonly T[],
  place: (candidate: T) => GatewayRelayPlace,
  currentRelayId: string
): T | null {
  const active = candidates.filter(({ assignmentState }) => assignmentState === 'active');
  const current = active.find(({ relayInstanceId }) => relayInstanceId === currentRelayId);
  if (!current || active.length < 2) return null;
  const currentPlace = place(current);
  if (!currentPlace.available) return null;
  // Another relay counts only once it has been reachable without a break for a while: one that just came back (or
  // keeps flapping) takes nothing yet.
  const steady = (candidate: T): GatewayRelayPlace => {
    const at = place(candidate);
    return candidate === current || at.stable ? at : { ...at, available: false };
  };
  const best = orderGatewayRelayCandidates(active, steady).find((candidate) => steady(candidate).available);
  if (!best || best === current) return null;
  const target = place(best);
  if (roleRank(best) < roleRank(current)) return best;
  if (roleRank(best) > roleRank(current) || target.rttMs === undefined) return null;
  if (currentPlace.rttMs === undefined) return best;
  return currentPlace.rttMs > returnBand(target.rttMs) ? best : null;
}

interface LatencySample {
  rttMs: number | null;
  at: number;
  /** Since when it has been reached without a failure; null while it fails. */
  reachedSince: number | null;
}

type Dial = (address: string, port: number, timeoutMs: number) => Promise<number>;

/** One TCP handshake's round trip, as daemons measure a relay they keep no lanes to. */
const dialRoundTrip: Dial = (address, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const socket = connect({ host: address, port });
    const timer = setTimeout(() => socket.destroy(new Error('relay round trip timed out')), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      const rtt = performance.now() - startedAt;
      socket.destroy();
      resolve(rtt);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

/**
 * Gateway's view of the relays its own streams use: the remote relays' measured round trips, the local relay's state
 * from its supervisor, and the routes' candidates; it orders a stream's relays and moves streams back to the nearest
 * relay, paced.
 */
export class GatewayRelayPaths {
  private readonly samples = new Map<string, LatencySample>();
  private readonly targets = new Map<string, { addresses: string[]; port: number; seenAt: number }>();
  private readonly routes = new Map<string, { candidates: GatewayRelayCandidate[]; at: number }>();
  private localRelay?: Pick<LocalRelayOutageSignal, 'latestOutage'>;
  private sampler: ReturnType<typeof setInterval> | null = null;
  private returner: ReturnType<typeof setInterval> | null = null;
  private sampling: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly dial: Dial;

  constructor(
    private readonly registry: Pick<RelayResumeRegistry, 'liveSessions' | 'schedule' | 'timers'>,
    /** A fresh assignment of a Gateway route (its candidates now). */
    private readonly fetchCandidates: (routeId: string) => Promise<GatewayRelayCandidate[]>,
    options: { now?: () => number; dial?: Dial } = {}
  ) {
    this.now = options.now ?? Date.now;
    this.dial = options.dial ?? dialRoundTrip;
  }

  setLocalRelay(signal: Pick<LocalRelayOutageSignal, 'latestOutage'>): void {
    this.localRelay = signal;
  }

  /** Where a relay stands now (GatewayRelayPlace). The local relay is on Gateway's host: no distance to speak of. */
  place(candidate: GatewayRelayCandidate): GatewayRelayPlace {
    const now = this.now();
    if (candidate.local) {
      const outage = this.localRelay?.latestOutage() ?? null;
      const serving = !outage || outage.servingAgainAt !== null;
      const stable = serving && (!outage || now - outage.servingAgainAt! >= GATEWAY_RETURN_STABLE_MS);
      return { available: serving, rttMs: 0, stable };
    }
    const sample = this.samples.get(candidate.relayInstanceId);
    if (!sample || now - sample.at > LATENCY_MAX_AGE_MS) return { available: true, stable: false };
    return {
      available: sample.reachedSince !== null,
      ...(sample.rttMs !== null ? { rttMs: sample.rttMs } : {}),
      stable: sample.reachedSince !== null && now - sample.reachedSince >= GATEWAY_RETURN_STABLE_MS,
    };
  }

  /** The candidates of one of Gateway's streams in the order to try them (orderGatewayRelayCandidates). */
  order<T extends GatewayRelayCandidate>(routeId: string, candidates: readonly T[], avoidRelayId: string | null): T[] {
    this.note(routeId, candidates);
    return orderGatewayRelayCandidates(candidates, (candidate) => this.place(candidate), avoidRelayId);
  }

  /** Remembers a route's candidates and the remote relays to measure; measures new ones at once. */
  note(routeId: string, candidates: readonly GatewayRelayCandidate[]): void {
    const now = this.now();
    this.routes.set(routeId, { candidates: [...candidates], at: now });
    let unmeasured = false;
    for (const candidate of candidates) {
      if (candidate.local || !candidate.addresses.length || !candidate.port) continue;
      unmeasured ||= !this.samples.has(candidate.relayInstanceId);
      this.targets.set(candidate.relayInstanceId, {
        addresses: candidate.addresses,
        port: candidate.port,
        seenAt: now,
      });
    }
    this.start();
    if (unmeasured) void this.sample();
  }

  /** Measures every remote relay of a recent assignment once (concurrent calls share one pass). */
  sample(): Promise<void> {
    this.sampling ??= this.runSample().finally(() => {
      this.sampling = null;
    });
    return this.sampling;
  }

  private async runSample(): Promise<void> {
    const now = this.now();
    for (const [id, target] of this.targets) {
      if (now - target.seenAt > TARGET_TTL_MS) {
        this.targets.delete(id);
        this.samples.delete(id);
      }
    }
    await Promise.all(
      [...this.targets].map(async ([id, target]) => {
        let rttMs: number | null = null;
        for (const address of target.addresses) {
          try {
            rttMs = await this.dial(address, target.port, PROBE_TIMEOUT_MS);
            break;
          } catch {
            // The next address, if any.
          }
        }
        this.observe(id, rttMs);
      })
    );
  }

  /** Folds one measurement in (null: the relay was not reached; its last round trip stays, as daemons keep it). */
  observe(relayInstanceId: string, rttMs: number | null): void {
    const now = this.now();
    const previous = this.samples.get(relayInstanceId);
    const fresh = previous && now - previous.at <= LATENCY_MAX_AGE_MS ? previous : undefined;
    if (rttMs === null) {
      this.samples.set(relayInstanceId, { rttMs: fresh?.rttMs ?? null, at: now, reachedSince: null });
      return;
    }
    const smoothed = fresh && fresh.rttMs !== null ? fresh.rttMs + LATENCY_WEIGHT * (rttMs - fresh.rttMs) : rttMs;
    this.samples.set(relayInstanceId, { rttMs: smoothed, at: now, reachedSince: fresh?.reachedSince ?? now });
  }

  /**
   * One returner pass (relayresume.Returner): each open stream that has not moved for the cooldown and stands on a
   * relay with a clearly nearer one (gatewayReturnTarget) moves through the planned path, at a random time within the
   * pass, at most a batch per pass. A planned move keeps the stream where it is when no new path opens; nothing is cut.
   */
  async returnPass(random: () => number = Math.random): Promise<number> {
    const now = this.now();
    const sessions = [...this.registry.liveSessions()];
    for (let index = sessions.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [sessions[index], sessions[other]] = [sessions[other]!, sessions[index]!];
    }
    let moved = 0;
    for (const session of sessions) {
      if (moved >= GATEWAY_RETURN_BATCH) break;
      const relayId = session.relayId;
      if (!relayId || !session.movable || now - session.lastMoveAt < GATEWAY_RETURN_COOLDOWN_MS) continue;
      if (!(await this.nearerRelay(session, relayId))) continue;
      const delay = Math.floor(random() * GATEWAY_RETURN_INTERVAL_MS);
      this.registry.timers.setTimeout(() => this.registry.schedule(() => session.migrate('return')), delay);
      moved += 1;
    }
    return moved;
  }

  private async nearerRelay(session: ResumableRelayDuplex, relayId: string): Promise<boolean> {
    const place = (candidate: GatewayRelayCandidate) => this.place(candidate);
    let route = this.routes.get(session.routeId);
    if (!route) return false;
    // Judged on the candidates the stream last dialed; a target found there is checked on a fresh assignment.
    if (!gatewayReturnTarget(route.candidates, place, relayId)) return false;
    if (this.now() - route.at > ROUTE_CANDIDATES_FRESH_MS) {
      try {
        this.note(session.routeId, await this.fetchCandidates(session.routeId));
      } catch (error) {
        logger.debug('A Gateway route was not looked up for a return to a nearer relay', {
          routeId: session.routeId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      route = this.routes.get(session.routeId)!;
    }
    return gatewayReturnTarget(route.candidates, place, relayId) !== null;
  }

  /** Starts measuring and returning (idempotent); both timers let the process exit. */
  start(): void {
    if (!this.sampler) {
      this.sampler = setInterval(() => void this.sample(), GATEWAY_RELAY_SAMPLE_INTERVAL_MS);
      this.sampler.unref?.();
    }
    if (!this.returner) {
      this.returner = setInterval(() => {
        void this.returnPass().catch((error) =>
          logger.debug('Gateway relay return pass failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }, GATEWAY_RETURN_INTERVAL_MS);
      this.returner.unref?.();
    }
  }

  stop(): void {
    if (this.sampler) clearInterval(this.sampler);
    if (this.returner) clearInterval(this.returner);
    this.sampler = null;
    this.returner = null;
  }
}
