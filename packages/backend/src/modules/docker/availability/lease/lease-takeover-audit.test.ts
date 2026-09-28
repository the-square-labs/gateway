import { describe, expect, it, vi } from 'vitest';
import type { LeaseObservationCandidate } from './lease-planning.js';
import type { LeaseHolderChangeNotice } from './lease-reports.js';
import {
  LEASE_TAKEOVER_SETTLE_MS,
  LEASE_TAKEOVER_UNKNOWN_SETTLE_MS,
  LeaseTakeoverAudit,
  type SettledLeaseTakeover,
} from './lease-takeover-audit.js';

// Stand run rc20 c (B-14), in wall-clock terms: app-node-2 last seen holding 15:22:43, killed 15:23:19.8; app-node-1
// acquired 15:23:55.160 through relay-136 while Gateway, the local relay and relay-137 were down. Gateway came back
// 15:25:15; the restarted local relay reported first (15:25:24.857), its first sighting 15:25:21.404; app-node-1's
// own report arrived 15:25:46.
const t = (clock: string) => new Date(`2026-09-28T${clock}Z`);
const LAST_SEEN = t('15:22:43.306');
const ACQUIRED = t('15:23:55.160');

function notice(extra: Partial<LeaseHolderChangeNotice> = {}): LeaseHolderChangeNotice {
  return {
    policyId: 'policy-hafo',
    slot: 0,
    kind: 'failover',
    from: 'app-node-2',
    to: 'app-node-1',
    ballot: { round: '4566', incarnation: '1790607095842', proposerId: 'app-node-1' },
    placementId: 'placement-1',
    source: 'relay',
    sourceId: 'local-relay',
    // The local relay's sighting was dropped (right after its own start): Gateway only knows when it noticed.
    holderSince: t('15:25:24.857'),
    takeoverSource: 'noticed',
    takeoverNotBefore: LAST_SEEN,
    ...extra,
  };
}

function candidate(extra: Partial<LeaseObservationCandidate>): LeaseObservationCandidate {
  return {
    holderId: 'app-node-1',
    ballot: { round: '4570', incarnation: '1790607095842', proposerId: 'app-node-1' },
    epoch: 15,
    manifestVersion: 32,
    source: 'relay',
    sourceId: 'relay-136',
    ...extra,
  };
}

function subject() {
  const written: SettledLeaseTakeover[] = [];
  const corrected: Array<{ holderId: string; since: Date }> = [];
  const audit = new LeaseTakeoverAudit(
    vi.fn(async (settled: SettledLeaseTakeover) => {
      written.push(settled);
    }),
    vi.fn(async (_policyId: string, _slot: number, holderId: string, since: Date) => {
      corrected.push({ holderId, since });
    })
  );
  return { audit, written, corrected };
}

const sighting = (...candidates: LeaseObservationCandidate[]) => [{ policyId: 'policy-hafo', slot: 0, candidates }];

describe('lease takeover audit time (B-14)', () => {
  it('stand run c: waits past the restarted relay and audits the holder its own acquisition time', async () => {
    const { audit, written, corrected } = subject();
    await audit.record(notice(), t('15:25:24.857'));
    expect(written).toEqual([]);

    // relay-137, restarted too, carries no usable sighting; relay-136 was up and saw the commit 150 ms in.
    await audit.observe(sighting(candidate({ sourceId: 'relay-137' })), t('15:25:30'));
    await audit.observe(sighting(candidate({ since: t('15:23:55.310') })), t('15:25:31'));
    expect(corrected.at(-1)).toEqual({ holderId: 'app-node-1', since: t('15:23:55.310') });
    expect(written).toEqual([]);

    await audit.observe(
      sighting(candidate({ source: 'daemon', sourceId: 'app-node-1', since: ACQUIRED, exact: true })),
      t('15:25:46.507')
    );
    expect(written).toEqual([
      expect.objectContaining({ takeoverAt: ACQUIRED, source: 'holder', noticedAt: t('15:25:24.857') }),
    ]);
    expect(corrected.at(-1)).toEqual({ holderId: 'app-node-1', since: ACQUIRED });
    expect(audit.pendingCount).toBe(0);
  });

  it('without the holder, audits the earliest voter sighting once the wait is over, never before the last holder', async () => {
    const { audit, written } = subject();
    await audit.record(notice({ holderSince: t('15:23:58'), takeoverSource: 'voters' }), t('15:25:24.857'));
    // A voter that missed the previous holder's term reports an older commit of this proposer: below the floor.
    await audit.observe(sighting(candidate({ since: t('15:10:00') })), t('15:25:26'));
    await audit.observe(sighting(candidate({ sourceId: 'secure-node-1', since: t('15:23:56') })), t('15:25:27'));
    await audit.settleDue(new Date(t('15:25:24.857').getTime() + LEASE_TAKEOVER_SETTLE_MS - 1));
    expect(written).toEqual([]);
    await audit.settleDue(new Date(t('15:25:24.857').getTime() + LEASE_TAKEOVER_SETTLE_MS));
    expect(written).toEqual([expect.objectContaining({ takeoverAt: t('15:23:56'), source: 'voters' })]);
  });

  it('waits longer for the holder when nobody reported a time, and not at all once the holder reported without one', async () => {
    const quiet = subject();
    await quiet.audit.record(notice(), t('15:25:24.857'));
    await quiet.audit.settleDue(new Date(t('15:25:24.857').getTime() + LEASE_TAKEOVER_SETTLE_MS));
    expect(quiet.written).toEqual([]);
    await quiet.audit.settleDue(new Date(t('15:25:24.857').getTime() + LEASE_TAKEOVER_UNKNOWN_SETTLE_MS));
    expect(quiet.written).toEqual([expect.objectContaining({ takeoverAt: t('15:25:24.857'), source: 'noticed' })]);

    // An older holder daemon reports no time: only the voters can still improve it.
    const older = subject();
    await older.audit.record(notice(), t('15:25:24.857'));
    await older.audit.observe(sighting(candidate({ source: 'daemon', sourceId: 'app-node-1' })), t('15:25:46'));
    await older.audit.settleDue(new Date(t('15:25:24.857').getTime() + LEASE_TAKEOVER_SETTLE_MS));
    expect(older.written).toEqual([expect.objectContaining({ source: 'noticed' })]);
  });

  it('audits at once when the change came with the holder its own time, and settles an earlier change first', async () => {
    const { audit, written } = subject();
    await audit.record(notice({ takeoverSource: 'voters', holderSince: t('15:23:56') }), t('15:25:24'));
    await audit.record(
      notice({
        kind: 'handoff',
        from: 'app-node-1',
        to: 'app-node-2',
        holderSince: t('15:27:13.554'),
        takeoverSource: 'holder',
      }),
      t('15:27:14.903')
    );
    expect(written.map(({ notice: change, source, takeoverAt }) => [change.kind, source, takeoverAt])).toEqual([
      ['failover', 'voters', t('15:23:56')],
      ['handoff', 'holder', t('15:27:13.554')],
    ]);
  });

  it('writes everything still waiting at shutdown', async () => {
    const { audit, written } = subject();
    await audit.record(notice(), t('15:25:24.857'));
    await audit.flush();
    expect(written).toHaveLength(1);
    expect(audit.pendingCount).toBe(0);
  });
});
