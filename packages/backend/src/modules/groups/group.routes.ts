import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeBase, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  authMiddleware,
  requireScope,
  requireScopeBase,
  requireScopeForResource,
} from '@/modules/auth/auth.middleware.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import type { AppEnv } from '@/types.js';
import {
  createGroupFolderRoute,
  createGroupRoute,
  deleteGroupFolderRoute,
  deleteGroupRoute,
  getGroupRoute,
  listGroupFoldersRoute,
  listGroupsRoute,
  moveGroupFolderRoute,
  moveGroupsToFolderRoute,
  reorderGroupFoldersRoute,
  reorderGroupsRoute,
  updateGroupFolderRoute,
  updateGroupRoute,
} from './group.docs.js';
import { CreateGroupSchema, UpdateGroupSchema } from './group.schemas.js';
import {
  createGroupForActor,
  deleteGroupForActor,
  type GroupActor,
  getGroupForActor,
  listVisibleGroups,
  updateGroupForActor,
} from './group-actions.js';
import { PermissionGroupFolderService } from './permission-group-folders.service.js';

export const groupRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

groupRoutes.use('*', authMiddleware);

function requireAnyGroupScope(...requiredScopes: string[]) {
  return async (c: any, next: () => Promise<void>) => {
    const scopes = c.get('effectiveScopes') || [];
    if (!requiredScopes.some((scope) => hasScopeBase(scopes, scope))) {
      return c.json({ code: 'FORBIDDEN', message: `Missing required scope: ${requiredScopes.join(' or ')}` }, 403);
    }
    await next();
  };
}

// List all groups
groupRoutes.openapi({ ...listGroupsRoute, middleware: requireScopeBase('admin:groups') }, async (c) =>
  c.json(await listVisibleGroups(c.get('effectiveScopes') || []))
);

groupRoutes.openapi(
  { ...listGroupFoldersRoute, middleware: requireAnyGroupScope('admin:groups', 'admin:groups:folders:manage') },
  async (c) => {
    const service = container.resolve(PermissionGroupFolderService);
    const scopes = c.get('effectiveScopes') || [];
    const data = await service.getFolderTree(
      hasScope(scopes, 'admin:groups') || hasScope(scopes, 'admin:groups:folders:manage')
        ? { includeAllFolders: true }
        : {
            allowedResourceIds: getResourceScopedIds(scopes, 'admin:groups'),
            allowedFolderIds: getFolderScopedIds(scopes, ['admin:groups']),
          }
    );
    return c.json({ data });
  }
);

groupRoutes.openapi(
  { ...createGroupFolderRoute, middleware: requireScope('admin:groups:folders:manage') },
  async (c) => {
    const service = container.resolve(PermissionGroupFolderService);
    const user = c.get('user')!;
    const input = CreateResourceFolderSchema.parse(await c.req.json());
    const data = await service.createFolder(input, user.id);
    return c.json({ data }, 201);
  }
);

groupRoutes.openapi(
  { ...reorderGroupFoldersRoute, middleware: requireScope('admin:groups:folders:manage') },
  async (c) => {
    const service = container.resolve(PermissionGroupFolderService);
    const input = ReorderResourceFoldersSchema.parse(await c.req.json());
    await service.reorderFolders(input);
    return c.json({ success: true });
  }
);

groupRoutes.openapi(
  { ...moveGroupsToFolderRoute, middleware: requireScope('admin:groups:folders:manage') },
  async (c) => {
    const service = container.resolve(PermissionGroupFolderService);
    const user = c.get('user')!;
    const input = MoveResourcesToFolderSchema.parse(await c.req.json());
    const scopes = c.get('effectiveScopes') || [];
    for (const id of input.ids)
      if (!hasScope(scopes, `admin:groups:${id}`))
        throw new AppError(403, 'FORBIDDEN', 'Group is outside your permissions', {
          requiredScope: `admin:groups:${id}`,
        });
    if (!hasScopeForCreation(scopes, 'admin:groups', input.folderId))
      throw new AppError(403, 'FORBIDDEN', 'Destination folder is outside your permissions', {
        requiredScope: input.folderId ? `admin:groups:folder/${input.folderId}` : 'admin:groups',
      });
    await service.moveResourcesToFolder(input, user.id);
    return c.json({ success: true });
  }
);

groupRoutes.openapi({ ...reorderGroupsRoute, middleware: requireScope('admin:groups:folders:manage') }, async (c) => {
  const service = container.resolve(PermissionGroupFolderService);
  const input = ReorderResourcesSchema.parse(await c.req.json());
  for (const item of input.items)
    if (!hasScope(c.get('effectiveScopes') || [], `admin:groups:${item.id}`))
      throw new AppError(403, 'FORBIDDEN', 'Group is outside your permissions', {
        requiredScope: `admin:groups:${item.id}`,
      });
  await service.reorderResources(input);
  return c.json({ success: true });
});

groupRoutes.openapi(
  { ...updateGroupFolderRoute, middleware: requireScope('admin:groups:folders:manage') },
  async (c) => {
    const service = container.resolve(PermissionGroupFolderService);
    const user = c.get('user')!;
    const input = UpdateResourceFolderSchema.parse(await c.req.json());
    const data = await service.updateFolder(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

groupRoutes.openapi({ ...moveGroupFolderRoute, middleware: requireScope('admin:groups:folders:manage') }, async (c) => {
  const service = container.resolve(PermissionGroupFolderService);
  const user = c.get('user')!;
  const input = MoveResourceFolderSchema.parse(await c.req.json());
  const data = await service.moveFolder(c.req.param('id')!, input, user.id);
  return c.json({ data });
});

groupRoutes.openapi(
  { ...deleteGroupFolderRoute, middleware: requireScope('admin:groups:folders:manage') },
  async (c) => {
    const service = container.resolve(PermissionGroupFolderService);
    const user = c.get('user')!;
    await service.deleteFolder(c.req.param('id')!, user.id);
    return c.json({ success: true });
  }
);

function groupActor(c: any): GroupActor {
  return {
    id: c.get('user')!.id,
    scopes: c.get('effectiveScopes') || [],
    accountScopes: c.get('isTokenAuth') ? c.get('user')!.scopes : undefined,
    userAgent: c.req.header('user-agent'),
  };
}

// Get single group
groupRoutes.openapi({ ...getGroupRoute, middleware: requireScopeForResource('admin:groups', 'id') }, async (c) =>
  c.json(await getGroupForActor(groupActor(c), c.req.param('id')!))
);

// Create custom group
groupRoutes.openapi({ ...createGroupRoute, middleware: requireScopeBase('admin:groups') }, async (c) => {
  const input = CreateGroupSchema.parse(await c.req.json());
  return c.json(await createGroupForActor(groupActor(c), input), 201);
});

// Update custom group
groupRoutes.openapi({ ...updateGroupRoute, middleware: requireScopeForResource('admin:groups', 'id') }, async (c) => {
  const input = UpdateGroupSchema.parse(await c.req.json());
  return c.json(await updateGroupForActor(groupActor(c), c.req.param('id')!, input));
});

// Delete custom group
groupRoutes.openapi({ ...deleteGroupRoute, middleware: requireScopeForResource('admin:groups', 'id') }, async (c) => {
  await deleteGroupForActor(groupActor(c), c.req.param('id')!);
  return c.json({ message: 'Group deleted' });
});
