import pg from 'pg';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
export const { Pool } = pg;
export const DATABASE_HEALTH_HISTORY_MIN_INTERVAL_MS = 30_000;
export const MANAGED_CLICKHOUSE_QUERY_PRINCIPAL_VERSION = 1;
export const INTERACTIVE_QUERY_MAX_CONCURRENT_PER_DATABASE = 3;
export const logger = createChildLogger('DatabaseConnectionService');

export type {
  ClickHouseConnectionConfig,
  DatabaseConnectionConfig,
  DatabaseConnectionView,
  DatabaseHealthStatus,
  PostgresConnectionConfig,
  RedisConnectionConfig,
} from './database-connection-view.js';
export type { DatabaseOperation, DatabaseType } from './database-error-mapping.js';
export { mapDatabaseDriverError } from './database-error-mapping.js';

export type PostgresRowSearchOperation = 'like' | 'equals' | 'notEquals' | 'greaterThan' | 'lessThan';
export type SqlQueryAccess = 'read' | 'write' | 'admin';

export interface PostgresRowSearchFilter {
  column: string;
  operation: PostgresRowSearchOperation;
  value: string;
}

export interface ManagedPostgresExtension {
  name: string;
  defaultVersion: string;
  installedVersion: string | null;
  comment: string | null;
}

export interface PostgresExtensionRow {
  name: string;
  default_version: string;
  comment: string | null;
}

export interface InstalledPostgresExtensionRow {
  name: string;
  installed_version: string;
}

export type ManagedPostgresExtensionDefinition = Omit<ManagedPostgresExtension, 'installedVersion'>;

export interface ManagedPostgresExtensionContext {
  imageRef: string;
}

export interface ManagedPostgresExtensionStateCacheEntry {
  expiresAt: number;
  value: Promise<ManagedPostgresExtension[]>;
}

export const POSTGRES_EXTENSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const POSTGRES_EXTENSIONS_EXCLUDED_FROM_MANAGER = new Set(['pg_stat_statements', 'plpgsql']);
export const MANAGED_POSTGRES_EXTENSION_STATE_CACHE_TTL_MS = 30_000;

export function normalizePostgresExtensionName(value: string): string {
  const name = value.trim();
  if (!POSTGRES_EXTENSION_NAME_PATTERN.test(name)) {
    throw new AppError(400, 'INVALID_POSTGRES_EXTENSION', 'Invalid PostgreSQL extension name');
  }
  return name;
}

export function quotePostgresExtensionName(name: string): string {
  return `"${normalizePostgresExtensionName(name)}"`;
}

export function toManagedPostgresExtensionDefinition(row: PostgresExtensionRow): ManagedPostgresExtensionDefinition {
  return {
    name: row.name,
    defaultVersion: row.default_version,
    comment: row.comment,
  };
}

export { inferClickHouseIntent, inferPostgresIntent, inferRedisIntent } from './database-query-intent.js';
