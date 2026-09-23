import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommercialOrchestrationActivity } from '@/edition/contract.js';
import {
  DEFAULT_ORCHESTRATION_WAIT_MS,
  MAX_ORCHESTRATION_WAIT_MS,
  orchestrationWaitDeadline,
  waitForOrchestrationIdle,
} from './orchestration-activity.js';

function source(readings: Array<CommercialOrchestrationActivity[] | null | Error>) {
  let index = 0;
  return {
    activeOrchestrationOperations: vi.fn(async () => {
      const reading = readings[Math.min(index++, readings.length - 1)]!;
      if (reading instanceof Error) throw reading;
      return reading;
    }),
    setOrchestrationAdmissionHold: vi.fn(() => true),
  };
}

const activity = (running: number, queued: number, expectedBy: number | null = null) => [
  { kind: 'availability', label: 'Availability operations', running, queued, expectedBy },
];

describe('waitForOrchestrationIdle', () => {
  afterEach(() => vi.useRealTimers());

  it('returns at once when nothing runs', async () => {
    const result = await waitForOrchestrationIdle(source([activity(0, 0)]), { scope: 'all', deadline: 'auto' });
    expect(result).toEqual({ outcome: 'idle', operations: [] });
  });

  it('reports a core that cannot count its operations', async () => {
    const result = await waitForOrchestrationIdle(source([null]), { scope: 'all', deadline: 'auto' });
    expect(result.outcome).toBe('unsupported');
  });

  it('waits for running and queued work until it finishes', async () => {
    vi.useFakeTimers();
    const onProgress = vi.fn();
    const operations = source([activity(1, 1), activity(0, 1), activity(0, 0)]);
    const waiting = waitForOrchestrationIdle(operations, { scope: 'all', deadline: 'auto', onProgress });

    await vi.advanceTimersByTimeAsync(4_000);
    await expect(waiting).resolves.toEqual({ outcome: 'idle', operations: [] });
    expect(onProgress.mock.calls.map(([pending]) => pending)).toEqual([
      [{ kind: 'availability', label: 'Availability operations', count: 2 }],
      [{ kind: 'availability', label: 'Availability operations', count: 1 }],
    ]);
  });

  it('ignores queued work when draining for shutdown', async () => {
    const result = await waitForOrchestrationIdle(source([activity(0, 3)]), {
      scope: 'running',
      deadline: Date.now() + 1_000,
    });
    expect(result.outcome).toBe('idle');
  });

  it('gives up at the deadline and reports what still runs', async () => {
    vi.useFakeTimers();
    const waiting = waitForOrchestrationIdle(source([activity(2, 0)]), {
      scope: 'running',
      deadline: Date.now() + 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(waiting).resolves.toEqual({
      outcome: 'deadline',
      operations: [{ kind: 'availability', label: 'Availability operations', count: 2 }],
    });
  });

  it('stops waiting when the operator overrides it', async () => {
    const override = new AbortController();
    const waiting = waitForOrchestrationIdle(source([activity(1, 0)]), {
      scope: 'all',
      deadline: 'auto',
      signal: override.signal,
    });
    await Promise.resolve();
    override.abort();
    await expect(waiting).resolves.toMatchObject({ outcome: 'override' });
  });

  it('keeps waiting while operations cannot be counted', async () => {
    vi.useFakeTimers();
    const onProgress = vi.fn();
    const waiting = waitForOrchestrationIdle(source([new Error('database unavailable'), activity(0, 0)]), {
      scope: 'all',
      deadline: 'auto',
      onProgress,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(waiting).resolves.toMatchObject({ outcome: 'idle' });
    expect(onProgress).toHaveBeenCalledWith([expect.objectContaining({ kind: 'unknown' })], expect.any(Number));
  });
});

describe('orchestrationWaitDeadline', () => {
  it('waits the default time unless an operation announces a longer one, within the cap', () => {
    const start = 1_000_000;
    expect(orchestrationWaitDeadline(start, activity(1, 0))).toBe(start + DEFAULT_ORCHESTRATION_WAIT_MS);
    expect(orchestrationWaitDeadline(start, activity(1, 0, start + 20 * 60_000))).toBe(start + 20 * 60_000);
    expect(orchestrationWaitDeadline(start, activity(1, 0, start + 5 * 60 * 60_000))).toBe(
      start + MAX_ORCHESTRATION_WAIT_MS
    );
  });
});
