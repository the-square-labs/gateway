import { describe, expect, it } from 'vitest';
import { freshRelayStartWaitMs } from './relay-recovery-decision.js';

const NOW = Date.parse('2026-09-28T00:38:32.000Z');
const LAST_HEALTHY = '2026-09-28T00:38:22.000Z';
const run = (startedAt: string | null, running = true) => ({ id: 'relay-id', running, startedAt });

describe('freshRelayStartWaitMs', () => {
  it('waits out the readiness window of a run started after the last healthy probe', () => {
    // docker restart finished at :30; the supervisor decided at :32.
    expect(freshRelayStartWaitMs(run('2026-09-28T00:38:30.123456789Z'), LAST_HEALTHY, 20_000, NOW)).toBe(18_123);
  });

  it('acts at once on a run that was already healthy before it stopped answering', () => {
    expect(freshRelayStartWaitMs(run('2026-09-28T00:30:00.000Z'), LAST_HEALTHY, 20_000, NOW)).toBe(0);
  });

  it('acts once a fresh run has used up its own readiness window', () => {
    expect(freshRelayStartWaitMs(run('2026-09-28T00:38:23.000Z'), LAST_HEALTHY, 5_000, NOW)).toBe(0);
  });

  it('acts on a stopped, missing or never-started relay', () => {
    expect(freshRelayStartWaitMs(run('2026-09-28T00:38:30.000Z', false), LAST_HEALTHY, 20_000, NOW)).toBe(0);
    expect(freshRelayStartWaitMs(null, LAST_HEALTHY, 20_000, NOW)).toBe(0);
    expect(freshRelayStartWaitMs(run('0001-01-01T00:00:00Z'), null, 20_000, NOW)).toBe(0);
    expect(freshRelayStartWaitMs(run(null), null, 20_000, NOW)).toBe(0);
  });

  it('never waits longer than one readiness window', () => {
    expect(freshRelayStartWaitMs(run('2026-09-28T00:38:40.000Z'), null, 20_000, NOW)).toBe(20_000);
  });
});
