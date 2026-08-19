import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { inferenceDiscoveredModels, inferenceProviderConnections } from './inference-providers.js';
import { permissionGroups } from './permission-groups.js';
import { users } from './users.js';

export type InferenceModelSourceType = 'subscription' | 'api';
export type InferenceAccessSubjectType = 'group' | 'user';
export type InferenceAccessEffect = 'allow' | 'deny';
export type InferenceLimitPolicyType = 'default' | 'user';

export const inferenceModels = pgTable(
  'inference_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: varchar('public_id', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    enabled: boolean('enabled').notNull().default(false),
    contextWindow: integer('context_window').notNull(),
    maxInputTokens: integer('max_input_tokens').notNull(),
    maxOutputTokens: integer('max_output_tokens'),
    autoCompactTokenLimit: integer('auto_compact_token_limit').notNull(),
    modalities: jsonb('modalities').$type<string[]>().notNull().default(['text']),
    capabilities: jsonb('capabilities').$type<Record<string, boolean>>().notNull().default({}),
    reasoningEfforts: jsonb('reasoning_efforts').$type<string[]>().notNull().default([]),
    defaultReasoningEffort: varchar('default_reasoning_effort', { length: 32 }),
    defaultAccessAllowed: boolean('default_access_allowed').notNull().default(false),
    subscriptionMultiplier: numeric('subscription_multiplier', { precision: 20, scale: 6 }).notNull().default('1'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inference_models_public_id_unique').on(table.publicId),
    index('inference_models_enabled_idx').on(table.enabled),
    check('inference_models_context_positive', sql`${table.contextWindow} > 0`),
    check(
      'inference_models_token_limits_valid',
      sql`${table.maxInputTokens} > 0 AND (${table.maxOutputTokens} IS NULL OR ${table.maxOutputTokens} > 0) AND ${table.autoCompactTokenLimit} > 0 AND ${table.autoCompactTokenLimit} <= ${table.maxInputTokens}`
    ),
    check('inference_models_multiplier_positive', sql`${table.subscriptionMultiplier} > 0`),
  ]
);

export const inferenceModelSources = pgTable(
  'inference_model_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => inferenceModels.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => inferenceProviderConnections.id, { onDelete: 'restrict' }),
    discoveredModelId: uuid('discovered_model_id').references(() => inferenceDiscoveredModels.id, {
      onDelete: 'set null',
    }),
    upstreamModelId: text('upstream_model_id').notNull(),
    // Stable OpenCodex core references assigned when the source is published
    // through the managed core; legacy pre-cutover sources keep them null.
    coreAccountId: text('core_account_id'),
    coreModelId: text('core_model_id'),
    sourceType: varchar('source_type', { length: 16 }).$type<InferenceModelSourceType>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    priority: integer('priority').notNull().default(0),
    subscriptionMultiplierOverride: numeric('subscription_multiplier_override', { precision: 20, scale: 6 }),
    reasoningEffortMap: jsonb('reasoning_effort_map').$type<Record<string, string>>().notNull().default({}),
    capabilitiesOverride: jsonb('capabilities_override').$type<Record<string, boolean>>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inference_model_sources_model_connection_remote_unique').on(
      table.modelId,
      table.connectionId,
      table.upstreamModelId
    ),
    index('inference_model_sources_route_idx').on(table.modelId, table.enabled, table.priority),
    check(
      'inference_model_sources_multiplier_positive',
      sql`${table.subscriptionMultiplierOverride} IS NULL OR ${table.subscriptionMultiplierOverride} > 0`
    ),
  ]
);

export const inferencePricingSnapshots = pgTable(
  'inference_pricing_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => inferenceModelSources.id, { onDelete: 'cascade' }),
    version: varchar('version', { length: 80 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    inputMicrodollarsPerMillion: bigint('input_microdollars_per_million', { mode: 'number' }),
    cachedInputMicrodollarsPerMillion: bigint('cached_input_microdollars_per_million', { mode: 'number' }),
    cacheWriteMicrodollarsPerMillion: bigint('cache_write_microdollars_per_million', { mode: 'number' }),
    outputMicrodollarsPerMillion: bigint('output_microdollars_per_million', { mode: 'number' }),
    reasoningMicrodollarsPerMillion: bigint('reasoning_microdollars_per_million', { mode: 'number' }),
    otherUnitPrices: jsonb('other_unit_prices').$type<Record<string, number>>().notNull().default({}),
    source: varchar('source', { length: 16 }).$type<'provider' | 'manual'>().notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inference_pricing_source_version_unique').on(table.sourceId, table.version),
    index('inference_pricing_source_effective_idx').on(table.sourceId, table.effectiveAt),
  ]
);

export const inferenceModelAccessRules = pgTable(
  'inference_model_access_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => inferenceModels.id, { onDelete: 'cascade' }),
    subjectType: varchar('subject_type', { length: 16 }).$type<InferenceAccessSubjectType>().notNull(),
    groupId: uuid('group_id').references(() => permissionGroups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    effect: varchar('effect', { length: 8 }).$type<InferenceAccessEffect>().notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inference_model_access_group_unique')
      .on(table.modelId, table.groupId)
      .where(sql`${table.groupId} IS NOT NULL`),
    uniqueIndex('inference_model_access_user_unique')
      .on(table.modelId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    index('inference_model_access_model_idx').on(table.modelId),
    check(
      'inference_model_access_subject_valid',
      sql`(${table.subjectType} = 'group' AND ${table.groupId} IS NOT NULL AND ${table.userId} IS NULL) OR (${table.subjectType} = 'user' AND ${table.userId} IS NOT NULL AND ${table.groupId} IS NULL)`
    ),
  ]
);

export const inferenceLimitPolicies = pgTable(
  'inference_limit_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    policyType: varchar('policy_type', { length: 16 }).$type<InferenceLimitPolicyType>().notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    credits5hEnabled: boolean('credits_5h_enabled').notNull().default(true),
    credits5h: numeric('credits_5h', { precision: 24, scale: 6 }).notNull(),
    credits7dEnabled: boolean('credits_7d_enabled').notNull().default(true),
    credits7d: numeric('credits_7d', { precision: 24, scale: 6 }).notNull(),
    credits30dEnabled: boolean('credits_30d_enabled').notNull().default(true),
    credits30d: numeric('credits_30d', { precision: 24, scale: 6 }).notNull(),
    apiMonthlyMicrodollars: bigint('api_monthly_microdollars', { mode: 'number' }).notNull(),
    billingTimezone: varchar('billing_timezone', { length: 64 }).notNull().default('UTC'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inference_limit_default_unique').on(table.policyType).where(sql`${table.policyType} = 'default'`),
    uniqueIndex('inference_limit_user_unique').on(table.userId).where(sql`${table.userId} IS NOT NULL`),
    check(
      'inference_limit_subject_valid',
      sql`(${table.policyType} = 'default' AND ${table.userId} IS NULL) OR (${table.policyType} = 'user' AND ${table.userId} IS NOT NULL)`
    ),
    check(
      'inference_limit_values_nonnegative',
      sql`${table.credits5h} >= 0 AND ${table.credits7d} >= 0 AND ${table.credits30d} >= 0 AND ${table.apiMonthlyMicrodollars} >= 0`
    ),
  ]
);

export type InferenceModel = typeof inferenceModels.$inferSelect;
export type InferenceModelSource = typeof inferenceModelSources.$inferSelect;
export type InferencePricingSnapshot = typeof inferencePricingSnapshots.$inferSelect;
export type InferenceLimitPolicy = typeof inferenceLimitPolicies.$inferSelect;
