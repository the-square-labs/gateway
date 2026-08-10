import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { aiConversationFolders } from './ai-conversation-folders.js';
import { users } from './users.js';

export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 255 }).notNull(),
    model: varchar('model', { length: 255 }),
    reasoningEffort: varchar('reasoning_effort', { length: 64 }),
    lastContext: jsonb('last_context').$type<Record<string, unknown> | null>(),
    discoveredToolsets: jsonb('discovered_toolsets').$type<string[]>().notNull().default([]),
    checkpoint: jsonb('checkpoint').$type<Record<string, unknown> | null>(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
    folderId: uuid('folder_id').references(() => aiConversationFolders.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userTitleIdx: uniqueIndex('ai_conversations_user_title_idx').on(table.userId, table.title),
    userUpdatedIdx: index('ai_conversations_user_updated_idx').on(table.userId, table.updatedAt),
    userFolderIdx: index('ai_conversations_user_folder_idx').on(table.userId, table.folderId),
  })
);

export const aiConversationMessages = pgTable(
  'ai_conversation_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    role: varchar('role', { length: 32 }).notNull(),
    content: text('content').notNull().default(''),
    uiMessage: jsonb('ui_message').$type<Record<string, unknown>>().notNull(),
    toolCalls: jsonb('tool_calls').$type<unknown[] | null>(),
    toolCallId: varchar('tool_call_id', { length: 255 }),
    toolName: varchar('tool_name', { length: 255 }),
    toolArgsCompact: jsonb('tool_args_compact').$type<Record<string, unknown> | null>(),
    toolResultRaw: jsonb('tool_result_raw').$type<unknown>(),
    toolResultCompact: jsonb('tool_result_compact').$type<unknown>(),
    toolResultSizeBytes: integer('tool_result_size_bytes').notNull().default(0),
    isSensitive: boolean('is_sensitive').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationSequenceIdx: uniqueIndex('ai_conversation_messages_conversation_sequence_idx').on(
      table.conversationId,
      table.sequence
    ),
    conversationCreatedIdx: index('ai_conversation_messages_conversation_created_idx').on(
      table.conversationId,
      table.createdAt
    ),
  })
);

export type AIConversation = typeof aiConversations.$inferSelect;
export type NewAIConversation = typeof aiConversations.$inferInsert;
export type AIConversationMessage = typeof aiConversationMessages.$inferSelect;
export type NewAIConversationMessage = typeof aiConversationMessages.$inferInsert;
