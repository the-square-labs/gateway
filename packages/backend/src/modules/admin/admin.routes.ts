import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { refreshGrpcServerCredentials } from '@/grpc/server.js';
import { createChildLogger } from '@/lib/logger.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { canManageUser, isScopeSubset } from '@/lib/permissions.js';
import { getRemoteAddress, resolveClientIp } from '@/lib/request-ip.js';
import {
  CreateUserSchema,
  UpdateAuthProvisioningSettingsSchema,
  UpdateBlockSchema,
  UpdateUserAdditionalPermissionsSchema,
  UpdateUserGroupSchema,
} from '@/modules/admin/admin.schemas.js';
import { AdminUserFolderService } from '@/modules/admin/admin-user-folders.service.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { authMiddleware, requireScope, sessionOnly } from '@/modules/auth/auth.middleware.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { GroupService } from '@/modules/groups/group.service.js';
import { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { NetworkSettingsService } from '@/modules/settings/network-settings.service.js';
import { OutboundWebhookPolicyService } from '@/modules/settings/outbound-webhook-policy.service.js';
import { GrpcIdentityService } from '@/services/grpc-identity.service.js';
import { SystemCAService } from '@/services/system-ca.service.js';
import type { AppEnv } from '@/types.js';
import {
  createAdminUserFolderRoute,
  createAdminUserRoute,
  deleteAdminUserFolderRoute,
  deleteAdminUserRoute,
  getAuthSettingsRoute,
  listAdminUserFoldersRoute,
  listAdminUsersRoute,
  moveAdminUserFolderRoute,
  moveAdminUsersToFolderRoute,
  reorderAdminUserFoldersRoute,
  reorderAdminUsersRoute,
  updateAdminUserFolderRoute,
  updateAuthSettingsRoute,
  updateUserAdditionalPermissionsRoute,
  updateUserBlockRoute,
  updateUserGroupRoute,
} from './admin.docs.js';

export const adminRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
const logger = createChildLogger('AdminRoutes');

adminRoutes.use('*', authMiddleware);
adminRoutes.use('*', sessionOnly);

function requireAnyAdminScope(...requiredScopes: string[]) {
  return async (c: any, next: () => Promise<void>) => {
    const scopes = c.get('effectiveScopes') || [];
    if (!requiredScopes.some((scope) => scopes.includes(scope))) {
      return c.json({ code: 'FORBIDDEN', message: `Missing required scope: ${requiredScopes.join(' or ')}` }, 403);
    }
    await next();
  };
}

function getEffectiveGroupScopes(group: { scopes: string[]; inheritedScopes?: string[] }) {
  return [...new Set([...(group.scopes ?? []), ...(group.inheritedScopes ?? [])])];
}

function touchesGrpcEndpointSettings(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const record = input as Record<string, unknown>;
  return 'gatewayGrpcPublicTarget' in record || 'gatewayGrpcLocalIp' in record;
}

// List all users
adminRoutes.openapi({ ...listAdminUsersRoute, middleware: requireScope('admin:users') }, async (c) => {
  const authService = container.resolve(AuthService);
  const userList = await authService.listUsers();
  return c.json(userList);
});

adminRoutes.openapi(
  { ...listAdminUserFoldersRoute, middleware: requireAnyAdminScope('admin:users', 'admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const scopes = c.get('effectiveScopes') || [];
    const data = await service.getFolderTree({ includeAllFolders: scopes.includes('admin:users:folders:manage') });
    return c.json({ data });
  }
);

adminRoutes.openapi(
  { ...createAdminUserFolderRoute, middleware: requireScope('admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const user = c.get('user')!;
    const input = CreateResourceFolderSchema.parse(await c.req.json());
    const data = await service.createFolder(input, user.id);
    return c.json({ data }, 201);
  }
);

adminRoutes.openapi(
  { ...reorderAdminUserFoldersRoute, middleware: requireScope('admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const input = ReorderResourceFoldersSchema.parse(await c.req.json());
    await service.reorderFolders(input);
    return c.json({ success: true });
  }
);

adminRoutes.openapi(
  { ...moveAdminUsersToFolderRoute, middleware: requireScope('admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const user = c.get('user')!;
    const input = MoveResourcesToFolderSchema.parse(await c.req.json());
    await service.moveResourcesToFolder(input, user.id);
    return c.json({ success: true });
  }
);

adminRoutes.openapi(
  { ...reorderAdminUsersRoute, middleware: requireScope('admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const input = ReorderResourcesSchema.parse(await c.req.json());
    await service.reorderResources(input);
    return c.json({ success: true });
  }
);

adminRoutes.openapi(
  { ...updateAdminUserFolderRoute, middleware: requireScope('admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const user = c.get('user')!;
    const input = UpdateResourceFolderSchema.parse(await c.req.json());
    const data = await service.updateFolder(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

adminRoutes.openapi(
  { ...moveAdminUserFolderRoute, middleware: requireScope('admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const user = c.get('user')!;
    const input = MoveResourceFolderSchema.parse(await c.req.json());
    const data = await service.moveFolder(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

adminRoutes.openapi(
  { ...deleteAdminUserFolderRoute, middleware: requireScope('admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const user = c.get('user')!;
    await service.deleteFolder(c.req.param('id')!, user.id);
    return c.json({ success: true });
  }
);

adminRoutes.openapi({ ...getAuthSettingsRoute, middleware: requireScope('settings:gateway:view') }, async (c) => {
  const authSettingsService = container.resolve(AuthSettingsService);
  const mcpSettingsService = container.resolve(McpSettingsService);
  const generalSettingsService = container.resolve(GeneralSettingsService);
  const networkSettingsService = container.resolve(NetworkSettingsService);
  const outboundWebhookPolicyService = container.resolve(OutboundWebhookPolicyService);
  const groupService = container.resolve(GroupService);
  const actorScopes = c.get('effectiveScopes') || [];

  const [settings, mcpSettings, generalSettings, networkSecurity, outboundWebhookPolicy, groups] = await Promise.all([
    authSettingsService.getConfig(),
    mcpSettingsService.getConfig(),
    generalSettingsService.getConfig(),
    networkSettingsService.getConfig(),
    outboundWebhookPolicyService.getConfig(),
    groupService.listGroups(),
  ]);
  const assignableGroups = groups.filter((group) => isScopeSubset(getEffectiveGroupScopes(group), actorScopes));

  return c.json({
    ...settings,
    mcpServerEnabled: mcpSettings.serverEnabled,
    mcpExtendedCompatibility: mcpSettings.extendedCompatibility,
    generalSettings,
    networkSecurity,
    outboundWebhookPolicy,
    currentRequestIp: resolveClientIp(c.req.raw.headers, getRemoteAddress(c), networkSecurity),
    availableGroups: assignableGroups.map((group) => ({
      id: group.id,
      name: group.name,
      isBuiltin: group.isBuiltin,
    })),
  });
});

adminRoutes.openapi({ ...updateAuthSettingsRoute, middleware: requireScope('settings:gateway:edit') }, async (c) => {
  const authSettingsService = container.resolve(AuthSettingsService);
  const mcpSettingsService = container.resolve(McpSettingsService);
  const generalSettingsService = container.resolve(GeneralSettingsService);
  const networkSettingsService = container.resolve(NetworkSettingsService);
  const outboundWebhookPolicyService = container.resolve(OutboundWebhookPolicyService);
  const groupService = container.resolve(GroupService);
  const auditService = container.resolve(AuditService);
  const currentUser = c.get('user')!;
  const actorScopes = c.get('effectiveScopes') || [];
  const body = await c.req.json();
  const input = UpdateAuthProvisioningSettingsSchema.parse(body);

  if (input.oidcDefaultGroupId) {
    const destGroup = await groupService.getGroup(input.oidcDefaultGroupId);
    if (!isScopeSubset(getEffectiveGroupScopes(destGroup), actorScopes)) {
      return c.json(
        { code: 'PRIVILEGE_BOUNDARY', message: 'Cannot assign a group with permissions you do not possess' },
        403
      );
    }
  }

  try {
    const shouldRefreshGrpcIdentity = touchesGrpcEndpointSettings(input.generalSettings);
    const previousGeneralSettings = shouldRefreshGrpcIdentity ? await generalSettingsService.getConfig() : null;
    const [updated, mcpSettings, generalSettings, networkSecurity, outboundWebhookPolicy] = await Promise.all([
      authSettingsService.updateConfig(input),
      mcpSettingsService.updateConfig({
        serverEnabled: input.mcpServerEnabled,
        extendedCompatibility: input.mcpExtendedCompatibility,
      }),
      input.generalSettings
        ? generalSettingsService.updateConfig(input.generalSettings)
        : generalSettingsService.getConfig(),
      input.networkSecurity
        ? networkSettingsService.updateConfig(input.networkSecurity)
        : networkSettingsService.getConfig(),
      input.outboundWebhookPolicy
        ? outboundWebhookPolicyService.updateConfig(input.outboundWebhookPolicy)
        : outboundWebhookPolicyService.getConfig(),
    ]);

    if (shouldRefreshGrpcIdentity) {
      const grpcIdentityService = container.resolve(GrpcIdentityService);
      const systemCA = container.resolve(SystemCAService);
      try {
        const grpcIdentity = await grpcIdentityService.refresh();
        await refreshGrpcServerCredentials(grpcIdentity.certPath, grpcIdentity.keyPath, systemCA);
      } catch (error) {
        if (previousGeneralSettings) {
          try {
            await generalSettingsService.updateConfig(previousGeneralSettings);
            const rollbackIdentity = await grpcIdentityService.refresh();
            await refreshGrpcServerCredentials(rollbackIdentity.certPath, rollbackIdentity.keyPath, systemCA);
          } catch (rollbackError) {
            logger.error('Failed to rollback gRPC endpoint settings after identity refresh failure', {
              error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
          }
        }
        throw error;
      }
    }

    const groups = await groupService.listGroups();
    const assignableGroups = groups.filter((group) => isScopeSubset(getEffectiveGroupScopes(group), actorScopes));

    await auditService.log({
      userId: currentUser.id,
      action: 'auth.settings_update',
      resourceType: 'settings',
      resourceId: 'auth',
      details: input,
      userAgent: c.req.header('user-agent'),
    });

    return c.json({
      ...updated,
      mcpServerEnabled: mcpSettings.serverEnabled,
      mcpExtendedCompatibility: mcpSettings.extendedCompatibility,
      generalSettings,
      networkSecurity,
      outboundWebhookPolicy,
      currentRequestIp: resolveClientIp(c.req.raw.headers, getRemoteAddress(c), networkSecurity),
      availableGroups: assignableGroups.map((group) => ({
        id: group.id,
        name: group.name,
        isBuiltin: group.isBuiltin,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update authentication settings';
    if (message === 'Permission group not found') {
      return c.json({ code: 'NOT_FOUND', message }, 404);
    }
    throw err;
  }
});

// Create user before first login
adminRoutes.openapi({ ...createAdminUserRoute, middleware: requireScope('admin:users') }, async (c) => {
  const authService = container.resolve(AuthService);
  const groupService = container.resolve(GroupService);
  const auditService = container.resolve(AuditService);
  const currentUser = c.get('user')!;
  const actorScopes = c.get('effectiveScopes') || [];
  const body = await c.req.json();
  const input = CreateUserSchema.parse(body);

  const destGroup = await groupService.getGroup(input.groupId);
  if (!isScopeSubset(getEffectiveGroupScopes(destGroup), actorScopes)) {
    return c.json(
      { code: 'PRIVILEGE_BOUNDARY', message: 'Cannot assign a group with permissions you do not possess' },
      403
    );
  }

  try {
    const createdUser = await authService.createUser(input);

    await auditService.log({
      userId: currentUser.id,
      action: 'user.create',
      resourceType: 'user',
      resourceId: createdUser.id,
      details: {
        targetUserId: createdUser.id,
        targetUserEmail: createdUser.email,
        targetUserName: createdUser.name,
        groupId: createdUser.groupId,
        groupName: createdUser.groupName,
      },
      userAgent: c.req.header('user-agent'),
    });

    return c.json(createdUser, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create user';
    if (message === 'User with this email already exists') {
      return c.json({ code: 'CONFLICT', message }, 409);
    }
    if (message === 'Permission group not found') {
      return c.json({ code: 'NOT_FOUND', message }, 404);
    }
    throw err;
  }
});

// Update user group
adminRoutes.openapi({ ...updateUserGroupRoute, middleware: requireScope('admin:users') }, async (c) => {
  const authService = container.resolve(AuthService);
  const auditService = container.resolve(AuditService);
  const currentUser = c.get('user')!;
  const actorScopes = c.get('effectiveScopes') || [];
  const userId = c.req.param('id')!;
  const body = await c.req.json();
  const { groupId } = UpdateUserGroupSchema.parse(body);

  const targetUser = await authService.assertCanUpdateUserGroup(currentUser.id, actorScopes, userId, groupId);

  const updatedUser = await authService.updateUserGroup(userId, groupId);

  await auditService.log({
    userId: currentUser.id,
    action: 'user.group_change',
    resourceType: 'user',
    resourceId: userId,
    details: {
      targetUserId: updatedUser.id,
      targetUserEmail: updatedUser.email,
      targetUserName: updatedUser.name,
      previousGroupId: targetUser.groupId,
      previousGroupName: targetUser.groupName,
      newGroupId: updatedUser.groupId,
      newGroupName: updatedUser.groupName,
    },
    userAgent: c.req.header('user-agent'),
  });

  return c.json(updatedUser);
});

// Replace user-specific additive permissions.
adminRoutes.openapi({ ...updateUserAdditionalPermissionsRoute, middleware: requireScope('admin:users') }, async (c) => {
  const authService = container.resolve(AuthService);
  const auditService = container.resolve(AuditService);
  const currentUser = c.get('user')!;
  const actorScopes = c.get('effectiveScopes') || [];
  const userId = c.req.param('id')!;
  const body = await c.req.json();
  const { additionalScopes: requestedScopes } = UpdateUserAdditionalPermissionsSchema.parse(body);

  const { targetUser, additionalScopes } = await authService.assertCanUpdateUserAdditionalScopes(
    currentUser.id,
    actorScopes,
    userId,
    requestedScopes
  );
  const previousAdditionalScopes = targetUser.additionalScopes ?? [];
  const updatedUser = await authService.updateUserAdditionalScopes(userId, additionalScopes);
  const previousSet = new Set(previousAdditionalScopes);
  const nextSet = new Set(additionalScopes);

  await auditService.log({
    userId: currentUser.id,
    action: 'user.additional_permissions_change',
    resourceType: 'user',
    resourceId: userId,
    details: {
      targetUserId: updatedUser.id,
      targetUserEmail: updatedUser.email,
      targetUserName: updatedUser.name,
      addedScopes: additionalScopes.filter((scope) => !previousSet.has(scope)),
      removedScopes: previousAdditionalScopes.filter((scope) => !nextSet.has(scope)),
      previousAdditionalScopes,
      additionalScopes,
      previousEffectiveScopes: targetUser.scopes,
      effectiveScopes: updatedUser.scopes,
    },
    userAgent: c.req.header('user-agent'),
  });

  return c.json(updatedUser);
});

// Block / unblock user
adminRoutes.openapi({ ...updateUserBlockRoute, middleware: requireScope('admin:users') }, async (c) => {
  const authService = container.resolve(AuthService);
  const auditService = container.resolve(AuditService);
  const currentUser = c.get('user')!;
  const actorScopes = c.get('effectiveScopes') || [];
  const userId = c.req.param('id')!;
  const body = await c.req.json();
  const { blocked } = UpdateBlockSchema.parse(body);

  if (userId === currentUser.id) {
    return c.json({ code: 'SELF_BLOCK', message: 'Cannot block yourself' }, 400);
  }

  // Check privilege boundary
  const targetUser = await authService.getUserById(userId);
  if (!targetUser) {
    return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
  }
  if (targetUser.oidcSubject.startsWith('system:')) {
    return c.json({ code: 'SYSTEM_USER', message: 'Cannot modify the system user' }, 403);
  }
  const denyReason = canManageUser(actorScopes, targetUser.scopes);
  if (denyReason) {
    return c.json({ code: 'PRIVILEGE_BOUNDARY', message: denyReason }, 403);
  }

  if (blocked) {
    await authService.blockUser(userId);
  } else {
    await authService.unblockUser(userId);
  }

  await auditService.log({
    userId: currentUser.id,
    action: blocked ? 'user.block' : 'user.unblock',
    resourceType: 'user',
    resourceId: userId,
    details: {
      targetUserId: targetUser.id,
      targetUserEmail: targetUser.email,
      targetUserName: targetUser.name,
      blocked,
    },
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ message: blocked ? 'User blocked' : 'User unblocked' });
});

// Delete user
adminRoutes.openapi({ ...deleteAdminUserRoute, middleware: requireScope('admin:users') }, async (c) => {
  const authService = container.resolve(AuthService);
  const auditService = container.resolve(AuditService);
  const currentUser = c.get('user')!;
  const actorScopes = c.get('effectiveScopes') || [];
  const userId = c.req.param('id')!;

  if (userId === currentUser.id) {
    return c.json({ code: 'SELF_DELETE', message: 'Cannot delete your own account' }, 400);
  }

  // Check privilege boundary
  const targetUser = await authService.getUserById(userId);
  if (!targetUser) {
    return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
  }
  if (targetUser.oidcSubject.startsWith('system:')) {
    return c.json({ code: 'SYSTEM_USER', message: 'Cannot delete the system user' }, 403);
  }
  const denyReason = canManageUser(actorScopes, targetUser.scopes);
  if (denyReason) {
    return c.json({ code: 'PRIVILEGE_BOUNDARY', message: denyReason }, 403);
  }

  await authService.deleteUser(userId);

  await auditService.log({
    userId: currentUser.id,
    action: 'user.delete',
    resourceType: 'user',
    resourceId: userId,
    details: {
      targetUserId: targetUser.id,
      targetUserEmail: targetUser.email,
      targetUserName: targetUser.name,
      targetGroupId: targetUser.groupId,
      targetGroupName: targetUser.groupName,
    },
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ message: 'User deleted' });
});
