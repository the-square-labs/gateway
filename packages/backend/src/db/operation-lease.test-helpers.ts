import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DrizzleClient } from '@/db/client.js';
import { createFakeAdvisoryLockDb } from './advisory-lock.test-helpers.js';

const dialect = new PgDialect();

/** An `operation_leases` row as the fake stores it. */
export interface FakeOperationLeaseRow {
  token: string;
  holder: string;
  data: unknown;
  expiresAt: Date;
}

/** Stored like the database would: jsonb data and timestamps are copies, never shared with the caller. */
function stored(row: FakeOperationLeaseRow): FakeOperationLeaseRow {
  return {
    token: row.token,
    holder: row.holder,
    data: JSON.parse(JSON.stringify(row.data ?? null)) as unknown,
    expiresAt: new Date(row.expiresAt),
  };
}

/**
 * In-memory `operation_leases` table behind `OperationLeaseStore`, with
 * advisory locks that behave like Postgres' (see createFakeAdvisoryLockDb).
 * Stores or services built on one fake act as separate backend processes
 * sharing one database. Only the statements the lease store issues are
 * supported: rows are matched by the keys (and token) among a condition's
 * parameters.
 */
export function createFakeOperationLeaseDb() {
  const rows = new Map<string, FakeOperationLeaseRow>();
  const paramsOf = (condition: unknown) => dialect.sqlToQuery(condition as SQL).params.map(String);
  const statements = {
    select: () => ({
      from: () => ({
        where: async (condition: unknown) =>
          paramsOf(condition).flatMap((key) => {
            const row = rows.get(key);
            return row ? [{ key, ...stored(row) }] : [];
          }),
      }),
    }),
    insert: () => ({
      values: (row: FakeOperationLeaseRow & { key: string }) => ({
        onConflictDoUpdate: async ({ set }: { set: FakeOperationLeaseRow }) => {
          rows.set(row.key, stored(rows.has(row.key) ? set : row));
        },
      }),
    }),
    delete: () => ({
      where: async (condition: unknown) => {
        const params = paramsOf(condition);
        for (const key of params) {
          const row = rows.get(key);
          if (row && params.includes(row.token)) rows.delete(key);
        }
      },
    }),
  };
  const locking = createFakeAdvisoryLockDb(() => statements);
  const db = { ...statements, transaction: locking.transaction } as unknown as DrizzleClient;
  return { db, rows, acquired: locking.acquired };
}
