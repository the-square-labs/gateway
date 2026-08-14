import { sql } from 'drizzle-orm';
import {
  bigint,
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
import { aiConversations } from './ai-conversations.js';
import { users } from './users.js';

export type AIPlanStatus =
  | 'drafting'
  | 'validating'
  | 'awaiting_decision'
  | 'executing'
  | 'pause_requested'
  | 'paused'
  | 'verifying'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type AIPlanRevisionStatus = 'draft' | 'validating' | 'published' | 'accepted' | 'superseded' | 'rejected';

export type AIPlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'skipped';

export interface AIPlanResearchFinding {
  title: string;
  summary: string;
  resourceReferenceIds?: string[];
}

export interface AIPlanReview {
  verdict: 'pass' | 'revise';
  summary: string;
  findings: string[];
}

export interface AIPlanVerificationCriterion {
  title: string;
  description: string;
}

export interface AIPlanChangeSummary {
  added: string[];
  changed: string[];
  removed: string[];
}

export interface AIPlanStepEvidence {
  summary: string;
  resourceReferenceIds?: string[];
}

export const aiPlans = pgTable(
  'ai_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 32 }).$type<AIPlanStatus>().notNull().default('drafting'),
    title: varchar('title', { length: 255 }),
    model: varchar('model', { length: 255 }),
    reasoningEffort: varchar('reasoning_effort', { length: 64 }),
    noProgressRuns: integer('no_progress_runs').notNull().default(0),
    progressVersion: integer('progress_version').notNull().default(0),
    activeTimeMs: bigint('active_time_ms', { mode: 'number' }).notNull().default(0),
    activeSince: timestamp('active_since', { withTimezone: true }),
    pauseReason: text('pause_reason'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    oneActivePerConversationIdx: uniqueIndex('ai_plans_one_active_per_conversation_idx')
      .on(table.conversationId)
      .where(
        sql`${table.status} IN ('drafting', 'validating', 'awaiting_decision', 'executing', 'pause_requested', 'paused', 'verifying')`
      ),
    userStatusIdx: index('ai_plans_user_status_idx').on(table.userId, table.status),
    conversationCreatedIdx: index('ai_plans_conversation_created_idx').on(table.conversationId, table.createdAt),
  })
);

export const aiPlanRevisions = pgTable(
  'ai_plan_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => aiPlans.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    status: varchar('status', { length: 32 }).$type<AIPlanRevisionStatus>().notNull().default('draft'),
    goal: text('goal').notNull(),
    scope: jsonb('scope').$type<string[]>().notNull().default([]),
    assumptions: jsonb('assumptions').$type<string[]>().notNull().default([]),
    research: jsonb('research').$type<AIPlanResearchFinding[]>().notNull().default([]),
    intentReview: jsonb('intent_review').$type<AIPlanReview | null>(),
    securityReview: jsonb('security_review').$type<AIPlanReview | null>(),
    verification: jsonb('verification').$type<AIPlanVerificationCriterion[]>().notNull().default([]),
    changeSummary: jsonb('change_summary').$type<AIPlanChangeSummary | null>(),
    validationAttempts: integer('validation_attempts').notNull().default(0),
    validatorFindings: jsonb('validator_findings').$type<string[]>().notNull().default([]),
    decision: varchar('decision', { length: 32 }).$type<'implement' | 'refine' | 'custom' | null>(),
    customInstruction: text('custom_instruction'),
    decisionClientCommandId: varchar('decision_client_command_id', { length: 128 }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    decisionAt: timestamp('decision_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    planRevisionIdx: uniqueIndex('ai_plan_revisions_plan_revision_idx').on(table.planId, table.revision),
    decisionCommandIdx: uniqueIndex('ai_plan_revisions_decision_command_idx')
      .on(table.decisionClientCommandId)
      .where(sql`${table.decisionClientCommandId} IS NOT NULL`),
    planStatusIdx: index('ai_plan_revisions_plan_status_idx').on(table.planId, table.status),
  })
);

export const aiPlanSteps = pgTable(
  'ai_plan_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => aiPlanRevisions.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description').notNull(),
    verification: text('verification').notNull(),
    status: varchar('status', { length: 32 }).$type<AIPlanStepStatus>().notNull().default('pending'),
    evidence: jsonb('evidence').$type<AIPlanStepEvidence[]>().notNull().default([]),
    skipReason: text('skip_reason'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    revisionOrdinalIdx: uniqueIndex('ai_plan_steps_revision_ordinal_idx').on(table.revisionId, table.ordinal),
    oneInProgressPerRevisionIdx: uniqueIndex('ai_plan_steps_one_in_progress_per_revision_idx')
      .on(table.revisionId)
      .where(sql`${table.status} = 'in_progress'`),
    revisionStatusIdx: index('ai_plan_steps_revision_status_idx').on(table.revisionId, table.status),
  })
);

export type AIPlan = typeof aiPlans.$inferSelect;
export type NewAIPlan = typeof aiPlans.$inferInsert;
export type AIPlanRevision = typeof aiPlanRevisions.$inferSelect;
export type NewAIPlanRevision = typeof aiPlanRevisions.$inferInsert;
export type AIPlanStep = typeof aiPlanSteps.$inferSelect;
export type NewAIPlanStep = typeof aiPlanSteps.$inferInsert;
