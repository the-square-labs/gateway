import { createHash } from 'node:crypto';
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
  version: string;
  storageSizeBytes: number;
  runtimeConfig: {
    cpuCores: number;
    memoryMb: number;
    swapMb: number;
  };
  publishedPort: number | null;
  publishedNativePort: number | null;
  tlsEnabled: boolean;
  /** Selected database-node address, available only for a published TCP endpoint. */
  endpointHost: string | null;
  status: 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'error' | 'deleting';
  lastError: string | null;
  clickhouseConfigXml?: string;
}

export interface DatabaseConnectionView {
  id: string;
  name: string;
  slug: string;
  type: DatabaseType;
  description: string | null;
  tags: string[];
  manualSizeLimitMb: number | null;
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

type DatabaseConnectionRow = {
  id: string;
  name: string;
  slug: string;
  type: DatabaseType;
  description: string | null;
  tags: unknown;
  manualSizeLimitMb: number | null;
  host: string;
  port: number;
  databaseName: string | null;
  username: string | null;
  tlsEnabled: boolean;
  healthStatus: DatabaseHealthStatus;
  lastHealthCheckAt: Date | null;
  lastError: string | null;
  healthHistory: unknown;
  folderId: string | null;
  sortOrder: number;
  createdById: string;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function maskDatabaseCredential(value: string | null | undefined): string {
  return value ? '••••••••' : '';
}

export function hashDatabasePreview(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function buildDatabaseConnectionString(config: DatabaseConnectionConfig): string {
  if (config.type === 'postgres') {
    const protocol = 'postgresql';
    const sslMode = config.sslEnabled ? '?sslmode=require' : '';
    return `${protocol}://${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${encodeURIComponent(config.database)}${sslMode}`;
  }
  if (config.type === 'clickhouse') {
    const url = new URL(config.url);
    url.username = config.username;
    url.password = config.password;
    url.searchParams.set('database', config.database);
    return url.toString();
  }
  const protocol = config.tlsEnabled ? 'rediss' : 'redis';
  const auth = config.username
    ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}`
    : `:${encodeURIComponent(config.password)}`;
  return `${protocol}://${auth}@${config.host}:${config.port}/${config.db}`;
}

export function toDatabaseConnectionView(
  row: DatabaseConnectionRow,
  config: DatabaseConnectionConfig,
  revealCredentials: boolean,
  includeHealthHistory = true,
  managed?: ManagedDatabaseConnectionMetadata
): DatabaseConnectionView {
  const capabilities: DatabaseCapabilities =
    config.type === 'postgres'
      ? {
          sqlConsole: true,
          commandConsole: false,
          catalogExplorer: true,
          rowInsert: true,
          rowUpdate: true,
          rowDelete: true,
          schemaMutation: true,
          exactRowCount: true,
        }
      : config.type === 'clickhouse'
        ? {
            sqlConsole: true,
            commandConsole: false,
            catalogExplorer: true,
            rowInsert: true,
            rowUpdate: true,
            rowDelete: true,
            schemaMutation: false,
            exactRowCount: false,
          }
        : {
            sqlConsole: false,
            commandConsole: true,
            catalogExplorer: false,
            rowInsert: false,
            rowUpdate: false,
            rowDelete: false,
            schemaMutation: false,
            exactRowCount: false,
          };
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    description: row.description,
    tags: (row.tags as string[] | null) ?? [],
    manualSizeLimitMb: row.manualSizeLimitMb,
    host: row.host,
    port: row.port,
    databaseName: row.databaseName,
    username: row.username,
    tlsEnabled: row.tlsEnabled,
    healthStatus: row.healthStatus,
    lastHealthCheckAt: row.lastHealthCheckAt?.toISOString() ?? null,
    lastError: row.lastError,
    ...(includeHealthHistory ? { healthHistory: (row.healthHistory as DatabaseHealthEntry[] | null) ?? [] } : {}),
    folderId: row.folderId,
    sortOrder: row.sortOrder,
    hasStoredPassword: !!config.password,
    config:
      config.type === 'postgres'
        ? {
            host: config.host,
            port: config.port,
            database: config.database,
            username: config.username,
            password: revealCredentials ? config.password : maskDatabaseCredential(config.password),
            sslEnabled: config.sslEnabled,
          }
        : config.type === 'clickhouse'
          ? {
              url: config.url,
              host: config.host,
              port: config.port,
              database: config.database,
              username: config.username,
              password: revealCredentials ? config.password : maskDatabaseCredential(config.password),
              tlsEnabled: config.tlsEnabled,
            }
          : {
              host: config.host,
              port: config.port,
              username: config.username,
              password: revealCredentials ? config.password : maskDatabaseCredential(config.password),
              db: config.db,
              tlsEnabled: config.tlsEnabled,
            },
    capabilities,
    ...(managed ? { managed } : {}),
    createdById: row.createdById,
    updatedById: row.updatedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
