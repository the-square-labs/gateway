import type { RelayContainerObservation } from './relay-docker-recovery.service.js';

/**
 * How long recovery should wait for a relay container that was started after the relay was last
 * seen healthy, instead of restarting it. Such a run was started by someone else (an operator's
 * `docker restart`, Docker's restart policy, an update) and is still booting; for a few seconds
 * the control channel may even keep reporting the old connection failure. It gets the same
 * readiness window a supervisor restart gets, counted from its own start. Zero means act now: no
 * running container, or a run that already had its window and is still not answering.
 */
export function freshRelayStartWaitMs(
  observed: RelayContainerObservation | null,
  lastHealthyAt: string | null,
  readinessWaitMs: number,
  now = Date.now()
): number {
  if (!observed?.running || !observed.startedAt) return 0;
  const startedAt = Date.parse(observed.startedAt);
  if (!Number.isFinite(startedAt)) return 0;
  const lastHealthy = lastHealthyAt ? Date.parse(lastHealthyAt) : Number.NEGATIVE_INFINITY;
  // A run that was already healthy once and then stopped answering is really down.
  if (Number.isFinite(lastHealthy) && startedAt <= lastHealthy) return 0;
  return Math.max(0, Math.min(readinessWaitMs, startedAt + readinessWaitMs - now));
}
