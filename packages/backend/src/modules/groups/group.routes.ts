import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeBase, hasScopeForCreation } from '@/lib/permissions.js';
import { canonicalizeScopes } from '@/lib/scopes.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import {
  authMiddleware,
  requireScope,
  requireScopeBase,
  requireScopeForResource,
  sessionOnly,
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
import { GroupService } from './group.service.js';
import { PermissionGroupFolderService } from './permission-group-folders.service.js';

export const groupRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

groupRoutes.use('*', authMiddleware);
groupRoutes.use('*', sessionOnly);

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
groupRoutes.openapi({ ...listGroupsRoute, middleware: requireScopeBase('admin:groups') }, async (c) => {
  const groupService = container.resolve(GroupService);
  const groups = await groupService.listGroups();
  const scopes = c.get('effectiveScopes') || [];
  return c.json(groups.filter((group) => hasScope(scopes, `admin:groups:${group.id}`)));
});

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
        throw new AppError(403, 'FORBIDDEN', 'Group is outside your permissions');
    if (!hasScopeForCreation(scopes, 'admin:groups', input.folderId))
      throw new AppError(403, 'FORBIDDEN', 'Destination folder is outside your permissions');
    await service.moveResourcesToFolder(input, user.id);
    return c.json({ success: true });
  }
);

groupRoutes.openapi({ ...reorderGroupsRoute, middleware: requireScope('admin:groups:folders:manage') }, async (c) => {
  const service = container.resolve(PermissionGroupFolderService);
  const input = ReorderResourcesSchema.parse(await c.req.json());
  for (const item of input.items)
    if (!hasScope(c.get('effectiveScopes') || [], `admin:groups:${item.id}`))
      throw new AppError(403, 'FORBIDDEN', 'Group is outside your permissions');
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

// Get single group
groupRoutes.openapi({ ...getGroupRoute, middleware: requireScopeForResource('admin:groups', 'id') }, async (c) => {
  const groupService = container.resolve(GroupService);
  const id = c.req.param('id')!;
  const group = await groupService.getGroup(id);
  return c.json(group);
});

// Create custom group
groupRoutes.openapi({ ...createGroupRoute, middleware: requireScopeBase('admin:groups') }, async (c) => {
  const groupService = container.resolve(GroupService);
  const auditService = container.resolve(AuditService);
  const user = c.get('user')!;
  const body = await c.req.json();
  const parsedInput = CreateGroupSchema.parse(body);
  const input = { ...parsedInput, scopes: canonicalizeScopes(parsedInput.scopes) };

  const userScopes = c.get('effectiveScopes') || [];
  if (!hasScopeForCreation(userScopes, 'admin:groups', input.folderId))
    throw new AppError(403, 'FORBIDDEN', 'Select an authorized destination group folder');
  if (input.folderId) await container.resolve(PermissionGroupFolderService).assertFolderExists(input.folderId);
  await groupService.assertCanCreateGroup(input, userScopes);

  const group = await groupService.createGroup(input);

  await auditService.log({
    userId: user.id,
    action: 'group.create',
    resourceType: 'permission_group',
    resourceId: group.id,
    details: { name: group.name, scopes: input.scopes },
    userAgent: c.req.header('user-agent'),
  });

  return c.json(group, 201);
});

// Update custom group
groupRoutes.openapi({ ...updateGroupRoute, middleware: requireScopeForResource('admin:groups', 'id') }, async (c) => {
  const groupService = container.resolve(GroupService);
  const auditService = container.resolve(AuditService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const body = await c.req.json();
  const parsedInput = UpdateGroupSchema.parse(body);
  const input = {
    ...parsedInput,
    ...(parsedInput.scopes !== undefined && { scopes: canonicalizeScopes(parsedInput.scopes) }),
  };

  const userScopes = c.get('effectiveScopes') || [];
  await groupService.assertCanUpdateGroup(id, input, userScopes);

  const group = await groupService.updateGroup(id, input);

  await auditService.log({
    userId: user.id,
    action: 'group.update',
    resourceType: 'permission_group',
    resourceId: id,
    details: { changes: input },
    userAgent: c.req.header('user-agent'),
  });

  return c.json(group);
});

// Delete custom group
groupRoutes.openapi({ ...deleteGroupRoute, middleware: requireScopeForResource('admin:groups', 'id') }, async (c) => {
  const groupService = container.resolve(GroupService);
  const auditService = container.resolve(AuditService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const userScopes = c.get('effectiveScopes') || [];

  await groupService.assertCanDeleteGroup(id, userScopes);

  // getGroup will throw 404 if not found, and deleteGroup will throw if built-in or has members
  const group = await groupService.getGroup(id);
  await groupService.deleteGroup(id);

  await auditService.log({
    userId: user.id,
    action: 'group.delete',
    resourceType: 'permission_group',
    resourceId: id,
    details: { name: group.name },
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ message: 'Group deleted' });
});
