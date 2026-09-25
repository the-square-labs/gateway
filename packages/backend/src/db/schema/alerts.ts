import { boolean, index, pgEnum, pgTable, primaryKey, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const alertTypeEnum = pgEnum('alert_type', ['expiry_warning', 'expiry_critical', 'ca_expiry', 'revocation']);

export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: alertTypeEnum('type').notNull(),
    resourceType: varchar('resource_type', { length: 50 }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    message: text('message').notNull(),
    dismissed: boolean('dismissed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    resourceIdx: index('alert_resource_idx').on(table.resourceType, table.resourceId),
    dismissedIdx: index('alert_dismissed_idx').on(table.dismissed),
    typeIdx: index('alert_type_idx').on(table.type),
  })
);

/**
 * Durable record that an expiry (or token maintenance) alert was raised for a
 * resource at a given threshold during one validity period. It survives the
 * housekeeping purge of dismissed alerts, so an alert is raised once per
 * threshold and lifetime; a renewal (new expires_at) starts a new period.
 */
export const expiryAlertMarkers = pgTable(
  'expiry_alert_markers',
  {
    resourceType: varchar('resource_type', { length: 50 }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    /** Threshold such as `expiry:30`, or a maintenance reason such as `git:shared-token`. */
    reason: varchar('reason', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    alertedAt: timestamp('alerted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'expiry_alert_markers_pkey',
      columns: [table.resourceType, table.resourceId, table.reason, table.expiresAt],
    }),
    expiresIdx: index('expiry_alert_markers_expires_idx').on(table.expiresAt),
  })
);
