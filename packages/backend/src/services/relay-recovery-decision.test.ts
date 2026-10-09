import { describe, expect, it } from 'vitest';
import { RELAY_EXIT_SETTLE_MS, relayRecoveryWait } from './relay-recovery-decision.js';

const now = Date.parse('2026-10-09T13:26:00.700Z');
const lastRunStart = '2026-10-09T11:36:14.049Z';

describe('relay recovery wait', () => {
  it('dates a settling relay from its exit a moment ago, not from the start of its last run (O-23)', () => {
    const exitedAt = now - 100;
    const wait = relayRecoveryWait(
      { id: 'relay', running: false, startedAt: lastRunStart, finishedAt: new Date(exitedAt).toISOString() },
      now - 5_000,
      30_000,
      now
    );
    expect(wait).toEqual({ activity: 'settling', waitMs: RELAY_EXIT_SETTLE_MS - 100, sinceMs: exitedAt });
  });

  it('does not wait for an exit older than the settle window', () => {
    const wait = relayRecoveryWait(
      {
        id: 'relay',
        running: false,
        startedAt: lastRunStart,
        finishedAt: new Date(now - RELAY_EXIT_SETTLE_MS - 1).toISOString(),
      },
      now - 5_000,
      30_000,
      now
    );
    expect(wait).toBeNull();
  });

  it('dates a stop in progress from its request and a fresh run from its start', () => {
    const startedAt = now - 60_000;
    const requestedAt = now - 2_000;
    expect(
      relayRecoveryWait(
        {
          id: 'relay',
          running: true,
          startedAt: new Date(startedAt).toISOString(),
          stopTimeoutSeconds: 10,
          events: [{ action: 'kill', timeMs: requestedAt, attributes: { signal: '15' } } as never],
        },
        now - 1_000,
        30_000,
        now
      )
    ).toMatchObject({ activity: 'stopping', sinceMs: requestedAt });
    const freshStart = now - 1_000;
    expect(
      relayRecoveryWait(
        { id: 'relay', running: true, startedAt: new Date(freshStart).toISOString() },
        now - 5_000,
        30_000,
        now
      )
    ).toEqual({ activity: 'fresh_run', waitMs: 29_000, sinceMs: freshStart });
  });
});
