import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeBase } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  authMiddleware,
  requireScope,
  requireScopeBase,
  requireScopeForResource,
} from '@/modules/auth/auth.middleware.js';
import { decodeComposeServiceTarget } from '@/modules/docker/compose/compose-managed-bindings.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { assertDockerResourceScope } from '@/modules/docker/docker-access.middleware.js';
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
  createManagedDatabaseBindingRoute,
  createManagedDatabaseRoute,
  databaseMonitoringStreamRoute,
  deleteDatabaseConnectionRoute,
  deleteDatabaseFolderRoute,
  deleteManagedDatabaseBindingRoute,
  deleteManagedDatabaseRoute,
  deletePostgresColumnRoute,
  deletePostgresRowRoute,
  deleteRedisKeyRoute,
  deleteSqlRowRoute,
  disableManagedPostgresExtensionRoute,
  enableManagedPostgresExtensionRoute,
  executePostgresQueryRoute,
  executeRedisCommandRoute,
  executeSqlRoute,
  expireRedisKeyRoute,
  getDatabaseConnectionBySlugRoute,
  getDatabaseConnectionRoute,
  getDatabaseHealthHistoryRoute,
  getManagedDatabaseRoute,
  getRedisKeyRoute,
  insertPostgresRowRoute,
  insertSqlRowRoute,
  listDatabaseConnectionsRoute,
  listDatabaseFoldersRoute,
  listManagedDatabaseBindingsRoute,
  listManagedDatabaseCatalogRoute,
  listManagedDatabasesRoute,
  listManagedPostgresExtensionsRoute,
  listPostgresSchemasRoute,
  listPostgresTablesRoute,
  listSqlNamespacesRoute,
  listSqlObjectsRoute,
  moveDatabaseFolderRoute,
  moveDatabasesToFolderRoute,
  pauseManagedDatabaseRoute,
  postgresTableMetadataRoute,
  reorderDatabaseFoldersRoute,
  reorderDatabasesRoute,
  restartManagedDatabaseRoute,
  retryManagedDatabaseProvisioningRoute,
  revealDatabaseCredentialsRoute,
  revealManagedDatabaseBindingCredentialsRoute,
  revealManagedDatabaseCredentialsRoute,
  rotateManagedDatabaseCertificateRoute,
  rotateManagedDatabaseDirectCredentialsRoute,
  scanRedisKeysRoute,
  setRedisKeyRoute,
  sqlTableMetadataRoute,
  testDatabaseConnectionRoute,
  unpauseManagedDatabaseRoute,
  updateDatabaseConnectionRoute,
  updateDatabaseFolderRoute,
  updateManagedDatabaseRoute,
  updatePostgresColumnTypeRoute,
  updatePostgresRowRoute,
  updateSqlRowRoute,
} from './databases.docs.js';
import {
  AddPostgresColumnSchema,
  BrowsePostgresRowsQuerySchema,
  BrowseSqlRowsQuerySchema,
  CreateDatabaseConnectionSchema,
  CreateManagedDatabaseBindingSchema,
  CreateManagedDatabaseSchema,
  DatabaseListQuerySchema,
  DeleteManagedDatabaseBindingSchema,
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
  UpdateManagedDatabaseSchema,
  UpdatePostgresColumnTypeSchema,
  UpdateSqlRowSchema,
} from './databases.schemas.js';
import {
  DatabaseConnectionService,
  inferPostgresIntent,
  inferRedisIntent,
  type SqlQueryAccess,
} from './databases.service.js';
import { ManagedDatabaseBindingService } from './managed-database-bindings.service.js';
import { ManagedDatabaseService } from './managed-databases.service.js';

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

export function resolveSqlQueryAccess(c: any, databaseId: string, intent: 'read' | 'write' | 'admin'): SqlQueryAccess {
  const scopes = c.get('effectiveScopes') ?? [];
  if (hasScope(scopes, `databases:query:admin:${databaseId}`)) return 'admin';
  if (intent === 'write' && hasScope(scopes, `databases:query:write:${databaseId}`)) return 'write';
  if (
    intent === 'read' &&
    (hasScope(scopes, `databases:query:read:${databaseId}`) || hasScope(scopes, `databases:query:write:${databaseId}`))
  ) {
    return 'read';
  }
  ensureQueryScope(c, databaseId, intent);
  throw new AppError(403, 'FORBIDDEN', `Missing required scope for database ${databaseId}`);
}

function ensureAnyDatabaseScope(c: any, databaseId: string, scopeBases: string[]) {
  const scopes = c.get('effectiveScopes') ?? [];
  const granted = scopeBases.some((base) => hasScope(scopes, `${base}:${databaseId}`));
  if (!granted) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope for database ${databaseId}`);
  }
}

/**
 * Managed-database routes use the instance ID in their URL, but scoped
 * database permissions are issued for the canonical database connection that
 * users see everywhere else. Resolve that mapping before checking a
 * resource-scoped grant so the UI and API authorize the same resource.
 */
export function requireManagedDatabaseScopes(...scopeBases: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = c.get('effectiveScopes') ?? [];
    const missingBases = scopeBases.filter((scopeBase) => !hasScope(scopes, scopeBase));
    if (missingBases.length > 0) {
      const managedDatabaseId = c.req.param('id');
      if (!managedDatabaseId) {
        throw new AppError(400, 'MANAGED_DATABASE_ID_REQUIRED', 'Managed database id is required');
      }
      const canonicalDatabaseId = await container
        .resolve(ManagedDatabaseService)
        .getCanonicalScopeResourceId(managedDatabaseId);
      const missingResources = missingBases.filter(
        (scopeBase) => !hasScope(scopes, `${scopeBase}:${canonicalDatabaseId}`)
      );
      if (missingResources.length > 0) {
        throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${missingResources.join(', ')}`);
      }
    }
    await next();
  };
}

type ManagedDatabaseBindingTarget = {
  targetNodeId: string;
  targetType: 'container' | 'deployment' | 'compose_service';
  targetResourceId: string;
};

/**
 * Binding a database changes the target workload, not only the database. Keep
 * the two authorization domains explicit so a database editor cannot inject
 * credentials into someone else's application.
 */
export async function assertManagedDatabaseBindingTargetAccess(c: any, target: ManagedDatabaseBindingTarget) {
  const scopes = c.get('effectiveScopes') || [];
  if (target.targetType === 'compose_service') {
    const composeTarget = decodeComposeServiceTarget(target.targetResourceId);
    assertDockerResourceScope(scopes, 'docker:compose:manage', target.targetNodeId, composeTarget.projectId);
  } else if (target.targetType === 'deployment') {
    for (const scope of ['docker:containers:edit', 'docker:containers:manage', 'docker:containers:secrets']) {
      assertDockerResourceScope(scopes, scope, target.targetNodeId, target.targetResourceId);
    }
  } else {
    const targetScopes = ['docker:containers:environment', 'docker:containers:secrets'];
    // A node- or globally-scoped token does not need to inspect the target
    // first. This keeps binding cleanup possible after a workload has already
    // been removed, while resource-scoped tokens retain the strict identity
    // lookup below.
    const canAccessNode = targetScopes.every(
      (scope) => hasScope(scopes, scope) || hasScope(scopes, `${scope}:${target.targetNodeId}`)
    );
    if (!canAccessNode) {
      const inspected = await container
        .resolve(DockerManagementService)
        .inspectContainer(target.targetNodeId, target.targetResourceId);
      const resourceId = String(inspected?.scopeResourceId ?? '');
      if (!resourceId) throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
      for (const scope of targetScopes) {
        assertDockerResourceScope(scopes, scope, target.targetNodeId, resourceId);
      }
    }
  }
  for (const scope of ['docker:networks:create', 'docker:networks:edit', 'docker:networks:delete']) {
    assertDockerResourceScope(scopes, scope, target.targetNodeId, '');
  }
}

databaseRoutes.use('*', authMiddleware);

databaseRoutes.get('/:id/logs', requireScopeForResource('databases:view', 'id'), async (c) => {
  const requestedTail = Number(c.req.query('tail')) || 500;
  const tailLines = Math.min(Math.max(Math.trunc(requestedTail), 1), 5_000);
  const data = await container.resolve(ManagedDatabaseService).getLogs(c.req.param('id')!, {
    tailLines,
    follow: false,
    timestamps: c.req.query('timestamps') !== 'false',
  });
  return c.json({ data });
});

databaseRoutes.openapi(
  { ...listManagedDatabaseCatalogRoute, middleware: requireScopeBase('databases:view') },
  async (c) => c.json({ data: container.resolve(ManagedDatabaseService).listCatalog() })
);

databaseRoutes.openapi({ ...listManagedDatabasesRoute, middleware: requireScopeBase('databases:view') }, async (c) => {
  const scopes = c.get('effectiveScopes') || [];
  const data = await container.resolve(ManagedDatabaseService).list();
  const allowedIds = hasScope(scopes, 'databases:view')
    ? null
    : new Set(getResourceScopedIds(scopes, 'databases:view'));
  return c.json({
    data: allowedIds ? data.filter((database) => allowedIds.has(database.databaseConnectionId ?? '')) : data,
  });
});

databaseRoutes.openapi({ ...createManagedDatabaseRoute, middleware: requireScope('databases:create') }, async (c) => {
  const user = c.get('user')!;
  const input = CreateManagedDatabaseSchema.parse(await c.req.json());
  const data = await container.resolve(ManagedDatabaseService).create(input, user.id);
  return c.json({ data }, 201);
});

databaseRoutes.openapi(
  { ...getManagedDatabaseRoute, middleware: requireManagedDatabaseScopes('databases:view') },
  async (c) => c.json({ data: await container.resolve(ManagedDatabaseService).get(c.req.param('id')!) })
);

databaseRoutes.openapi(
  { ...updateManagedDatabaseRoute, middleware: requireManagedDatabaseScopes('databases:edit') },
  async (c) => {
    const user = c.get('user')!;
    const input = UpdateManagedDatabaseSchema.parse(await c.req.json());
    const data = await container.resolve(ManagedDatabaseService).update(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...deleteManagedDatabaseRoute, middleware: requireManagedDatabaseScopes('databases:delete') },
  async (c) => {
    const user = c.get('user')!;
    const data = await container.resolve(ManagedDatabaseService).delete(c.req.param('id')!, user.id);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...retryManagedDatabaseProvisioningRoute, middleware: requireManagedDatabaseScopes('databases:edit') },
  async (c) => {
    const user = c.get('user')!;
    const data = await container.resolve(ManagedDatabaseService).retryProvisioning(c.req.param('id')!, user.id);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...restartManagedDatabaseRoute, middleware: requireManagedDatabaseScopes('databases:edit') },
  async (c) => {
    const user = c.get('user')!;
    return c.json({ data: await container.resolve(ManagedDatabaseService).restart(c.req.param('id')!, user.id) });
  }
);

databaseRoutes.openapi(
  { ...pauseManagedDatabaseRoute, middleware: requireManagedDatabaseScopes('databases:edit') },
  async (c) => {
    const user = c.get('user')!;
    return c.json({ data: await container.resolve(ManagedDatabaseService).pause(c.req.param('id')!, user.id) });
  }
);

databaseRoutes.openapi(
  { ...unpauseManagedDatabaseRoute, middleware: requireManagedDatabaseScopes('databases:edit') },
  async (c) => {
    const user = c.get('user')!;
    return c.json({ data: await container.resolve(ManagedDatabaseService).unpause(c.req.param('id')!, user.id) });
  }
);

databaseRoutes.openapi(
  {
    ...revealManagedDatabaseCredentialsRoute,
    middleware: requireManagedDatabaseScopes('databases:credentials:reveal'),
  },
  async (c) => c.json({ data: await container.resolve(ManagedDatabaseService).revealCredentials(c.req.param('id')!) })
);

databaseRoutes.openapi(
  {
    ...rotateManagedDatabaseDirectCredentialsRoute,
    middleware: requireManagedDatabaseScopes('databases:edit', 'databases:credentials:reveal'),
  },
  async (c) => {
    const user = c.get('user')!;
    return c.json({
      data: await container.resolve(ManagedDatabaseService).rotateDirectAccessCredentials(c.req.param('id')!, user.id),
    });
  }
);

databaseRoutes.openapi(
  { ...rotateManagedDatabaseCertificateRoute, middleware: requireManagedDatabaseScopes('databases:edit') },
  async (c) => {
    const user = c.get('user')!;
    return c.json({
      data: await container.resolve(ManagedDatabaseService).rotateCertificate(c.req.param('id')!, user.id),
    });
  }
);

databaseRoutes.openapi(
  { ...listManagedDatabaseBindingsRoute, middleware: requireManagedDatabaseScopes('databases:view') },
  async (c) => c.json({ data: await container.resolve(ManagedDatabaseBindingService).list(c.req.param('id')!) })
);

databaseRoutes.openapi(
  { ...createManagedDatabaseBindingRoute, middleware: requireManagedDatabaseScopes('databases:edit') },
  async (c) => {
    const user = c.get('user')!;
    const input = CreateManagedDatabaseBindingSchema.parse(await c.req.json());
    await assertManagedDatabaseBindingTargetAccess(c, input);
    const data = await container.resolve(ManagedDatabaseBindingService).create(c.req.param('id')!, input, user.id);
    return c.json({ data }, 201);
  }
);

databaseRoutes.openapi(
  { ...deleteManagedDatabaseBindingRoute, middleware: requireManagedDatabaseScopes('databases:delete') },
  async (c) => {
    const user = c.get('user')!;
    const bindings = container.resolve(ManagedDatabaseBindingService);
    const managedDatabaseId = c.req.param('id')!;
    const bindingId = c.req.param('bindingId')!;
    await assertManagedDatabaseBindingTargetAccess(c, await bindings.getTarget(managedDatabaseId, bindingId));
    const body = await c.req.json().catch(() => ({}));
    const input = DeleteManagedDatabaseBindingSchema.parse(body);
    const data = await bindings.delete(managedDatabaseId, bindingId, user.id, input);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  {
    ...revealManagedDatabaseBindingCredentialsRoute,
    middleware: requireManagedDatabaseScopes('databases:credentials:reveal'),
  },
  async (c) => {
    const bindings = container.resolve(ManagedDatabaseBindingService);
    const managedDatabaseId = c.req.param('id')!;
    const bindingId = c.req.param('bindingId')!;
    await assertManagedDatabaseBindingTargetAccess(c, await bindings.getTarget(managedDatabaseId, bindingId));
    return c.json({ data: await bindings.revealCredentials(managedDatabaseId, bindingId) });
  }
);

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
    const id = c.req.param('id')!;
    const managed = await container.resolve(ManagedDatabaseService).getByDatabaseConnectionId(id);
    if (managed) await container.resolve(ManagedDatabaseService).delete(managed.id, user.id);
    else await service.delete(id, user.id);
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
    const databaseId = c.req.param('id')!;
    const access = resolveSqlQueryAccess(c, databaseId, 'read');
    const service = container.resolve(DatabaseConnectionService);
    const data = await service.listSqlNamespaces(databaseId, access);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...listSqlObjectsRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const databaseId = c.req.param('id')!;
    const access = resolveSqlQueryAccess(c, databaseId, 'read');
    const service = container.resolve(DatabaseConnectionService);
    const namespace = c.req.query('namespace');
    if (!namespace) throw new AppError(400, 'VALIDATION_ERROR', 'namespace is required');
    const data = await service.listSqlObjects(databaseId, namespace, access);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...sqlTableMetadataRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const databaseId = c.req.param('id')!;
    const access = resolveSqlQueryAccess(c, databaseId, 'read');
    const service = container.resolve(DatabaseConnectionService);
    const query = SqlTableQuerySchema.parse(c.req.query());
    const data = await service.getSqlTableMetadata(databaseId, query.namespace, query.table, access);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...browseSqlRowsRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const databaseId = c.req.param('id')!;
    const access = resolveSqlQueryAccess(c, databaseId, 'read');
    const service = container.resolve(DatabaseConnectionService);
    const query = BrowseSqlRowsQuerySchema.parse(c.req.query());
    const data = await service.browseSqlRows(
      databaseId,
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
      },
      access
    );
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...insertSqlRowRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const databaseId = c.req.param('id')!;
    const access = resolveSqlQueryAccess(c, databaseId, 'write');
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const input = InsertSqlRowSchema.parse(await c.req.json());
    const data = await service.insertSqlRow(databaseId, input.namespace, input.table, input.values, user.id, access);
    return c.json({ data }, 201);
  }
);

databaseRoutes.openapi(
  { ...updateSqlRowRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const databaseId = c.req.param('id')!;
    const access = resolveSqlQueryAccess(c, databaseId, 'write');
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const input = UpdateSqlRowSchema.parse(await c.req.json());
    const data = await service.updateSqlRow(
      databaseId,
      input.namespace,
      input.table,
      input.locator,
      input.values,
      user.id,
      access
    );
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...deleteSqlRowRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const databaseId = c.req.param('id')!;
    const access = resolveSqlQueryAccess(c, databaseId, 'write');
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const input = DeleteSqlRowSchema.parse(await c.req.json());
    const data = await service.deleteSqlRow(databaseId, input.namespace, input.table, input.locator, user.id, access);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...executeSqlRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const { sql, maxRows } = ExecuteSqlSchema.parse(await c.req.json());
    const databaseId = c.req.param('id')!;
    const access = resolveSqlQueryAccess(c, databaseId, await service.inferSqlIntent(databaseId, sql));
    const data = await service.executeSql(databaseId, sql, user.id, { maxRows, signal: c.req.raw.signal }, access);
    return c.json({ data });
  }
);

// Postgres explorer
databaseRoutes.openapi(
  { ...listManagedPostgresExtensionsRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, [
      'databases:query:read',
      'databases:query:write',
      'databases:query:admin',
    ]);
    const service = container.resolve(DatabaseConnectionService);
    const data = await service.listManagedPostgresExtensions(c.req.param('id')!);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...enableManagedPostgresExtensionRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, ['databases:query:admin']);
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const data = await service.enableManagedPostgresExtension(c.req.param('id')!, c.req.param('name')!, user.id);
    return c.json({ data });
  }
);

databaseRoutes.openapi(
  { ...disableManagedPostgresExtensionRoute, middleware: requireScopeForResource('databases:view', 'id') },
  async (c) => {
    ensureAnyDatabaseScope(c, c.req.param('id')!, ['databases:query:admin']);
    const service = container.resolve(DatabaseConnectionService);
    const user = c.get('user')!;
    const data = await service.disableManagedPostgresExtension(c.req.param('id')!, c.req.param('name')!, user.id);
    return c.json({ data });
  }
);

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
