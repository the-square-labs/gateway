import { describe, expect, it, vi } from 'vitest';
import { BackgroundWriteTracker, closeDataStoresAfterWrites } from './background-writes.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('BackgroundWriteTracker', () => {
  it('waits for writes, including ones started while it drains', async () => {
    const writes = new BackgroundWriteTracker();
    const first = deferred();
    const second = deferred();
    writes.track(first.promise);
    let drained = false;
    const drain = writes.drain({ deadline: Date.now() + 5_000, sourcesDeadline: 0 }).then((settled) => {
      drained = settled;
    });

    // The first write's completion starts another one (deregister, then the audit row).
    first.resolve();
    writes.track(second.promise);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(drained).toBe(false);

    second.resolve();
    await drain;
    expect(drained).toBe(true);
    expect(writes.pendingWrites).toBe(0);
  });

  it('gives open sources until their deadline to close and start their writes', async () => {
    const writes = new BackgroundWriteTracker();
    const release = writes.openSource();
    const audit = deferred();
    setTimeout(() => {
      // A node stream delivers its close event after the gRPC server stopped.
      writes.track(audit.promise);
      release();
      setTimeout(audit.resolve, 30);
    }, 30);

    await expect(writes.drain({ deadline: Date.now() + 5_000, sourcesDeadline: Date.now() + 2_000 })).resolves.toBe(
      true
    );
    expect(writes.pendingWrites).toBe(0);
    expect(writes.openSources).toBe(0);
  });

  it('stops waiting for a source that never closes at its deadline', async () => {
    const writes = new BackgroundWriteTracker();
    writes.openSource();
    const startedAt = Date.now();
    await expect(writes.drain({ deadline: Date.now() + 5_000, sourcesDeadline: Date.now() + 60 })).resolves.toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('reports writes still running at the deadline', async () => {
    const writes = new BackgroundWriteTracker();
    writes.track(new Promise(() => undefined));
    await expect(writes.drain({ deadline: Date.now() + 50, sourcesDeadline: 0 })).resolves.toBe(false);
  });

  it('keeps a failed write from blocking the drain and passes its result through', async () => {
    const writes = new BackgroundWriteTracker();
    await expect(writes.track(Promise.reject(new Error('insert failed')))).rejects.toThrow('insert failed');
    await expect(writes.track(Promise.resolve(7))).resolves.toBe(7);
    await expect(writes.drain({ deadline: Date.now() + 1_000, sourcesDeadline: 0 })).resolves.toBe(true);
  });
});

describe('closeDataStoresAfterWrites', () => {
  it('closes Redis and the pool only after the writes a stream close produced (N-6)', async () => {
    const writes = new BackgroundWriteTracker();
    const order: string[] = [];
    // An open node stream: its close handler deregisters the node and writes node.disconnected.
    const release = writes.openSource();
    setTimeout(() => {
      writes.track(
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          order.push('audit node.disconnected');
        })()
      );
      release();
    }, 20);

    await closeDataStoresAfterWrites({
      writes,
      deadline: Date.now() + 10_000,
      closeRedis: async () => void order.push('redis quit'),
      closeDatabase: async () => void order.push('pool end'),
    });

    expect(order).toEqual(['audit node.disconnected', 'redis quit', 'pool end']);
  });

  it('closes the stores at the deadline and reports writes that did not finish', async () => {
    const writes = new BackgroundWriteTracker();
    writes.track(new Promise(() => undefined));
    const onUnsettled = vi.fn();
    const closeDatabase = vi.fn(async () => undefined);
    await closeDataStoresAfterWrites({
      writes,
      deadline: Date.now() + 1_100,
      onUnsettled,
      closeRedis: async () => undefined,
      closeDatabase,
    });
    expect(onUnsettled).toHaveBeenCalledWith(1);
    expect(closeDatabase).toHaveBeenCalled();
  });
});
