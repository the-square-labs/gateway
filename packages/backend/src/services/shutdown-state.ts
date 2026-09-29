/**
 * Whether this process is shutting down (SIGTERM/SIGINT received). At a host shutdown dockerd stops postgres and
 * redis together with the app, so their connections end while the app drains: expected then, logged once at info
 * instead of as errors or uncaught exceptions (N-19).
 */
let shuttingDown = false;
const reported = new Set<string>();

export function markShuttingDown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** True the first time `key` is reported during this shutdown: the caller logs once. */
export function firstShutdownReport(key: string): boolean {
  if (reported.has(key)) return false;
  reported.add(key);
  return true;
}
