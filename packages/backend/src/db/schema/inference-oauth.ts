import { index, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export type InferenceOAuthFlow = 'redirect' | 'device';
export type InferenceOAuthSessionStatus = 'pending' | 'complete' | 'error' | 'expired' | 'cancelled';

export const inferenceOAuthSessions = pgTable(
  'inference_oauth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: varchar('provider_id', { length: 80 }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectionName: varchar('connection_name', { length: 255 }).notNull(),
    flow: varchar('flow', { length: 16 }).$type<InferenceOAuthFlow>().notNull(),
    status: varchar('status', { length: 16 }).$type<InferenceOAuthSessionStatus>().notNull().default('pending'),
    stateHash: text('state_hash').notNull(),
    encryptedPayload: text('encrypted_payload').notNull(),
    encryptedDek: text('encrypted_dek').notNull(),
    authorizationUrl: text('authorization_url').notNull(),
    completionMode: varchar('completion_mode', { length: 32 }).notNull(),
    userCode: varchar('user_code', { length: 128 }),
    pollIntervalSeconds: integer('poll_interval_seconds'),
    errorCode: varchar('error_code', { length: 128 }),
    errorMessage: text('error_message'),
    connectionId: uuid('connection_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('inference_oauth_user_status_idx').on(table.userId, table.status, table.expiresAt),
    index('inference_oauth_state_idx').on(table.stateHash),
  ]
);

export type InferenceOAuthSession = typeof inferenceOAuthSessions.$inferSelect;
