export type {
  ClickHouseConnectionConfig,
  DatabaseConnectionConfig,
  DatabaseConnectionView,
  DatabaseHealthStatus,
  PostgresConnectionConfig,
  RedisConnectionConfig,
} from './database-connection-view.js';
export type { DatabaseOperation, DatabaseType } from './database-error-mapping.js';
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
