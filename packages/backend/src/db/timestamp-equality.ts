import { type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * Equality of a `timestamptz` column with a Date read back from it, for compare-and-set guards. A Date carries
 * milliseconds and node-postgres truncates the column to them on read, while now() and defaultNow() store
 * microseconds: a plain equality never matches such a row. Compares at millisecond precision.
 */
export function sameTimestamp(column: PgColumn, value: Date): SQL {
  return sql`date_trunc('milliseconds', ${column}) = ${value.toISOString()}::timestamptz`;
}
