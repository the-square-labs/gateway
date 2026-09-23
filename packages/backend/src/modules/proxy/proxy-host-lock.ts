import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * In-process keyed mutex that serializes the "write DB -> render -> apply"
 * sequence per proxy host, so a node always ends up serving the config that
 * matches the last committed DB state.
 *
 * Keys are acquired in sorted order to avoid lock-order deadlocks. The lock is
 * reentrant within one async call chain: a locked operation that calls another
 * locked operation for a key it already holds (for example an update that
 * re-renders the same host through an Additional Route hook) runs directly.
 */
const heldKeys = new AsyncLocalStorage<ReadonlySet<string>>();
const tails = new Map<string, Promise<void>>();

export function proxyHostLockKey(hostId: string): string {
  return `proxy-host:${hostId}`;
}

/** Held by operations that can make a host serve on a node (create, enable, move). */
export function proxyNodeLockKey(nodeId: string): string {
  return `proxy-node:${nodeId}`;
}

export function accessListLockKey(accessListId: string): string {
  return `access-list:${accessListId}`;
}

export async function withProxyLocks<T>(
  keys: Array<string | null | undefined | false>,
  fn: () => Promise<T>
): Promise<T> {
  const held = heldKeys.getStore() ?? new Set<string>();
  const wanted = [...new Set(keys.filter((key): key is string => typeof key === 'string' && key.length > 0))]
    .filter((key) => !held.has(key))
    .sort();
  if (wanted.length === 0) return fn();

  const releases: Array<() => void> = [];
  try {
    for (const key of wanted) {
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => released);
      tails.set(key, tail);
      releases.push(() => {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      });
      await previous;
    }
    return await heldKeys.run(new Set([...held, ...wanted]), fn);
  } finally {
    for (const release of releases.reverse()) release();
  }
}

export function withProxyHostLock<T>(hostId: string, fn: () => Promise<T>): Promise<T> {
  return withProxyLocks([proxyHostLockKey(hostId)], fn);
}

/** Test hook: number of keys with queued or running holders. */
export function activeProxyLockCount(): number {
  return tails.size;
}
