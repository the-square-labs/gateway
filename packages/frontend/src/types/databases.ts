// Databases
export type DatabaseType = "postgres" | "redis" | "clickhouse";
export type DatabaseHealthStatus = "online" | "offline" | "degraded" | "unknown";
export type ManagedDatabaseStatus =
  | "creating"
  | "updating"
  | "ready"
  | "paused"
  | "stopped"
  | "error"
  | "deleting";

/** A database provisioned on a dedicated Gateway databases node. Credentials are never returned here. */
export interface ManagedDatabase {
  id: string;
  databaseConnectionId: string;
  slug: string;
  name: string;
  type: DatabaseType;
  version: string;
  nodeId: string;
  storageSizeBytes: string | number;
  runtimeConfig: { cpuCores: number; memoryMb: number; swapMb: number };
  publishedPort: number | null;
  publishedNativePort: number | null;
  tlsEnabled: boolean;
  status: ManagedDatabaseStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedDatabaseCatalogEntry {
  type: DatabaseType;
  versions: string[];
}

export interface ManagedDatabaseCreateInput {
  name: string;
  type: DatabaseType;
  version: string;
  nodeId: string;
  storageSizeGb: number;
  cpuCores: number;
  memoryMb: number;
  swapMb: number;
  publishTcp: boolean;
  publishedPort?: number;
  publishedNativePort?: number;
  tlsEnabled?: boolean;
  clickhouseConfigXml?: string;
}

export type ManagedDatabaseBindingTargetType = "container" | "deployment";

export interface ManagedDatabaseBindingEnvironment {
  connectionUri?: string;
  host?: string;
  port?: string;
  database?: string;
  username?: string;
  password?: string;
}

export interface ManagedDatabaseBinding {
  id: string;
  managedDatabaseId: string;
  targetNodeId: string;
  targetType: ManagedDatabaseBindingTargetType;
  targetResourceId: string;
  environment: ManagedDatabaseBindingEnvironment;
  status: "creating" | "ready" | "error" | "deleting";
  createdAt: string;
  updatedAt: string;
}

export interface ManagedDatabaseBindingCreateInput {
  targetNodeId: string;
  targetType: ManagedDatabaseBindingTargetType;
  targetResourceId: string;
  environment: ManagedDatabaseBindingEnvironment;
  /** Explicit acknowledgement that colliding ordinary env/secrets are replaced. */
  replaceExistingEnvironment?: boolean;
  /** Full ordinary environment draft saved with the binding update. */
  targetEnvironment?: Record<string, string>;
}

export interface ManagedDatabaseBindingDeleteInput {
  /** Full ordinary environment draft saved with the binding removal. */
  targetEnvironment?: Record<string, string>;
}

export interface DatabaseHealthEntry {
  ts: string;
  status: DatabaseHealthStatus;
  responseMs?: number;
  slow?: boolean;
}

export interface PostgresDatabaseConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslEnabled: boolean;
}

export interface RedisDatabaseConfig {
  host: string;
  port: number;
  username: string | null;
  password: string;
  db: number;
  tlsEnabled: boolean;
}

export interface ClickHouseDatabaseConfig {
  url: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tlsEnabled: boolean;
}

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

export interface DatabaseConnection {
  id: string;
  slug: string;
  name: string;
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
  folderId?: string | null;
  sortOrder?: number;
  hasStoredPassword: boolean;
  config: PostgresDatabaseConfig | RedisDatabaseConfig | ClickHouseDatabaseConfig;
  capabilities?: DatabaseCapabilities;
  managed?: {
    id: string;
    nodeId: string;
    version: string;
    storageSizeBytes: number;
    runtimeConfig: { cpuCores: number; memoryMb: number; swapMb: number };
    publishedPort: number | null;
    publishedNativePort: number | null;
    tlsEnabled: boolean;
    endpointHost: string | null;
    status: ManagedDatabaseStatus;
    lastError: string | null;
    clickhouseConfigXml?: string;
  };
  createdById: string;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseMetricSnapshot {
  timestamp: string;
  databaseId: string;
  type: DatabaseType;
  name: string;
  status: DatabaseHealthStatus;
  responseMs: number;
  metrics: Record<string, number | null>;
}

export interface PostgresTableColumn {
  name: string;
  dataType: string;
  udtName: string;
  udtSchema: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  hasDefault: boolean;
}

export interface PostgresTableMetadata {
  schema: string;
  table: string;
  columns: PostgresTableColumn[];
  primaryKey: string[];
  hasPrimaryKey: boolean;
}

export interface SqlNamespace {
  name: string;
  system: boolean;
}

export interface SqlObjectSummary {
  name: string;
  type: "table" | "view" | "materialized-view" | "dictionary" | "other";
  engine?: string;
  estimatedRows?: number | null;
  estimatedBytes?: number | null;
}

export interface SqlColumnMetadata {
  name: string;
  dataType: string;
  nativeTypeName?: string;
  nativeTypeNamespace?: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isSortingKey?: boolean;
  isPartitionKey?: boolean;
  hasDefault: boolean;
  defaultExpression?: string | null;
  comment?: string | null;
}

export interface SqlTableMutationCapabilities {
  rowInsert: boolean;
  rowUpdate: boolean;
  rowDelete: boolean;
  identityColumns: string[];
  immutableColumns: string[];
  reason?: string;
}

export interface SqlTableMetadata {
  provider: "postgres" | "clickhouse";
  namespace: string;
  table: string;
  objectType: SqlObjectSummary["type"];
  engine?: string;
  columns: SqlColumnMetadata[];
  primaryKey: string[];
  hasPrimaryKey: boolean;
  sortingKey?: string | null;
  partitionKey?: string | null;
  providerMetadata?: Record<string, unknown>;
  mutations: SqlTableMutationCapabilities;
}

export interface SqlBrowseResult {
  metadata: SqlTableMetadata;
  rows: Record<string, unknown>[];
  page: number;
  limit: number;
  total: number | null;
  totalKind: "exact" | "approximate" | "unavailable";
  truncated: boolean;
}

export interface SqlExecutionResult {
  results: Array<{
    command: string;
    queryId?: string;
    rowCount: number;
    durationMs: number;
    fields: string[];
    columns: Array<{ name: string; type: string }>;
    rows: Record<string, unknown>[];
    truncated: boolean;
    maxRows: number;
    statistics?: Record<string, number>;
  }>;
  truncated: boolean;
  resultLimit: number;
}

export interface SqlRowMutationResult {
  success: true;
  affectedRows: number;
  queryId?: string;
}

export interface RedisKeyRecord {
  key: string;
  type: string;
  ttlSeconds: number;
}
