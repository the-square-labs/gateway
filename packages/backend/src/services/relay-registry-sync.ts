import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('RelayRegistryService');

/**
 * One node's registry sync (routes, grants, token issue, the bindings command) ends within this bound. Its steps carry
 * their own command timeouts; this bound keeps a sync stuck anywhere else from holding the node's queue, and so every
 * later binding of that node, for good (stand rc.10, S6: a rollout waited on the target node's binding forever).
 */
export const NODE_SYNC_TIMEOUT_MS = 90_000;
/** The same failure of a background sync is logged as a warning once per interval. */
const FAILURE_REPORT_MS = 10 * 60 * 1000;

export function withinNodeSyncBound(sync: Promise<void>, nodeId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // The daemon answered none of the sync's commands in time (its command loop busy, or the commands lost).
      logger.warn('Internal registry sync of a node is given up; the next sync starts', {
        nodeId,
        boundSeconds: NODE_SYNC_TIMEOUT_MS / 1000,
      });
      reject(
        new Error(`Internal registry sync of node ${nodeId} did not finish within ${NODE_SYNC_TIMEOUT_MS / 1000} s`)
      );
    }, NODE_SYNC_TIMEOUT_MS);
    timer.unref?.();
  });
  // A sync given up on still ends on its own; its outcome is no longer awaited.
  sync.catch(() => undefined);
  return Promise.race([sync, bound]).finally(() => clearTimeout(timer));
}

/**
 * Failures of the background registry work (the 15-second token refresh, a node coming online): nobody awaits them,
 * and a node whose sync keeps failing lets its 120-second tokens expire. Each is logged, the same one per key once per
 * interval and otherwise at debug level, so a sync failing every 15 s does not flood the log.
 */
export class RegistrySyncFailureLog {
  private readonly reported = new Map<string, { message: string; at: number }>();

  report(key: string, error: unknown, context: Record<string, unknown> = {}, now = Date.now()): void {
    const message = error instanceof Error ? error.message : String(error);
    const last = this.reported.get(key);
    if (last?.message === message && now - last.at < FAILURE_REPORT_MS) {
      logger.debug('Internal registry sync failed again', { ...context, error: message });
      return;
    }
    this.reported.set(key, { message, at: now });
    logger.warn('Internal registry sync failed; retried by the next refresh', { ...context, error: message });
  }

  clear(key: string): void {
    this.reported.delete(key);
  }
}
