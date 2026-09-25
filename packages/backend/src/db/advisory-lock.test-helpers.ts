import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();

/** The key of a `pg_advisory_xact_lock(...)` statement (its parameters joined), or null for any other SQL. */
export function advisoryLockKey(query: unknown): string | null {
  try {
    const rendered = dialect.sqlToQuery(query as SQL);
    if (!/pg_advisory_xact_lock/i.test(rendered.sql)) return null;
    return rendered.params.map(String).join(':');
  } catch {
    return null;
  }
}

export interface FakeAdvisoryLockDb<Tx> {
  /** Stand-in for `db.transaction`: runs `fn` with a transaction whose advisory locks behave like Postgres'. */
  transaction<T>(fn: (tx: Tx & { execute(query: unknown): Promise<unknown> }) => Promise<T>): Promise<T>;
  /** Lock keys in the order transactions acquired them. */
  acquired: string[];
}

/**
 * Emulates transaction-scoped advisory locks for unit tests. A transaction that
 * runs `select pg_advisory_xact_lock(...)` waits until every earlier holder of
 * the same key has finished its transaction callback; the lock is released when
 * the callback settles (commit or rollback). Re-acquiring a key inside the same
 * transaction does not wait, as in Postgres. Other `execute` calls go to the
 * `execute` of the object `makeTx` returns, if any. `onRequest` runs when a
 * transaction asks for a lock, before it waits for it.
 */
export function createFakeAdvisoryLockDb<Tx extends object>(
  makeTx: () => Tx,
  options: { onRequest?: (key: string) => void } = {}
): FakeAdvisoryLockDb<Tx> {
  const tails = new Map<string, Promise<void>>();
  const acquired: string[] = [];

  async function transaction<T>(fn: (tx: Tx & { execute(query: unknown): Promise<unknown> }) => Promise<T>) {
    const held = new Set<string>();
    const releases: Array<() => void> = [];
    const base = makeTx() as Tx & { execute?: (query: unknown) => Promise<unknown> };
    const tx = Object.assign(Object.create(base) as Tx, {
      async execute(query: unknown) {
        const key = advisoryLockKey(query);
        if (key === null) return base.execute ? base.execute(query) : { rows: [] };
        if (held.has(key)) return { rows: [] };
        held.add(key);
        options.onRequest?.(key);
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
        acquired.push(key);
        return { rows: [] };
      },
    });
    try {
      return await fn(tx);
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  return { transaction, acquired };
}
