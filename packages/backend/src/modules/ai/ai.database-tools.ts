import { hasScope } from '@/lib/permissions.js';
import {
  AddPostgresColumnSchema,
  BrowsePostgresRowsQuerySchema,
  CreateDatabaseConnectionSchema,
  DeletePostgresColumnSchema,
  PostgresObjectSchema,
  RedisExpireKeySchema,
  RedisGetKeyQuerySchema,
  RedisScanKeysQuerySchema,
  RedisSetKeySchema,
  UpdateDatabaseConnectionSchema,
  UpdatePostgresColumnTypeSchema,
} from '@/modules/databases/databases.schemas.js';
import {
  type DatabaseConnectionService,
  inferPostgresIntent,
  inferRedisIntent,
} from '@/modules/databases/databases.service.js';
import type { User } from '@/types.js';
import { directResourceIdsForScopes } from './ai.service-helpers.js';

export const DATABASE_TOOL_NAMES = new Set([
  'list_databases',
  'get_database_connection',
  'query_postgres_read',
  'execute_postgres_sql',
  'browse_redis_keys',
  'get_redis_key',
  'set_redis_key',
  'execute_redis_command',
  'manage_database_connection',
  'manage_postgres_data',
  'manage_redis_data',
]);

export interface DatabaseToolContext {
  databaseService: DatabaseConnectionService;
}

export async function executeDatabaseTool(
  context: DatabaseToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;

  switch (toolName) {
    case 'list_databases': {
      const allowedIds = directResourceIdsForScopes(user.scopes, 'databases:view');
      if (allowedIds?.length === 0) {
        throw new Error('PERMISSION_DENIED: Missing required scope databases:view');
      }
      return context.databaseService.list(
        {
          page: 1,
          limit: 100,
          search: a.search,
          type: a.type,
          healthStatus: a.healthStatus,
        },
        { allowedIds }
      );
    }
    case 'get_database_connection':
      ensureDirectDatabaseScope(user, 'databases:view', a.databaseId);
      return context.databaseService.get(a.databaseId);
    case 'query_postgres_read':
      ensureReadOnlyPostgresQuery(user, a.databaseId, a.sql);
      return context.databaseService.executePostgresSql(a.databaseId, a.sql, user.id);
    case 'execute_postgres_sql':
      ensurePostgresQueryIntentScope(user, a.databaseId, a.sql);
      return context.databaseService.executePostgresSql(a.databaseId, a.sql, user.id);
    case 'browse_redis_keys':
      ensureDatabaseQueryScopes(user, 'databases:query:read', a.databaseId);
      return context.databaseService.scanRedisKeys(a.databaseId, 0, 100, a.search, a.type);
    case 'get_redis_key':
      ensureDatabaseQueryScopes(user, 'databases:query:read', a.databaseId);
      return context.databaseService.getRedisKey(a.databaseId, a.key);
    case 'set_redis_key':
      ensureDatabaseQueryScopes(user, 'databases:query:write', a.databaseId);
      return context.databaseService.setRedisKey(a.databaseId, a.key, a.type, a.value, a.ttlSeconds, user.id);
    case 'execute_redis_command':
      ensureDatabaseQueryScopes(user, 'databases:query:admin', a.databaseId);
      return context.databaseService.executeRedisCommand(a.databaseId, a.command, user.id);
    case 'manage_database_connection':
      return manageDatabaseConnection(context, user, args);
    case 'manage_postgres_data':
      return managePostgresData(context, user, args);
    case 'manage_redis_data':
      return manageRedisData(context, user, args);
    default:
      throw new Error(`Unsupported database tool: ${toolName}`);
  }
}

async function manageDatabaseConnection(context: DatabaseToolContext, user: User, args: Record<string, unknown>) {
  const operation = String(args.operation);
  const databaseId = String(args.databaseId ?? '');
  if (operation === 'create') {
    ensureToolScope(user, 'databases:create');
    return context.databaseService.create(CreateDatabaseConnectionSchema.parse(args), user.id);
  }
  if (operation === 'update') {
    ensureDirectDatabaseScope(user, 'databases:edit', databaseId);
    return context.databaseService.update(databaseId, UpdateDatabaseConnectionSchema.parse(args), user.id);
  }
  if (operation === 'delete') {
    ensureDirectDatabaseScope(user, 'databases:delete', databaseId);
    await context.databaseService.delete(databaseId, user.id);
    return { success: true };
  }
  if (operation === 'test') {
    ensureDirectDatabaseScope(user, 'databases:edit', databaseId);
    return context.databaseService.testSavedConnection(databaseId, user.id);
  }
  if (operation === 'reveal_credentials') {
    ensureDirectDatabaseScope(user, 'databases:credentials:reveal', databaseId);
    return context.databaseService.revealCredentials(databaseId);
  }
  if (operation === 'health_history') {
    ensureDirectDatabaseScope(user, 'databases:view', databaseId);
    return context.databaseService.getHealthHistory(databaseId);
  }
  throw new Error(`Unsupported database connection operation: ${operation}`);
}

async function managePostgresData(context: DatabaseToolContext, user: User, args: Record<string, unknown>) {
  const operation = String(args.operation);
  const databaseId = String(args.databaseId);
  if (operation === 'list_schemas') {
    ensureDatabaseQueryScopes(user, 'databases:query:read', databaseId);
    return context.databaseService.listPostgresSchemas(databaseId);
  }
  if (operation === 'list_tables') {
    ensureDatabaseQueryScopes(user, 'databases:query:read', databaseId);
    return context.databaseService.listPostgresTables(databaseId, String(args.schema));
  }
  if (operation === 'table_metadata') {
    ensureDatabaseQueryScopes(user, 'databases:query:read', databaseId);
    const input = BrowsePostgresRowsQuerySchema.pick({ schema: true, table: true }).parse(args);
    return context.databaseService.getPostgresTableMetadata(databaseId, input.schema, input.table);
  }
  if (operation === 'browse_rows') {
    ensureDatabaseQueryScopes(user, 'databases:query:read', databaseId);
    const input = BrowsePostgresRowsQuerySchema.parse(args);
    return context.databaseService.browsePostgresRows(
      databaseId,
      input.schema,
      input.table,
      input.page,
      input.limit,
      input.sortBy,
      input.sortOrder,
      input.searchColumn
        ? { column: input.searchColumn, operation: input.searchOperation ?? 'like', value: input.searchValue ?? '' }
        : undefined
    );
  }
  if (operation === 'insert_row') {
    ensureDatabaseQueryScopes(user, 'databases:query:write', databaseId);
    const input = BrowsePostgresRowsQuerySchema.pick({ schema: true, table: true }).parse(args);
    return context.databaseService.insertPostgresRow(
      databaseId,
      input.schema,
      input.table,
      PostgresObjectSchema.parse(args.values ?? {}),
      user.id
    );
  }
  if (operation === 'update_row') {
    ensureDatabaseQueryScopes(user, 'databases:query:write', databaseId);
    const input = BrowsePostgresRowsQuerySchema.pick({ schema: true, table: true }).parse(args);
    return context.databaseService.updatePostgresRow(
      databaseId,
      input.schema,
      input.table,
      PostgresObjectSchema.parse(args.primaryKey ?? {}),
      PostgresObjectSchema.parse(args.values ?? {}),
      user.id
    );
  }
  if (operation === 'delete_row') {
    ensureDatabaseQueryScopes(user, 'databases:query:write', databaseId);
    const input = BrowsePostgresRowsQuerySchema.pick({ schema: true, table: true }).parse(args);
    return context.databaseService.deletePostgresRow(
      databaseId,
      input.schema,
      input.table,
      PostgresObjectSchema.parse(args.primaryKey ?? {}),
      user.id
    );
  }
  if (operation === 'add_column') {
    ensureDatabaseQueryScopes(user, 'databases:query:admin', databaseId);
    const input = AddPostgresColumnSchema.parse(args);
    return context.databaseService.addPostgresColumn(
      databaseId,
      input.schema,
      input.table,
      input.column,
      input.dataType,
      user.id
    );
  }
  if (operation === 'update_column_type') {
    ensureDatabaseQueryScopes(user, 'databases:query:admin', databaseId);
    const input = UpdatePostgresColumnTypeSchema.parse(args);
    return context.databaseService.updatePostgresColumnType(
      databaseId,
      input.schema,
      input.table,
      input.column,
      input.dataType,
      user.id
    );
  }
  if (operation === 'delete_column') {
    ensureDatabaseQueryScopes(user, 'databases:query:admin', databaseId);
    const input = DeletePostgresColumnSchema.parse(args);
    return context.databaseService.deletePostgresColumn(databaseId, input.schema, input.table, input.column, user.id);
  }
  throw new Error(`Unsupported Postgres operation: ${operation}`);
}

async function manageRedisData(context: DatabaseToolContext, user: User, args: Record<string, unknown>) {
  const operation = String(args.operation);
  const databaseId = String(args.databaseId);
  if (operation === 'scan_keys') {
    ensureDatabaseQueryScopes(user, 'databases:query:read', databaseId);
    const input = RedisScanKeysQuerySchema.parse(args);
    return context.databaseService.scanRedisKeys(databaseId, input.cursor, input.limit, input.search, input.type);
  }
  if (operation === 'get_key') {
    ensureDatabaseQueryScopes(user, 'databases:query:read', databaseId);
    const input = RedisGetKeyQuerySchema.parse(args);
    return context.databaseService.getRedisKey(databaseId, input.key, input);
  }
  if (operation === 'set_key') {
    ensureDatabaseQueryScopes(user, 'databases:query:write', databaseId);
    const input = RedisSetKeySchema.parse(args);
    return context.databaseService.setRedisKey(
      databaseId,
      input.key,
      input.type,
      input.value,
      input.ttlSeconds,
      user.id
    );
  }
  if (operation === 'delete_key') {
    ensureDatabaseQueryScopes(user, 'databases:query:write', databaseId);
    const input = RedisGetKeyQuerySchema.parse(args);
    return context.databaseService.deleteRedisKey(databaseId, input.key, user.id);
  }
  if (operation === 'expire_key') {
    ensureDatabaseQueryScopes(user, 'databases:query:write', databaseId);
    const input = RedisExpireKeySchema.parse(args);
    return context.databaseService.expireRedisKey(databaseId, input.key, input.ttlSeconds, user.id);
  }
  if (operation === 'execute_command') {
    const command = String(args.command ?? '');
    const intent = inferRedisIntent(command);
    ensureDatabaseQueryScopes(
      user,
      intent === 'read'
        ? 'databases:query:read'
        : intent === 'write'
          ? 'databases:query:write'
          : 'databases:query:admin',
      databaseId
    );
    return context.databaseService.executeRedisCommand(databaseId, command, user.id);
  }
  throw new Error(`Unsupported Redis operation: ${operation}`);
}

function ensureToolScope(user: User, scope: string) {
  if (!hasScope(user.scopes, scope)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${scope}`);
  }
}

function ensureDatabaseScope(user: User, baseScope: string, databaseId: string) {
  if (!hasScope(user.scopes, `${baseScope}:${databaseId}`)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${baseScope}:${databaseId}`);
  }
}

function ensureDatabaseQueryScopes(user: User, queryScope: string, databaseId: string) {
  ensureDirectDatabaseScope(user, 'databases:view', databaseId);
  ensureDatabaseScope(user, queryScope, databaseId);
}

function ensureReadOnlyPostgresQuery(user: User, databaseId: string, sql: string) {
  const intent = inferPostgresIntent(sql);
  if (intent !== 'read') {
    throw new Error('INVALID_SQL_INTENT: query_postgres_read only allows read-only Postgres SQL');
  }
  ensureDatabaseQueryScopes(user, 'databases:query:read', databaseId);
}

function ensurePostgresQueryIntentScope(user: User, databaseId: string, sql: string) {
  const intent = inferPostgresIntent(sql);
  const queryScope =
    intent === 'read' ? 'databases:query:read' : intent === 'write' ? 'databases:query:write' : 'databases:query:admin';
  ensureDatabaseQueryScopes(user, queryScope, databaseId);
}

function ensureDirectDatabaseScope(user: User, baseScope: string, databaseId: string) {
  if (!user.scopes.includes(baseScope) && !user.scopes.includes(`${baseScope}:${databaseId}`)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${baseScope}:${databaseId}`);
  }
}
