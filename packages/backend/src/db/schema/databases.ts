import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { certificates } from './certificates.js';
import { databaseConnectionFolders } from './database-connection-folders.js';
import { nodes } from './nodes.js';
import { users } from './users.js';

export const databaseTypeEnum = pgEnum('database_type', ['postgres', 'redis', 'clickhouse']);
export const databaseHealthStatusEnum = pgEnum('database_health_status', ['online', 'offline', 'degraded', 'unknown']);
export const managedDatabaseStatusEnum = pgEnum('managed_database_status', [
  'creating',
  'updating',
  'ready',
  'paused',
  'stopped',
  'error',
  'deleting',
]);
export const databaseBindingTargetTypeEnum = pgEnum('database_binding_target_type', ['container', 'deployment']);
export const databaseBindingStatusEnum = pgEnum('database_binding_status', ['creating', 'ready', 'error', 'deleting']);

export interface DatabaseHealthEntry {
  ts: string;
  status: 'online' | 'offline' | 'degraded' | 'unknown';
  responseMs?: number;
  slow?: boolean;
}

export const databaseConnections = pgTable(
  'database_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 60 }).notNull(),
    type: databaseTypeEnum('type').notNull(),
    description: text('description'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    host: varchar('host', { length: 255 }).notNull(),
    port: integer('port').notNull(),
    databaseName: varchar('database_name', { length: 255 }),
    username: varchar('username', { length: 255 }),
    tlsEnabled: boolean('tls_enabled').notNull().default(false),
    manualSizeLimitMb: integer('manual_size_limit_mb'),
    encryptedConfig: text('encrypted_config').notNull(),
    healthStatus: databaseHealthStatusEnum('health_status').notNull().default('unknown'),
    lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
    lastError: text('last_error'),
    healthHistory: jsonb('health_history').$type<DatabaseHealthEntry[]>().notNull().default([]),
    folderId: uuid('folder_id').references(() => databaseConnectionFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    typeIdx: index('database_connections_type_idx').on(table.type),
    healthIdx: index('database_connections_health_idx').on(table.healthStatus),
    folderIdx: index('database_connections_folder_idx').on(table.folderId),
    createdByIdx: index('database_connections_created_by_idx').on(table.createdById),
    updatedByIdx: index('database_connections_updated_by_idx').on(table.updatedById),
    slugUnique: unique('database_connections_slug_unique').on(table.slug),
  })
);

export interface ManagedDatabaseEngineConfig {
  databaseName?: string;
  ownerUsername: string;
  publishTcp?: boolean;
  publishNativeTcp?: boolean;
  clickhouseConfigXml?: string;
}

export interface ManagedDatabaseRuntimeConfig {
  nanoCPUs?: number;
  cpuShares?: number;
  memoryLimitBytes?: number;
  memorySwapBytes?: number;
  pidsLimit?: number;
}

export interface ManagedDatabasePendingOperation {
  id: string;
  action: 'create' | 'update' | 'restart' | 'pause' | 'unpause' | 'delete';
}

export interface DatabaseBindingEnvironment {
  connectionUri?: string;
  host?: string;
  port?: string;
  database?: string;
  username?: string;
  password?: string;
}

/**
 * Deployment and storage state for a managed database. The linked
 * database_connections row is the canonical user-facing resource; this table
 * only owns the database-node lifecycle.
 */
export const managedDatabaseInstances = pgTable(
  'managed_database_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    databaseConnectionId: uuid('database_connection_id').references(() => databaseConnections.id, {
      onDelete: 'restrict',
    }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 60 }).notNull(),
    type: databaseTypeEnum('type').notNull(),
    version: varchar('version', { length: 128 }).notNull(),
    imageRef: varchar('image_ref', { length: 512 }).notNull(),
    engineConfig: jsonb('engine_config').$type<ManagedDatabaseEngineConfig>().notNull(),
    encryptedOwnerCredentials: text('encrypted_owner_credentials').notNull(),
    // Direct TCP access uses its own least-privileged database principal.
    // The internal owner is never returned to clients.
    encryptedDirectCredentials: text('encrypted_direct_credentials'),
    storageSizeBytes: bigint('storage_size_bytes', { mode: 'number' }).notNull(),
    runtimeConfig: jsonb('runtime_config').$type<ManagedDatabaseRuntimeConfig>().notNull().default({}),
    // Database TLS material exists independently from the direct-publication
    // toggle. The certificate's key is held only by Gateway and the daemon.
    certificateId: uuid('certificate_id').references(() => certificates.id, { onDelete: 'restrict' }),
    tlsEnabled: boolean('tls_enabled').notNull().default(true),
    publishedPort: integer('published_port'),
    // ClickHouse uses a second published endpoint for secure native TCP while
    // publishedPort remains the primary HTTPS endpoint for compatibility.
    publishedNativePort: integer('published_native_port'),
    status: managedDatabaseStatusEnum('status').notNull().default('creating'),
    pendingOperation: jsonb('pending_operation').$type<ManagedDatabasePendingOperation>(),
    lastError: text('last_error'),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    databaseConnectionUnique: unique('managed_database_instances_database_connection_unique').on(
      table.databaseConnectionId
    ),
    nodeIdx: index('managed_database_instances_node_idx').on(table.nodeId),
    statusIdx: index('managed_database_instances_status_idx').on(table.status),
    slugUnique: unique('managed_database_instances_slug_unique').on(table.slug),
  })
);

/**
 * A scoped secure application path to a managed database. The encrypted
 * credential belongs to this binding, never to the target node or sidecar.
 */
export const managedDatabaseBindings = pgTable(
  'managed_database_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    managedDatabaseId: uuid('managed_database_id')
      .notNull()
      .references(() => managedDatabaseInstances.id, { onDelete: 'cascade' }),
    targetNodeId: uuid('target_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    targetType: databaseBindingTargetTypeEnum('target_type').notNull(),
    targetResourceId: varchar('target_resource_id', { length: 255 }).notNull(),
    networkName: varchar('network_name', { length: 128 }).notNull(),
    connectorName: varchar('connector_name', { length: 128 }).notNull(),
    connectorAlias: varchar('connector_alias', { length: 128 }).notNull(),
    environment: jsonb('environment').$type<DatabaseBindingEnvironment>().notNull(),
    encryptedCredentials: text('encrypted_credentials').notNull(),
    status: databaseBindingStatusEnum('status').notNull().default('creating'),
    lastError: text('last_error'),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    managedDatabaseIdx: index('managed_database_bindings_database_idx').on(table.managedDatabaseId),
    targetNodeIdx: index('managed_database_bindings_target_node_idx').on(table.targetNodeId),
    targetUnique: unique('managed_database_bindings_target_unique').on(
      table.managedDatabaseId,
      table.targetNodeId,
      table.targetType,
      table.targetResourceId
    ),
  })
);
