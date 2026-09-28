/**
 * A daemon reconnects a dropped control stream after about a second (its reconnect delay is 1 s, then 1 s and 2 s
 * connector retries while the relay comes back). Every control stream runs through the local relay, so a relay
 * restart drops all of them at once. An offline transition is published only when the node is still disconnected
 * after this window, so consumers do not tear down routes, members or replicas for a node that is already back.
 * Other detection (missed health reports, stale lastSeenAt) keeps its own timing.
 */
export const NODE_OFFLINE_DEBOUNCE_MS = 5_000;

/** One pending offline transition per node; a reconnect cancels it. */
export class NodeOfflineDebounce {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(readonly delayMs: number = NODE_OFFLINE_DEBOUNCE_MS) {}

  get enabled(): boolean {
    return this.delayMs > 0;
  }

  schedule(nodeId: string, markOffline: () => Promise<void>, onError: (error: unknown) => void): void {
    this.cancel(nodeId);
    const timer = setTimeout(() => {
      if (this.timers.get(nodeId) !== timer) return;
      this.timers.delete(nodeId);
      void markOffline().catch(onError);
    }, this.delayMs);
    timer.unref?.();
    this.timers.set(nodeId, timer);
  }

  /** Returns whether an offline transition was pending. */
  cancel(nodeId: string): boolean {
    const timer = this.timers.get(nodeId);
    if (!timer) return false;
    clearTimeout(timer);
    this.timers.delete(nodeId);
    return true;
  }
}
