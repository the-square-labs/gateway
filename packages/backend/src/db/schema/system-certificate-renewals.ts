import { boolean, index, integer, pgTable, primaryKey, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { systemCertificateOwnerTypeEnum } from './certificates.js';

/**
 * Renewal progress of one system certificate owner (a managed storage cluster
 * or managed database). The certificate rows themselves stay the source of
 * truth for what is current or staged; this row only remembers the attempt
 * that is in flight, why it started, and why it last failed, so retries back
 * off and the UI can show what is happening.
 */
export const systemCertificateRenewals = pgTable(
  'system_certificate_renewals',
  {
    ownerType: systemCertificateOwnerTypeEnum('owner_type').notNull(),
    ownerId: varchar('owner_id', { length: 255 }).notNull(),
    /** idle | delivering | awaiting_reload | waiting_for_daemon | failed */
    state: varchar('state', { length: 32 }).notNull().default('idle'),
    reason: varchar('reason', { length: 64 }),
    pendingCertificateId: uuid('pending_certificate_id'),
    pendingSerial: varchar('pending_serial', { length: 255 }),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastError: text('last_error'),
    servedFingerprint: varchar('served_fingerprint', { length: 128 }),
    lastMethod: varchar('last_method', { length: 32 }),
    lastRestarted: boolean('last_restarted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerType, table.ownerId], name: 'system_certificate_renewals_pkey' }),
    index('system_certificate_renewals_next_attempt_idx').on(table.nextAttemptAt),
  ]
);

export type SystemCertificateRenewalRow = typeof systemCertificateRenewals.$inferSelect;
