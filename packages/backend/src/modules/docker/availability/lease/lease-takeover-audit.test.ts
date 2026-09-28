import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import type { LeaseObservationCandidate } from './lease-planning.js';
import type { LeaseHolderChangeNotice } from './lease-reports.js';
import {
  LEASE_TAKEOVER_SETTING_PREFIX,
  LEASE_TAKEOVER_SETTLE_MS,
  LEASE_TAKEOVER_UNKNOWN_SETTLE_MS,
  LeaseTakeoverAudit,
  pendingLeaseTakeover,
  persistPendingLeaseTakeover,
  type SettledLeaseTakeover,
} from './lease-takeover-audit.js';

// Stand run rc20 c (B-14), in wall-clock terms: app-node-2 last seen holding 15:22:43, killed 15:23:19.8; app-node-1
// acquired 15:23:55.160 through relay-136 while Gateway, the local relay and relay-137 were down. Gateway came back
// 15:25:15; the restarted local relay reported first (15:25:24.857), its first sighting 15:25:21.404; app-node-1's
// own report arrived 15:25:46.
const t = (clock: string) => new Date(`2026-09-28T${clock}Z`);
const LAST_SEEN = t('15:22:43.306');
const ACQUIRED = t('15:23:55.160');
const NOTICED = t('15:25:24.857');
const noticedPlus = (ms: number) => new Date(NOTICED.getTime() + ms);

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
    holderSince: NOTICED,
    takeoverSource: 'noticed',
    takeoverNotBefore: LAST_SEEN,
    noticedAt: NOTICED,
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

const sighting = (...candidates: LeaseObservationCandidate[]) => [{ policyId: 'policy-hafo', slot: 0, candidates }];

function sqlValues(condition: any): unknown[] {
  return (condition?.queryChunks ?? []).flatMap((chunk: any) =>
    chunk?.queryChunks ? sqlValues(chunk) : chunk?.value !== undefined ? [chunk.value] : []
  );
}

/** The settings rows the audit keeps its waiting entries in; they outlive a process. */
function settingsTable() {
  const rows = new Map<string, unknown>();
  const db = {
    select: () => ({
      from: () => ({
        where: async () =>
          [...rows]
            .filter(([key]) => key.startsWith(LEASE_TAKEOVER_SETTING_PREFIX))
            .map(([key, value]) => ({ key, value: structuredClone(value) })),
      }),
    }),
    insert: () => ({
      values: (row: { key: string; value: unknown }) => ({
        onConflictDoUpdate: async () => {
          rows.set(row.key, structuredClone(row.value));
        },
      }),
    }),
    delete: () => ({
      where: async (condition: unknown) => {
        for (const value of sqlValues(condition)) rows.delete(String(value));
      },
    }),
  };
  return { rows, db: db as unknown as DrizzleClient };
}

/** A Gateway process: its audit log is shared with the next process, like the database. */
function gateway(table: ReturnType<typeof settingsTable>, log: SettledLeaseTakeover[], failWrites = false) {
  const corrected: Array<{ holderId: string; since: Date }> = [];
  const audit = new LeaseTakeoverAudit(table.db, {
    write: vi.fn(async (settled: SettledLeaseTakeover) => {
      if (failWrites) return false;
      log.push(settled);
      return true;
    }),
    written: vi.fn(async (settled: SettledLeaseTakeover) =>
      log.some((entry) => entry.takeoverId === settled.takeoverId)
    ),
    correct: vi.fn(async (_policyId: string, _slot: number, holderId: string, since: Date) => {
      corrected.push({ holderId, since });
    }),
  });
  /** What the report ingestion does: the entry is stored with the holder change, then the service records it. */
  const notice$ = async (change: LeaseHolderChangeNotice) => {
    await persistPendingLeaseTakeover(table.db, pendingLeaseTakeover(change));
    await audit.record(change);
  };
  return { audit, corrected, notice: notice$ };
}

describe('lease takeover audit time (B-14)', () => {
  it('stand run c: waits past the restarted relay and audits the holder its own acquisition time', async () => {
    const table = settingsTable();
    const log: SettledLeaseTakeover[] = [];
    const { audit, corrected, notice: change } = gateway(table, log);
    await change(notice());
    expect(log).toEqual([]);
    expect(table.rows.size).toBe(1);

    // relay-137, restarted too, carries no usable sighting; relay-136 was up and saw the commit 150 ms in.
    await audit.observe(sighting(candidate({ sourceId: 'relay-137' })), noticedPlus(5_000));
    await audit.observe(sighting(candidate({ since: t('15:23:55.310') })), noticedPlus(6_000));
    expect(corrected.at(-1)).toEqual({ holderId: 'app-node-1', since: t('15:23:55.310') });
    expect(log).toEqual([]);

    await audit.observe(
      sighting(candidate({ source: 'daemon', sourceId: 'app-node-1', since: ACQUIRED, exact: true })),
      t('15:25:46.507')
    );
    expect(log).toEqual([
      expect.objectContaining({
        takeoverAt: ACQUIRED,
        source: 'holder',
        noticedAt: NOTICED,
        takeoverId: expect.any(String),
      }),
    ]);
    expect(corrected.at(-1)).toEqual({ holderId: 'app-node-1', since: ACQUIRED });
    expect(audit.pendingCount).toBe(0);
    expect(table.rows.size).toBe(0);
  });

  it('without the holder, audits the earliest voter sighting once the wait is over, never before the last holder', async () => {
    const table = settingsTable();
    const log: SettledLeaseTakeover[] = [];
    const { audit, notice: change } = gateway(table, log);
    await change(notice({ holderSince: t('15:23:58'), takeoverSource: 'voters' }));
    // A voter that missed the previous holder's term reports an older commit of this proposer: below the floor.
    await audit.observe(sighting(candidate({ since: t('15:10:00') })), noticedPlus(1_000));
    await audit.observe(sighting(candidate({ sourceId: 'secure-node-1', since: t('15:23:56') })), noticedPlus(2_000));
    await audit.settleDue(noticedPlus(LEASE_TAKEOVER_SETTLE_MS - 1));
    expect(log).toEqual([]);
    await audit.settleDue(noticedPlus(LEASE_TAKEOVER_SETTLE_MS));
    expect(log).toEqual([expect.objectContaining({ takeoverAt: t('15:23:56'), source: 'voters' })]);
    expect(table.rows.size).toBe(0);
  });

  it('waits longer for the holder when nobody reported a time, and not at all once the holder reported without one', async () => {
    const quiet = settingsTable();
    const quietLog: SettledLeaseTakeover[] = [];
    const first = gateway(quiet, quietLog);
    await first.notice(notice());
    await first.audit.settleDue(noticedPlus(LEASE_TAKEOVER_SETTLE_MS));
    expect(quietLog).toEqual([]);
    await first.audit.settleDue(noticedPlus(LEASE_TAKEOVER_UNKNOWN_SETTLE_MS));
    expect(quietLog).toEqual([expect.objectContaining({ takeoverAt: NOTICED, source: 'noticed' })]);

    // An older holder daemon reports no time: only the voters can still improve it.
    const older = settingsTable();
    const olderLog: SettledLeaseTakeover[] = [];
    const second = gateway(older, olderLog);
    await second.notice(notice());
    await second.audit.observe(sighting(candidate({ source: 'daemon', sourceId: 'app-node-1' })), noticedPlus(21_000));
    await second.audit.settleDue(noticedPlus(LEASE_TAKEOVER_SETTLE_MS));
    expect(olderLog).toEqual([expect.objectContaining({ source: 'noticed' })]);
  });

  it('audits at once when the change came with the holder its own time, and settles an earlier change first', async () => {
    const table = settingsTable();
    const log: SettledLeaseTakeover[] = [];
    const { notice: change } = gateway(table, log);
    await change(notice({ takeoverSource: 'voters', holderSince: t('15:23:56') }));
    await change(
      notice({
        kind: 'handoff',
        from: 'app-node-1',
        to: 'app-node-2',
        ballot: { round: '4589', incarnation: '1790609156998', proposerId: 'app-node-2' },
        holderSince: t('15:27:13.554'),
        takeoverSource: 'holder',
        noticedAt: t('15:27:14.903'),
      })
    );
    expect(log.map(({ notice: entry, source, takeoverAt }) => [entry.kind, source, takeoverAt])).toEqual([
      ['failover', 'voters', t('15:23:56')],
      ['handoff', 'holder', t('15:27:13.554')],
    ]);
    expect(table.rows.size).toBe(0);
  });

  it('writes everything still waiting at shutdown', async () => {
    const table = settingsTable();
    const log: SettledLeaseTakeover[] = [];
    const { audit, notice: change } = gateway(table, log);
    await change(notice());
    await audit.flush();
    expect(log).toHaveLength(1);
    expect(audit.pendingCount).toBe(0);
    expect(table.rows.size).toBe(0);
  });
});

describe('lease takeover audit across a Gateway crash (B-14)', () => {
  it('continues the wait after a restart and audits the holder its own time when it reports', async () => {
    const table = settingsTable();
    const log: SettledLeaseTakeover[] = [];
    const crashed = gateway(table, log);
    await crashed.notice(notice());
    await crashed.audit.observe(sighting(candidate({ since: t('15:23:55.310') })), noticedPlus(6_000));
    // Crash: no shutdown flush. The next process starts with only the database.
    const restarted = gateway(table, log);
    await restarted.audit.settleDue(noticedPlus(20_000));
    expect(log).toEqual([]);
    expect(restarted.audit.pendingCount).toBe(1);
    await restarted.audit.observe(
      sighting(candidate({ source: 'daemon', sourceId: 'app-node-1', since: ACQUIRED, exact: true })),
      noticedPlus(21_650)
    );
    expect(log).toEqual([expect.objectContaining({ takeoverAt: ACQUIRED, source: 'holder', noticedAt: NOTICED })]);
    expect(table.rows.size).toBe(0);
  });

  it('writes what is overdue at the first settle after the restart, dated at the best time known', async () => {
    const table = settingsTable();
    const log: SettledLeaseTakeover[] = [];
    const crashed = gateway(table, log);
    await crashed.notice(notice());
    await crashed.audit.observe(sighting(candidate({ since: t('15:23:55.310') })), noticedPlus(6_000));
    const restarted = gateway(table, log);
    await restarted.audit.settleDue(noticedPlus(10 * 60_000));
    expect(log).toEqual([
      expect.objectContaining({ takeoverAt: t('15:23:55.310'), source: 'voters', noticedAt: NOTICED }),
    ]);
    expect(table.rows.size).toBe(0);
  });

  it('keeps the holder time a crashed process got but could not write, and writes it once', async () => {
    const table = settingsTable();
    const log: SettledLeaseTakeover[] = [];
    const failing = gateway(table, log, true);
    await failing.notice(notice());
    await failing.audit.observe(
      sighting(candidate({ source: 'daemon', sourceId: 'app-node-1', since: ACQUIRED, exact: true })),
      noticedPlus(21_650)
    );
    expect(log).toEqual([]);
    expect(table.rows.size).toBe(1);
    const restarted = gateway(table, log);
    await restarted.audit.settleDue(noticedPlus(22_000));
    await restarted.audit.settleDue(noticedPlus(23_000));
    expect(log).toEqual([expect.objectContaining({ takeoverAt: ACQUIRED, source: 'holder' })]);
    expect(table.rows.size).toBe(0);
  });

  it('does not audit twice when the crash came between the audit row and clearing the entry', async () => {
    const table = settingsTable();
    const log: SettledLeaseTakeover[] = [];
    const change = notice({ takeoverSource: 'holder', holderSince: ACQUIRED });
    const pending = pendingLeaseTakeover(change);
    await persistPendingLeaseTakeover(table.db, pending);
    // The crashed process wrote the audit row but not the deletion.
    log.push({ takeoverId: pending.id, notice: change, takeoverAt: ACQUIRED, source: 'holder', noticedAt: NOTICED });
    const restarted = gateway(table, log);
    await restarted.audit.settleDue(noticedPlus(1_000));
    expect(log).toHaveLength(1);
    expect(table.rows.size).toBe(0);
  });
});
