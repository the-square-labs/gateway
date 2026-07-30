import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const inferenceTokens = pgTable(
  'inference_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    managedBy: varchar('managed_by', { length: 64 }),
    harness: varchar('harness', { length: 64 }),
    deviceName: varchar('device_name', { length: 255 }),
    installationId: uuid('installation_id'),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: varchar('token_prefix', { length: 20 }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inference_tokens_token_hash_unique').on(table.tokenHash),
    index('inference_tokens_user_idx').on(table.userId, table.createdAt),
    index('inference_tokens_active_idx').on(table.userId, table.revokedAt),
    uniqueIndex('inference_tokens_managed_identity_active_unique')
      .on(table.userId, table.managedBy, table.harness, table.installationId)
      .where(sql`${table.revokedAt} is null and ${table.managedBy} is not null`),
  ]
);

export type InferenceToken = typeof inferenceTokens.$inferSelect;
export type NewInferenceToken = typeof inferenceTokens.$inferInsert;
