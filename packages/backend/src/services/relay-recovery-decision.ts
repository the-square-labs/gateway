import type { RelayContainerObservation } from './relay-docker-recovery.service.js';

/** Signals a `docker stop`, `docker restart` or `docker kill` sends to end the relay. */
const TERMINATING_SIGNALS = new Set(['2', '3', '9', '15', 'SIGINT', 'SIGQUIT', 'SIGKILL', 'SIGTERM']);
/** Docker's stop timeout when the container sets none. */
const DEFAULT_STOP_TIMEOUT_SECONDS = 10;
/** Slack after a stop's kill deadline: SIGKILL delivery, exit and Docker's own bookkeeping. */
const STOP_GRACE_MS = 5_000;
/**
 * How long a relay that just exited is left alone. A `docker restart` starts the new run a few
 * milliseconds after the old one exits, and Docker's restart policy marks the container
 * `Restarting` at once; a relay still down after this is really down.
 */
export const RELAY_EXIT_SETTLE_MS = 2_000;

export type RelayExternalActivity =
  /** A run the supervisor never saw healthy is booting; it gets its own readiness window. */
  | 'fresh_run'
  /** Docker's restart policy is bringing the relay back. */
  | 'restarting'
  /** Someone asked the current run to stop (`docker stop`/`restart`/`kill`); it is shutting down. */
  | 'stopping'
  /** The relay exited a moment ago; a restart's start may follow. */
  | 'settling';

export interface RelayRecoveryWait {
  activity: RelayExternalActivity;
  /** How long to leave the relay alone before judging it again. */
  waitMs: number;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  // Docker reports "0001-01-01T00:00:00Z" for a run that never happened.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Whether something other than the supervisor is acting on the relay container right now, and how
 * long recovery must leave it alone. `baselineMs` is the supervisor's last own observation of the
 * relay: the last healthy probe, or the end of its own last recovery action, whichever is later.
 * A run started after it was started by someone else (an operator's `docker restart`, Docker's
 * restart policy, an update); a relay being stopped by someone else is still inside that stop.
 * Restarting the relay in either case starts it a second time and only doubles the outage.
 *
 * Returns null when recovery should act now: no container, a run that was already observed and
 * stopped answering (a crash or hang), or a run that used up its own window and still does not
 * answer.
 */
export function relayRecoveryWait(
  observed: RelayContainerObservation | null,
  baselineMs: number | null,
  readinessWaitMs: number,
  now = Date.now()
): RelayRecoveryWait | null {
  if (!observed) return null;
  if (observed.restarting) return { activity: 'restarting', waitMs: readinessWaitMs };
  if (!observed.running) {
    const finishedAt = parseTime(observed.finishedAt);
    if (finishedAt === null) return null;
    const waitMs = Math.min(RELAY_EXIT_SETTLE_MS, finishedAt + RELAY_EXIT_SETTLE_MS - now);
    return waitMs > 0 ? { activity: 'settling', waitMs } : null;
  }
  const startedAt = parseTime(observed.startedAt);
  if (startedAt === null) return null;
  if (baselineMs === null || startedAt > baselineMs) {
    const waitMs = Math.min(readinessWaitMs, startedAt + readinessWaitMs - now);
    if (waitMs > 0) return { activity: 'fresh_run', waitMs };
  }
  // A stop request against the current run that has not finished yet: its kill deadline is the
  // container's stop timeout after the signal. A stop that outlived that is hung, and recovery acts.
  const stopTimeoutMs = (observed.stopTimeoutSeconds ?? DEFAULT_STOP_TIMEOUT_SECONDS) * 1000;
  let stopWaitMs = 0;
  for (const event of observed.events ?? []) {
    if (event.timeMs < startedAt) continue;
    const signal = event.attributes.signal;
    const stopRequest = event.action === 'kill' ? signal !== undefined && TERMINATING_SIGNALS.has(signal) : false;
    if (!stopRequest) continue;
    const deadline = event.timeMs + (signal === '9' || signal === 'SIGKILL' ? 0 : stopTimeoutMs) + STOP_GRACE_MS;
    stopWaitMs = Math.max(stopWaitMs, deadline - now);
  }
  return stopWaitMs > 0 ? { activity: 'stopping', waitMs: stopWaitMs } : null;
}
