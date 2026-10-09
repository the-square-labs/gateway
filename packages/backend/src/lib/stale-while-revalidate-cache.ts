/**
 * An in-memory cache that answers from the last value while it reloads it in the background. A value younger
 * than `freshMs` is returned as is; an older one, up to `staleMs`, is returned at once and reloaded once (one
 * shared in-flight load per key); anything older, or a missing value, is loaded before answering. A failed load
 * is not cached, and a failed background reload keeps the last value. The size bound evicts the oldest entries.
 */
export class StaleWhileRevalidateCache<V> {
  private readonly entries = new Map<string, { value: V; loadedAt: number }>();
  private readonly loading = new Map<string, Promise<V>>();

  constructor(
    private readonly freshMs: number,
    private readonly staleMs: number,
    private readonly maxEntries = 1000,
    private readonly now: () => number = Date.now
  ) {}

  /** The cached value, or a loaded one; `refreshing` says a background reload of a stale value is running. */
  async get(key: string, load: () => Promise<V>): Promise<{ value: V; refreshing: boolean }> {
    const entry = this.entries.get(key);
    const age = entry ? this.now() - entry.loadedAt : Number.POSITIVE_INFINITY;
    if (entry && age < this.freshMs) return { value: entry.value, refreshing: false };
    if (entry && age < this.staleMs) {
      void this.reload(key, load).catch(() => undefined);
      return { value: entry.value, refreshing: true };
    }
    return { value: await this.reload(key, load), refreshing: false };
  }

  /** The value once a running reload settles; without one, the same answer as `get`. */
  async settled(key: string, load: () => Promise<V>): Promise<V> {
    const pending = this.loading.get(key);
    if (pending) {
      try {
        return await pending;
      } catch (error) {
        const entry = this.entries.get(key);
        if (entry) return entry.value;
        throw error;
      }
    }
    return (await this.get(key, load)).value;
  }

  /** Forget every entry (and running load) whose key starts with `prefix`; a forgotten load is not stored. */
  deletePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.entries.delete(key);
    for (const key of [...this.loading.keys()]) if (key.startsWith(prefix)) this.loading.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.loading.clear();
  }

  private reload(key: string, load: () => Promise<V>): Promise<V> {
    const pending = this.loading.get(key);
    if (pending) return pending;
    const request: Promise<V> = load()
      .then((value) => {
        if (this.loading.get(key) === request) this.store(key, value);
        return value;
      })
      .finally(() => {
        if (this.loading.get(key) === request) this.loading.delete(key);
      });
    this.loading.set(key, request);
    return request;
  }

  private store(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, loadedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
