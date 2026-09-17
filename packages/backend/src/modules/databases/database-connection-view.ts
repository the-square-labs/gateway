import type { ManagedRedisConfig } from '@/db/schema/databases.js';
import type { DatabaseHealthEntry } from '@/db/schema/index.js';
import type { DatabaseType } from './database-error-mapping.js';
export type DatabaseHealthStatus = 'online' | 'offline' | 'degraded' | 'unknown';
export interface PostgresConnectionConfig {
  type: 'postgres';
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslEnabled: boolean;
}
export interface RedisConnectionConfig {
  type: 'redis';
  host: string;
  port: number;
  username: string | null;
  password: string;
  db: number;
  tlsEnabled: boolean;
}
export interface ClickHouseConnectionConfig {
  type: 'clickhouse';
  url: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tlsEnabled: boolean;
}
export type DatabaseConnectionConfig = PostgresConnectionConfig | RedisConnectionConfig | ClickHouseConnectionConfig;
export interface DatabaseCapabilities {
  sqlConsole: boolean;
  commandConsole: boolean;
  catalogExplorer: boolean;
  rowInsert: boolean;
  rowUpdate: boolean;
  rowDelete: boolean;
  schemaMutation: boolean;
  exactRowCount: boolean;
}
export interface ManagedDatabaseConnectionMetadata {
  id: string;
  nodeId: string;
  nodeAvailable: boolean;
  version: string;
  storageSizeBytes: number;
  runtimeConfig: {
    cpuCores: number;
    memoryMb: number;
    swapMb: number;
  };
  publishedPort: number | null;
  publishedNativePort: number | null;
  publishTcp: boolean;
  publishNativeTcp: boolean;
  tlsEnabled: boolean;
  /** Selected database-node address, available only for a published TCP endpoint. */
  endpointHost: string | null;
  status: 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'error' | 'deleting';
  lastError: string | null;
  clickhouseConfigXml?: string;
  redisConfig?: ManagedRedisConfig;
}
export interface DatabaseConnectionView {
  id: string;
  name: string;
  slug: string;
  type: DatabaseType;
  description: string | null;
  tags: string[];
  manualSizeLimitMb: number | null;
  interactiveQueryBudgetSeconds: number;
  host: string;
  port: number;
  databaseName: string | null;
  username: string | null;
  tlsEnabled: boolean;
  healthStatus: DatabaseHealthStatus;
  lastHealthCheckAt: string | null;
  lastError: string | null;
  healthHistory?: DatabaseHealthEntry[];
  folderId: string | null;
  sortOrder: number;
  hasStoredPassword: boolean;
  config: Record<string, unknown>;
  capabilities: DatabaseCapabilities;
  managed?: ManagedDatabaseConnectionMetadata;
  createdById: string;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
}
