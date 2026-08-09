import type { ClickHouseClient } from '@clickhouse/client';
import { asc, count, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import Redis from 'ioredis';
import pg from 'pg';
import type { DrizzleClient } from '@/db/client.js';
import { type DatabaseHealthEntry, databaseConnections, managedDatabaseInstances, nodes } from '@/db/schema/index.js';
import type { ManagedDatabaseTunnelLane } from '@/grpc/services/database-tunnel.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { createChildLogger } from '@/lib/logger.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { getEffectiveNodeServiceAddress, getEffectivePublishedNodeIP } from '@/modules/nodes/node-service-address.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { PaginatedResponse } from '@/types.js';
import { createClickHouseDatabaseClient, normalizeClickHouseConnection } from './clickhouse-connection.js';
import { ClickHouseSqlAdapter } from './clickhouse-sql-adapter.js';
import {
  buildDatabaseConnectionString,
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
  executeRedisCommand as executeRedisCommandOperation,
} from './database-query-execution.js';
import { inferPostgresIntent } from './database-query-intent.js';
import type {
  CreateDatabaseConnectionInput,
  DatabaseListQuery,
  UpdateDatabaseConnectionInput,
} from './databases.schemas.js';
import type { ManagedDatabaseTunnelProxy } from './managed-database-tunnel-proxy.js';
import {
  ensurePostgresBaseTable,
  normalizePostgresColumnType,
  postgresColumnTypeSql,
} from './postgres-column-operations.js';
import {
  deletePostgresRow as deletePostgresRowOperation,
  insertPostgresRow as insertPostgresRowOperation,
  type PostgresRowOperationContext,
  updatePostgresRow as updatePostgresRowOperation,
} from './postgres-row-operations.js';
import { quoteIdent } from './postgres-row-sql.js';
import {
  getPostgresTableMetadata as getPostgresTableMetadataOperation,
  listPostgresSchemas as listPostgresSchemasOperation,
  listPostgresTables as listPostgresTablesOperation,
  type PostgresSchemaOperationContext,
} from './postgres-schema-operations.js';
import { PostgresSqlAdapter } from './postgres-sql-adapter.js';
import {
  getRedisKey as getRedisKeyOperation,
  type RedisKeyValueType,
  scanRedisKeys as scanRedisKeysOperation,
  setRedisKey as setRedisKeyOperation,
} from './redis-key-operations.js';
import type { SqlDatabaseAdapter } from './sql-database-adapter.js';

const { Pool } = pg;
const DATABASE_HEALTH_HISTORY_MIN_INTERVAL_MS = 30_000;
const MANAGED_CLICKHOUSE_QUERY_PRINCIPAL_VERSION = 1;
const logger = createChildLogger('DatabaseConnectionService');

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

type PostgresRowSearchOperation = 'like' | 'equals' | 'notEquals' | 'greaterThan' | 'lessThan';
export type SqlQueryAccess = 'read' | 'write' | 'admin';

interface PostgresRowSearchFilter {
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

interface PostgresExtensionRow {
  name: string;
  default_version: string;
  comment: string | null;
}

interface InstalledPostgresExtensionRow {
  name: string;
  installed_version: string;
}

type ManagedPostgresExtensionDefinition = Omit<ManagedPostgresExtension, 'installedVersion'>;

interface ManagedPostgresExtensionContext {
  imageRef: string;
}

interface ManagedPostgresExtensionStateCacheEntry {
  expiresAt: number;
  value: Promise<ManagedPostgresExtension[]>;
}

const POSTGRES_EXTENSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const POSTGRES_EXTENSIONS_EXCLUDED_FROM_MANAGER = new Set(['pg_stat_statements', 'plpgsql']);
const MANAGED_POSTGRES_EXTENSION_STATE_CACHE_TTL_MS = 30_000;

function normalizePostgresExtensionName(value: string): string {
  const name = value.trim();
  if (!POSTGRES_EXTENSION_NAME_PATTERN.test(name)) {
    throw new AppError(400, 'INVALID_POSTGRES_EXTENSION', 'Invalid PostgreSQL extension name');
  }
  return name;
}

function quotePostgresExtensionName(name: string): string {
  return `"${normalizePostgresExtensionName(name)}"`;
}

function toManagedPostgresExtensionDefinition(row: PostgresExtensionRow): ManagedPostgresExtensionDefinition {
  return {
    name: row.name,
    defaultVersion: row.default_version,
    comment: row.comment,
  };
}

export { inferClickHouseIntent, inferPostgresIntent, inferRedisIntent } from './database-query-intent.js';

export class DatabaseConnectionService {
  private eventBus?: EventBusService;
  private readonly postgresPools = new Map<string, pg.Pool>();
  private readonly postgresExtensionCatalogs = new Map<string, Promise<ManagedPostgresExtensionDefinition[]>>();
  private readonly postgresExtensionStates = new Map<string, ManagedPostgresExtensionStateCacheEntry>();
  private readonly redisClients = new Map<string, Redis>();
  private readonly clickHouseClients = new Map<string, ClickHouseClient>();
  private readonly sqlAdapters: Map<'postgres' | 'clickhouse', SqlDatabaseAdapter>;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly cryptoService: CryptoService,
    private readonly managedTunnelProxy?: ManagedDatabaseTunnelProxy
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

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  private queryExecutionContext(): DatabaseQueryExecutionContext {
    return {
      withPostgresPool: (id, operation, fn) => this.withPostgresPool(id, operation, fn),
      withRedisClient: (id, operation, fn) => this.withRedisClient(id, operation, fn),
      auditLog: async (entry) => {
        await this.auditService.log(entry);
      },
      emitChange: (id, action, extra) => this.emitChange(id, action, extra),
    };
  }

  private postgresRowOperationContext(): PostgresRowOperationContext {
    return {
      withPostgresPool: (id, operation, fn) => this.withPostgresPool(id, operation, fn),
      getPostgresTableMetadata: (id, schema, table) => this.getPostgresTableMetadata(id, schema, table),
      auditLog: (entry, options) => this.auditService.log(entry, options),
      emitChange: (id, action, extra) => this.emitChange(id, action, extra),
    };
  }

  private postgresSchemaOperationContext(): PostgresSchemaOperationContext {
    return {
      withPostgresPool: (id, operation, fn) => this.withPostgresPool(id, operation, fn),
    };
  }

  async getSqlCapabilities(id: string, access: SqlQueryAccess = 'admin') {
    return (await this.getSqlAdapter(id, access)).capabilities;
  }

  async inferSqlIntent(id: string, sql: string) {
    return (await this.getSqlAdapter(id)).inferIntent(sql);
  }

  async listSqlNamespaces(id: string, access: SqlQueryAccess = 'admin') {
    return (await this.getSqlAdapter(id, access)).listNamespaces(id);
  }

  async listSqlObjects(id: string, namespace: string, access: SqlQueryAccess = 'admin') {
    return (await this.getSqlAdapter(id, access)).listObjects(id, namespace);
  }

  async getSqlTableMetadata(id: string, namespace: string, table: string, access: SqlQueryAccess = 'admin') {
    return (await this.getSqlAdapter(id, access)).getTableMetadata(id, namespace, table);
  }

  async browseSqlRows(
    id: string,
    namespace: string,
    table: string,
    page: number,
    limit: number,
    options?: {
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      search?: PostgresRowSearchFilter;
    },
    access: SqlQueryAccess = 'admin'
  ) {
    return (await this.getSqlAdapter(id, access)).browseRows(id, namespace, table, page, limit, options);
  }

  async executeSql(
    id: string,
    sql: string,
    userId: string,
    options: { maxRows?: number } = {},
    access: SqlQueryAccess = 'admin'
  ) {
    return (await this.getSqlAdapter(id, access)).executeSql(id, sql, userId, options);
  }

  async insertSqlRow(
    id: string,
    namespace: string,
    table: string,
    values: Record<string, unknown>,
    userId: string,
    access: SqlQueryAccess = 'admin'
  ) {
    return (await this.getSqlAdapter(id, access)).insertRow(id, namespace, table, values, userId);
  }

  async updateSqlRow(
    id: string,
    namespace: string,
    table: string,
    locator: Record<string, unknown>,
    values: Record<string, unknown>,
    userId: string,
    access: SqlQueryAccess = 'admin'
  ) {
    return (await this.getSqlAdapter(id, access)).updateRow(id, namespace, table, locator, values, userId);
  }

  async deleteSqlRow(
    id: string,
    namespace: string,
    table: string,
    locator: Record<string, unknown>,
    userId: string,
    access: SqlQueryAccess = 'admin'
  ) {
    return (await this.getSqlAdapter(id, access)).deleteRow(id, namespace, table, locator, userId);
  }

  async list(
    query: DatabaseListQuery,
    options?: {
      allowedIds?: string[];
    }
  ): Promise<PaginatedResponse<DatabaseConnectionView>> {
    const conditions: (SQL | undefined)[] = [];
    if (options?.allowedIds) {
      if (options.allowedIds.length === 0) {
        return {
          data: [],
          pagination: {
            page: query.page,
            limit: query.limit,
            total: 0,
            totalPages: 0,
          },
        };
      }
      conditions.push(inArray(databaseConnections.id, options.allowedIds));
    }
    if (query.search) {
      conditions.push(
        or(
          ilike(databaseConnections.name, `%${query.search}%`),
          ilike(databaseConnections.host, `%${query.search}%`),
          ilike(databaseConnections.databaseName, `%${query.search}%`)
        )
      );
    }
    if (query.type) conditions.push(eq(databaseConnections.type, query.type));
    if (query.healthStatus) conditions.push(eq(databaseConnections.healthStatus, query.healthStatus));

    const where = buildWhere(conditions);
    const [rows, [{ count: totalCount }]] = await Promise.all([
      this.db
        .select()
        .from(databaseConnections)
        .where(where)
        .orderBy(asc(databaseConnections.sortOrder), asc(databaseConnections.name), asc(databaseConnections.id))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
      this.db.select({ count: count() }).from(databaseConnections).where(where),
    ]);

    const data = await Promise.all(rows.map((row) => this.toView(row, false, false)));
    const total = Number(totalCount);
    return {
      data,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async get(id: string, revealCredentials = false): Promise<DatabaseConnectionView> {
    const row = await this.getRow(id);
    return this.toView(row, revealCredentials, false);
  }

  async getBySlug(slug: string): Promise<DatabaseConnectionView> {
    const row = await this.db.query.databaseConnections.findFirst({
      where: eq(databaseConnections.slug, slug),
    });
    if (!row) throw new AppError(404, 'DATABASE_NOT_FOUND', 'Database connection not found');
    return this.toView(row, false, false);
  }

  async getHealthHistory(id: string): Promise<DatabaseHealthEntry[]> {
    const row = await this.getRow(id);
    return (row.healthHistory as DatabaseHealthEntry[] | null) ?? [];
  }

  async revealCredentials(id: string): Promise<Record<string, unknown>> {
    const row = await this.getRow(id);
    const config = this.decryptConfig(row.encryptedConfig);
    const managed = await this.getManagedMetadata(id);
    if (managed) {
      // Managed rows used to retain the database owner in this canonical
      // connection. It is an internal control-plane credential and must never
      // escape through the generic connection endpoint. Consumers must use the
      // managed route, which returns only the separately generated direct
      // access principal and only after TCP publication.
      throw new AppError(
        409,
        'MANAGED_DATABASE_CREDENTIALS_REQUIRE_DIRECT_ACCESS',
        'Use the managed database credential endpoint after publishing a TCP port'
      );
    }
    return {
      ...config,
      connectionString: buildDatabaseConnectionString(config),
    };
  }

  async create(input: CreateDatabaseConnectionInput, userId: string): Promise<DatabaseConnectionView> {
    const normalized =
      input.type === 'postgres'
        ? this.normalizePostgres(input.config)
        : input.type === 'clickhouse'
          ? normalizeClickHouseConnection(input.config)
          : this.normalizeRedis(input.config);
    const testResult = await this.testNormalizedConnection(normalized);
    const encryptedConfig = this.encryptConfig(normalized);
    const row = await writeWithAllocatedSlug({
      source: input.name,
      fallback: 'database',
      constraint: 'database_connections_slug_unique',
      write: async (slug) => {
        const [created] = await this.db
          .insert(databaseConnections)
          .values({
            name: input.name,
            slug,
            type: input.type,
            description: input.description ?? null,
            tags: input.tags ?? [],
            manualSizeLimitMb: input.type === 'postgres' ? (input.manualSizeLimitMb ?? null) : null,
            host: normalized.host,
            port: normalized.port,
            databaseName: normalized.type === 'redis' ? `db${normalized.db}` : normalized.database,
            username: normalized.username ?? null,
            tlsEnabled: normalized.type === 'postgres' ? normalized.sslEnabled : normalized.tlsEnabled,
            encryptedConfig,
            healthStatus: testResult.status,
            lastHealthCheckAt: new Date(),
            lastError: null,
            healthHistory: [
              {
                ts: new Date().toISOString(),
                status: testResult.status,
                responseMs: testResult.responseMs,
                slow: testResult.status === 'degraded',
              },
            ],
            createdById: userId,
            updatedById: userId,
          })
          .returning();
        return created;
      },
    });

    await this.auditService.log({
      userId,
      action: 'database.connection.create',
      resourceType: 'database',
      resourceId: row.id,
      details: { name: row.name, type: row.type, host: row.host, port: row.port },
    });
    this.emitChange(row.id, 'created', { name: row.name, type: row.type, healthStatus: row.healthStatus });
    return toDatabaseConnectionView(row, normalized, false, false);
  }

  async update(id: string, input: UpdateDatabaseConnectionInput, userId: string): Promise<DatabaseConnectionView> {
    const existing = await this.getRow(id);
    if (await this.getManagedMetadata(id)) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_SETTINGS',
        'Managed database connection settings must be updated through its managed configuration'
      );
    }
    const currentConfig = this.decryptConfig(existing.encryptedConfig);
    const replacementPassword = this.extractReplacementPassword(input.config);
    const nextPassword = replacementPassword !== undefined ? replacementPassword : currentConfig.password;
    const inputConfig = input.config ?? {};
    const mergedConfig =
      currentConfig.type === 'postgres'
        ? this.normalizePostgres(
            inputConfig.connectionString
              ? {
                  ...inputConfig,
                  password: nextPassword,
                }
              : {
                  host: currentConfig.host,
                  port: currentConfig.port,
                  database: currentConfig.database,
                  username: currentConfig.username,
                  sslEnabled: currentConfig.sslEnabled,
                  ...inputConfig,
                  password: nextPassword,
                }
          )
        : currentConfig.type === 'clickhouse'
          ? normalizeClickHouseConnection(
              inputConfig.connectionString || inputConfig.url
                ? {
                    ...inputConfig,
                    password: nextPassword,
                  }
                : {
                    url: currentConfig.url,
                    database: currentConfig.database,
                    username: currentConfig.username,
                    ...inputConfig,
                    password: nextPassword,
                  }
            )
          : this.normalizeRedis(
              inputConfig.connectionString
                ? {
                    ...inputConfig,
                    password: nextPassword,
                  }
                : {
                    host: currentConfig.host,
                    port: currentConfig.port,
                    username: currentConfig.username ?? undefined,
                    db: currentConfig.db,
                    tlsEnabled: currentConfig.tlsEnabled,
                    ...inputConfig,
                    password: nextPassword,
                  }
            );

    this.assertOriginChangeHasReplacementPassword(currentConfig, mergedConfig, replacementPassword);

    const connectionFieldsChanged = JSON.stringify(currentConfig) !== JSON.stringify(mergedConfig);
    let statusUpdate: Partial<typeof databaseConnections.$inferInsert> = {};
    if (connectionFieldsChanged) {
      const testResult = await this.testNormalizedConnection(mergedConfig);
      statusUpdate = {
        healthStatus: testResult.status,
        lastHealthCheckAt: new Date(),
        lastError: null,
      };
    }

    const updateData = {
      name: input.name ?? existing.name,
      description: input.description === undefined ? existing.description : (input.description ?? null),
      tags: input.tags ?? (existing.tags as string[]),
      manualSizeLimitMb:
        existing.type === 'postgres'
          ? input.manualSizeLimitMb === undefined
            ? existing.manualSizeLimitMb
            : (input.manualSizeLimitMb ?? null)
          : null,
      host: mergedConfig.host,
      port: mergedConfig.port,
      databaseName: mergedConfig.type === 'redis' ? `db${mergedConfig.db}` : mergedConfig.database,
      username: mergedConfig.username ?? null,
      tlsEnabled: mergedConfig.type === 'postgres' ? mergedConfig.sslEnabled : mergedConfig.tlsEnabled,
      encryptedConfig: this.encryptConfig(mergedConfig),
      updatedById: userId,
      updatedAt: new Date(),
      ...statusUpdate,
    };
    const updateConnection = async (slug?: string) => {
      const [updated] = await this.db
        .update(databaseConnections)
        .set({ ...updateData, ...(slug === undefined ? {} : { slug }) })
        .where(eq(databaseConnections.id, id))
        .returning();
      return updated;
    };
    const row =
      input.name !== undefined && input.name !== existing.name
        ? await writeWithAllocatedSlug({
            source: input.name,
            fallback: 'database',
            constraint: 'database_connections_slug_unique',
            write: updateConnection,
          })
        : await updateConnection();

    this.disposeClient(id).catch(() => {});

    await this.auditService.log({
      userId,
      action: 'database.connection.update',
      resourceType: 'database',
      resourceId: id,
      details: {
        name: row.name,
        type: row.type,
        connectionChanged: connectionFieldsChanged,
        fields: Object.keys(input),
      },
    });
    this.emitChange(id, 'updated', {
      name: row.name,
      type: row.type,
      healthStatus: row.healthStatus,
      ...(row.slug === existing.slug ? {} : { oldSlug: existing.slug, slug: row.slug }),
    });
    return this.toView(row, false, false);
  }

  async delete(id: string, userId: string): Promise<void> {
    const existing = await this.getRow(id);
    await this.db.delete(databaseConnections).where(eq(databaseConnections.id, id));
    await this.disposeClient(id);

    await this.auditService.log({
      userId,
      action: 'database.connection.delete',
      resourceType: 'database',
      resourceId: id,
      details: { name: existing.name, type: existing.type, host: existing.host, port: existing.port },
    });
    this.emitChange(id, 'deleted', { name: existing.name, type: existing.type });
  }

  async testSavedConnection(
    id: string,
    userId: string
  ): Promise<{ ok: true; responseMs: number; status: DatabaseHealthStatus }> {
    const row = await this.getRow(id);
    const config = await this.getDecryptedConfig(id);
    let result: { status: DatabaseHealthStatus; responseMs: number };
    try {
      result = await this.testNormalizedConnection(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Database connection test failed';
      await this.updateHealth(id, {
        status: 'offline',
        lastError: message,
        forceHistory: true,
      }).catch(() => {});
      throw error;
    }
    const history = this.trimHealthHistory([
      ...((row.healthHistory as DatabaseHealthEntry[] | null) ?? []),
      {
        ts: new Date().toISOString(),
        status: result.status,
        responseMs: result.responseMs,
        slow: result.status === 'degraded',
      },
    ]);
    await this.db
      .update(databaseConnections)
      .set({
        healthStatus: result.status,
        lastHealthCheckAt: new Date(),
        lastError: null,
        healthHistory: history,
        updatedAt: new Date(),
      })
      .where(eq(databaseConnections.id, id));

    await this.auditService.log({
      userId,
      action: 'database.connection.test',
      resourceType: 'database',
      resourceId: id,
      details: { name: row.name, type: row.type, responseMs: result.responseMs, status: result.status },
    });
    this.emitChange(id, 'tested', {
      name: row.name,
      type: row.type,
      healthStatus: result.status,
      responseMs: result.responseMs,
    });
    return { ok: true, responseMs: result.responseMs, status: result.status };
  }

  async listPostgresSchemas(id: string) {
    return listPostgresSchemasOperation(this.postgresSchemaOperationContext(), id);
  }

  async listManagedPostgresExtensions(id: string): Promise<ManagedPostgresExtension[]> {
    return this.loadManagedPostgresExtensionState(id);
  }

  async warmManagedPostgresExtensionCatalog(id: string): Promise<void> {
    await this.loadManagedPostgresExtensionState(id);
  }

  async enableManagedPostgresExtension(
    id: string,
    rawName: string,
    userId: string
  ): Promise<ManagedPostgresExtension[]> {
    const context = await this.getManagedPostgresExtensionContext(id);
    const name = normalizePostgresExtensionName(rawName);
    return this.withPostgresPool(id, 'query', async (pool) => {
      const extension = await this.getManagedPostgresExtension(pool, context, name);
      if (!extension) {
        throw new AppError(
          404,
          'POSTGRES_EXTENSION_NOT_AVAILABLE',
          'PostgreSQL extension is not available in this image'
        );
      }
      if (!extension.installedVersion) {
        await pool.query(`create extension if not exists ${quotePostgresExtensionName(name)}`);
        await this.auditService.log({
          userId,
          action: 'database.postgres.extension.enable',
          resourceType: 'database',
          resourceId: id,
          details: { name, version: extension.defaultVersion },
        });
        this.emitChange(id, 'extensions.updated', { provider: 'postgres', name, enabled: true });
      }

      return this.refreshManagedPostgresExtensionState(id, pool, context);
    });
  }

  async disableManagedPostgresExtension(
    id: string,
    rawName: string,
    userId: string
  ): Promise<ManagedPostgresExtension[]> {
    const context = await this.getManagedPostgresExtensionContext(id);
    const name = normalizePostgresExtensionName(rawName);
    return this.withPostgresPool(id, 'query', async (pool) => {
      const extension = await this.getManagedPostgresExtension(pool, context, name);
      if (!extension) {
        throw new AppError(
          404,
          'POSTGRES_EXTENSION_NOT_AVAILABLE',
          'PostgreSQL extension is not available in this image'
        );
      }
      if (extension.installedVersion) {
        try {
          await pool.query(`drop extension ${quotePostgresExtensionName(name)}`);
        } catch (error) {
          if ((error as { code?: string }).code === '2BP01') {
            throw new AppError(
              409,
              'POSTGRES_EXTENSION_HAS_DEPENDENCIES',
              `Cannot disable ${name} while database objects depend on it`
            );
          }
          throw error;
        }
        await this.auditService.log({
          userId,
          action: 'database.postgres.extension.disable',
          resourceType: 'database',
          resourceId: id,
          details: { name, version: extension.installedVersion },
        });
        this.emitChange(id, 'extensions.updated', { provider: 'postgres', name, enabled: false });
      }

      return this.refreshManagedPostgresExtensionState(id, pool, context);
    });
  }

  async listPostgresTables(id: string, schema: string) {
    return listPostgresTablesOperation(this.postgresSchemaOperationContext(), id, schema);
  }

  async getPostgresTableMetadata(id: string, schema: string, table: string) {
    return getPostgresTableMetadataOperation(this.postgresSchemaOperationContext(), id, schema, table);
  }

  async browsePostgresRows(
    id: string,
    schema: string,
    table: string,
    page: number,
    limit: number,
    sortBy?: string,
    sortOrder: 'asc' | 'desc' = 'asc',
    search?: PostgresRowSearchFilter
  ) {
    return this.withPostgresPool(id, 'query', async (pool) => {
      const metadata = await this.getPostgresTableMetadata(id, schema, table);
      const schemaSql = quoteIdent(schema);
      const tableSql = quoteIdent(table);
      const validColumns = new Set(metadata.columns.map((column) => column.name));
      const orderColumn =
        sortBy && validColumns.has(sortBy) ? sortBy : (metadata.primaryKey[0] ?? metadata.columns[0]?.name);
      const orderSql = orderColumn
        ? `order by ${quoteIdent(orderColumn)} ${sortOrder === 'desc' ? 'desc' : 'asc'}`
        : '';
      const filterColumn = search?.column && validColumns.has(search.column) ? search.column : undefined;
      const params: unknown[] = [];
      let whereSql = '';
      if (filterColumn && search?.value) {
        const columnSql = quoteIdent(filterColumn);
        params.push(search.operation === 'like' ? `%${search.value}%` : search.value);
        const paramSql = `$${params.length}`;
        const expressionByOperation: Record<PostgresRowSearchOperation, string> = {
          like: `${columnSql}::text ilike ${paramSql}`,
          equals: `${columnSql} = ${paramSql}`,
          notEquals: `${columnSql} <> ${paramSql}`,
          greaterThan: `${columnSql} > ${paramSql}`,
          lessThan: `${columnSql} < ${paramSql}`,
        };
        whereSql = `where ${expressionByOperation[search.operation]}`;
      }
      params.push(limit, (page - 1) * limit);
      const limitParam = `$${params.length - 1}`;
      const offsetParam = `$${params.length}`;
      const [countResult, rowsResult] = await Promise.all([
        pool.query<{ total: string }>(`select count(*)::text as total from ${schemaSql}.${tableSql} ${whereSql}`, [
          ...params.slice(0, -2),
        ]),
        pool.query(
          `select * from ${schemaSql}.${tableSql} ${whereSql} ${orderSql} limit ${limitParam} offset ${offsetParam}`,
          params
        ),
      ]);
      return {
        metadata,
        rows: rowsResult.rows,
        total: Number(countResult.rows[0]?.total ?? 0),
        page,
        limit,
      };
    });
  }

  async insertPostgresRow(id: string, schema: string, table: string, values: Record<string, unknown>, userId: string) {
    return insertPostgresRowOperation(this.postgresRowOperationContext(), id, schema, table, values, userId);
  }

  async updatePostgresRow(
    id: string,
    schema: string,
    table: string,
    primaryKey: Record<string, unknown>,
    values: Record<string, unknown>,
    userId: string
  ) {
    return updatePostgresRowOperation(
      this.postgresRowOperationContext(),
      id,
      schema,
      table,
      primaryKey,
      values,
      userId
    );
  }

  async deletePostgresRow(
    id: string,
    schema: string,
    table: string,
    primaryKey: Record<string, unknown>,
    userId: string
  ) {
    return deletePostgresRowOperation(this.postgresRowOperationContext(), id, schema, table, primaryKey, userId);
  }

  async updatePostgresColumnType(
    id: string,
    schema: string,
    table: string,
    column: string,
    dataType: string,
    userId: string
  ) {
    return this.withPostgresPool(id, 'query', async (pool) => {
      const normalizedType = normalizePostgresColumnType(dataType);
      const typeSql = postgresColumnTypeSql(normalizedType);
      if (!typeSql) {
        throw new AppError(400, 'INVALID_COLUMN_TYPE', 'Unsupported PostgreSQL column data type');
      }

      await ensurePostgresBaseTable(pool, schema, table);
      const metadata = await this.getPostgresTableMetadata(id, schema, table);
      const targetColumn = metadata.columns.find((candidate) => candidate.name === column);
      if (!targetColumn) {
        throw new AppError(404, 'COLUMN_NOT_FOUND', 'Column not found');
      }

      await pool.query(
        `alter table ${quoteIdent(schema)}.${quoteIdent(table)}
           alter column ${quoteIdent(column)}
           type ${typeSql}
           using ${quoteIdent(column)}::${typeSql}`
      );
      await this.auditService.log({
        userId,
        action: 'database.postgres.column.type.update',
        resourceType: 'database',
        resourceId: id,
        details: { schema, table, column, from: targetColumn.dataType, to: normalizedType },
      });
      this.emitChange(id, 'schema.updated', { provider: 'postgres', schema, table, column });
      return this.getPostgresTableMetadata(id, schema, table);
    });
  }

  async addPostgresColumn(id: string, schema: string, table: string, column: string, dataType: string, userId: string) {
    return this.withPostgresPool(id, 'query', async (pool) => {
      const normalizedType = normalizePostgresColumnType(dataType);
      const typeSql = postgresColumnTypeSql(normalizedType);
      if (!typeSql) {
        throw new AppError(400, 'INVALID_COLUMN_TYPE', 'Unsupported PostgreSQL column data type');
      }

      await ensurePostgresBaseTable(pool, schema, table);
      await pool.query(
        `alter table ${quoteIdent(schema)}.${quoteIdent(table)} add column ${quoteIdent(column)} ${typeSql}`
      );
      await this.auditService.log({
        userId,
        action: 'database.postgres.column.add',
        resourceType: 'database',
        resourceId: id,
        details: { schema, table, column, dataType: normalizedType },
      });
      this.emitChange(id, 'schema.updated', { provider: 'postgres', schema, table, column });
      return this.getPostgresTableMetadata(id, schema, table);
    });
  }

  async deletePostgresColumn(id: string, schema: string, table: string, column: string, userId: string) {
    return this.withPostgresPool(id, 'query', async (pool) => {
      await ensurePostgresBaseTable(pool, schema, table);
      const metadata = await this.getPostgresTableMetadata(id, schema, table);
      const targetColumn = metadata.columns.find((candidate) => candidate.name === column);
      if (!targetColumn) {
        throw new AppError(404, 'COLUMN_NOT_FOUND', 'Column not found');
      }

      await pool.query(`alter table ${quoteIdent(schema)}.${quoteIdent(table)} drop column ${quoteIdent(column)}`);
      await this.auditService.log({
        userId,
        action: 'database.postgres.column.delete',
        resourceType: 'database',
        resourceId: id,
        details: { schema, table, column, dataType: targetColumn.dataType },
      });
      this.emitChange(id, 'schema.updated', { provider: 'postgres', schema, table, column });
      return this.getPostgresTableMetadata(id, schema, table);
    });
  }

  async executePostgresSql(id: string, sqlText: string, userId: string, options: { maxRows?: number } = {}) {
    return executePostgresSqlOperation(this.queryExecutionContext(), id, sqlText, userId, options);
  }

  async scanRedisKeys(id: string, cursor: number, limit: number, search?: string, type?: string) {
    return this.withRedisClient(id, 'query', (client) => scanRedisKeysOperation(client, cursor, limit, search, type));
  }

  async getRedisKey(
    id: string,
    key: string,
    options: { offset?: number; limit?: number; maxStringBytes?: number } = {}
  ) {
    return this.withRedisClient(id, 'query', (client) => getRedisKeyOperation(client, key, options));
  }

  async setRedisKey(
    id: string,
    key: string,
    valueType: RedisKeyValueType,
    value: unknown,
    ttlSeconds: number | undefined,
    userId: string
  ) {
    return this.withRedisClient(id, 'query', async (client) => {
      await setRedisKeyOperation(client, key, valueType, value, ttlSeconds);
      await this.auditService.log({
        userId,
        action: 'database.redis.key.set',
        resourceType: 'database',
        resourceId: id,
        details: { key, type: valueType, ttlSeconds },
      });
      this.emitChange(id, 'data.updated', { provider: 'redis', key, intent: 'write' });
      return this.getRedisKey(id, key);
    });
  }

  async deleteRedisKey(id: string, key: string, userId: string) {
    return this.withRedisClient(id, 'query', async (client) => {
      await client.del(key);
      await this.auditService.log({
        userId,
        action: 'database.redis.key.delete',
        resourceType: 'database',
        resourceId: id,
        details: { key },
      });
      this.emitChange(id, 'data.updated', { provider: 'redis', key, intent: 'write' });
      return { success: true };
    });
  }

  async expireRedisKey(id: string, key: string, ttlSeconds: number, userId: string) {
    return this.withRedisClient(id, 'query', async (client) => {
      if (ttlSeconds < 0) {
        await client.persist(key);
      } else {
        await client.expire(key, ttlSeconds);
      }
      await this.auditService.log({
        userId,
        action: 'database.redis.key.expire',
        resourceType: 'database',
        resourceId: id,
        details: { key, ttlSeconds },
      });
      this.emitChange(id, 'data.updated', { provider: 'redis', key, intent: 'write' });
      return this.getRedisKey(id, key);
    });
  }

  async executeRedisCommand(id: string, commandText: string, userId: string) {
    return executeRedisCommandOperation(this.queryExecutionContext(), id, commandText, userId);
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

  private async getRow(id: string) {
    const row = await this.db.query.databaseConnections.findFirst({
      where: eq(databaseConnections.id, id),
    });
    if (!row) throw new AppError(404, 'DATABASE_NOT_FOUND', 'Database connection not found');
    return row;
  }

  private async getManagedPostgresExtensionContext(id: string): Promise<ManagedPostgresExtensionContext> {
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

  private async readManagedPostgresExtensionsWithPool(
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

  private async refreshManagedPostgresExtensionState(
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

  private async loadManagedPostgresExtensionState(id: string): Promise<ManagedPostgresExtension[]> {
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

  private getCachedManagedPostgresExtensionState(id: string): Promise<ManagedPostgresExtension[]> | null {
    const cached = this.postgresExtensionStates.get(id);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.postgresExtensionStates.delete(id);
      return null;
    }
    return cached.value;
  }

  private async getManagedPostgresExtensionCatalog(
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

  private async getManagedPostgresExtension(
    pool: pg.Pool,
    context: ManagedPostgresExtensionContext,
    name: string
  ): Promise<ManagedPostgresExtension | undefined> {
    const extensions = await this.readManagedPostgresExtensionsWithPool(pool, context);
    return extensions.find((extension) => extension.name === name);
  }

  private async toView(
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

  private async getManagedMetadata(
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
                serviceAddress: managed.serviceAddress,
                lastHealthReport: managed.lastHealthReport,
              })
            : getEffectiveNodeServiceAddress({
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

  private async getManagedClickHouseQueryPrincipal(
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

  private emitChange(id: string, action: string, extra: Record<string, unknown> = {}) {
    this.eventBus?.publish('database.changed', { id, action, ...extra });
  }

  private encryptConfig(config: DatabaseConnectionConfig): string {
    return JSON.stringify(this.cryptoService.encryptString(JSON.stringify(config)));
  }

  private decryptConfig(encryptedConfig: string): DatabaseConnectionConfig {
    const parsed = JSON.parse(encryptedConfig) as { encryptedKey: string; encryptedDek: string };
    return JSON.parse(this.cryptoService.decryptString(parsed)) as DatabaseConnectionConfig;
  }

  private extractReplacementPassword(inputConfig: UpdateDatabaseConnectionInput['config']): string | undefined {
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

  private databaseCredentialOrigin(config: DatabaseConnectionConfig): Record<string, string | number | boolean | null> {
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

  private assertOriginChangeHasReplacementPassword(
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

  private normalizePostgres(
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

  private normalizeRedis(
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

  private async testNormalizedConnection(
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
      max: 10,
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

  private databaseClientKey(
    id: string,
    lane: ManagedDatabaseTunnelLane,
    queryAccess: SqlQueryAccess = 'admin'
  ): string {
    return `${id}:${lane}:${queryAccess}`;
  }

  private async withPostgresPool<T>(
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

  private async withRedisClient<T>(
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

  private async withClickHouseClient<T>(
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

  private clickHouseSqlAdapter(queryAccess: SqlQueryAccess): SqlDatabaseAdapter {
    return new ClickHouseSqlAdapter({
      withClient: (id, operation, fn) => this.withClickHouseClient(id, operation, fn, queryAccess),
      auditLog: async (entry) => {
        await this.auditService.log(entry);
      },
      emitChange: (id, action, extra) => this.emitChange(id, action, extra),
    });
  }

  private async getSqlAdapter(id: string, queryAccess: SqlQueryAccess = 'admin'): Promise<SqlDatabaseAdapter> {
    const config = await this.getDecryptedConfig(id, 'interactive', queryAccess);
    if (config.type === 'redis') {
      throw new AppError(400, 'INVALID_PROVIDER', 'Database does not support SQL operations');
    }
    if (config.type === 'clickhouse') {
      return queryAccess === 'admin' ? this.sqlAdapters.get('clickhouse')! : this.clickHouseSqlAdapter(queryAccess);
    }
    return this.sqlAdapters.get(config.type)!;
  }

  private rethrowDatabaseError(error: unknown, provider: DatabaseType, operation: DatabaseOperation): never {
    const mapped = mapDatabaseDriverError(error, provider, operation);
    if (mapped) throw mapped;
    throw error;
  }

  private trimHealthHistory(history: DatabaseHealthEntry[]): DatabaseHealthEntry[] {
    return compactHealthHistory(history);
  }
}
