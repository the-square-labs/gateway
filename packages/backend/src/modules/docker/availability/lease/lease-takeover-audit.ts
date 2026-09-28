import { type LeaseTakeoverSource, leaseExactHolderSince } from './lease-planning.js';
import type { LeaseHolderChangeNotice, LeaseTakeoverSighting } from './lease-reports.js';

/** How long a takeover time from voter sightings waits for the holder's own time or an earlier sighting. */
export const LEASE_TAKEOVER_SETTLE_MS = 60_000;
/**
 * How long a takeover nobody reported a time for waits for the holder's own report: after Gateway comes back the
 * nodes reconnect only after their backoff, well after the relays.
 */
export const LEASE_TAKEOVER_UNKNOWN_SETTLE_MS = 5 * 60_000;

export interface SettledLeaseTakeover {
  notice: LeaseHolderChangeNotice;
  takeoverAt: Date;
  source: LeaseTakeoverSource;
  noticedAt: Date;
}

interface PendingTakeover {
  notice: LeaseHolderChangeNotice;
  noticedAt: Date;
  /** The earliest voter sighting of the takeover so far; null while nobody reported one. */
  best: Date | null;
  /** The holder itself reported without a time: waiting for it gains nothing, only for voters. */
  holderReported: boolean;
}

/**
 * B-14: the audit of a lease holder change carries the takeover time, whichever member reports it first. The holder's
 * own acquisition time is exact and audited at once. A voter's sighting is only an upper bound: a voter that was down
 * or cut off during the takeover sees it late (stand run rc20 c: the local relay, restarted with Gateway, reported the
 * takeover 86 s late). Such a change waits until the holder reports its time, taking the earliest sighting meanwhile,
 * for LEASE_TAKEOVER_SETTLE_MS, or LEASE_TAKEOVER_UNKNOWN_SETTLE_MS when nobody reported a time at all. Better times
 * also correct the key's recorded holderSince.
 */
export class LeaseTakeoverAudit {
  private readonly pending = new Map<string, PendingTakeover>();

  constructor(
    private readonly write: (settled: SettledLeaseTakeover) => Promise<void>,
    private readonly correct: (policyId: string, slot: number, holderId: string, since: Date) => Promise<void>
  ) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  /** An audited holder change (failover or handoff): written now when its time is the holder's own, else held back. */
  async record(notice: LeaseHolderChangeNotice, now = new Date()): Promise<void> {
    const key = keyOf(notice.policyId, notice.slot);
    const earlier = this.pending.get(key);
    if (earlier) {
      // The key changed holder again before the earlier change settled: that one is final as it stands.
      this.pending.delete(key);
      await this.write(settle(earlier));
    }
    const noticedAt = now;
    if (notice.takeoverSource === 'holder') {
      await this.write({ notice, takeoverAt: notice.holderSince ?? noticedAt, source: 'holder', noticedAt });
      return;
    }
    this.pending.set(key, {
      notice,
      noticedAt,
      best: notice.takeoverSource === 'voters' ? (notice.holderSince ?? null) : null,
      holderReported: notice.source === 'daemon' && notice.sourceId === notice.to,
    });
  }

  /** Later reports of the keys with a change held back: the holder's own time settles it, a voter's may improve it. */
  async observe(sightings: LeaseTakeoverSighting[], now = new Date()): Promise<void> {
    for (const sighting of sightings) {
      const key = keyOf(sighting.policyId, sighting.slot);
      const pending = this.pending.get(key);
      if (!pending) continue;
      const holderId = pending.notice.to;
      const exact = leaseExactHolderSince(holderId, sighting.candidates, now);
      if (exact) {
        this.pending.delete(key);
        await this.correct(sighting.policyId, sighting.slot, holderId, exact);
        await this.write({ notice: pending.notice, takeoverAt: exact, source: 'holder', noticedAt: pending.noticedAt });
        continue;
      }
      if (sighting.candidates.some((candidate) => candidate.source === 'daemon' && candidate.sourceId === holderId)) {
        pending.holderReported = true;
      }
      const floor = pending.notice.takeoverNotBefore?.getTime() ?? Number.NEGATIVE_INFINITY;
      const earliest = sighting.candidates
        .filter((candidate) => candidate.holderId === holderId && !candidate.exact && candidate.since instanceof Date)
        .map((candidate) => candidate.since!.getTime())
        .filter((time) => Number.isFinite(time) && time <= now.getTime() && time >= floor)
        .reduce((min, time) => Math.min(min, time), Number.POSITIVE_INFINITY);
      if (Number.isFinite(earliest) && (!pending.best || earliest < pending.best.getTime())) {
        pending.best = new Date(earliest);
        await this.correct(sighting.policyId, sighting.slot, holderId, pending.best);
      }
    }
  }

  /** Writes every held-back change whose wait is over. */
  async settleDue(now = new Date()): Promise<void> {
    for (const [key, pending] of [...this.pending]) {
      const wait = pending.best || pending.holderReported ? LEASE_TAKEOVER_SETTLE_MS : LEASE_TAKEOVER_UNKNOWN_SETTLE_MS;
      if (now.getTime() - pending.noticedAt.getTime() < wait) continue;
      if (this.pending.get(key) !== pending) continue;
      this.pending.delete(key);
      await this.write(settle(pending));
    }
  }

  /** Shutdown: nothing held back is lost. */
  async flush(): Promise<void> {
    for (const [key, pending] of [...this.pending]) {
      if (this.pending.get(key) !== pending) continue;
      this.pending.delete(key);
      await this.write(settle(pending));
    }
  }
}

function keyOf(policyId: string, slot: number): string {
  return `${policyId}/${slot}`;
}

function settle(pending: PendingTakeover): SettledLeaseTakeover {
  return pending.best
    ? { notice: pending.notice, takeoverAt: pending.best, source: 'voters', noticedAt: pending.noticedAt }
    : {
        notice: pending.notice,
        takeoverAt: pending.notice.holderSince ?? pending.noticedAt,
        source: 'noticed',
        noticedAt: pending.noticedAt,
      };
}
