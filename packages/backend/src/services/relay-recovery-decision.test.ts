import { describe, expect, it } from 'vitest';
import { RELAY_EXIT_SETTLE_MS, relayRecoveryWait } from './relay-recovery-decision.js';

const NOW = Date.parse('2026-09-28T00:38:32.000Z');
const LAST_HEALTHY = Date.parse('2026-09-28T00:38:22.000Z');
const OLD_RUN = '2026-09-28T00:30:00.000Z';
const run = (startedAt: string | null, running = true, extra: Record<string, unknown> = {}) => ({
  id: 'relay-id',
  running,
  startedAt,
  ...extra,
});
const kill = (at: number, signal = '15') => ({ action: 'kill', timeMs: at, attributes: { signal } });

describe('relayRecoveryWait', () => {
  it('waits out the readiness window of a run started after the last healthy probe', () => {
    // docker restart finished at :30; the supervisor decided at :32.
    expect(relayRecoveryWait(run('2026-09-28T00:38:30.123456789Z'), LAST_HEALTHY, 20_000, NOW)).toEqual({
      activity: 'fresh_run',
      waitMs: 18_123,
    });
  });

  it('acts at once on a run that was already healthy before it stopped answering (crash or hang)', () => {
    expect(relayRecoveryWait(run(OLD_RUN), LAST_HEALTHY, 20_000, NOW)).toBeNull();
  });

  it('acts once a fresh run has used up its own readiness window', () => {
    expect(relayRecoveryWait(run('2026-09-28T00:38:23.000Z'), LAST_HEALTHY, 5_000, NOW)).toBeNull();
  });

  it('acts on a missing or never-started relay', () => {
    expect(relayRecoveryWait(null, LAST_HEALTHY, 20_000, NOW)).toBeNull();
    expect(relayRecoveryWait(run('0001-01-01T00:00:00Z'), null, 20_000, NOW)).toBeNull();
    expect(relayRecoveryWait(run(null), null, 20_000, NOW)).toBeNull();
  });

  it('never waits longer than one readiness window for a fresh run', () => {
    expect(relayRecoveryWait(run('2026-09-28T00:38:40.000Z'), null, 20_000, NOW)).toEqual({
      activity: 'fresh_run',
      waitMs: 20_000,
    });
  });

  it('leaves a relay alone while Docker restart policy brings it back', () => {
    expect(relayRecoveryWait(run(OLD_RUN, false, { restarting: true }), LAST_HEALTHY, 20_000, NOW)).toEqual({
      activity: 'restarting',
      waitMs: 20_000,
    });
  });

  it('waits for an external stop in progress to reach its kill deadline (slow docker restart)', () => {
    // `docker restart` sent SIGTERM 5.8 s ago; the relay drains and is still running its old run.
    const observed = run(OLD_RUN, true, { stopTimeoutSeconds: 10, events: [kill(NOW - 5_800)] });
    expect(relayRecoveryWait(observed, LAST_HEALTHY, 20_000, NOW)).toEqual({ activity: 'stopping', waitMs: 9_200 });
  });

  it('counts a stop request that arrived before the last healthy probe', () => {
    // The relay kept answering for a moment after SIGTERM; the stop is still in progress.
    const observed = run(OLD_RUN, true, { events: [kill(LAST_HEALTHY - 1_000)] });
    expect(relayRecoveryWait(observed, LAST_HEALTHY, 20_000, NOW)).toMatchObject({ activity: 'stopping' });
  });

  it('acts on a stop that outlived its kill deadline', () => {
    const observed = run(OLD_RUN, true, { stopTimeoutSeconds: 10, events: [kill(NOW - 16_000)] });
    expect(relayRecoveryWait(observed, LAST_HEALTHY, 20_000, NOW)).toBeNull();
  });

  it('gives a SIGKILL only the exit grace', () => {
    const observed = run(OLD_RUN, true, { events: [kill(NOW - 1_000, '9')] });
    expect(relayRecoveryWait(observed, LAST_HEALTHY, 20_000, NOW)).toEqual({ activity: 'stopping', waitMs: 4_000 });
  });

  it('ignores signals that do not stop the relay and stop requests against an earlier run', () => {
    expect(
      relayRecoveryWait(run(OLD_RUN, true, { events: [kill(NOW - 1_000, '1')] }), LAST_HEALTHY, 20_000, NOW)
    ).toBeNull();
    expect(
      relayRecoveryWait(run(OLD_RUN, true, { events: [kill(Date.parse(OLD_RUN) - 1_000)] }), LAST_HEALTHY, 20_000, NOW)
    ).toBeNull();
  });

  it('gives a relay that just exited a moment for a restart to start it', () => {
    const observed = run(OLD_RUN, false, { finishedAt: new Date(NOW - 500).toISOString() });
    expect(relayRecoveryWait(observed, LAST_HEALTHY, 20_000, NOW)).toEqual({
      activity: 'settling',
      waitMs: RELAY_EXIT_SETTLE_MS - 500,
    });
  });

  it('acts at once on a relay that exited earlier and stayed down (crash without restart)', () => {
    const observed = run(OLD_RUN, false, { finishedAt: new Date(NOW - 6_000).toISOString() });
    expect(relayRecoveryWait(observed, LAST_HEALTHY, 20_000, NOW)).toBeNull();
    expect(relayRecoveryWait(run(OLD_RUN, false), LAST_HEALTHY, 20_000, NOW)).toBeNull();
  });
});
