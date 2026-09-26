/**
 * A small in-memory cache with a per-entry time to live, a size bound (oldest entries are evicted first)
 * and shared in-flight loads, so concurrent requests for the same key call the loader once. A failed load
 * is not cached.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly loading = new Map<string, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1000,
    private readonly now: () => number = Date.now
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const pending = this.loading.get(key);
    if (pending) return pending;
    const request = load()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, request);
    return request;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Forget every entry (and pending load) whose key starts with `prefix`. */
  deletePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.entries.delete(key);
    for (const key of [...this.loading.keys()]) if (key.startsWith(prefix)) this.loading.delete(key);
  }

  /**
   * Load a value, bypassing the cache when `fresh` is set (the result still refreshes it). With a lookup
   * budget, a load that misses the cache consumes one unit and fails once the budget is spent.
   */
  async load(key: string, loader: () => Promise<V>, options: { fresh?: boolean; budget?: LookupBudget } = {}) {
    if (!options.fresh) {
      const cached = this.get(key);
      if (cached !== undefined) return cached;
    }
    options.budget?.consume();
    if (options.fresh) {
      const value = await loader();
      this.set(key, value);
      return value;
    }
    return this.getOrLoad(key, loader);
  }

  clear(): void {
    this.entries.clear();
    this.loading.clear();
  }
}

/** Thrown when a request spends its provider lookup budget. */
export class LookupBudgetExceededError extends Error {
  constructor() {
    super('Provider lookup budget exceeded');
    this.name = 'LookupBudgetExceededError';
  }
}

/** A per-request cap on uncached provider lookups (for example scope picker labels and group parents). */
export class LookupBudget {
  constructor(private remaining: number) {}

  consume(): void {
    if (this.remaining <= 0) throw new LookupBudgetExceededError();
    this.remaining -= 1;
  }
}
