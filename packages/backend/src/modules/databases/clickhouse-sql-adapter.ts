import type { ClickHouseClient } from '@clickhouse/client';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import {
  type ClickHouseRowOperationContext,
  deleteClickHouseRow,
  insertClickHouseRow,
  updateClickHouseRow,
} from './clickhouse-row-operations.js';
import {
  clickHouseVersionAtLeast,
  hasClickHouseLightweightUpdateColumns,
  isClickHouseMergeTreeEngine,
  quoteClickHouseIdentifier,
  safeClickHouseType,
} from './clickhouse-sql.js';
import { hashDatabasePreview } from './database-connection-view.js';
import type { DatabaseOperation } from './database-error-mapping.js';
import { inferClickHouseIntent, splitSqlStatements } from './database-query-intent.js';
import { estimateJsonBytes } from './database-result-compaction.js';
import type {
  SqlDatabaseAdapter,
  SqlExecutionResult,
  SqlObjectSummary,
  SqlStatementResult,
  SqlTableMetadata,
} from './sql-database-adapter.js';

const CLICKHOUSE_STATEMENT_LIMIT = 10;
const CLICKHOUSE_QUERY_TIMEOUT_SECONDS = 15;
const CLICKHOUSE_RESPONSE_MAX_BYTES = 768 * 1024;

export interface ClickHouseSqlAdapterContext {
  withClient<T>(id: string, operation: DatabaseOperation, fn: (client: ClickHouseClient) => Promise<T>): Promise<T>;
  auditLog(entry: Parameters<AuditService['log']>[0]): Promise<void>;
  emitChange(id: string, action: string, extra?: Record<string, unknown>): void;
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function objectType(engine: string): SqlObjectSummary['type'] {
  const normalized = engine.toLowerCase();
  if (normalized.includes('materializedview')) return 'materialized-view';
  if (normalized.includes('view')) return 'view';
  if (normalized.includes('dictionary')) return 'dictionary';
  return 'table';
}

function commandName(statement: string): string {
  return statement.trim().split(/\s+/, 1)[0]?.toUpperCase() || 'QUERY';
}

export class ClickHouseSqlAdapter implements SqlDatabaseAdapter {
  readonly type = 'clickhouse' as const;
  readonly capabilities = {
    sqlConsole: true,
    catalogExplorer: true,
    rowInsert: true,
    rowUpdate: true,
    rowDelete: true,
    schemaMutation: false,
    exactRowCount: false,
  } as const;

  constructor(private readonly context: ClickHouseSqlAdapterContext) {}

  private rowOperationContext(): ClickHouseRowOperationContext {
    return {
      ...this.context,
      getTableMetadata: (id, namespace, table) => this.getTableMetadata(id, namespace, table),
    };
  }

  inferIntent(sql: string) {
    return inferClickHouseIntent(sql);
  }

  listNamespaces(id: string) {
    return this.context.withClient(id, 'query', async (client) => {
      const result = await client.query({
        query: `SELECT name FROM system.databases ORDER BY name`,
        format: 'JSONEachRow',
        clickhouse_settings: { max_execution_time: CLICKHOUSE_QUERY_TIMEOUT_SECONDS, readonly: '1' },
      });
      const rows = await result.json<Array<{ name: string }>[number]>();
      return rows.map((row) => ({
        name: String(row.name),
        system: ['system', 'information_schema', 'INFORMATION_SCHEMA'].includes(String(row.name)),
      }));
    });
  }

  listObjects(id: string, namespace: string) {
    return this.context.withClient(id, 'query', async (client) => {
      const result = await client.query({
        query: `
          SELECT name, engine, total_rows, total_bytes
          FROM system.tables
          WHERE database = {database: String}
          ORDER BY name
        `,
        format: 'JSONEachRow',
        query_params: { database: namespace },
        clickhouse_settings: { max_execution_time: CLICKHOUSE_QUERY_TIMEOUT_SECONDS, readonly: '1' },
      });
      const rows = await result.json<{
        name: string;
        engine: string;
        total_rows: string | number | null;
        total_bytes: string | number | null;
      }>();
      return rows.map((row) => ({
        name: String(row.name),
        type: objectType(String(row.engine ?? '')),
        engine: String(row.engine ?? ''),
        estimatedRows: numeric(row.total_rows),
        estimatedBytes: numeric(row.total_bytes),
      }));
    });
  }

  getTableMetadata(id: string, namespace: string, table: string) {
    return this.context.withClient(id, 'query', async (client): Promise<SqlTableMetadata> => {
      const [tableResult, columnsResult] = await Promise.all([
        client.query({
          query: `
            SELECT engine, sorting_key, primary_key, partition_key, total_rows, total_bytes,
                   create_table_query,
                   version() AS server_version
            FROM system.tables
            WHERE database = {database: String} AND name = {table: String}
            LIMIT 1
          `,
          format: 'JSONEachRow',
          query_params: { database: namespace, table },
          clickhouse_settings: { max_execution_time: CLICKHOUSE_QUERY_TIMEOUT_SECONDS, readonly: '1' },
        }),
        client.query({
          query: `
            SELECT name, type, default_kind, default_expression, comment,
                   is_in_primary_key, is_in_sorting_key, is_in_partition_key
            FROM system.columns
            WHERE database = {database: String} AND table = {table: String}
            ORDER BY position
          `,
          format: 'JSONEachRow',
          query_params: { database: namespace, table },
          clickhouse_settings: { max_execution_time: CLICKHOUSE_QUERY_TIMEOUT_SECONDS, readonly: '1' },
        }),
      ]);
      const tables = await tableResult.json<{
        engine: string;
        sorting_key: string;
        primary_key: string;
        partition_key: string;
        total_rows: string | number | null;
        total_bytes: string | number | null;
        create_table_query: string;
        server_version: string;
      }>();
      const tableRow = tables[0];
      const columns = await columnsResult.json<{
        name: string;
        type: string;
        default_kind: string;
        default_expression: string;
        comment: string;
        is_in_primary_key: number;
        is_in_sorting_key: number;
        is_in_partition_key: number;
      }>();
      if (!tableRow || columns.length === 0) {
        throw new AppError(404, 'TABLE_NOT_FOUND', 'ClickHouse table or view not found');
      }
      const primaryKey = columns
        .filter((column) => Number(column.is_in_primary_key) === 1)
        .map((column) => column.name);
      const engine = String(tableRow.engine ?? '');
      const resolvedObjectType = objectType(engine);
      const serverVersion = String(tableRow.server_version ?? '0.0');
      const supportsLightweightUpdateColumns = hasClickHouseLightweightUpdateColumns(
        String(tableRow.create_table_query ?? '')
      );
      const systemNamespace = ['system', 'information_schema', 'INFORMATION_SCHEMA'].includes(namespace);
      const mutableTable = resolvedObjectType === 'table' && !systemNamespace && isClickHouseMergeTreeEngine(engine);
      const identityColumns = mutableTable ? primaryKey : [];
      const immutableColumns = columns
        .filter(
          (column) =>
            Number(column.is_in_primary_key) === 1 ||
            Number(column.is_in_sorting_key) === 1 ||
            Number(column.is_in_partition_key) === 1
        )
        .map((column) => String(column.name));
      const rowUpdate =
        mutableTable &&
        identityColumns.length > 0 &&
        clickHouseVersionAtLeast(serverVersion, [25, 7]) &&
        supportsLightweightUpdateColumns;
      const rowDelete = mutableTable && identityColumns.length > 0 && clickHouseVersionAtLeast(serverVersion, [23, 3]);
      const reason = systemNamespace
        ? 'System databases are browse-only'
        : resolvedObjectType !== 'table'
          ? 'Views and dictionaries are browse-only'
          : !isClickHouseMergeTreeEngine(engine)
            ? `Inline mutations are unavailable for ${engine || 'this table engine'}`
            : identityColumns.length === 0
              ? 'Inline update and delete require a ClickHouse primary key'
              : !clickHouseVersionAtLeast(serverVersion, [25, 7])
                ? `Lightweight UPDATE requires ClickHouse 25.7 or newer (server ${serverVersion})`
                : !supportsLightweightUpdateColumns
                  ? 'Lightweight UPDATE requires enable_block_number_column = 1 on this table'
                  : undefined;
      return {
        provider: 'clickhouse',
        namespace,
        table,
        objectType: resolvedObjectType,
        engine,
        columns: columns.map((column) => ({
          name: String(column.name),
          dataType: String(column.type),
          nullable: /^Nullable\(/.test(String(column.type)),
          isPrimaryKey: Number(column.is_in_primary_key) === 1,
          isSortingKey: Number(column.is_in_sorting_key) === 1,
          isPartitionKey: Number(column.is_in_partition_key) === 1,
          hasDefault: Boolean(column.default_kind),
          defaultExpression: column.default_expression || null,
          comment: column.comment || null,
        })),
        primaryKey,
        hasPrimaryKey: primaryKey.length > 0,
        sortingKey: tableRow.sorting_key || null,
        partitionKey: tableRow.partition_key || null,
        providerMetadata: {
          estimatedRows: numeric(tableRow.total_rows),
          estimatedBytes: numeric(tableRow.total_bytes),
          serverVersion,
        },
        mutations: {
          rowInsert: resolvedObjectType === 'table' && !systemNamespace,
          rowUpdate,
          rowDelete,
          identityColumns,
          immutableColumns,
          reason,
        },
      };
    });
  }

  async browseRows(
    id: string,
    namespace: string,
    table: string,
    page: number,
    limit: number,
    options?: {
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      search?: {
        column: string;
        operation: 'like' | 'equals' | 'notEquals' | 'greaterThan' | 'lessThan';
        value: string;
      };
    }
  ) {
    const metadata = await this.getTableMetadata(id, namespace, table);
    const columnByName = new Map(metadata.columns.map((column) => [column.name, column]));
    const sortColumn = options?.sortBy && columnByName.has(options.sortBy) ? options.sortBy : metadata.primaryKey[0];
    const queryParams: Record<string, unknown> = {
      limit: Math.min(Math.max(Math.trunc(limit), 1), 500),
      offset: Math.max(0, (Math.max(1, Math.trunc(page)) - 1) * limit),
    };
    let whereSql = '';
    if (options?.search && columnByName.has(options.search.column)) {
      const column = columnByName.get(options.search.column)!;
      const columnSql = quoteClickHouseIdentifier(column.name);
      queryParams.search = options.search.value;
      if (options.search.operation === 'like') {
        whereSql = `WHERE positionCaseInsensitive(toString(${columnSql}), {search: String}) > 0`;
      } else {
        const operatorByIntent = {
          equals: '=',
          notEquals: '!=',
          greaterThan: '>',
          lessThan: '<',
        } as const;
        const operator = operatorByIntent[options.search.operation];
        whereSql = `WHERE ${columnSql} ${operator} CAST({search: String}, '${safeClickHouseType(column.dataType)}')`;
      }
    }
    const orderSql = sortColumn
      ? `ORDER BY ${quoteClickHouseIdentifier(sortColumn)} ${options?.sortOrder === 'desc' ? 'DESC' : 'ASC'}`
      : '';
    const result = await this.context.withClient(id, 'query', async (client) => {
      const response = await client.query({
        query: `SELECT * FROM ${quoteClickHouseIdentifier(namespace)}.${quoteClickHouseIdentifier(table)} ${whereSql} ${orderSql} LIMIT {limit: UInt32} OFFSET {offset: UInt64}`,
        format: 'JSON',
        query_params: queryParams,
        clickhouse_settings: {
          max_execution_time: CLICKHOUSE_QUERY_TIMEOUT_SECONDS,
          max_result_rows: String(queryParams.limit),
          result_overflow_mode: 'break',
          readonly: '1',
          cancel_http_readonly_queries_on_client_close: 1,
        },
      });
      return response.json<Record<string, unknown>>();
    });
    const estimatedRows = metadata.providerMetadata?.estimatedRows;
    return {
      metadata,
      rows: result.data,
      page,
      limit: Number(queryParams.limit),
      total: options?.search ? null : typeof estimatedRows === 'number' ? estimatedRows : null,
      totalKind: options?.search ? ('unavailable' as const) : ('approximate' as const),
      truncated: result.data.length >= Number(queryParams.limit),
    };
  }

  insertRow(id: string, namespace: string, table: string, values: Record<string, unknown>, userId: string) {
    return insertClickHouseRow(this.rowOperationContext(), id, namespace, table, values, userId);
  }

  updateRow(
    id: string,
    namespace: string,
    table: string,
    locator: Record<string, unknown>,
    values: Record<string, unknown>,
    userId: string
  ) {
    return updateClickHouseRow(this.rowOperationContext(), id, namespace, table, locator, values, userId);
  }

  deleteRow(id: string, namespace: string, table: string, locator: Record<string, unknown>, userId: string) {
    return deleteClickHouseRow(this.rowOperationContext(), id, namespace, table, locator, userId);
  }

  executeSql(
    id: string,
    sqlText: string,
    userId: string,
    options: { maxRows?: number } = {}
  ): Promise<SqlExecutionResult> {
    const maxRows = Math.min(Math.max(Math.trunc(options.maxRows ?? 500), 1), 2000);
    const statements = splitSqlStatements(sqlText);
    if (statements.length > CLICKHOUSE_STATEMENT_LIMIT) {
      throw new AppError(
        400,
        'CLICKHOUSE_STATEMENT_LIMIT_EXCEEDED',
        `ClickHouse SQL execution is limited to ${CLICKHOUSE_STATEMENT_LIMIT} statements per request`
      );
    }
    return this.context.withClient(id, 'query', async (client) => {
      const results: SqlStatementResult[] = [];
      let responseTruncated = false;
      for (const statement of statements) {
        const intent = inferClickHouseIntent(statement);
        const started = Date.now();
        let entry: SqlStatementResult;
        if (intent === 'read') {
          const response = await client.query({
            query: statement,
            format: 'JSON',
            clickhouse_settings: {
              max_execution_time: CLICKHOUSE_QUERY_TIMEOUT_SECONDS,
              max_result_rows: String(maxRows),
              result_overflow_mode: 'break',
              readonly: '1',
              cancel_http_readonly_queries_on_client_close: 1,
            },
          });
          const body = await response.json<Record<string, unknown>>();
          const columns = body.meta?.map((column) => ({ name: column.name, type: column.type })) ?? [];
          entry = {
            command: commandName(statement),
            queryId: body.query_id ?? response.query_id,
            rowCount: body.rows ?? body.data.length,
            durationMs: Math.round((body.statistics?.elapsed ?? (Date.now() - started) / 1000) * 1000),
            fields: columns.map((column) => column.name),
            columns,
            rows: body.data.slice(0, maxRows),
            truncated:
              body.data.length > maxRows ||
              (body.rows_before_limit_at_least != null && body.rows_before_limit_at_least > body.data.length),
            maxRows,
            statistics: body.statistics
              ? {
                  elapsedMs: body.statistics.elapsed * 1000,
                  rowsRead: body.statistics.rows_read,
                  bytesRead: body.statistics.bytes_read,
                }
              : undefined,
          };
        } else {
          const response = await client.command({
            query: statement,
            clickhouse_settings: { max_execution_time: CLICKHOUSE_QUERY_TIMEOUT_SECONDS },
          });
          entry = {
            command: commandName(statement),
            queryId: response.query_id,
            rowCount: numeric(response.summary?.written_rows) ?? numeric(response.summary?.result_rows) ?? 0,
            durationMs: Date.now() - started,
            fields: [],
            columns: [],
            rows: [],
            truncated: false,
            maxRows,
          };
        }
        if (estimateJsonBytes([...results, entry]) > CLICKHOUSE_RESPONSE_MAX_BYTES) {
          responseTruncated = true;
          break;
        }
        results.push(entry);
      }
      const intent = inferClickHouseIntent(sqlText);
      await this.context.auditLog({
        userId,
        action: 'database.clickhouse.query',
        resourceType: 'database',
        resourceId: id,
        details: {
          intent,
          statementCount: statements.length,
          statementHash: hashDatabasePreview(sqlText),
          statementPreview: sqlText.trim().slice(0, 160),
        },
      });
      this.context.emitChange(id, 'query.executed', {
        provider: 'clickhouse',
        intent,
        statementCount: statements.length,
      });
      return { results, truncated: responseTruncated, resultLimit: CLICKHOUSE_STATEMENT_LIMIT };
    });
  }
}
