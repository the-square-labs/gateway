/**
 * Writes that event handlers start on their own, outside any request: node stream close handlers
 * (deregistration, relay instance state, the `node.disconnected` audit row), daemon reports on an
 * open stream, audit rows from anywhere. Shutdown waits for them before it closes Redis and the
 * Postgres pool, so a row an event produced in the last moment is written instead of failing with
 * "Cannot use a pool after calling end on the pool".
 *
 * Sources are the open streams whose close starts such work: after the gRPC server stopped, their
 * close events are still on their way, and drain gives them a short moment to arrive.
 */
export class BackgroundWriteTracker {
  private readonly tasks = new Set<Promise<void>>();
  private readonly sources = new Set<object>();

  /** Tracks a write already running; returns it unchanged. */
  track<T>(task: Promise<T>): Promise<T> {
    const settled: Promise<void> = task.then(
      () => undefined,
      () => undefined
    );
    this.tasks.add(settled);
    void settled.then(() => this.tasks.delete(settled));
    return task;
  }

  /** Marks an open source that starts tracked work when it closes; call the result once it closed. */
  openSource(): () => void {
    const token = {};
    this.sources.add(token);
    return () => {
      this.sources.delete(token);
    };
  }

  get pendingWrites(): number {
    return this.tasks.size;
  }

  get openSources(): number {
    return this.sources.size;
  }

  /**
   * Waits until no tracked write runs, including writes started while it waits, and until every
   * open source closed or `sourcesDeadline` passed. Returns false when writes still run at
   * `deadline`.
   */
  async drain(options: {
    deadline: number;
    sourcesDeadline: number;
    now?: () => number;
    pollMs?: number;
  }): Promise<boolean> {
    const now = options.now ?? Date.now;
    const pollMs = options.pollMs ?? 20;
    for (;;) {
      const awaitingSources = this.sources.size > 0 && now() < options.sourcesDeadline;
      if (this.tasks.size === 0 && !awaitingSources) return true;
      const remaining = options.deadline - now();
      if (remaining <= 0) return this.tasks.size === 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        ...(this.tasks.size > 0 ? [Promise.allSettled([...this.tasks])] : []),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(1, Math.min(pollMs, remaining)));
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
  }
}

export const backgroundWrites = new BackgroundWriteTracker();

/** Time kept back from the hard deadline for closing Redis and the pool once writes drained. */
const DATA_STORE_CLOSE_RESERVE_MS = 1_000;
/** How long open streams get to deliver their close events after the gRPC server stopped. */
const SOURCE_CLOSE_GRACE_MS = 1_000;

/**
 * The last step of shutdown, after the gRPC server and every module stopped: waits for the
 * background writes their closing produced, then closes Redis and the database pool.
 */
export async function closeDataStoresAfterWrites(options: {
  deadline: number;
  closeRedis: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  onUnsettled?: (pendingWrites: number) => void;
  writes?: BackgroundWriteTracker;
  now?: () => number;
}): Promise<void> {
  const writes = options.writes ?? backgroundWrites;
  const now = options.now ?? Date.now;
  const settled = await writes.drain({
    deadline: options.deadline - DATA_STORE_CLOSE_RESERVE_MS,
    sourcesDeadline: now() + SOURCE_CLOSE_GRACE_MS,
    now,
  });
  if (!settled) options.onUnsettled?.(writes.pendingWrites);
  await options.closeRedis();
  await options.closeDatabase();
}
