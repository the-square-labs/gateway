import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import type { AIResourceReference } from '@/modules/ai/ai.types.js';
import { aiConversationMessages, aiConversations } from './ai-conversations.js';
import { integrationConnectors } from './integration-connectors.js';
import { users } from './users.js';

export type AIRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_answer'
  | 'waiting_for_credential'
  | 'completed'
  | 'failed'
  | 'stopped';

export type AIToolApprovalClass =
  | 'system-never-ask'
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'destructive'
  | 'execute';

export type AIToolApprovalPolicy = 'system_skipped' | 'auto_approved' | 'requires_approval' | 'blocked';

export type AIToolCallStatus =
  | 'created'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'running'
  | 'completed'
  | 'failed'
  | 'effect_unknown'
  | 'stopped';

export type AIToolRoundStatus =
  | 'collecting'
  | 'waiting_questions'
  | 'waiting_approvals'
  | 'ready'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'stopped';

export type AIQuestionStatus = 'pending' | 'answered' | 'stopped';
export type AICredentialChallengeStatus = 'pending' | 'authorized' | 'rejected' | 'stopped';

export const aiRuns = pgTable(
  'ai_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 32 }).$type<AIRunStatus>().notNull().default('queued'),
    activeMessageId: uuid('active_message_id'),
    model: varchar('model', { length: 255 }),
    reasoningEffort: varchar('reasoning_effort', { length: 64 }),
    clientCommandId: varchar('client_command_id', { length: 128 }).notNull(),
    assistantDraftContent: text('assistant_draft_content'),
    executionEpoch: integer('execution_epoch').notNull().default(0),
    leaseOwner: varchar('lease_owner', { length: 255 }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    oneActivePerConversationIdx: uniqueIndex('ai_runs_one_active_per_conversation_idx')
      .on(table.conversationId)
      .where(
        sql`${table.status} IN ('queued', 'running', 'waiting_for_approval', 'waiting_for_answer', 'waiting_for_credential')`
      ),
    userConversationCommandIdx: uniqueIndex('ai_runs_user_conversation_command_idx').on(
      table.userId,
      table.conversationId,
      table.clientCommandId
    ),
    userCommandIdx: uniqueIndex('ai_runs_user_command_idx').on(table.userId, table.clientCommandId),
    conversationStatusIdx: index('ai_runs_conversation_status_idx').on(table.conversationId, table.status),
    userCreatedIdx: index('ai_runs_user_created_idx').on(table.userId, table.createdAt),
  })
);

export const aiRunToolRounds = pgTable(
  'ai_run_tool_rounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => aiRuns.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    status: varchar('status', { length: 32 }).$type<AIToolRoundStatus>().notNull().default('collecting'),
    providerMessages: jsonb('provider_messages').$type<Record<string, unknown>[]>().notNull().default([]),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runSequenceIdx: uniqueIndex('ai_run_tool_rounds_run_sequence_idx').on(table.runId, table.sequence),
    conversationStatusIdx: index('ai_run_tool_rounds_conversation_status_idx').on(table.conversationId, table.status),
  })
);

export const aiRunToolCalls = pgTable(
  'ai_run_tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => aiRuns.id, { onDelete: 'cascade' }),
    roundId: uuid('round_id').references(() => aiRunToolRounds.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    assistantMessageId: uuid('assistant_message_id').references(() => aiConversationMessages.id, {
      onDelete: 'set null',
    }),
    toolCallId: varchar('tool_call_id', { length: 255 }).notNull(),
    toolName: varchar('tool_name', { length: 255 }).notNull(),
    toolArgs: jsonb('tool_args').$type<Record<string, unknown>>().notNull().default({}),
    classification: varchar('classification', { length: 32 }).$type<AIToolApprovalClass>().notNull(),
    approvalPolicy: varchar('approval_policy', { length: 32 }).$type<AIToolApprovalPolicy>().notNull(),
    requiredScopes: jsonb('required_scopes').$type<string[]>().notNull().default([]),
    status: varchar('status', { length: 32 }).$type<AIToolCallStatus>().notNull().default('created'),
    decision: varchar('decision', { length: 16 }).$type<'approved' | 'rejected' | null>(),
    decisionUserId: uuid('decision_user_id').references(() => users.id, { onDelete: 'set null' }),
    decisionClientCommandId: varchar('decision_client_command_id', { length: 128 }),
    decisionAt: timestamp('decision_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    result: jsonb('result').$type<unknown>(),
    resourceReferences: jsonb('resource_references').$type<AIResourceReference[]>().notNull().default([]),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runToolCallIdx: uniqueIndex('ai_run_tool_calls_run_tool_call_idx').on(table.runId, table.toolCallId),
    decisionCommandIdx: uniqueIndex('ai_run_tool_calls_decision_command_idx')
      .on(table.runId, table.decisionClientCommandId)
      .where(sql`${table.decisionClientCommandId} IS NOT NULL`),
    runStatusIdx: index('ai_run_tool_calls_run_status_idx').on(table.runId, table.status),
    conversationStatusIdx: index('ai_run_tool_calls_conversation_status_idx').on(table.conversationId, table.status),
  })
);

export const aiRunQuestions = pgTable(
  'ai_run_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => aiRuns.id, { onDelete: 'cascade' }),
    roundId: uuid('round_id').references(() => aiRunToolRounds.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    toolCallId: varchar('tool_call_id', { length: 255 }).notNull(),
    question: text('question').notNull(),
    status: varchar('status', { length: 32 }).$type<AIQuestionStatus>().notNull().default('pending'),
    answer: text('answer'),
    answerUserId: uuid('answer_user_id').references(() => users.id, { onDelete: 'set null' }),
    answerClientCommandId: varchar('answer_client_command_id', { length: 128 }),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runToolCallIdx: uniqueIndex('ai_run_questions_run_tool_call_idx').on(table.runId, table.toolCallId),
    answerCommandIdx: uniqueIndex('ai_run_questions_answer_command_idx')
      .on(table.runId, table.answerClientCommandId)
      .where(sql`${table.answerClientCommandId} IS NOT NULL`),
    runStatusIdx: index('ai_run_questions_run_status_idx').on(table.runId, table.status),
    conversationStatusIdx: index('ai_run_questions_conversation_status_idx').on(table.conversationId, table.status),
  })
);

export const aiRunCredentialChallenges = pgTable(
  'ai_run_credential_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => aiRuns.id, { onDelete: 'cascade' }),
    roundId: uuid('round_id').references(() => aiRunToolRounds.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).$type<'gitlab'>().notNull(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => integrationConnectors.id, { onDelete: 'cascade' }),
    toolCallId: varchar('tool_call_id', { length: 255 }).notNull(),
    toolName: varchar('tool_name', { length: 255 }).notNull(),
    status: varchar('status', { length: 32 }).$type<AICredentialChallengeStatus>().notNull().default('pending'),
    decisionClientCommandId: varchar('decision_client_command_id', { length: 128 }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runToolCallIdx: uniqueIndex('ai_run_credential_challenges_run_tool_call_idx').on(table.runId, table.toolCallId),
    userConnectorStatusIdx: index('ai_run_credential_challenges_user_connector_status_idx').on(
      table.userId,
      table.connectorId,
      table.status
    ),
    conversationStatusIdx: index('ai_run_credential_challenges_conversation_status_idx').on(
      table.conversationId,
      table.status
    ),
  })
);

export type AIRun = typeof aiRuns.$inferSelect;
export type NewAIRun = typeof aiRuns.$inferInsert;
export type AIRunToolRound = typeof aiRunToolRounds.$inferSelect;
export type NewAIRunToolRound = typeof aiRunToolRounds.$inferInsert;
export type AIRunToolCall = typeof aiRunToolCalls.$inferSelect;
export type NewAIRunToolCall = typeof aiRunToolCalls.$inferInsert;
export type AIRunQuestion = typeof aiRunQuestions.$inferSelect;
export type NewAIRunQuestion = typeof aiRunQuestions.$inferInsert;
export type AICredentialChallenge = typeof aiRunCredentialChallenges.$inferSelect;
export type NewAICredentialChallenge = typeof aiRunCredentialChallenges.$inferInsert;
