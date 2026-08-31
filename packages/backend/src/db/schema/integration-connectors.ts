import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { dockerRegistries } from './docker-registries.js';
import { users } from './users.js';

export type IntegrationProvider = 'gitlab' | 'github' | 'git' | 'cloudflare' | 'ssh';
export type IntegrationConnectorAuthMode = 'token' | 'oauth';
export type IntegrationAllowlistMode = 'selected' | 'all_visible';
export type IntegrationSyncStatus = 'never' | 'idle' | 'running' | 'success' | 'error';
export type IntegrationAllowlistEntryType = 'group' | 'project';
export type IntegrationRegistryStatus = 'available' | 'inaccessible';
export type IntegrationConnectorCredentialType = 'gitlab_deploy_token';
export type GitLabUserCredentialStatus = 'valid' | 'invalid';

export interface IntegrationConnectorSettings {
  autoSyncEnabled: boolean;
  autoSyncIntervalSeconds: number;
  cloneShallow: boolean;
  cloneDepth: number;
  cloneLfs: boolean;
  cloneSubmodules: boolean;
  cloneMaxSizeMb: number;
  cloneTimeoutSeconds: number;
}

export interface CloudflareConnectorSettings {
  autoSyncEnabled: boolean;
  autoSyncIntervalSeconds: number;
  defaultTtl: number;
  defaultProxied: boolean;
}

export interface GitConnectorSettings {
  repositoryMode: 'single_repository' | 'multi_repository';
  autoSyncEnabled: boolean;
  autoSyncIntervalSeconds: number;
}

export type IntegrationConnectorCapabilities = Record<string, boolean>;
export type IntegrationConnectorSettingsValue =
  | IntegrationConnectorSettings
  | CloudflareConnectorSettings
  | GitConnectorSettings;

export const integrationConnectors = pgTable(
  'integration_connectors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: varchar('provider', { length: 32 }).$type<IntegrationProvider>().notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    baseUrl: text('base_url').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    authMode: varchar('auth_mode', { length: 32 }).$type<IntegrationConnectorAuthMode>().notNull().default('token'),
    username: varchar('username', { length: 255 }),
    encryptedToken: text('encrypted_token'),
    encryptedRefreshToken: text('encrypted_refresh_token'),
    tokenLast4: varchar('token_last4', { length: 16 }),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    allowlistMode: varchar('allowlist_mode', { length: 32 })
      .$type<IntegrationAllowlistMode>()
      .notNull()
      .default('selected'),
    settings: jsonb('settings').$type<IntegrationConnectorSettingsValue>().notNull().default({
      autoSyncEnabled: true,
      autoSyncIntervalSeconds: 900,
      cloneShallow: true,
      cloneDepth: 1,
      cloneLfs: false,
      cloneSubmodules: false,
      cloneMaxSizeMb: 1024,
      cloneTimeoutSeconds: 300,
    }),
    capabilities: jsonb('capabilities').$type<IntegrationConnectorCapabilities>().notNull().default({}),
    syncStatus: varchar('sync_status', { length: 32 }).$type<IntegrationSyncStatus>().notNull().default('never'),
    syncLastError: text('sync_last_error'),
    syncFailureCount: integer('sync_failure_count').notNull().default(0),
    syncStartedAt: timestamp('sync_started_at', { withTimezone: true }),
    syncFinishedAt: timestamp('sync_finished_at', { withTimezone: true }),
    syncLastOverlapAt: timestamp('sync_last_overlap_at', { withTimezone: true }),
    syncNextRetryAt: timestamp('sync_next_retry_at', { withTimezone: true }),
    testedAt: timestamp('tested_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('integration_connector_provider_name_unique').on(table.provider, table.name),
    index('integration_connector_provider_idx').on(table.provider),
    index('integration_connector_enabled_idx').on(table.enabled),
    index('integration_connector_sync_idx').on(table.provider, table.syncStatus, table.syncNextRetryAt),
  ]
);

export type GitHubOAuthSessionStatus = 'pending' | 'processing' | 'complete' | 'expired' | 'cancelled' | 'error';

export interface GitHubOAuthConnectorDraft {
  targetConnectorId?: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  repositoryMode: 'single_repository' | 'multi_repository';
  repositoryUrl?: string;
  allowlistEntries?: Array<{
    entryType: 'group' | 'project';
    remoteId: string;
    fullPath: string;
    name?: string;
    webUrl?: string | null;
  }>;
}

export const integrationGitHubOAuthSessions = pgTable(
  'integration_github_oauth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    encryptedDeviceCode: text('encrypted_device_code').notNull(),
    userCode: varchar('user_code', { length: 64 }).notNull(),
    verificationUri: text('verification_uri').notNull(),
    connectorDraft: jsonb('connector_draft').$type<GitHubOAuthConnectorDraft>().notNull(),
    status: varchar('status', { length: 32 }).$type<GitHubOAuthSessionStatus>().notNull().default('pending'),
    pollIntervalSeconds: integer('poll_interval_seconds').notNull().default(5),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    connectorId: uuid('connector_id').references(() => integrationConnectors.id, { onDelete: 'set null' }),
    errorMessage: text('error_message'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('integration_github_oauth_user_status_idx').on(table.userId, table.status),
    index('integration_github_oauth_expiry_idx').on(table.expiresAt),
  ]
);

export const integrationConnectorCloudflareZones = pgTable(
  'integration_connector_cloudflare_zones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => integrationConnectors.id, { onDelete: 'cascade' }),
    remoteId: varchar('remote_id', { length: 128 }).notNull(),
    name: text('name').notNull(),
    status: varchar('status', { length: 64 }),
    accountId: varchar('account_id', { length: 128 }),
    accountName: text('account_name'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('integration_cloudflare_zone_connector_remote_unique').on(table.connectorId, table.remoteId),
    unique('integration_cloudflare_zone_connector_name_unique').on(table.connectorId, table.name),
    index('integration_cloudflare_zone_connector_idx').on(table.connectorId),
    index('integration_cloudflare_zone_name_idx').on(table.name),
  ]
);

export const integrationConnectorAllowlistEntries = pgTable(
  'integration_connector_allowlist_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => integrationConnectors.id, { onDelete: 'cascade' }),
    entryType: varchar('entry_type', { length: 32 }).$type<IntegrationAllowlistEntryType>().notNull(),
    remoteId: varchar('remote_id', { length: 128 }).notNull(),
    fullPath: text('full_path').notNull(),
    name: text('name'),
    webUrl: text('web_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('integration_allowlist_connector_entry_unique').on(table.connectorId, table.entryType, table.remoteId),
    index('integration_allowlist_connector_idx').on(table.connectorId),
  ]
);

export const integrationConnectorProjects = pgTable(
  'integration_connector_projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => integrationConnectors.id, { onDelete: 'cascade' }),
    remoteId: varchar('remote_id', { length: 128 }).notNull(),
    fullPath: text('full_path').notNull(),
    name: text('name').notNull(),
    webUrl: text('web_url'),
    visibility: varchar('visibility', { length: 32 }),
    defaultBranch: text('default_branch'),
    archived: boolean('archived').notNull().default(false),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    inaccessibleAt: timestamp('inaccessible_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('integration_project_connector_remote_unique').on(table.connectorId, table.remoteId),
    unique('integration_project_connector_path_unique').on(table.connectorId, table.fullPath),
    index('integration_project_connector_idx').on(table.connectorId),
  ]
);

export const integrationConnectorRegistryLinks = pgTable(
  'integration_connector_registry_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => integrationConnectors.id, { onDelete: 'cascade' }),
    registryId: uuid('registry_id')
      .notNull()
      .references(() => dockerRegistries.id, { onDelete: 'cascade' }),
    remoteRegistryId: varchar('remote_registry_id', { length: 128 }),
    projectRemoteId: varchar('project_remote_id', { length: 128 }),
    projectFullPath: text('project_full_path'),
    status: varchar('status', { length: 32 }).$type<IntegrationRegistryStatus>().notNull().default('available'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('integration_registry_link_registry_unique').on(table.registryId),
    index('integration_registry_link_connector_idx').on(table.connectorId),
    index('integration_registry_link_project_idx').on(table.connectorId, table.projectRemoteId),
  ]
);

export const integrationConnectorRegistries = pgTable(
  'integration_connector_registries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => integrationConnectors.id, { onDelete: 'cascade' }),
    remoteRegistryId: varchar('remote_registry_id', { length: 128 }),
    projectRemoteId: varchar('project_remote_id', { length: 128 }),
    projectFullPath: text('project_full_path'),
    registryUrl: text('registry_url').notNull(),
    name: text('name').notNull(),
    status: varchar('status', { length: 32 }).$type<IntegrationRegistryStatus>().notNull().default('available'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    inaccessibleAt: timestamp('inaccessible_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('integration_registry_connector_url_unique').on(table.connectorId, table.registryUrl),
    index('integration_registry_connector_idx').on(table.connectorId),
    index('integration_registry_project_idx').on(table.connectorId, table.projectRemoteId),
  ]
);

export const integrationConnectorCredentials = pgTable(
  'integration_connector_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => integrationConnectors.id, { onDelete: 'cascade' }),
    credentialType: varchar('credential_type', { length: 64 }).$type<IntegrationConnectorCredentialType>().notNull(),
    name: text('name').notNull(),
    encryptedSecret: text('encrypted_secret').notNull(),
    secretLast4: varchar('secret_last4', { length: 16 }),
    username: text('username'),
    projectRemoteId: varchar('project_remote_id', { length: 128 }),
    projectFullPath: text('project_full_path'),
    registryUrl: text('registry_url'),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('integration_credential_connector_idx').on(table.connectorId),
    index('integration_credential_project_idx').on(table.connectorId, table.projectRemoteId),
  ]
);

export const gitLabUserCredentials = pgTable(
  'gitlab_user_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => integrationConnectors.id, { onDelete: 'cascade' }),
    encryptedToken: text('encrypted_token').notNull(),
    tokenLast4: varchar('token_last4', { length: 16 }).notNull(),
    gitlabUserId: varchar('gitlab_user_id', { length: 64 }).notNull(),
    gitlabUsername: varchar('gitlab_username', { length: 255 }).notNull(),
    tokenScopes: jsonb('token_scopes').$type<string[]>().notNull().default([]),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    status: varchar('status', { length: 16 }).$type<GitLabUserCredentialStatus>().notNull().default('valid'),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }).notNull().defaultNow(),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userConnectorUnique: unique('gitlab_user_credentials_user_connector_unique').on(table.userId, table.connectorId),
    userIdx: index('gitlab_user_credentials_user_idx').on(table.userId),
    connectorIdx: index('gitlab_user_credentials_connector_idx').on(table.connectorId),
  })
);
