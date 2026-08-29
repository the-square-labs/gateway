import type { ClickHouseClient } from '@clickhouse/client';
import { asc, eq } from 'drizzle-orm';
import Redis from 'ioredis';
import type pg from 'pg';
import type { DrizzleClient } from '@/db/client.js';
import { type DatabaseHealthEntry, databaseConnections, managedDatabaseInstances, nodes } from '@/db/schema/index.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { getEffectiveNodeServiceAddress, getEffectivePublishedNodeIP } from '@/modules/nodes/node-service-address.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { createClickHouseDatabaseClient } from './clickhouse-connection.js';
import { ClickHouseSqlAdapter } from './clickhouse-sql-adapter.js';
import {
  type DatabaseConnectionConfig,
  type DatabaseConnectionView,
  type DatabaseHealthStatus,
  type ManagedDatabaseConnectionMetadata,
  type PostgresConnectionConfig,
  type RedisConnectionConfig,
  toDatabaseConnectionView,
} from './database-connection-view.js';
import { type DatabaseOperation, type DatabaseType, mapDatabaseDriverError } from './database-error-mapping.js';
import {
  type DatabaseQueryExecutionContext,
  executePostgresSql as executePostgresSqlOperation,
} from './database-query-execution.js';
import { inferPostgresIntent } from './database-query-intent.js';
import type { UpdateDatabaseConnectionInput } from './databases.schemas.js';
import {
  DATABASE_HEALTH_HISTORY_MIN_INTERVAL_MS,
  type InstalledPostgresExtensionRow,
  logger,
  MANAGED_CLICKHOUSE_QUERY_PRINCIPAL_VERSION,
  MANAGED_POSTGRES_EXTENSION_STATE_CACHE_TTL_MS,
  type ManagedPostgresExtension,
  type ManagedPostgresExtensionContext,
  type ManagedPostgresExtensionDefinition,
  type ManagedPostgresExtensionStateCacheEntry,
  POSTGRES_EXTENSIONS_EXCLUDED_FROM_MANAGER,
  Pool,
  type PostgresExtensionRow,
  type PostgresRowSearchFilter,
  type SqlQueryAccess,
  toManagedPostgresExtensionDefinition,
} from './databases.service.shared.js';
import type { ManagedDatabaseTunnelLane, ManagedDatabaseTunnelProxy } from './managed-database-tunnel-proxy.js';
import type {
  deletePostgresRow as deletePostgresRowOperation,
  insertPostgresRow as insertPostgresRowOperation,
  PostgresRowOperationContext,
  updatePostgresRow as updatePostgresRowOperation,
} from './postgres-row-operations.js';
import type {
  getPostgresTableMetadata as getPostgresTableMetadataOperation,
  listPostgresSchemas as listPostgresSchemasOperation,
  listPostgresTables as listPostgresTablesOperation,
  PostgresSchemaOperationContext,
} from './postgres-schema-operations.js';
import { PostgresSqlAdapter } from './postgres-sql-adapter.js';
import type { SqlDatabaseAdapter } from './sql-database-adapter.js';

export abstract class DatabaseConnectionServiceRuntime {
  protected eventBus?: EventBusService;
  protected readonly postgresPools = new Map<string, pg.Pool>();
  protected readonly postgresExtensionCatalogs = new Map<string, Promise<ManagedPostgresExtensionDefinition[]>>();
  protected readonly postgresExtensionStates = new Map<string, ManagedPostgresExtensionStateCacheEntry>();
  protected readonly redisClients = new Map<string, Redis>();
  protected readonly clickHouseClients = new Map<string, ClickHouseClient>();
  protected readonly interactiveQueryRuns = new Map<string, { total: number; users: Set<string> }>();
  protected readonly sqlAdapters: Map<'postgres' | 'clickhouse', SqlDatabaseAdapter>;

  constructor(
    protected readonly db: DrizzleClient,
    protected readonly auditService: AuditService,
    protected readonly cryptoService: CryptoService,
    protected readonly managedTunnelProxy?: ManagedDatabaseTunnelProxy
  ) {
    this.sqlAdapters = new Map<'postgres' | 'clickhouse', SqlDatabaseAdapter>([
      [
        'postgres',
        new PostgresSqlAdapter({
          listSchemas: (id) => this.listPostgresSchemas(id),
          listTables: (id, schema) => this.listPostgresTables(id, schema),
          getTableMetadata: (id, schema, table) => this.getPostgresTableMetadata(id, schema, table),
          browseRows: (id, schema, table, page, limit, sortBy, sortOrder, search) =>
            this.browsePostgresRows(id, schema, table, page, limit, sortBy, sortOrder, search),
          insertRow: (id, schema, table, values, userId) => this.insertPostgresRow(id, schema, table, values, userId),
          updateRow: (id, schema, table, primaryKey, values, userId) =>
            this.updatePostgresRow(id, schema, table, primaryKey, values, userId),
          deleteRow: (id, schema, table, primaryKey, userId) =>
            this.deletePostgresRow(id, schema, table, primaryKey, userId),
          executeSql: async (id, sql, userId, options) => {
            const result = await executePostgresSqlOperation(this.queryExecutionContext(), id, sql, userId, options);
            return {
              ...result,
              results: result.results.map((entry) => ({
                ...entry,
                durationMs: entry.durationMs ?? 0,
                columns: entry.fields.map((name) => ({ name, type: '' })),
                truncated: entry.truncated ?? false,
                maxRows: entry.maxRows ?? options?.maxRows ?? 500,
              })),
            };
          },
          inferIntent: inferPostgresIntent,
        }),
      ],
      [
        'clickhouse',
        new ClickHouseSqlAdapter({
          withClient: (id, operation, fn) => this.withClickHouseClient(id, operation, fn),
          auditLog: async (entry) => {
            await this.auditService.log(entry);
          },
          emitChange: (id, action, extra) => this.emitChange(id, action, extra),
        }),
      ],
    ]);
  }

  protected abstract listPostgresSchemas(id: string): ReturnType<typeof listPostgresSchemasOperation>;

  protected abstract listPostgresTables(id: string, schema: string): ReturnType<typeof listPostgresTablesOperation>;

  protected abstract getPostgresTableMetadata(
    id: string,
    schema: string,
    table: string
  ): ReturnType<typeof getPostgresTableMetadataOperation>;

  protected abstract browsePostgresRows(
    id: string,
    schema: string,
    table: string,
    page: number,
    limit: number,
    sortBy?: string,
    sortOrder?: 'asc' | 'desc',
    search?: PostgresRowSearchFilter
  ): Promise<{
    metadata: Awaited<ReturnType<typeof getPostgresTableMetadataOperation>>;
    rows: Record<string, unknown>[];
    total: number;
    page: number;
    limit: number;
  }>;

  protected abstract insertPostgresRow(
    id: string,
    schema: string,
    table: string,
    values: Record<string, unknown>,
    userId: string
  ): ReturnType<typeof insertPostgresRowOperation>;

  protected abstract updatePostgresRow(
    id: string,
    schema: string,
    table: string,
    primaryKey: Record<string, unknown>,
    values: Record<string, unknown>,
    userId: string
  ): ReturnType<typeof updatePostgresRowOperation>;

  protected abstract deletePostgresRow(
    id: string,
    schema: string,
    table: string,
    primaryKey: Record<string, unknown>,
    userId: string
  ): ReturnType<typeof deletePostgresRowOperation>;

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  protected queryExecutionContext(): DatabaseQueryExecutionContext {
    return {
      withPostgresPool: (id, operation, fn) => this.withPostgresPool(id, operation, fn),
      withRedisClient: (id, operation, fn) => this.withRedisClient(id, operation, fn),
      auditLog: async (entry) => {
        await this.auditService.log(entry);
      },
      emitChange: (id, action, extra) => this.emitChange(id, action, extra),
    };
  }

  protected postgresRowOperationContext(): PostgresRowOperationContext {
    return {
      withPostgresPool: (id, operation, fn) => this.withPostgresPool(id, operation, fn),
      getPostgresTableMetadata: (id, schema, table) => this.getPostgresTableMetadata(id, schema, table),
      auditLog: (entry, options) => this.auditService.log(entry, options),
      emitChange: (id, action, extra) => this.emitChange(id, action, extra),
    };
  }

  protected postgresSchemaOperationContext(): PostgresSchemaOperationContext {
    return {
      withPostgresPool: (id, operation, fn) => this.withPostgresPool(id, operation, fn),
    };
  }

  async getDecryptedConfig(
    id: string,
    lane: ManagedDatabaseTunnelLane = 'interactive',
    queryAccess: SqlQueryAccess = 'admin'
  ): Promise<DatabaseConnectionConfig> {
    const row = await this.getRow(id);
    let config = this.decryptConfig(row.encryptedConfig);
    const managed = await this.getManagedMetadata(id);
    if (!managed) return config;
    if (config.type === 'clickhouse' && queryAccess !== 'admin') {
      const principal = await this.getManagedClickHouseQueryPrincipal(id, queryAccess);
      if (!principal) {
        throw new AppError(
          503,
          'MANAGED_CLICKHOUSE_QUERY_ACCESS_UNAVAILABLE',
          'Secure query access is being configured for this managed ClickHouse database'
        );
      }
      config = { ...config, username: principal.username, password: principal.password };
    }
    if (!this.managedTunnelProxy) {
      throw new AppError(503, 'MANAGED_DATABASE_TUNNEL_UNAVAILABLE', 'Managed database tunnel is unavailable');
    }
    const endpoint = await this.managedTunnelProxy.getEndpoint(managed.id, lane);
    if (config.type === 'postgres') {
      return { ...config, host: endpoint.host, port: endpoint.port };
    }
    if (config.type === 'redis') {
      return { ...config, host: endpoint.host, port: endpoint.port, tlsEnabled: false };
    }
    return {
      ...config,
      url: `http://${endpoint.host}:${endpoint.port}`,
      host: endpoint.host,
      port: endpoint.port,
      tlsEnabled: false,
    };
  }

  async listAllRows() {
    return this.db
      .select()
      .from(databaseConnections)
      .orderBy(asc(databaseConnections.name), asc(databaseConnections.id));
  }

  async updateHealth(
    id: string,
    patch: {
      status: DatabaseHealthStatus;
      responseMs?: number;
      lastError?: string | null;
      forceHistory?: boolean;
    }
  ) {
    const row = await this.getRow(id);
    const now = new Date();
    const nowIso = now.toISOString();
    const existingHistory = (row.healthHistory as DatabaseHealthEntry[] | null) ?? [];
    const lastRecordedAt =
      existingHistory.length > 0 ? new Date(existingHistory[existingHistory.length - 1]!.ts).getTime() : 0;

    const shouldWriteHistory =
      patch.forceHistory ||
      row.healthStatus !== patch.status ||
      lastRecordedAt === 0 ||
      now.getTime() - lastRecordedAt >= DATABASE_HEALTH_HISTORY_MIN_INTERVAL_MS;

    const history = shouldWriteHistory
      ? this.trimHealthHistory([
          ...existingHistory,
          {
            ts: nowIso,
            status: patch.status,
            responseMs: patch.responseMs,
            slow: patch.status === 'degraded',
          },
        ])
      : existingHistory;

    const updatePayload: Partial<typeof databaseConnections.$inferInsert> = {
      healthStatus: patch.status,
      lastHealthCheckAt: now,
      lastError: patch.lastError ?? null,
      updatedAt: now,
    };
    if (shouldWriteHistory) updatePayload.healthHistory = history;

    await this.db.update(databaseConnections).set(updatePayload).where(eq(databaseConnections.id, id));
    if (shouldWriteHistory) {
      this.emitChange(id, 'health.sampled', {
        name: row.name,
        type: row.type,
        healthStatus: patch.status,
        sampledAt: nowIso,
      });
    }
    if (row.healthStatus !== patch.status) {
      const action =
        patch.status === 'online'
          ? 'health.online'
          : patch.status === 'degraded'
            ? 'health.degraded'
            : 'health.offline';
      this.emitChange(id, action, { name: row.name, type: row.type, healthStatus: patch.status, sampledAt: nowIso });
    }
  }

  protected async getRow(id: string) {
    const row = await this.db.query.databaseConnections.findFirst({
      where: eq(databaseConnections.id, id),
    });
    if (!row) throw new AppError(404, 'DATABASE_NOT_FOUND', 'Database connection not found');
    return row;
  }

  protected async getManagedPostgresExtensionContext(id: string): Promise<ManagedPostgresExtensionContext> {
    const row = await this.getRow(id);
    const config = this.decryptConfig(row.encryptedConfig);
    if (config.type !== 'postgres') {
      throw new AppError(400, 'INVALID_PROVIDER', 'PostgreSQL extensions are available only for PostgreSQL databases');
    }
    const [managed] = await this.db
      .select({ imageRef: managedDatabaseInstances.imageRef })
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.databaseConnectionId, id))
      .limit(1);
    if (!managed) {
      throw new AppError(
        400,
        'MANAGED_DATABASE_REQUIRED',
        'PostgreSQL extensions are available only for managed databases'
      );
    }
    return { imageRef: managed.imageRef };
  }

  protected async readManagedPostgresExtensionsWithPool(
    pool: pg.Pool,
    context: ManagedPostgresExtensionContext
  ): Promise<ManagedPostgresExtension[]> {
    const [definitions, installed] = await Promise.all([
      this.getManagedPostgresExtensionCatalog(pool, context.imageRef),
      pool.query<InstalledPostgresExtensionRow>(
        `select extname as name, extversion as installed_version
           from pg_extension`
      ),
    ]);
    const installedByName = new Map(installed.rows.map((extension) => [extension.name, extension.installed_version]));
    return definitions.map((extension) => ({
      ...extension,
      installedVersion: installedByName.get(extension.name) ?? null,
    }));
  }

  protected async refreshManagedPostgresExtensionState(
    id: string,
    pool: pg.Pool,
    context: ManagedPostgresExtensionContext
  ): Promise<ManagedPostgresExtension[]> {
    const value = this.readManagedPostgresExtensionsWithPool(pool, context);
    const entry: ManagedPostgresExtensionStateCacheEntry = {
      expiresAt: Date.now() + MANAGED_POSTGRES_EXTENSION_STATE_CACHE_TTL_MS,
      value,
    };
    this.postgresExtensionStates.set(id, entry);
    try {
      return await value;
    } catch (error) {
      if (this.postgresExtensionStates.get(id) === entry) {
        this.postgresExtensionStates.delete(id);
      }
      throw error;
    }
  }

  protected async loadManagedPostgresExtensionState(id: string): Promise<ManagedPostgresExtension[]> {
    const cached = this.getCachedManagedPostgresExtensionState(id);
    if (cached) return cached;

    const value = (async () => {
      const context = await this.getManagedPostgresExtensionContext(id);
      return this.withPostgresPool(id, 'query', (pool) => this.readManagedPostgresExtensionsWithPool(pool, context));
    })();
    const entry: ManagedPostgresExtensionStateCacheEntry = {
      expiresAt: Date.now() + MANAGED_POSTGRES_EXTENSION_STATE_CACHE_TTL_MS,
      value,
    };
    this.postgresExtensionStates.set(id, entry);
    try {
      return await value;
    } catch (error) {
      if (this.postgresExtensionStates.get(id) === entry) {
        this.postgresExtensionStates.delete(id);
      }
      throw error;
    }
  }

  protected getCachedManagedPostgresExtensionState(id: string): Promise<ManagedPostgresExtension[]> | null {
    const cached = this.postgresExtensionStates.get(id);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.postgresExtensionStates.delete(id);
      return null;
    }
    return cached.value;
  }

  protected async getManagedPostgresExtensionCatalog(
    pool: pg.Pool,
    imageRef: string
  ): Promise<ManagedPostgresExtensionDefinition[]> {
    const cached = this.postgresExtensionCatalogs.get(imageRef);
    if (cached) return cached;

    const catalog = pool
      .query<PostgresExtensionRow>(
        `select name, default_version, comment
           from pg_available_extensions
           order by name asc`
      )
      .then((result) =>
        result.rows
          .filter((extension) => !POSTGRES_EXTENSIONS_EXCLUDED_FROM_MANAGER.has(extension.name))
          .map(toManagedPostgresExtensionDefinition)
      );
    this.postgresExtensionCatalogs.set(imageRef, catalog);
    try {
      return await catalog;
    } catch (error) {
      if (this.postgresExtensionCatalogs.get(imageRef) === catalog) {
        this.postgresExtensionCatalogs.delete(imageRef);
      }
      throw error;
    }
  }

  protected async getManagedPostgresExtension(
    pool: pg.Pool,
    context: ManagedPostgresExtensionContext,
    name: string
  ): Promise<ManagedPostgresExtension | undefined> {
    const extensions = await this.readManagedPostgresExtensionsWithPool(pool, context);
    return extensions.find((extension) => extension.name === name);
  }

  protected async toView(
    row: typeof databaseConnections.$inferSelect,
    revealCredentials: boolean,
    includeHealthHistory: boolean
  ): Promise<DatabaseConnectionView> {
    return toDatabaseConnectionView(
      row,
      this.decryptConfig(row.encryptedConfig),
      revealCredentials,
      includeHealthHistory,
      await this.getManagedMetadata(row.id)
    );
  }

  protected async getManagedMetadata(
    databaseConnectionId: string
  ): Promise<ManagedDatabaseConnectionMetadata | undefined> {
    const [managed] = await this.db
      .select({
        id: managedDatabaseInstances.id,
        nodeId: managedDatabaseInstances.nodeId,
        version: managedDatabaseInstances.version,
        storageSizeBytes: managedDatabaseInstances.storageSizeBytes,
        runtimeConfig: managedDatabaseInstances.runtimeConfig,
        engineConfig: managedDatabaseInstances.engineConfig,
        publishedPort: managedDatabaseInstances.publishedPort,
        publishedNativePort: managedDatabaseInstances.publishedNativePort,
        tlsEnabled: managedDatabaseInstances.tlsEnabled,
        status: managedDatabaseInstances.status,
        lastError: managedDatabaseInstances.lastError,
        serviceAddresses: nodes.serviceAddresses,
        serviceAddress: nodes.serviceAddress,
        lastHealthReport: nodes.lastHealthReport,
        nodeStatus: nodes.status,
      })
      .from(managedDatabaseInstances)
      .leftJoin(nodes, eq(nodes.id, managedDatabaseInstances.nodeId))
      .where(eq(managedDatabaseInstances.databaseConnectionId, databaseConnectionId))
      .limit(1);
    if (!managed) return undefined;
    const runtime = managed.runtimeConfig as Record<string, unknown>;
    const memoryBytes = Number(runtime.memoryLimitBytes ?? 0);
    const swapBytes = Number(runtime.memorySwapBytes ?? 0);
    const engineConfig = managed.engineConfig as unknown as Record<string, unknown>;
    const clickhouseConfigXml = engineConfig.clickhouseConfigXml;
    const redisConfig = engineConfig.redisConfig;
    return {
      id: managed.id,
      nodeId: managed.nodeId,
      nodeAvailable: managed.nodeStatus === 'online',
      version: managed.version,
      storageSizeBytes: Number(managed.storageSizeBytes),
      runtimeConfig: {
        cpuCores: Number(runtime.nanoCPUs ?? 0) / 1_000_000_000,
        memoryMb: Math.round(memoryBytes / (1024 * 1024)),
        swapMb: Math.max(0, Math.round((swapBytes - memoryBytes) / (1024 * 1024))),
      },
      publishedPort: managed.publishedPort,
      publishedNativePort: managed.publishedNativePort,
      publishTcp:
        typeof engineConfig.publishTcp === 'boolean' ? engineConfig.publishTcp : managed.publishedPort !== null,
      publishNativeTcp:
        typeof engineConfig.publishNativeTcp === 'boolean'
          ? engineConfig.publishNativeTcp
          : managed.publishedNativePort !== null,
      tlsEnabled: managed.tlsEnabled,
      endpointHost:
        managed.publishedPort === null
          ? null
          : managed.tlsEnabled
            ? getEffectivePublishedNodeIP({
                serviceAddresses: managed.serviceAddresses,
                serviceAddress: managed.serviceAddress,
                lastHealthReport: managed.lastHealthReport,
              })
            : getEffectiveNodeServiceAddress({
                serviceAddresses: managed.serviceAddresses,
                serviceAddress: managed.serviceAddress,
                lastHealthReport: managed.lastHealthReport,
              }),
      status: managed.status,
      lastError: managed.lastError,
      ...(typeof clickhouseConfigXml === 'string' ? { clickhouseConfigXml } : {}),
      ...(redisConfig && typeof redisConfig === 'object'
        ? { redisConfig: redisConfig as ManagedDatabaseConnectionMetadata['redisConfig'] }
        : {}),
    };
  }

  protected async getManagedClickHouseQueryPrincipal(
    databaseConnectionId: string,
    access: Exclude<SqlQueryAccess, 'admin'>
  ): Promise<{ username: string; password: string } | undefined> {
    const [managed] = await this.db
      .select({
        type: managedDatabaseInstances.type,
        clickhouseQueryPrincipalVersion: managedDatabaseInstances.clickhouseQueryPrincipalVersion,
        encryptedDirectCredentials: managedDatabaseInstances.encryptedDirectCredentials,
        encryptedQueryCredentials: managedDatabaseInstances.encryptedQueryCredentials,
      })
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.databaseConnectionId, databaseConnectionId))
      .limit(1);
    if (
      !managed ||
      managed.type !== 'clickhouse' ||
      managed.clickhouseQueryPrincipalVersion !== MANAGED_CLICKHOUSE_QUERY_PRINCIPAL_VERSION
    ) {
      return undefined;
    }
    const encrypted = access === 'read' ? managed.encryptedQueryCredentials : managed.encryptedDirectCredentials;
    if (!encrypted) return undefined;
    try {
      const decrypted = JSON.parse(this.cryptoService.decryptString(JSON.parse(encrypted))) as {
        username?: unknown;
        password?: unknown;
      };
      if (typeof decrypted.username === 'string' && typeof decrypted.password === 'string') {
        return { username: decrypted.username, password: decrypted.password };
      }
    } catch {
      // A generic unavailability response keeps encrypted payload details out
      // of the API while allowing a later daemon reconciliation to recover.
    }
    return undefined;
  }

  protected emitChange(id: string, action: string, extra: Record<string, unknown> = {}) {
    this.eventBus?.publish('database.changed', { id, action, ...extra });
  }

  protected encryptConfig(config: DatabaseConnectionConfig): string {
    return JSON.stringify(this.cryptoService.encryptString(JSON.stringify(config)));
  }

  protected decryptConfig(encryptedConfig: string): DatabaseConnectionConfig {
    const parsed = JSON.parse(encryptedConfig) as { encryptedKey: string; encryptedDek: string };
    return JSON.parse(this.cryptoService.decryptString(parsed)) as DatabaseConnectionConfig;
  }

  protected extractReplacementPassword(inputConfig: UpdateDatabaseConnectionInput['config']): string | undefined {
    if (!inputConfig) return undefined;
    if ('password' in inputConfig) return inputConfig.password;
    const connectionUrl = inputConfig.connectionString || inputConfig.url;
    if (!connectionUrl) return undefined;

    try {
      const url = new URL(connectionUrl);
      return url.password ? decodeURIComponent(url.password) : undefined;
    } catch {
      return undefined;
    }
  }

  protected databaseCredentialOrigin(
    config: DatabaseConnectionConfig
  ): Record<string, string | number | boolean | null> {
    if (config.type === 'postgres') {
      return {
        type: config.type,
        host: config.host.trim().toLowerCase(),
        port: config.port,
        database: config.database,
        username: config.username,
        sslEnabled: config.sslEnabled,
      };
    }

    if (config.type === 'clickhouse') {
      return {
        type: config.type,
        url: config.url.trim(),
        database: config.database,
        username: config.username,
        tlsEnabled: config.tlsEnabled,
      };
    }

    return {
      type: config.type,
      host: config.host.trim().toLowerCase(),
      port: config.port,
      db: config.db,
      username: config.username ?? null,
      tlsEnabled: config.tlsEnabled,
    };
  }

  protected assertOriginChangeHasReplacementPassword(
    currentConfig: DatabaseConnectionConfig,
    mergedConfig: DatabaseConnectionConfig,
    replacementPassword: string | undefined
  ) {
    if (!currentConfig.password) return;

    const currentOrigin = this.databaseCredentialOrigin(currentConfig);
    const nextOrigin = this.databaseCredentialOrigin(mergedConfig);
    const originChanged = Object.keys(currentOrigin).some((key) => currentOrigin[key] !== nextOrigin[key]);
    if (!originChanged || replacementPassword?.length) return;

    throw new AppError(
      400,
      'CREDENTIAL_REENTRY_REQUIRED',
      'Database connection target changed. Re-enter the database password to avoid reusing saved credentials against a different target.'
    );
  }

  protected normalizePostgres(
    config: Partial<PostgresConnectionConfig> & {
      connectionString?: string;
      database?: string;
      sslEnabled?: boolean;
    }
  ): PostgresConnectionConfig {
    let host = config.host?.trim();
    let port = config.port;
    let database = config.database?.trim();
    let username = config.username?.trim();
    let password = config.password ?? '';
    let sslEnabled = config.sslEnabled ?? false;

    if (config.connectionString) {
      const url = new URL(config.connectionString);
      if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
        throw new AppError(400, 'INVALID_CONNECTION_STRING', 'Invalid Postgres connection string');
      }
      host = host ?? url.hostname;
      port = port ?? Number(url.port || 5432);
      database = database ?? decodeURIComponent(url.pathname.replace(/^\//, ''));
      username = username ?? decodeURIComponent(url.username);
      password = config.password ?? decodeURIComponent(url.password);
      sslEnabled =
        config.sslEnabled ?? ['require', 'verify-full', 'verify-ca'].includes(url.searchParams.get('sslmode') ?? '');
    }

    if (!host || !port || !database || !username) {
      throw new AppError(
        400,
        'INVALID_DATABASE_CONFIG',
        'Postgres connections require host, port, database, username, and password'
      );
    }
    if (password === undefined || password === null) {
      throw new AppError(400, 'INVALID_DATABASE_CONFIG', 'Postgres password is required');
    }

    return {
      type: 'postgres',
      host,
      port,
      database,
      username,
      password,
      sslEnabled,
    };
  }

  protected normalizeRedis(
    config: Partial<RedisConnectionConfig> & {
      connectionString?: string;
      db?: number;
      tlsEnabled?: boolean;
    }
  ): RedisConnectionConfig {
    let host = config.host?.trim();
    let port = config.port;
    let username = config.username?.trim() ?? null;
    let password = config.password ?? '';
    let db = config.db ?? 0;
    let tlsEnabled = config.tlsEnabled ?? false;

    if (config.connectionString) {
      const url = new URL(config.connectionString);
      if (!['redis:', 'rediss:'].includes(url.protocol)) {
        throw new AppError(400, 'INVALID_CONNECTION_STRING', 'Invalid Redis connection string');
      }
      host = host ?? url.hostname;
      port = port ?? Number(url.port || 6379);
      username = config.username ?? (url.username ? decodeURIComponent(url.username) : null);
      password = config.password ?? decodeURIComponent(url.password);
      db = config.db ?? Number(url.pathname.replace(/^\//, '') || 0);
      tlsEnabled = config.tlsEnabled ?? url.protocol === 'rediss:';
    }

    if (!host || !port) {
      throw new AppError(400, 'INVALID_DATABASE_CONFIG', 'Redis connections require host and port');
    }
    if (password === undefined || password === null) {
      throw new AppError(400, 'INVALID_DATABASE_CONFIG', 'Redis password is required');
    }

    return {
      type: 'redis',
      host,
      port,
      username,
      password,
      db,
      tlsEnabled,
    };
  }

  protected async testNormalizedConnection(
    config: DatabaseConnectionConfig
  ): Promise<{ status: DatabaseHealthStatus; responseMs: number }> {
    const started = Date.now();
    if (config.type === 'postgres') {
      const pool = new Pool({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.username,
        password: config.password,
        max: 1,
        idleTimeoutMillis: 5000,
        connectionTimeoutMillis: 10_000,
        ssl: config.sslEnabled ? { rejectUnauthorized: false } : undefined,
      });
      try {
        await pool.query('select 1');
      } catch (error) {
        this.rethrowDatabaseError(error, 'postgres', 'connect');
      } finally {
        await pool.end().catch(() => {});
      }
    } else if (config.type === 'clickhouse') {
      const client = createClickHouseDatabaseClient(config, 1);
      try {
        const result = await client.ping();
        if (!result.success) throw result.error;
      } catch (error) {
        this.rethrowDatabaseError(error, 'clickhouse', 'connect');
      } finally {
        await client.close().catch(() => {});
      }
    } else {
      const client = new Redis({
        host: config.host,
        port: config.port,
        username: config.username ?? undefined,
        password: config.password,
        db: config.db,
        lazyConnect: true,
        connectTimeout: 10_000,
        tls: config.tlsEnabled ? { rejectUnauthorized: false } : undefined,
      });
      try {
        await client.connect();
        await client.ping();
      } catch (error) {
        this.rethrowDatabaseError(error, 'redis', 'connect');
      } finally {
        await client.quit().catch(() => client.disconnect());
      }
    }
    const responseMs = Date.now() - started;
    return { status: responseMs >= 1_000 ? 'degraded' : 'online', responseMs };
  }

  async getPostgresPool(id: string, lane: ManagedDatabaseTunnelLane = 'interactive'): Promise<pg.Pool> {
    const key = this.databaseClientKey(id, lane);
    const existing = this.postgresPools.get(key);
    if (existing) return existing;
    const config = await this.getDecryptedConfig(id, lane);
    if (config.type !== 'postgres') throw new AppError(400, 'INVALID_PROVIDER', 'Database is not Postgres');
    const pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      // Monitoring runs several independent metric queries every three
      // seconds. They do not need parallel backend sessions; keeping this
      // lane at one connection avoids four permanent relay tunnels per
      // managed PostgreSQL database. Interactive workloads retain the wider
      // pool for user-initiated query concurrency.
      max: lane === 'monitoring' ? 1 : 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      ssl: config.sslEnabled ? { rejectUnauthorized: false } : undefined,
    });
    // `pg.Pool` emits an `error` event when an idle client is disconnected.
    // EventEmitter treats that event as fatal when no listener is attached,
    // which must never let a transient managed-database tunnel disconnect
    // terminate the Gateway process. Drop the affected cached pool so the
    // next operation establishes a fresh connection through the tunnel.
    pool.on('error', (error) => {
      logger.debug('Postgres pool connection lost', {
        databaseId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.postgresPools.get(key) === pool) this.postgresPools.delete(key);
      void pool.end().catch(() => {});
    });
    try {
      await pool.query('select 1');
    } catch (error) {
      await pool.end().catch(() => {});
      this.rethrowDatabaseError(error, 'postgres', 'connect');
    }
    this.postgresPools.set(key, pool);
    return pool;
  }

  async getRedisClient(id: string, lane: ManagedDatabaseTunnelLane = 'interactive'): Promise<Redis> {
    const key = this.databaseClientKey(id, lane);
    const existing = this.redisClients.get(key);
    if (existing) return existing;
    const config = await this.getDecryptedConfig(id, lane);
    if (config.type !== 'redis') throw new AppError(400, 'INVALID_PROVIDER', 'Database is not Redis');
    const client = new Redis({
      host: config.host,
      port: config.port,
      username: config.username ?? undefined,
      password: config.password,
      db: config.db,
      lazyConnect: true,
      connectTimeout: 15_000,
      maxRetriesPerRequest: 2,
      tls: config.tlsEnabled ? { rejectUnauthorized: false } : undefined,
    });
    try {
      await client.connect();
    } catch (error) {
      client.disconnect();
      this.rethrowDatabaseError(error, 'redis', 'connect');
    }
    this.redisClients.set(key, client);
    return client;
  }

  async getClickHouseClient(
    id: string,
    lane: ManagedDatabaseTunnelLane = 'interactive',
    queryAccess: SqlQueryAccess = 'admin'
  ): Promise<ClickHouseClient> {
    const key = this.databaseClientKey(id, lane, queryAccess);
    const existing = this.clickHouseClients.get(key);
    if (existing) return existing;
    const config = await this.getDecryptedConfig(id, lane, queryAccess);
    if (config.type !== 'clickhouse') throw new AppError(400, 'INVALID_PROVIDER', 'Database is not ClickHouse');
    const client = createClickHouseDatabaseClient(config, 10);
    try {
      const result = await client.ping();
      if (!result.success) throw result.error;
    } catch (error) {
      await client.close().catch(() => {});
      this.rethrowDatabaseError(error, 'clickhouse', 'connect');
    }
    this.clickHouseClients.set(key, client);
    return client;
  }

  async disposeClient(id: string): Promise<void> {
    if (this.managedTunnelProxy) {
      const [managed] = await this.db
        .select({ id: managedDatabaseInstances.id })
        .from(managedDatabaseInstances)
        .where(eq(managedDatabaseInstances.databaseConnectionId, id))
        .limit(1);
      if (managed) await this.managedTunnelProxy.disposeDatabase(managed.id);
    }
    this.postgresExtensionStates.delete(id);
    const prefix = `${id}:`;
    for (const [key, pool] of this.postgresPools) {
      if (!key.startsWith(prefix)) continue;
      this.postgresPools.delete(key);
      await pool.end().catch(() => {});
    }
    for (const [key, redisClient] of this.redisClients) {
      if (!key.startsWith(prefix)) continue;
      this.redisClients.delete(key);
      await redisClient.quit().catch(() => redisClient.disconnect());
    }
    for (const [key, clickHouseClient] of this.clickHouseClients) {
      if (!key.startsWith(prefix)) continue;
      this.clickHouseClients.delete(key);
      await clickHouseClient.close().catch(() => {});
    }
  }

  protected databaseClientKey(
    id: string,
    lane: ManagedDatabaseTunnelLane,
    queryAccess: SqlQueryAccess = 'admin'
  ): string {
    return `${id}:${lane}:${queryAccess}`;
  }

  protected async withPostgresPool<T>(
    id: string,
    operation: DatabaseOperation,
    run: (pool: pg.Pool) => Promise<T>
  ): Promise<T> {
    const pool = await this.getPostgresPool(id);
    try {
      return await run(pool);
    } catch (error) {
      this.rethrowDatabaseError(error, 'postgres', operation);
    }
  }

  protected async withRedisClient<T>(
    id: string,
    operation: DatabaseOperation,
    run: (client: Redis) => Promise<T>
  ): Promise<T> {
    const client = await this.getRedisClient(id);
    try {
      return await run(client);
    } catch (error) {
      this.rethrowDatabaseError(error, 'redis', operation);
    }
  }

  protected async withClickHouseClient<T>(
    id: string,
    operation: DatabaseOperation,
    run: (client: ClickHouseClient) => Promise<T>,
    queryAccess: SqlQueryAccess = 'admin'
  ): Promise<T> {
    const client = await this.getClickHouseClient(id, 'interactive', queryAccess);
    try {
      return await run(client);
    } catch (error) {
      this.rethrowDatabaseError(error, 'clickhouse', operation);
    }
  }

  protected clickHouseSqlAdapter(queryAccess: SqlQueryAccess): SqlDatabaseAdapter {
    return new ClickHouseSqlAdapter({
      withClient: (id, operation, fn) => this.withClickHouseClient(id, operation, fn, queryAccess),
      auditLog: async (entry) => {
        await this.auditService.log(entry);
      },
      emitChange: (id, action, extra) => this.emitChange(id, action, extra),
    });
  }

  protected async getSqlAdapter(id: string, queryAccess: SqlQueryAccess = 'admin'): Promise<SqlDatabaseAdapter> {
    const config = await this.getDecryptedConfig(id, 'interactive', queryAccess);
    if (config.type === 'redis') {
      throw new AppError(400, 'INVALID_PROVIDER', 'Database does not support SQL operations');
    }
    if (config.type === 'clickhouse') {
      return queryAccess === 'admin' ? this.sqlAdapters.get('clickhouse')! : this.clickHouseSqlAdapter(queryAccess);
    }
    return this.sqlAdapters.get(config.type)!;
  }

  protected rethrowDatabaseError(error: unknown, provider: DatabaseType, operation: DatabaseOperation): never {
    const mapped = mapDatabaseDriverError(error, provider, operation);
    if (mapped) throw mapped;
    throw error;
  }

  protected trimHealthHistory(history: DatabaseHealthEntry[]): DatabaseHealthEntry[] {
    return compactHealthHistory(history);
  }
}
