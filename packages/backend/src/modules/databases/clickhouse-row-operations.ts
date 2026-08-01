import type { ClickHouseClient } from '@clickhouse/client';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { quoteClickHouseIdentifier, safeClickHouseType } from './clickhouse-sql.js';
import type { DatabaseOperation } from './database-error-mapping.js';
import type { SqlRowMutationResult, SqlTableMetadata } from './sql-database-adapter.js';

export interface ClickHouseRowOperationContext {
  withClient<T>(id: string, operation: DatabaseOperation, fn: (client: ClickHouseClient) => Promise<T>): Promise<T>;
  getTableMetadata(id: string, namespace: string, table: string): Promise<SqlTableMetadata>;
  auditLog(entry: Parameters<AuditService['log']>[0]): Promise<void>;
  emitChange(id: string, action: string, extra?: Record<string, unknown>): void;
}

function qualifiedTable(namespace: string, table: string): string {
  return `${quoteClickHouseIdentifier(namespace)}.${quoteClickHouseIdentifier(table)}`;
}

function columnMap(metadata: SqlTableMetadata) {
  return new Map(metadata.columns.map((column) => [column.name, column]));
}

function assertMutationSupported(metadata: SqlTableMetadata, operation: 'rowInsert' | 'rowUpdate' | 'rowDelete'): void {
  if (metadata.mutations[operation]) return;
  throw new AppError(
    400,
    'CLICKHOUSE_ROW_MUTATION_UNSUPPORTED',
    metadata.mutations.reason ?? 'This ClickHouse table does not support the requested inline row mutation'
  );
}

function typedParameter(name: string, type: string): string {
  return `{${name}: ${safeClickHouseType(type)}}`;
}

function buildIdentityPredicate(metadata: SqlTableMetadata, locator: Record<string, unknown>) {
  if (metadata.mutations.identityColumns.length === 0) {
    throw new AppError(400, 'ROW_IDENTITY_REQUIRED', 'This ClickHouse table has no usable row identity');
  }
  const columns = columnMap(metadata);
  const params: Record<string, unknown> = {};
  const clauses = metadata.mutations.identityColumns.map((name, index) => {
    if (!(name in locator)) {
      throw new AppError(400, 'ROW_IDENTITY_REQUIRED', `Missing row identity column "${name}"`);
    }
    const column = columns.get(name);
    if (!column) throw new AppError(400, 'INVALID_COLUMN', `Unknown ClickHouse column "${name}"`);
    const value = locator[name];
    if (value == null) return `${quoteClickHouseIdentifier(name)} IS NULL`;
    const parameter = `identity_${index}`;
    params[parameter] = value;
    return `${quoteClickHouseIdentifier(name)} = ${typedParameter(parameter, column.dataType)}`;
  });
  return { sql: clauses.join(' AND '), params };
}

async function assertExactlyOneMatch(
  client: ClickHouseClient,
  metadata: SqlTableMetadata,
  predicate: { sql: string; params: Record<string, unknown> }
): Promise<void> {
  const result = await client.query({
    query: `SELECT count() AS matched FROM ${qualifiedTable(metadata.namespace, metadata.table)} WHERE ${predicate.sql}`,
    format: 'JSONEachRow',
    query_params: predicate.params,
    clickhouse_settings: { readonly: '1', max_execution_time: 15 },
  });
  const rows = await result.json<Array<{ matched: string | number }>[number]>();
  const matched = Number(rows[0]?.matched ?? 0);
  if (matched === 0) {
    throw new AppError(409, 'ROW_NOT_FOUND', 'The ClickHouse row no longer matches its original identity');
  }
  if (matched !== 1) {
    throw new AppError(
      409,
      'ROW_IDENTITY_NOT_UNIQUE',
      `The ClickHouse row identity matches ${matched} rows; use SQL Console with an explicit predicate`
    );
  }
}

export async function insertClickHouseRow(
  context: ClickHouseRowOperationContext,
  id: string,
  namespace: string,
  table: string,
  values: Record<string, unknown>,
  userId: string
): Promise<SqlRowMutationResult> {
  const metadata = await context.getTableMetadata(id, namespace, table);
  assertMutationSupported(metadata, 'rowInsert');
  const columns = columnMap(metadata);
  const unknownColumns = Object.keys(values).filter((name) => !columns.has(name));
  if (unknownColumns.length > 0) {
    throw new AppError(400, 'INVALID_COLUMN', `Unknown ClickHouse column "${unknownColumns[0]}"`);
  }
  const names = metadata.columns.map((column) => column.name).filter((name) => name in values);
  if (names.length === 0) throw new AppError(400, 'INVALID_ROW', 'At least one column value is required');
  const queryParams: Record<string, unknown> = {};
  const placeholders = names.map((name, index) => {
    const column = columns.get(name)!;
    const value = values[name];
    if (value == null && !column.nullable) {
      throw new AppError(400, 'INVALID_ROW', `Column "${name}" is not nullable`);
    }
    const parameter = `value_${index}`;
    queryParams[parameter] = value;
    return typedParameter(parameter, column.dataType);
  });
  const response = await context.withClient(id, 'query', (client) =>
    client.command({
      query: `INSERT INTO ${qualifiedTable(namespace, table)} (${names.map(quoteClickHouseIdentifier).join(', ')}) VALUES (${placeholders.join(', ')})`,
      query_params: queryParams,
      clickhouse_settings: { wait_end_of_query: 1 },
    })
  );
  await context.auditLog({
    userId,
    action: 'database.clickhouse.row.insert',
    resourceType: 'database',
    resourceId: id,
    details: { namespace, table, columns: names },
  });
  context.emitChange(id, 'data.updated', { provider: 'clickhouse', namespace, table });
  return { success: true, affectedRows: 1, queryId: response.query_id };
}

export async function updateClickHouseRow(
  context: ClickHouseRowOperationContext,
  id: string,
  namespace: string,
  table: string,
  locator: Record<string, unknown>,
  values: Record<string, unknown>,
  userId: string
): Promise<SqlRowMutationResult> {
  const metadata = await context.getTableMetadata(id, namespace, table);
  assertMutationSupported(metadata, 'rowUpdate');
  const columns = columnMap(metadata);
  const immutable = new Set(metadata.mutations.immutableColumns);
  const names = Object.keys(values);
  if (names.length === 0) throw new AppError(400, 'INVALID_ROW', 'No editable columns provided');
  const queryParams: Record<string, unknown> = {};
  const assignments = names.map((name, index) => {
    const column = columns.get(name);
    if (!column) throw new AppError(400, 'INVALID_COLUMN', `Unknown ClickHouse column "${name}"`);
    if (immutable.has(name)) {
      throw new AppError(400, 'IMMUTABLE_CLICKHOUSE_COLUMN', `ClickHouse key column "${name}" is not inline editable`);
    }
    const value = values[name];
    if (value == null && !column.nullable) {
      throw new AppError(400, 'INVALID_ROW', `Column "${name}" is not nullable`);
    }
    const parameter = `value_${index}`;
    queryParams[parameter] = value;
    return `${quoteClickHouseIdentifier(name)} = ${typedParameter(parameter, column.dataType)}`;
  });
  const predicate = buildIdentityPredicate(metadata, locator);
  const response = await context.withClient(id, 'query', async (client) => {
    await assertExactlyOneMatch(client, metadata, predicate);
    return client.command({
      query: `UPDATE ${qualifiedTable(namespace, table)} SET ${assignments.join(', ')} WHERE ${predicate.sql}`,
      query_params: { ...predicate.params, ...queryParams },
      clickhouse_settings: { wait_end_of_query: 1 },
    });
  });
  await context.auditLog({
    userId,
    action: 'database.clickhouse.row.update',
    resourceType: 'database',
    resourceId: id,
    details: { namespace, table, identityColumns: metadata.mutations.identityColumns, columns: names },
  });
  context.emitChange(id, 'data.updated', { provider: 'clickhouse', namespace, table });
  return { success: true, affectedRows: 1, queryId: response.query_id };
}

export async function deleteClickHouseRow(
  context: ClickHouseRowOperationContext,
  id: string,
  namespace: string,
  table: string,
  locator: Record<string, unknown>,
  userId: string
): Promise<SqlRowMutationResult> {
  const metadata = await context.getTableMetadata(id, namespace, table);
  assertMutationSupported(metadata, 'rowDelete');
  const predicate = buildIdentityPredicate(metadata, locator);
  const response = await context.withClient(id, 'query', async (client) => {
    await assertExactlyOneMatch(client, metadata, predicate);
    return client.command({
      query: `DELETE FROM ${qualifiedTable(namespace, table)} WHERE ${predicate.sql}`,
      query_params: predicate.params,
      clickhouse_settings: { wait_end_of_query: 1 },
    });
  });
  await context.auditLog({
    userId,
    action: 'database.clickhouse.row.delete',
    resourceType: 'database',
    resourceId: id,
    details: { namespace, table, identityColumns: metadata.mutations.identityColumns },
  });
  context.emitChange(id, 'data.updated', { provider: 'clickhouse', namespace, table });
  return { success: true, affectedRows: 1, queryId: response.query_id };
}
