import {
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
import { databaseConnectionFolders } from './database-connection-folders.js';
import { users } from './users.js';

export const databaseTypeEnum = pgEnum('database_type', ['postgres', 'redis', 'clickhouse']);
export const databaseHealthStatusEnum = pgEnum('database_health_status', ['online', 'offline', 'degraded', 'unknown']);

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
