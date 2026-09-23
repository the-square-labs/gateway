import type { CommercialOrchestrationActivity } from '@/edition/contract.js';
import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('OrchestrationActivity');

/** The commercial edition runtime; cores that predate the hook report null. */
export interface OrchestrationActivitySource {
  activeOrchestrationOperations(): Promise<CommercialOrchestrationActivity[] | null>;
  setOrchestrationAdmissionHold(reason: string | null): boolean;
}

/**
 * `running` is work executing in this process or on a node right now: what a
 * shutdown drains. `all` also waits for queued work that finishes by itself,
 * such as a slot drain that falls due: what an update waits for.
 */
export type OrchestrationWaitScope = 'running' | 'all';

export interface PendingOrchestrationOperation {
  kind: string;
  label: string;
  count: number;
}

export interface OrchestrationWaitResult {
  outcome: 'idle' | 'unsupported' | 'deadline' | 'override';
  operations: PendingOrchestrationOperation[];
}

/** Used when no running operation announces how long it may take. */
export const DEFAULT_ORCHESTRATION_WAIT_MS = 15 * 60_000;
/** A longer announced operation extends the wait, never beyond this. */
export const MAX_ORCHESTRATION_WAIT_MS = 60 * 60_000;
const POLL_INTERVAL_MS = 2_000;

export function pendingOrchestrationOperations(
  activity: readonly CommercialOrchestrationActivity[],
  scope: OrchestrationWaitScope
): PendingOrchestrationOperation[] {
  return activity
    .map(({ kind, label, running, queued }) => ({
      kind,
      label,
      count: Math.max(0, running) + (scope === 'all' ? Math.max(0, queued) : 0),
    }))
    .filter((operation) => operation.count > 0);
}

/** The longest announced deadline of the pending work, or the default. */
export function orchestrationWaitDeadline(
  startedAt: number,
  activity: readonly CommercialOrchestrationActivity[]
): number {
  const announced = Math.max(0, ...activity.map((item) => item.expectedBy ?? 0));
  return Math.min(
    startedAt + MAX_ORCHESTRATION_WAIT_MS,
    Math.max(startedAt + DEFAULT_ORCHESTRATION_WAIT_MS, announced)
  );
}

/**
 * Waits until no orchestration work of the scope is pending, the deadline
 * passes or the signal aborts (an operator override). A deadline of 'auto'
 * follows the work itself (see orchestrationWaitDeadline).
 */
export async function waitForOrchestrationIdle(
  source: OrchestrationActivitySource,
  options: {
    scope: OrchestrationWaitScope;
    deadline: number | 'auto';
    signal?: AbortSignal;
    pollIntervalMs?: number;
    onProgress?: (operations: PendingOrchestrationOperation[], deadline: number) => void;
    now?: () => number;
  }
): Promise<OrchestrationWaitResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let deadline = typeof options.deadline === 'number' ? options.deadline : null;
  let operations: PendingOrchestrationOperation[] = [];
  let reported = '';
  for (;;) {
    if (options.signal?.aborted) return { outcome: 'override', operations };
    let activity: CommercialOrchestrationActivity[] | null | undefined;
    try {
      activity = await source.activeOrchestrationOperations();
    } catch (error) {
      // Unknown is not idle: keep waiting until the deadline or an override.
      logger.warn('Could not read running orchestration operations', { error });
      if (!operations.length)
        operations = [{ kind: 'unknown', label: 'Operations that could not be counted', count: 1 }];
    }
    if (activity === null) return { outcome: 'unsupported', operations: [] };
    if (activity) {
      operations = pendingOrchestrationOperations(activity, options.scope);
      if (!operations.length) return { outcome: 'idle', operations };
      deadline ??= orchestrationWaitDeadline(startedAt, activity);
    }
    deadline ??= startedAt + DEFAULT_ORCHESTRATION_WAIT_MS;
    if (now() >= deadline) return { outcome: 'deadline', operations };
    const snapshot = JSON.stringify([operations, deadline]);
    if (snapshot !== reported && operations.length) {
      reported = snapshot;
      options.onProgress?.(operations, deadline);
    }
    await pause(Math.min(options.pollIntervalMs ?? POLL_INTERVAL_MS, Math.max(0, deadline - now())), options.signal);
  }
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener('abort', done, { once: true });
  });
}
