import { sql } from 'drizzle-orm';
import { bigserial, index, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { notificationWebhooks } from './notification-webhooks.js';

export const notificationDeliveryLog = pgTable(
  'notification_delivery_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Queue order: each webhook's deliveries go out in this order, one at a time. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => notificationWebhooks.id, { onDelete: 'cascade' }),

    eventType: varchar('event_type', { length: 100 }).notNull(),
    severity: varchar('severity', { length: 20 }).notNull(),
    /** The alert state this notification is about (its firing or its resolve); null for tests and older rows. */
    alertStateId: uuid('alert_state_id'),

    // Request
    requestUrl: text('request_url').notNull(),
    requestMethod: varchar('request_method', { length: 10 }).notNull(),
    requestBody: text('request_body'),

    // Response
    responseStatus: integer('response_status'),
    responseBody: text('response_body'), // truncated to 2KB
    responseTimeMs: integer('response_time_ms'),

    // Retry
    attempt: integer('attempt').notNull().default(1),
    maxAttempts: integer('max_attempts').notNull().default(5),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),

    // 'pending' | 'retrying' | 'success' | 'failed' | 'superseded' (not sent: the alert resolved before it could go out)
    status: varchar('status', { length: 20 }).notNull().default('retrying'),
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    webhookIdx: index('notif_delivery_log_webhook_idx').on(table.webhookId),
    statusIdx: index('notif_delivery_log_status_idx').on(table.status),
    retryIdx: index('notif_delivery_log_retry_idx').on(table.nextRetryAt),
    createdIdx: index('notif_delivery_log_created_idx').on(table.createdAt),
    queueIdx: index('notif_delivery_log_queue_idx')
      .on(table.webhookId, table.seq)
      .where(sql`status in ('pending', 'retrying')`),
    alertStateIdx: index('notif_delivery_log_alert_state_idx').on(table.alertStateId),
  })
);
