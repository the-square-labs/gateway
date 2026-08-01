import { OpenAPIHono } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeBase } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireScope, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import type { AppEnv } from '@/types.js';
import { DatabaseFolderService } from './database-folders.service.js';
import { DatabaseMonitoringService } from './database-monitoring.service.js';
import {
  addPostgresColumnRoute,
  browsePostgresRowsRoute,
  browseSqlRowsRoute,
  createDatabaseConnectionRoute,
  createDatabaseFolderRoute,
  databaseMonitoringStreamRoute,
  deleteDatabaseConnectionRoute,
  deleteDatabaseFolderRoute,
  deletePostgresColumnRoute,
  deletePostgresRowRoute,
  deleteRedisKeyRoute,
  deleteSqlRowRoute,
  executePostgresQueryRoute,
  executeRedisCommandRoute,
  executeSqlRoute,
  expireRedisKeyRoute,
  getDatabaseConnectionBySlugRoute,
  getDatabaseConnectionRoute,
  getDatabaseHealthHistoryRoute,
  getRedisKeyRoute,
  insertPostgresRowRoute,
  insertSqlRowRoute,
  listDatabaseConnectionsRoute,
  listDatabaseFoldersRoute,
  listPostgresSchemasRoute,
  listPostgresTablesRoute,
  listSqlNamespacesRoute,
  listSqlObjectsRoute,
  moveDatabaseFolderRoute,
  moveDatabasesToFolderRoute,
  postgresTableMetadataRoute,
  reorderDatabaseFoldersRoute,
  reorderDatabasesRoute,
  revealDatabaseCredentialsRoute,
  scanRedisKeysRoute,
  setRedisKeyRoute,
  sqlTableMetadataRoute,
  testDatabaseConnectionRoute,
  updateDatabaseConnectionRoute,
  updateDatabaseFolderRoute,
  updatePostgresColumnTypeRoute,
  updatePostgresRowRoute,
  updateSqlRowRoute,
} from './databases.docs.js';
import {
  AddPostgresColumnSchema,
  BrowsePostgresRowsQuerySchema,
  BrowseSqlRowsQuerySchema,
  CreateDatabaseConnectionSchema,
  DatabaseListQuerySchema,
  DeletePostgresColumnSchema,
  DeleteSqlRowSchema,
  ExecutePostgresSqlSchema,
  ExecuteRedisCommandSchema,
  ExecuteSqlSchema,
  InsertSqlRowSchema,
  PostgresObjectSchema,
  RedisExpireKeySchema,
  RedisGetKeyQuerySchema,
  RedisScanKeysQuerySchema,
  RedisSetKeySchema,
  SqlTableQuerySchema,
  UpdateDatabaseConnectionSchema,
  UpdatePostgresColumnTypeSchema,
  UpdateSqlRowSchema,
} from './databases.schemas.js';
import { DatabaseConnectionService, inferPostgresIntent, inferRedisIntent } from './databases.service.js';

export const databaseRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

function ensureQueryScope(c: any, databaseId: string, intent: 'read' | 'write' | 'admin') {
  const scopeSets =
    intent === 'read'
      ? ['databases:query:read', 'databases:query:write', 'databases:query:admin']
      : intent === 'write'
        ? ['databases:query:write', 'databases:query:admin']
        : ['databases:query:admin'];
  ensureAnyDatabaseScope(c, databaseId, scopeSets);
}

function ensureAnyDatabaseScope(c: any, databaseId: string, scopeBases: string[]) {
  const scopes = c.get('effectiveScopes') ?? [];
  const granted = scopeBases.some((base) => hasScope(scopes, `${base}:${databaseId}`));
  if (!granted) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope for database ${databaseId}`);
  }
}

databaseRoutes.use('*', authMiddleware);

databaseRoutes.openapi(listDatabaseFoldersRoute, async (c) => {
  const service = container.resolve(DatabaseFolderService);
  const scopes = c.get('effectiveScopes') ?? [];
  const canManageFolders = hasScope(scopes, 'databases:folders:manage');
  const hasGlobalAccess = hasScope(scopes, 'databases:view');
  const allowedIds = getResourceScopedIds(scopes, 'databases:view');
  if (!canManageFolders && !hasScopeBase(scopes, 'databases:view')) {
    throw new AppError(403, 'FORBIDDEN', 'Missing required scope: databases:view or databases:folders:manage');
  }
  const data = await service.getFolderTree(
    canManageFolders || hasGlobalAccess ? { includeAllFolders: canManageFolders } : { allowedResourceIds: allowedIds }
  );
  return c.json({ data });
});

databaseRoutes.openapi(
  { ...createDatabaseFolderRoute, middleware: requireScope('databases:folders:manage') },
  async (c) => {
    const service = container.resolve(DatabaseFolderService);
    const user = c.get('user')!;
    const input = CreateResourceFolderSchema.parse(await c.req.json());
    const data = await service.createFolder(input, user.id);
    return c.json({ data }, 201);
  }
);

databaseRoutes.openapi(
  { ...reorderDatabaseFoldersRoute, middleware: requireScope('databases:folders:manage') },
  async (c) => {
    const service = container.resolve(DatabaseFolderService);
    const input = ReorderResourceFoldersSchema.parse(await c.req.json());
    await service.reorderFolders(input);
    return c.json({ success: true });
  }
);

databaseRoutes.openapi(
  { ...moveDatabasesToFolderRoute, middleware: requireScope('databases:folders:manage') },
  async (c) => {
    const service = container.resolve(DatabaseFolderService);
    const user = c.get('user')!;
    const input = MoveResourcesToFolderSchema.parse(await c.req.json());
    await service.moveResourcesToFolder(input, user.id);
    return c.json({ success: true });
  }
);

databaseRoutes.openapi(
  { ...reorderDatabasesRoute, middleware: requireScope('databases:folders:manage') },
  async (c) => {
    const service = container.resolve(DatabaseFolderService);
    const input = ReorderResourcesSchema.parse(await c.req.json());
    await service.reorderResources(input);
    return c.json({ success: true });
  }
);

databaseRoutes.openapi(
  { ...updateDatabaseFolderRoute, middleware: requireScope('databases:folders:manage') },
  async (c) => {
    const service = container.resolve(DatabaseFolderService);
    const user = c.get('user')!;
    const input = UpdateResourceFolderSchema.parse(await c.req.json());
    const data = await service.updateFolder(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...moveDatabaseFolderRoute, middleware: requireScope('databases:folders:manage') },
  async (c) => {
    const service = container.resolve(DatabaseFolderService);
    const user = c.get('user')!;
    const input = MoveResourceFolderSchema.parse(await c.req.json());
    const data = await service.moveFolder(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...deleteDatabaseFolderRoute, middleware: requireScope('databases:folders:manage') },
  async (c) => {
    const service = container.resolve(DatabaseFolderService);
    const user = c.get('user')!;
    await service.deleteFolder(c.req.param('id')!, user.id);
    return c.json({ success: true });
  }
);

databaseRoutes.openapi(listDatabaseConnectionsRoute, async (c) => {
  const service = container.resolve(DatabaseConnectionService);
  const scopes = c.get('effectiveScopes') ?? [];
  const hasGlobalAccess = hasScope(scopes, 'databases:view');
  const canManageFolders = hasScope(scopes, 'databases:folders:manage');
  const allowedIds = getResourceScopedIds(scopes, 'databases:view');
  if (!hasGlobalAccess && !canManageFolders && allowedIds.length === 0) {
    throw new AppError(403, 'FORBIDDEN', 'Missing required database access scope');
  }
  const query = DatabaseListQuerySchema.parse(c.req.query());
  const data = await service.list(query, hasGlobalAccess || canManageFolders ? undefined : { allowedIds });
  return c.json(data);
});

databaseRoutes.openapi(
  { ...createDatabaseConnectionRoute, middleware: requireScope('databases:create') },
  async (c) => {
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const input = CreateDatabaseConnectionSchema.parse(await c.req.json());
    const data = await service.create(input, user.id);
    return c.json({ data }, 201);
  }
);

databaseRoutes.openapi(getDatabaseConnectionBySlugRoute, async (c) => {
  const service = container.resolve(DatabaseConnectionService);
  const data = await service.getBySlug(c.req.param('slug')!);
  const scopes = c.get('effectiveScopes') ?? [];
  if (!hasScope(scopes, `databases:view:${data.id}`)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: databases:view:${data.id}`);
  }
  return c.json({ data });
});

databaseRoutes.openapi(
  { ...getDatabaseConnectionRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const service = container.resolve(DatabaseConnectionService);
    const data = await service.get(c.req.param('id')!);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...getDatabaseHealthHistoryRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const service = container.resolve(DatabaseConnectionService);
    const data = await service.getHealthHistory(c.req.param('id')!);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...updateDatabaseConnectionRoute, middleware: requireScopeForResource('databases:edit', 'id') },
  async (c) => {
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const input = UpdateDatabaseConnectionSchema.parse(await c.req.json());
    const data = await service.update(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...deleteDatabaseConnectionRoute, middleware: requireScopeForResource('databases:delete', 'id') },
  async (c) => {
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    await service.delete(c.req.param('id')!, user.id);
    return c.json({ success: true });
  }
);

databaseRoutes.openapi(
  { ...testDatabaseConnectionRoute, middleware: requireScopeForResource('databases:edit', 'id') },
  async (c) => {
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const data = await service.testSavedConnection(c.req.param('id')!, user.id);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...revealDatabaseCredentialsRoute, middleware: requireScopeForResource('databases:credentials:reveal', 'id') },
  async (c) => {
    const service = container.resolve(DatabaseConnectionService);
    const data = await service.revealCredentials(c.req.param('id')!);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...databaseMonitoringStreamRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const databaseId = c.req.param('id')!;
    const monitoring = container.resolve(DatabaseMonitoringService);
    const connections = container.resolve(DatabaseConnectionService);

    return streamSSE(c, async (stream) => {
      const details = await connections.get(databaseId);
      const healthHistory = await connections.getHealthHistory(databaseId);
      const history = await monitoring.getHistory(databaseId);
      await stream.writeSSE({
        data: JSON.stringify({
          connected: true,
          databaseId,
          healthHistory,
          healthStatus: details.healthStatus,
        }),
        event: 'connected',
      });
      await stream.sleep(0);

      if (history.length > 0) {
        await stream.writeSSE({
          data: JSON.stringify({ databaseId, history }),
          event: 'history',
        });
      }

      const onSnapshot = (payload: { databaseId: string; snapshot: unknown }) => {
        if (payload.databaseId !== databaseId) return;
        stream.writeSSE({ data: JSON.stringify(payload.snapshot), event: 'snapshot' }).catch(() => {});
      };
      monitoring.on('snapshot', onSnapshot);
      monitoring.registerClient(databaseId);

      const keepalive = setInterval(() => {
        stream.writeSSE({ data: '', event: 'ping' }).catch(() => clearInterval(keepalive));
      }, 30_000);

      stream.onAbort(() => {
        clearInterval(keepalive);
        monitoring.off('snapshot', onSnapshot);
        monitoring.unregisterClient(databaseId);
      });

      await new Promise(() => {});
    });
  }
);

// Provider-neutral SQL explorer and console
databaseRoutes.openapi(
  { ...listSqlNamespacesRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, [
      'databases:query:read',
      'databases:query:write',
      'databases:query:admin',
    ]);
    const service = container.resolve(DatabaseConnectionService);
    const data = await service.listSqlNamespaces(c.req.param('id')!);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...listSqlObjectsRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, [
      'databases:query:read',
      'databases:query:write',
      'databases:query:admin',
    ]);
    const service = container.resolve(DatabaseConnectionService);
    const namespace = c.req.query('namespace');
    if (!namespace) throw new AppError(400, 'VALIDATION_ERROR', 'namespace is required');
    const data = await service.listSqlObjects(c.req.param('id')!, namespace);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...sqlTableMetadataRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, [
      'databases:query:read',
      'databases:query:write',
      'databases:query:admin',
    ]);
    const service = container.resolve(DatabaseConnectionService);
    const query = SqlTableQuerySchema.parse(c.req.query());
    const data = await service.getSqlTableMetadata(c.req.param('id')!, query.namespace, query.table);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...browseSqlRowsRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, [
      'databases:query:read',
      'databases:query:write',
      'databases:query:admin',
    ]);
    const service = container.resolve(DatabaseConnectionService);
    const query = BrowseSqlRowsQuerySchema.parse(c.req.query());
    const data = await service.browseSqlRows(
      c.req.param('id')!,
      query.namespace,
      query.table,
      query.page,
      query.limit,
      {
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        search:
          query.searchColumn && query.searchOperation && query.searchValue
            ? { column: query.searchColumn, operation: query.searchOperation, value: query.searchValue }
            : undefined,
      }
    );
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...insertSqlRowRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const databaseId = c.req.param('id')!;
    ensureAnyDatabaseScope(c, databaseId, ['databases:query:write', 'databases:query:admin']);
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const input = InsertSqlRowSchema.parse(await c.req.json());
    const data = await service.insertSqlRow(databaseId, input.namespace, input.table, input.values, user.id);
    return c.json({ data }, 201);
  }
);

databaseRoutes.openapi(
  { ...updateSqlRowRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const databaseId = c.req.param('id')!;
    ensureAnyDatabaseScope(c, databaseId, ['databases:query:write', 'databases:query:admin']);
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const input = UpdateSqlRowSchema.parse(await c.req.json());
    const data = await service.updateSqlRow(
      databaseId,
      input.namespace,
      input.table,
      input.locator,
      input.values,
      user.id
    );
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...deleteSqlRowRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const databaseId = c.req.param('id')!;
    ensureAnyDatabaseScope(c, databaseId, ['databases:query:write', 'databases:query:admin']);
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const input = DeleteSqlRowSchema.parse(await c.req.json());
    const data = await service.deleteSqlRow(databaseId, input.namespace, input.table, input.locator, user.id);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...executeSqlRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const { sql, maxRows } = ExecuteSqlSchema.parse(await c.req.json());
    ensureQueryScope(c, c.req.param('id')!, await service.inferSqlIntent(c.req.param('id')!, sql));
    const data = await service.executeSql(c.req.param('id')!, sql, user.id, { maxRows });
    return c.json({ data });
  }
);

// Postgres explorer
databaseRoutes.openapi(
  { ...listPostgresSchemasRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, [
      'databases:query:read',
      'databases:query:write',
      'databases:query:admin',
    ]);
    const service = container.resolve(DatabaseConnectionService);
    const data = await service.listPostgresSchemas(c.req.param('id')!);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...listPostgresTablesRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, [
      'databases:query:read',
      'databases:query:write',
      'databases:query:admin',
    ]);
    const service = container.resolve(DatabaseConnectionService);
    const schema = c.req.query('schema');
    if (!schema) throw new AppError(400, 'VALIDATION_ERROR', 'schema is required');
    const data = await service.listPostgresTables(c.req.param('id')!, schema);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...postgresTableMetadataRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, [
      'databases:query:read',
      'databases:query:write',
      'databases:query:admin',
    ]);
    const service = container.resolve(DatabaseConnectionService);
    const query = BrowsePostgresRowsQuerySchema.pick({ schema: true, table: true }).parse(c.req.query());
    const data = await service.getPostgresTableMetadata(c.req.param('id')!, query.schema, query.table);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...browsePostgresRowsRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, [
      'databases:query:read',
      'databases:query:write',
      'databases:query:admin',
    ]);
    const service = container.resolve(DatabaseConnectionService);
    const query = BrowsePostgresRowsQuerySchema.parse(c.req.query());
    const data = await service.browsePostgresRows(
      c.req.param('id')!,
      query.schema,
      query.table,
      query.page,
      query.limit,
      query.sortBy,
      query.sortOrder,
      query.searchColumn && query.searchOperation && query.searchValue
        ? {
            column: query.searchColumn,
            operation: query.searchOperation,
            value: query.searchValue,
          }
        : undefined
    );
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...insertPostgresRowRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, ['databases:query:write', 'databases:query:admin']);
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const body = await c.req.json();
    const schema = BrowsePostgresRowsQuerySchema.pick({ schema: true, table: true }).parse(body);
    const values = PostgresObjectSchema.parse(body.values ?? {});
    const data = await service.insertPostgresRow(c.req.param('id')!, schema.schema, schema.table, values, user.id);
    return c.json({ data }, 201);
  }
);

databaseRoutes.openapi(
  { ...updatePostgresRowRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, ['databases:query:write', 'databases:query:admin']);
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const body = await c.req.json();
    const schema = BrowsePostgresRowsQuerySchema.pick({ schema: true, table: true }).parse(body);
    const primaryKey = PostgresObjectSchema.parse(body.primaryKey ?? {});
    const values = PostgresObjectSchema.parse(body.values ?? {});
    const data = await service.updatePostgresRow(
      c.req.param('id')!,
      schema.schema,
      schema.table,
      primaryKey,
      values,
      user.id
    );
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...deletePostgresRowRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, ['databases:query:write', 'databases:query:admin']);
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const body = await c.req.json();
    const schema = BrowsePostgresRowsQuerySchema.pick({ schema: true, table: true }).parse(body);
    const primaryKey = PostgresObjectSchema.parse(body.primaryKey ?? {});
    const data = await service.deletePostgresRow(c.req.param('id')!, schema.schema, schema.table, primaryKey, user.id);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...addPostgresColumnRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, ['databases:query:admin']);
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const input = AddPostgresColumnSchema.parse(await c.req.json());
    const data = await service.addPostgresColumn(
      c.req.param('id')!,
      input.schema,
      input.table,
      input.column,
      input.dataType,
      user.id
    );
    return c.json({ data }, 201);
  }
);

databaseRoutes.openapi(
  { ...deletePostgresColumnRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, ['databases:query:admin']);
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const input = DeletePostgresColumnSchema.parse(await c.req.json());
    const data = await service.deletePostgresColumn(
      c.req.param('id')!,
      input.schema,
      input.table,
      input.column,
      user.id
    );
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...updatePostgresColumnTypeRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, ['databases:query:admin']);
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const input = UpdatePostgresColumnTypeSchema.parse(await c.req.json());
    const data = await service.updatePostgresColumnType(
      c.req.param('id')!,
      input.schema,
      input.table,
      input.column,
      input.dataType,
      user.id
    );
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...executePostgresQueryRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const { sql, maxRows } = ExecutePostgresSqlSchema.parse(await c.req.json());
    ensureQueryScope(c, c.req.param('id')!, inferPostgresIntent(sql));
    const data = await service.executePostgresSql(c.req.param('id')!, sql, user.id, { maxRows });
    return c.json({ data });
  }
);

// Redis explorer
databaseRoutes.openapi(
  { ...scanRedisKeysRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, [
      'databases:query:read',
      'databases:query:write',
      'databases:query:admin',
    ]);
    const service = container.resolve(DatabaseConnectionService);
    const query = RedisScanKeysQuerySchema.parse(c.req.query());
    const data = await service.scanRedisKeys(c.req.param('id')!, query.cursor, query.limit, query.search, query.type);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...getRedisKeyRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, [
      'databases:query:read',
      'databases:query:write',
      'databases:query:admin',
    ]);
    const service = container.resolve(DatabaseConnectionService);
    const query = RedisGetKeyQuerySchema.parse(c.req.query());
    const data = await service.getRedisKey(c.req.param('id')!, query.key, {
      offset: query.offset,
      limit: query.limit,
      maxStringBytes: query.maxStringBytes,
    });
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...setRedisKeyRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, ['databases:query:write', 'databases:query:admin']);
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const body = RedisSetKeySchema.parse(await c.req.json());
    const data = await service.setRedisKey(
      c.req.param('id')!,
      body.key,
      body.type,
      body.value,
      body.ttlSeconds,
      user.id
    );
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...deleteRedisKeyRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, ['databases:query:write', 'databases:query:admin']);
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const body = RedisGetKeyQuerySchema.parse(await c.req.json());
    const data = await service.deleteRedisKey(c.req.param('id')!, body.key, user.id);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...expireRedisKeyRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, ['databases:query:write', 'databases:query:admin']);
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const body = RedisExpireKeySchema.parse(await c.req.json());
    const data = await service.expireRedisKey(c.req.param('id')!, body.key, body.ttlSeconds, user.id);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...executeRedisCommandRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const { command } = ExecuteRedisCommandSchema.parse(await c.req.json());
    ensureQueryScope(c, c.req.param('id')!, inferRedisIntent(command));
    const data = await service.executeRedisCommand(c.req.param('id')!, command, user.id);
    return c.json({ data });
  }
);
