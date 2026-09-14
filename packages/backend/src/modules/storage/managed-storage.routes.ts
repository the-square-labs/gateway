import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireScopeBase } from '@/modules/auth/auth.middleware.js';
import { assertManagedDatabaseBindingTargetAccess } from '@/modules/databases/databases.routes.js';
import type { AppEnv } from '@/types.js';
import {
  createManagedStorageAccessKeyRoute,
  createManagedStorageBindingRoute,
  createManagedStorageRoute,
  deleteManagedStorageBindingRoute,
  deleteManagedStorageRoute,
  getManagedStorageRoute,
  listManagedStorageAccessKeysRoute,
  listManagedStorageBindingsRoute,
  listManagedStorageCatalogRoute,
  listManagedStorageRoute,
  removeManagedStorageAccessKeyRoute,
  restartManagedStorageRoute,
  retryManagedStorageProvisioningRoute,
  revealManagedStorageCredentialsRoute,
  updateManagedStorageRoute,
} from './managed-storage.docs.js';
import {
  CreateManagedStorageAccessKeySchema,
  CreateManagedStorageBindingSchema,
  CreateManagedStorageSchema,
  DeleteManagedStorageBindingSchema,
  UpdateManagedStorageSchema,
} from './managed-storage.schemas.js';
import { ManagedStorageService } from './managed-storage.service.js';
import { ManagedStorageBindingsService } from './managed-storage-bindings.service.js';

export const managedStorageRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

/**
 * Managed-storage routes use the cluster ID in their URL, but scoped storage
 * permissions are issued for the canonical object storage connection that
 * users see everywhere else (Explorer, bindings, ...). Resolve that mapping
 * before checking a resource-scoped grant so the UI and API authorize the
 * same resource. Mirrors `requireManagedDatabaseScopes`
 * (`modules/databases/databases.routes.ts`).
 */
export function requireManagedStorageScopes(...scopeBases: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = c.get('effectiveScopes') ?? [];
    const missingBases = scopeBases.filter((scopeBase) => !hasScope(scopes, scopeBase));
    if (missingBases.length > 0) {
      const managedStorageId = c.req.param('id');
      if (!managedStorageId) {
        throw new AppError(400, 'MANAGED_STORAGE_ID_REQUIRED', 'Managed storage id is required');
      }
      const canonicalConnectionId = await container
        .resolve(ManagedStorageService)
        .getCanonicalScopeResourceId(managedStorageId);
      const missingResources = missingBases.filter(
        (scopeBase) => !hasScope(scopes, `${scopeBase}:${canonicalConnectionId}`)
      );
      if (missingResources.length > 0) {
        throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${missingResources.join(', ')}`);
      }
    }
    await next();
  };
}

managedStorageRoutes.use('*', authMiddleware);

managedStorageRoutes.openapi(
  { ...listManagedStorageCatalogRoute, middleware: requireScopeBase('storage:view') },
  async (c) => c.json({ data: container.resolve(ManagedStorageService).listCatalog() })
);

managedStorageRoutes.openapi(
  { ...listManagedStorageRoute, middleware: requireScopeBase('storage:view') },
  async (c) => {
    const scopes = c.get('effectiveScopes') ?? [];
    const data = await container.resolve(ManagedStorageService).list();
    const allowed = hasScope(scopes, 'storage:view') ? null : new Set(getResourceScopedIds(scopes, 'storage:view'));
    return c.json({ data: allowed ? data.filter((row) => allowed.has(row.objectStorageConnectionId ?? '')) : data });
  }
);

managedStorageRoutes.openapi(createManagedStorageRoute, async (c) => {
  const user = c.get('user')!;
  const input = CreateManagedStorageSchema.parse(await c.req.json());
  const scopes = c.get('effectiveScopes') ?? [];
  for (const nodeId of input.memberNodeIds ?? [input.nodeId]) {
    if (!hasScopeForCreation(scopes, 'storage:create', undefined, nodeId))
      throw new AppError(403, 'FORBIDDEN', 'Missing storage:create permission for the selected node');
  }
  const data = await container.resolve(ManagedStorageService).create(input, user.id);
  return c.json({ data }, 201);
});

managedStorageRoutes.openapi(
  { ...getManagedStorageRoute, middleware: requireManagedStorageScopes('storage:view') },
  async (c) => c.json({ data: await container.resolve(ManagedStorageService).get(c.req.param('id')!) })
);

managedStorageRoutes.openapi(
  { ...updateManagedStorageRoute, middleware: requireManagedStorageScopes('storage:edit') },
  async (c) => {
    const user = c.get('user')!;
    const input = UpdateManagedStorageSchema.parse(await c.req.json());
    const data = await container.resolve(ManagedStorageService).update(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

managedStorageRoutes.openapi(
  { ...deleteManagedStorageRoute, middleware: requireManagedStorageScopes('storage:delete') },
  async (c) => {
    const user = c.get('user')!;
    const data = await container.resolve(ManagedStorageService).delete(c.req.param('id')!, user.id);
    return c.json({ data });
  }
);

managedStorageRoutes.openapi(
  { ...retryManagedStorageProvisioningRoute, middleware: requireManagedStorageScopes('storage:edit') },
  async (c) => {
    const user = c.get('user')!;
    const data = await container.resolve(ManagedStorageService).retryProvisioning(c.req.param('id')!, user.id);
    return c.json({ data });
  }
);

managedStorageRoutes.openapi(
  { ...restartManagedStorageRoute, middleware: requireManagedStorageScopes('storage:edit') },
  async (c) => {
    const user = c.get('user')!;
    const data = await container.resolve(ManagedStorageService).restart(c.req.param('id')!, user.id);
    return c.json({ data });
  }
);

managedStorageRoutes.openapi(
  {
    ...revealManagedStorageCredentialsRoute,
    middleware: requireManagedStorageScopes('storage:credentials:reveal'),
  },
  async (c) => c.json({ data: await container.resolve(ManagedStorageService).revealCredentials(c.req.param('id')!) })
);

managedStorageRoutes.openapi(
  { ...createManagedStorageAccessKeyRoute, middleware: requireManagedStorageScopes('storage:iam') },
  async (c) => {
    const user = c.get('user')!;
    const input = CreateManagedStorageAccessKeySchema.parse(await c.req.json());
    const data = await container.resolve(ManagedStorageService).createAccessKey(c.req.param('id')!, input, user.id);
    return c.json({ data }, 201);
  }
);

managedStorageRoutes.openapi(
  { ...listManagedStorageAccessKeysRoute, middleware: requireManagedStorageScopes('storage:view') },
  async (c) => c.json({ data: await container.resolve(ManagedStorageService).listAccessKeys(c.req.param('id')!) })
);

managedStorageRoutes.openapi(
  { ...removeManagedStorageAccessKeyRoute, middleware: requireManagedStorageScopes('storage:iam') },
  async (c) => {
    const user = c.get('user')!;
    const data = await container
      .resolve(ManagedStorageService)
      .removeAccessKey(c.req.param('id')!, c.req.param('accessKeyId')!, user.id);
    return c.json({ data });
  }
);

// Bindings hand a workload a live, scoped credential for the cluster, so they
// are gated on storage:iam like the access keys they issue — storage:edit is
// deliberately not enough.
managedStorageRoutes.openapi(
  { ...createManagedStorageBindingRoute, middleware: requireManagedStorageScopes('storage:iam') },
  async (c) => {
    const user = c.get('user')!;
    const input = CreateManagedStorageBindingSchema.parse(await c.req.json());
    await assertManagedDatabaseBindingTargetAccess(c, input);
    const data = await container.resolve(ManagedStorageBindingsService).create(c.req.param('id')!, input, user.id);
    return c.json({ data }, 201);
  }
);

managedStorageRoutes.openapi(
  { ...listManagedStorageBindingsRoute, middleware: requireManagedStorageScopes('storage:view') },
  async (c) => c.json({ data: await container.resolve(ManagedStorageBindingsService).list(c.req.param('id')!) })
);

managedStorageRoutes.openapi(
  {
    ...deleteManagedStorageBindingRoute,
    request: { params: deleteManagedStorageBindingRoute.request!.params },
    middleware: requireManagedStorageScopes('storage:iam'),
  },
  async (c) => {
    const user = c.get('user')!;
    await assertManagedDatabaseBindingTargetAccess(
      c,
      await container.resolve(ManagedStorageBindingsService).getTarget(c.req.param('id')!, c.req.param('bindingId')!)
    );
    const body = await c.req.text();
    let parsed: unknown = {};
    if (body) {
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new AppError(400, 'INVALID_JSON', 'Invalid JSON request body');
      }
    }
    const options = DeleteManagedStorageBindingSchema.parse(parsed);
    const data = await container
      .resolve(ManagedStorageBindingsService)
      .delete(c.req.param('id')!, c.req.param('bindingId')!, user.id, options.targetEnvironment);
    return c.json(data);
  }
);
