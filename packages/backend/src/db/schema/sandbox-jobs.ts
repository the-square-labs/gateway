import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { aiConversations } from './ai-conversations.js';
import { users } from './users.js';

export const sandboxJobs = pgTable(
  'sandbox_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => aiConversations.id, { onDelete: 'set null' }),
    kind: varchar('kind', { length: 32 }).notNull(),
    runtime: varchar('runtime', { length: 32 }).notNull(),
    resourceTier: varchar('resource_tier', { length: 32 }).notNull(),
    requestedTtlSeconds: integer('requested_ttl_seconds').notNull(),
    effectiveTtlSeconds: integer('effective_ttl_seconds').notNull(),
    requiredScopes: jsonb('required_scopes').$type<string[]>().notNull().default([]),
    status: varchar('status', { length: 32 }).notNull().default('queued'),
    containerId: varchar('container_id', { length: 128 }),
    exitCode: integer('exit_code'),
    outputBytes: integer('output_bytes').notNull().default(0),
    workspaceReservationBytes: bigint('workspace_reservation_bytes', { mode: 'number' }).notNull().default(0),
    workspaceUsageBytes: bigint('workspace_usage_bytes', { mode: 'number' }).notNull().default(0),
    workspaceReservationReleasedAt: timestamp('workspace_reservation_released_at', { withTimezone: true }),
    stdoutCursor: varchar('stdout_cursor', { length: 128 }),
    stderrCursor: varchar('stderr_cursor', { length: 128 }),
    revocationReason: text('revocation_reason'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userStatusIdx: index('sandbox_jobs_user_status_idx').on(table.userId, table.status),
    conversationIdx: index('sandbox_jobs_conversation_idx').on(table.conversationId),
    statusExpiresIdx: index('sandbox_jobs_status_expires_idx').on(table.status, table.expiresAt),
    containerIdx: index('sandbox_jobs_container_idx').on(table.containerId),
  })
);

export type SandboxJob = typeof sandboxJobs.$inferSelect;
export type NewSandboxJob = typeof sandboxJobs.$inferInsert;
