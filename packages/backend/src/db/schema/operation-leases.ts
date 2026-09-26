import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Leases that make an operation exclusive across backend processes (see
 * OperationLeaseStore): one row per leased resource key. A row whose
 * `expires_at` passed no longer holds anything; housekeeping removes old ones
 * with the operation history retention.
 */
export const operationLeases = pgTable(
  'operation_leases',
  {
    key: text('key').primaryKey(),
    token: uuid('token').notNull(),
    /** The backend process (and, for some callers, the component in it) holding the lease. */
    holder: text('holder').notNull(),
    data: jsonb('data').$type<unknown>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('operation_leases_expires_at_idx').on(table.expiresAt)]
);
