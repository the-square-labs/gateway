import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

export type InferenceProviderAuthType = 'oauth' | 'api_key' | 'local';
export type InferenceRoutingStrategy = 'even' | 'balanced' | 'sequential';
export type InferenceConnectionStatus =
  | 'pending'
  | 'healthy'
  | 'quota_hot'
  | 'cooldown'
  | 'stale'
  | 'reauth_required'
  | 'unavailable'
  | 'disabled';
export type InferenceSyncStatus = 'never' | 'running' | 'success' | 'error';

export const inferenceProviderSettings = pgTable('inference_provider_settings', {
  providerId: varchar('provider_id', { length: 80 }).primaryKey(),
  routingStrategy: varchar('routing_strategy', { length: 16 })
    .$type<InferenceRoutingStrategy>()
    .notNull()
    .default('balanced'),
  termsAcceptedVersion: varchar('terms_accepted_version', { length: 80 }),
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
  termsAcceptedBy: uuid('terms_accepted_by').references(() => users.id, { onDelete: 'set null' }),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const inferenceProviderConnections = pgTable(
  'inference_provider_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: varchar('provider_id', { length: 80 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    authType: varchar('auth_type', { length: 16 }).$type<InferenceProviderAuthType>().notNull(),
    baseUrl: text('base_url').notNull(),
    accountExternalId: text('account_external_id'),
    accountLabel: text('account_label'),
    enabled: boolean('enabled').notNull().default(true),
    routingOrder: integer('routing_order').notNull().default(0),
    minimumRemainingPercent: integer('minimum_remaining_percent').notNull().default(0),
    apiMonthlyLimitMicrodollars: bigint('api_monthly_limit_microdollars', { mode: 'number' }),
    status: varchar('status', { length: 32 }).$type<InferenceConnectionStatus>().notNull().default('pending'),
    healthReason: text('health_reason'),
    syncStatus: varchar('sync_status', { length: 16 }).$type<InferenceSyncStatus>().notNull().default('never'),
    syncLastError: text('sync_last_error'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    nextSyncAt: timestamp('next_sync_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('inference_provider_connections_provider_idx').on(table.providerId, table.enabled, table.deletedAt),
    index('inference_provider_connections_routing_idx').on(table.providerId, table.routingOrder),
    index('inference_provider_connections_sync_idx').on(table.syncStatus, table.nextSyncAt),
    check(
      'inference_provider_connections_minimum_remaining_range',
      sql`${table.minimumRemainingPercent} >= 0 AND ${table.minimumRemainingPercent} <= 100`
    ),
    check(
      'inference_provider_connections_api_monthly_limit_nonnegative',
      sql`${table.apiMonthlyLimitMicrodollars} IS NULL OR ${table.apiMonthlyLimitMicrodollars} >= 0`
    ),
  ]
);

export const inferenceProviderCredentials = pgTable(
  'inference_provider_credentials',
  {
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => inferenceProviderConnections.id, { onDelete: 'cascade' }),
    credentialKind: varchar('credential_kind', { length: 32 }).notNull(),
    encryptedPayload: text('encrypted_payload').notNull(),
    encryptedDek: text('encrypted_dek').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    secretLast4: varchar('secret_last4', { length: 16 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.credentialKind] })]
);

export const inferenceDiscoveredModels = pgTable(
  'inference_discovered_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => inferenceProviderConnections.id, { onDelete: 'cascade' }),
    remoteModelId: text('remote_model_id').notNull(),
    displayName: text('display_name'),
    contextWindow: integer('context_window'),
    maxInputTokens: integer('max_input_tokens'),
    maxOutputTokens: integer('max_output_tokens'),
    autoCompactTokenLimit: integer('auto_compact_token_limit'),
    modalities: jsonb('modalities').$type<string[]>().notNull().default(['text']),
    capabilities: jsonb('capabilities').$type<Record<string, boolean>>().notNull().default({}),
    reasoningEfforts: jsonb('reasoning_efforts').$type<string[]>().notNull().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    available: boolean('available').notNull().default(true),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inference_discovered_models_connection_remote_unique').on(table.connectionId, table.remoteModelId),
    index('inference_discovered_models_connection_idx').on(table.connectionId, table.available),
  ]
);

export type InferenceProviderConnection = typeof inferenceProviderConnections.$inferSelect;
export type InferenceProviderCredential = typeof inferenceProviderCredentials.$inferSelect;
export type InferenceDiscoveredModel = typeof inferenceDiscoveredModels.$inferSelect;
