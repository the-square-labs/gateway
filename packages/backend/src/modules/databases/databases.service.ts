import { asc, count, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import { type DatabaseHealthEntry, databaseConnections } from '@/db/schema/index.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { PaginatedResponse } from '@/types.js';
import { normalizeClickHouseConnection } from './clickhouse-connection.js';
import {
  buildDatabaseConnectionString,
  type DatabaseConnectionView,
  type DatabaseHealthStatus,
  toDatabaseConnectionView,
} from './database-connection-view.js';
import {
  executePostgresSql as executePostgresSqlOperation,
  executeRedisCommand as executeRedisCommandOperation,
} from './database-query-execution.js';
import type {
  CreateDatabaseConnectionInput,
  DatabaseListQuery,
  UpdateDatabaseConnectionInput,
} from './databases.schemas.js';
import { DatabaseConnectionServiceRuntime } from './databases.service.runtime.js';
import {
  INTERACTIVE_QUERY_MAX_CONCURRENT_PER_DATABASE,
  type ManagedPostgresExtension,
  normalizePostgresExtensionName,
  type PostgresRowSearchFilter,
  type PostgresRowSearchOperation,
  quotePostgresExtensionName,
  type SqlQueryAccess,
} from './databases.service.shared.js';
import {
  ensurePostgresBaseTable,
  normalizePostgresColumnType,
  postgresColumnTypeSql,
} from './postgres-column-operations.js';
import {
  deletePostgresRow as deletePostgresRowOperation,
  insertPostgresRow as insertPostgresRowOperation,
  updatePostgresRow as updatePostgresRowOperation,
} from './postgres-row-operations.js';
import { quoteIdent } from './postgres-row-sql.js';
import {
  getPostgresTableMetadata as getPostgresTableMetadataOperation,
  listPostgresSchemas as listPostgresSchemasOperation,
  listPostgresTables as listPostgresTablesOperation,
} from './postgres-schema-operations.js';
import {
  getRedisKey as getRedisKeyOperation,
  type RedisKeyValueType,
  scanRedisKeys as scanRedisKeysOperation,
  setRedisKey as setRedisKeyOperation,
} from './redis-key-operations.js';
import type { SqlExecutionOptions } from './sql-database-adapter.js';

export * from './databases.service.shared.js';

export class DatabaseConnectionService extends DatabaseConnectionServiceRuntime {
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
    options: SqlExecutionOptions = {},
    access: SqlQueryAccess = 'admin'
  ) {
    const startedAt = Date.now();
    const row = await this.getRow(id);
    const deadlineMs = startedAt + row.interactiveQueryBudgetSeconds * 1000;
    return this.withInteractiveQuerySlot(id, userId, async () =>
      (await this.getSqlAdapter(id, access)).executeSql(id, sql, userId, {
        ...options,
        deadlineMs,
      })
    );
  }

  protected async withInteractiveQuerySlot<T>(id: string, userId: string, run: () => Promise<T>): Promise<T> {
    const state = this.interactiveQueryRuns.get(id) ?? { total: 0, users: new Set<string>() };
    if (state.users.has(userId)) {
      throw new AppError(
        409,
        'DATABASE_QUERY_ALREADY_RUNNING',
        'This user already has an interactive query running for this database'
      );
    }
    if (state.total >= INTERACTIVE_QUERY_MAX_CONCURRENT_PER_DATABASE) {
      throw new AppError(
        429,
        'DATABASE_QUERY_CONCURRENCY_LIMIT',
        'This database already has the maximum number of interactive queries running'
      );
    }
    state.total += 1;
    state.users.add(userId);
    this.interactiveQueryRuns.set(id, state);
    try {
      return await run();
    } finally {
      state.total -= 1;
      state.users.delete(userId);
      if (state.total === 0) this.interactiveQueryRuns.delete(id);
    }
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
            interactiveQueryBudgetSeconds: input.type === 'redis' ? 300 : (input.interactiveQueryBudgetSeconds ?? 300),
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
    const managed = await this.getManagedMetadata(id);
    if (managed) {
      const fields = Object.keys(input);
      if (fields.length === 1 && input.interactiveQueryBudgetSeconds !== undefined && existing.type !== 'redis') {
        const [updated] = await this.db
          .update(databaseConnections)
          .set({
            interactiveQueryBudgetSeconds: input.interactiveQueryBudgetSeconds,
            updatedById: userId,
            updatedAt: new Date(),
          })
          .where(eq(databaseConnections.id, id))
          .returning();
        await this.auditService.log({
          userId,
          action: 'database.connection.update',
          resourceType: 'database',
          resourceId: id,
          details: { name: updated!.name, type: updated!.type, fields },
        });
        this.emitChange(id, 'updated', {
          name: updated!.name,
          type: updated!.type,
          healthStatus: updated!.healthStatus,
        });
        return this.toView(updated!, false, false);
      }
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
      interactiveQueryBudgetSeconds:
        existing.type === 'redis'
          ? 300
          : (input.interactiveQueryBudgetSeconds ?? existing.interactiveQueryBudgetSeconds),
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
}
