import { isIP } from 'node:net';
import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { refreshGrpcServerCredentials } from '@/grpc/server.js';
import { createChildLogger } from '@/lib/logger.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { canManageUser, isScopeSubset } from '@/lib/permissions.js';
import { getRemoteAddress, resolveClientIp } from '@/lib/request-ip.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  CreateUserSchema,
  RestoreUserSchema,
  type UpdateAuthProvisioningSettingsInput,
  UpdateAuthProvisioningSettingsSchema,
  UpdateBlockSchema,
  UpdateUserAdditionalPermissionsSchema,
  UpdateUserAuthMethodSchema,
  UpdateUserGroupSchema,
  UpdateUserNameSchema,
} from '@/modules/admin/admin.schemas.js';
import { AdminUserFolderService } from '@/modules/admin/admin-user-folders.service.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { authMiddleware, requireScope, sessionOnly } from '@/modules/auth/auth.middleware.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { AuthMailService } from '@/modules/auth/auth-mail.service.js';
import { LocalAuthService } from '@/modules/auth/local-auth.service.js';
import { MfaService } from '@/modules/auth/mfa.service.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { GroupService } from '@/modules/groups/group.service.js';
import { LoggingRuntimeService } from '@/modules/logging/logging-runtime.service.js';
import { LoggingSettingsService } from '@/modules/logging/logging-settings.service.js';
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
import { RuntimeRestartService } from '@/services/runtime-restart.service.js';
import { SessionService } from '@/services/session.service.js';
import { SystemCAService } from '@/services/system-ca.service.js';
import { WebIdentityService } from '@/services/web-identity.service.js';
import { WebTransportSettingsService } from '@/services/web-transport-settings.service.js';
import type { AppEnv } from '@/types.js';
import {
  createAdminUserFolderRoute,
  createAdminUserRoute,
  deleteAdminUserFolderRoute,
  deleteAdminUserRoute,
  getAuthSettingsRoute,
  listAdminUserFoldersRoute,
  listAdminUserSessionsRoute,
  listAdminUsersRoute,
  listDeletedAdminUsersRoute,
  moveAdminUserFolderRoute,
  moveAdminUsersToFolderRoute,
  reorderAdminUserFoldersRoute,
  reorderAdminUsersRoute,
  resetAdminUserMfaRoute,
  restoreAdminUserRoute,
  revokeAdminUserSessionRoute,
  revokeAllAdminUserSessionsRoute,
  sendAdminUserPasswordSetupRoute,
  updateAdminUserFolderRoute,
  updateAuthSettingsRoute,
  updateUserAdditionalPermissionsRoute,
  updateUserAuthMethodRoute,
  updateUserBlockRoute,
  updateUserGroupRoute,
  updateUserNameRoute,
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

// Deleted accounts are operationally invisible; only system administrators can inspect them.
adminRoutes.openapi({ ...listDeletedAdminUsersRoute, middleware: requireScope('admin:system') }, async (c) => {
  const authService = container.resolve(AuthService);
  return c.json(await authService.listDeletedUsers());
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
  const authMailService = container.resolve(AuthMailService);
  const mcpSettingsService = container.resolve(McpSettingsService);
  const generalSettingsService = container.resolve(GeneralSettingsService);
  const networkSettingsService = container.resolve(NetworkSettingsService);
  const outboundWebhookPolicyService = container.resolve(OutboundWebhookPolicyService);
  const groupService = container.resolve(GroupService);
  const actorScopes = c.get('effectiveScopes') || [];

  const [
    settings,
    smtp,
    oidc,
    logging,
    mcpSettings,
    generalSettings,
    webTransport,
    networkSecurity,
    outboundWebhookPolicy,
    groups,
  ] = await Promise.all([
    authSettingsService.getConfig(),
    authMailService.getPublicConfig(),
    container.resolve(OidcSettingsService).getPublicConfig(),
    container.resolve(LoggingSettingsService).getPublicConfig(),
    mcpSettingsService.getConfig(),
    generalSettingsService.getConfig(),
    container.resolve(WebTransportSettingsService).getConfig(),
    networkSettingsService.getConfig(),
    outboundWebhookPolicyService.getConfig(),
    groupService.listGroups(),
  ]);
  const assignableGroups = groups.filter((group) => isScopeSubset(getEffectiveGroupScopes(group), actorScopes));

  return c.json({
    ...settings,
    smtp,
    oidc,
    logging,
    mcpServerEnabled: mcpSettings.serverEnabled,
    mcpExtendedCompatibility: mcpSettings.extendedCompatibility,
    generalSettings,
    webTransport: { ...webTransport, restartRequired: false, directAccess: false, targetUrl: null },
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
  const authMailService = container.resolve(AuthMailService);
  const oidcSettingsService = container.resolve(OidcSettingsService);
  const mcpSettingsService = container.resolve(McpSettingsService);
  const generalSettingsService = container.resolve(GeneralSettingsService);
  const networkSettingsService = container.resolve(NetworkSettingsService);
  const outboundWebhookPolicyService = container.resolve(OutboundWebhookPolicyService);
  const webTransportSettingsService = container.resolve(WebTransportSettingsService);
  const loggingSettingsService = container.resolve(LoggingSettingsService);
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
    const previousWebTransport = await webTransportSettingsService.getConfig();
    if (input.smtp) {
      await authMailService.saveConfig(input.smtp);
      if (input.smtp.testRecipient)
        await authMailService.sendTestEmail(input.smtp.testRecipient, input.smtp.testEmailKind);
    }
    if (input.oidc) {
      await oidcSettingsService.saveConfig(input.oidc);
      container.resolve(AuthService).invalidateOidcConfiguration();
    }
    if (input.methods && (input.methods.password === true || input.methods.emailOtp === true)) {
      const smtp = await authMailService.getPublicConfig();
      if (!smtp.verifiedAt) {
        throw new AppError(
          409,
          'SMTP_NOT_VERIFIED',
          'Configure and verify SMTP before enabling password or email-code sign-in'
        );
      }
    }
    if (input.methods?.oidc === true && !(await oidcSettingsService.getPublicConfig()).configured) {
      throw new AppError(409, 'OIDC_NOT_CONFIGURED', 'Configure OIDC before enabling OIDC sign-in');
    }
    const logging = input.logging
      ? await container.resolve(LoggingRuntimeService).update(input.logging)
      : await loggingSettingsService.getPublicConfig();
    const shouldRefreshGrpcIdentity = touchesGrpcEndpointSettings(input.generalSettings);
    const shouldRefreshWebIdentity = input.generalSettings?.publicUrl !== undefined;
    const nextTlsEnabled = input.webTlsEnabled ?? previousWebTransport.tlsEnabled;
    const previousGeneralSettings =
      shouldRefreshGrpcIdentity || shouldRefreshWebIdentity ? await generalSettingsService.getConfig() : null;
    const [updated, smtp, oidc, mcpSettings, generalSettings, networkSecurity, outboundWebhookPolicy] =
      await Promise.all([
        authSettingsService.updateConfig(input),
        authMailService.getPublicConfig(),
        oidcSettingsService.getPublicConfig(),
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

    if (shouldRefreshGrpcIdentity || (shouldRefreshWebIdentity && nextTlsEnabled)) {
      const grpcIdentityService = container.resolve(GrpcIdentityService);
      const systemCA = container.resolve(SystemCAService);
      const webIdentityService = container.resolve(WebIdentityService);
      try {
        if (shouldRefreshGrpcIdentity) {
          const grpcIdentity = await grpcIdentityService.refresh();
          await refreshGrpcServerCredentials(grpcIdentity.certPath, grpcIdentity.keyPath, systemCA);
        }
        if (shouldRefreshWebIdentity && nextTlsEnabled) await webIdentityService.refresh();
      } catch (error) {
        if (previousGeneralSettings) {
          try {
            await generalSettingsService.updateConfig(previousGeneralSettings);
            if (shouldRefreshGrpcIdentity) {
              const rollbackIdentity = await grpcIdentityService.refresh();
              await refreshGrpcServerCredentials(rollbackIdentity.certPath, rollbackIdentity.keyPath, systemCA);
            }
            if (shouldRefreshWebIdentity && nextTlsEnabled) await webIdentityService.refresh();
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
      details: toAuthSettingsAuditDetails(input),
      userAgent: c.req.header('user-agent'),
    });

    let webTransport = {
      ...previousWebTransport,
      restartRequired: shouldRefreshWebIdentity && nextTlsEnabled,
      directAccess: false,
      targetUrl: null as string | null,
    };
    if (input.webTlsEnabled !== undefined && input.webTlsEnabled !== previousWebTransport.tlsEnabled) {
      const next = await webTransportSettingsService.updateConfig({ tlsEnabled: input.webTlsEnabled });
      const host = c.req.header('host') ?? '';
      let hostname = '';
      try {
        hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
      } catch {
        // Global host validation already rejected malformed values.
      }
      const directAccess = isIP(hostname) !== 0 && !c.req.header('x-forwarded-host');
      webTransport = {
        ...next,
        restartRequired: true,
        directAccess,
        targetUrl: directAccess ? `${next.tlsEnabled ? 'https' : 'http'}://${host}` : null,
      };
    }
    if (webTransport.restartRequired) {
      container.resolve(RuntimeRestartService).request('web identity or transport changed');
    }

    return c.json({
      ...updated,
      smtp,
      oidc,
      logging,
      mcpServerEnabled: mcpSettings.serverEnabled,
      mcpExtendedCompatibility: mcpSettings.extendedCompatibility,
      generalSettings,
      webTransport,
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

function toAuthSettingsAuditDetails(input: UpdateAuthProvisioningSettingsInput) {
  const { smtp: smtpInput, oidc: oidcInput, logging: loggingInput, ...rest } = input;
  const smtp = smtpInput ? (({ password: _password, ...safe }) => safe)(smtpInput) : undefined;
  const oidc = oidcInput ? (({ clientSecret: _clientSecret, ...safe }) => safe)(oidcInput) : undefined;
  const logging = loggingInput ? (({ password: _password, ...safe }) => safe)(loggingInput) : undefined;
  return {
    ...rest,
    ...(smtp ? { smtp: { ...smtp, ...(smtpInput?.password ? { passwordChanged: true } : {}) } } : {}),
    ...(oidc ? { oidc: { ...oidc, ...(oidcInput?.clientSecret ? { clientSecretChanged: true } : {}) } } : {}),
    ...(logging ? { logging: { ...logging, ...(loggingInput?.password ? { passwordChanged: true } : {}) } } : {}),
  };
}

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
    if (input.authMethod === 'password' && !(await container.resolve(AuthMailService).getPublicConfig()).verifiedAt) {
      return c.json(
        { code: 'SMTP_NOT_VERIFIED', message: 'SMTP must be verified before creating a password account' },
        409
      );
    }
    const createdUser = await authService.createUser(input);
    if (input.authMethod === 'password') {
      await container.resolve(LocalAuthService).requestPasswordLink(input.email, 'password_setup');
    }

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

adminRoutes.openapi({ ...updateUserAuthMethodRoute, middleware: requireScope('admin:users') }, async (c) => {
  const authService = container.resolve(AuthService);
  const auditService = container.resolve(AuditService);
  const currentUser = c.get('user')!;
  const actorScopes = c.get('effectiveScopes') || [];
  const userId = c.req.param('id')!;
  const { authMethod } = UpdateUserAuthMethodSchema.parse(await c.req.json());
  const targetUser = await authService.getUserById(userId);
  if (!targetUser) return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
  const denyReason = canManageUser(actorScopes, targetUser.scopes);
  if (denyReason) return c.json({ code: 'PRIVILEGE_BOUNDARY', message: denyReason }, 403);
  if (authMethod === 'password' && !(await container.resolve(AuthMailService).getPublicConfig()).verifiedAt) {
    return c.json(
      { code: 'SMTP_NOT_VERIFIED', message: 'SMTP must be verified before switching to password sign-in' },
      409
    );
  }
  const updated = await authService.updateUserAuthMethod(userId, authMethod);
  if (authMethod === 'password') {
    await container.resolve(LocalAuthService).requestPasswordLink(updated.email, 'password_setup');
  }
  await auditService.log({
    userId: currentUser.id,
    action: 'user.auth_method_change',
    resourceType: 'user',
    resourceId: updated.id,
    details: { targetUserId: updated.id, previousAuthMethod: targetUser.authMethod, authMethod },
    userAgent: c.req.header('user-agent'),
  });
  return c.json(updated);
});

adminRoutes.openapi({ ...updateUserNameRoute, middleware: requireScope('admin:users') }, async (c) => {
  const authService = container.resolve(AuthService);
  const auditService = container.resolve(AuditService);
  const currentUser = c.get('user')!;
  const actorScopes = c.get('effectiveScopes') || [];
  const userId = c.req.param('id')!;
  const { name } = UpdateUserNameSchema.parse(await c.req.json());
  const targetUser = await authService.getUserById(userId);
  if (!targetUser) return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
  if (targetUser.authMethod === 'oidc') {
    return c.json({ code: 'OIDC_NAME_MANAGED', message: 'OIDC user names are managed by the identity provider' }, 409);
  }
  const denyReason = canManageUser(actorScopes, targetUser.scopes);
  if (denyReason) return c.json({ code: 'PRIVILEGE_BOUNDARY', message: denyReason }, 403);
  const updated = await authService.updateLocalUserName(userId, name);
  await auditService.log({
    userId: currentUser.id,
    action: 'user.rename',
    resourceType: 'user',
    resourceId: updated.id,
    details: { targetUserId: updated.id, previousName: targetUser.name, name: updated.name },
    userAgent: c.req.header('user-agent'),
  });
  return c.json(updated);
});

adminRoutes.openapi({ ...sendAdminUserPasswordSetupRoute, middleware: requireScope('admin:users') }, async (c) => {
  const authService = container.resolve(AuthService);
  const auditService = container.resolve(AuditService);
  const currentUser = c.get('user')!;
  const actorScopes = c.get('effectiveScopes') || [];
  const targetUser = await authService.getUserById(c.req.param('id')!);
  if (!targetUser) return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
  const denyReason = canManageUser(actorScopes, targetUser.scopes);
  if (denyReason) return c.json({ code: 'PRIVILEGE_BOUNDARY', message: denyReason }, 403);
  if (targetUser.authMethod !== 'password') {
    return c.json({ code: 'PASSWORD_AUTH_REQUIRED', message: 'User does not use password sign-in' }, 409);
  }
  if (!(await container.resolve(AuthMailService).getPublicConfig()).verifiedAt) {
    return c.json(
      { code: 'SMTP_NOT_VERIFIED', message: 'SMTP must be verified before sending a password setup link' },
      409
    );
  }
  const purpose = (await authService.hasCompletedSignIn(targetUser.id)) ? 'password_reset' : 'password_setup';
  await container.resolve(LocalAuthService).requestPasswordLink(targetUser.email, purpose);
  await auditService.log({
    userId: currentUser.id,
    action: 'user.password_link_sent',
    resourceType: 'user',
    resourceId: targetUser.id,
    details: { targetUserId: targetUser.id, purpose },
    userAgent: c.req.header('user-agent'),
  });
  return c.json({
    message: purpose === 'password_setup' ? 'Password setup link sent' : 'Password reset link sent',
    purpose,
  });
});

adminRoutes.openapi({ ...resetAdminUserMfaRoute, middleware: requireScope('admin:system') }, async (c) => {
  const authService = container.resolve(AuthService);
  const auditService = container.resolve(AuditService);
  const currentUser = c.get('user')!;
  const actorScopes = c.get('effectiveScopes') || [];
  const targetUser = await authService.getUserById(c.req.param('id')!);
  if (!targetUser) return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
  const denyReason = canManageUser(actorScopes, targetUser.scopes);
  if (denyReason) return c.json({ code: 'PRIVILEGE_BOUNDARY', message: denyReason }, 403);
  await container.resolve(MfaService).resetMfa(targetUser.id);
  await container.resolve(SessionService).destroyAllUserSessions(targetUser.id);
  await auditService.log({
    userId: currentUser.id,
    action: 'user.mfa_reset',
    resourceType: 'user',
    resourceId: targetUser.id,
    details: { targetUserId: targetUser.id },
    userAgent: c.req.header('user-agent'),
  });
  return c.json({ message: 'MFA reset and browser sessions revoked' });
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
  if (targetUser.isDeleted) {
    return c.json({ code: 'USER_DELETED', message: 'Deleted users must be restored before they can be changed' }, 409);
  }
  if (targetUser.oidcSubject?.startsWith('system:')) {
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
  if (targetUser.isDeleted) {
    return c.json({ code: 'USER_DELETED', message: 'User is already deleted' }, 409);
  }
  if (targetUser.oidcSubject?.startsWith('system:')) {
    return c.json({ code: 'SYSTEM_USER', message: 'Cannot delete the system user' }, 403);
  }
  const denyReason = canManageUser(actorScopes, targetUser.scopes);
  if (denyReason) {
    return c.json({ code: 'PRIVILEGE_BOUNDARY', message: denyReason }, 403);
  }

  await authService.deleteUser(userId, currentUser.id);

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

  return c.json({ message: 'User deleted and access revoked' });
});

// Restoring deliberately leaves the account blocked. A separate unblock action is required to grant access.
adminRoutes.openapi({ ...restoreAdminUserRoute, middleware: requireScope('admin:system') }, async (c) => {
  const authService = container.resolve(AuthService);
  const auditService = container.resolve(AuditService);
  const currentUser = c.get('user')!;
  const userId = c.req.param('id')!;
  const { groupId } = RestoreUserSchema.parse(await c.req.json());
  const restoredUser = await authService.restoreUser(userId, groupId);

  await auditService.log({
    userId: currentUser.id,
    action: 'user.restore',
    resourceType: 'user',
    resourceId: userId,
    details: {
      targetUserId: restoredUser.id,
      targetUserEmail: restoredUser.email,
      targetUserName: restoredUser.name,
      groupId: restoredUser.groupId,
      groupName: restoredUser.groupName,
      remainsBlocked: true,
    },
    userAgent: c.req.header('user-agent'),
  });

  return c.json(restoredUser);
});

adminRoutes.openapi({ ...listAdminUserSessionsRoute, middleware: requireScope('admin:users') }, async (c) => {
  const authService = container.resolve(AuthService);
  const sessionService = container.resolve(SessionService);
  const actorScopes = c.get('effectiveScopes') || [];
  const userId = c.req.param('id')!;
  const targetUser = await authService.getUserById(userId);

  if (!targetUser) return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);

  const denyReason = canManageUser(actorScopes, targetUser.scopes);
  if (denyReason) return c.json({ code: 'PRIVILEGE_BOUNDARY', message: denyReason }, 403);

  return c.json(await sessionService.listPublicUserSessions(userId, c.get('sessionId')!));
});

adminRoutes.openapi({ ...revokeAdminUserSessionRoute, middleware: requireScope('admin:users') }, async (c) => {
  const authService = container.resolve(AuthService);
  const sessionService = container.resolve(SessionService);
  const auditService = container.resolve(AuditService);
  const currentUser = c.get('user')!;
  const actorScopes = c.get('effectiveScopes') || [];
  const userId = c.req.param('id')!;
  const targetUser = await authService.getUserById(userId);

  if (!targetUser) return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);

  const denyReason = canManageUser(actorScopes, targetUser.scopes);
  if (denyReason) return c.json({ code: 'PRIVILEGE_BOUNDARY', message: denyReason }, 403);

  const sessionId = c.req.param('sessionId')!;
  const revoked = await sessionService.revokeUserSessionByPublicId(userId, sessionId);
  if (!revoked) return c.json({ code: 'SESSION_NOT_FOUND', message: 'Session not found' }, 404);

  await auditService.log({
    userId: currentUser.id,
    action: 'user.session_revoke',
    resourceType: 'session',
    resourceId: sessionId,
    details: {
      targetUserId: targetUser.id,
      targetUserEmail: targetUser.email,
      targetUserName: targetUser.name,
    },
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ message: 'Session revoked' });
});

adminRoutes.openapi({ ...revokeAllAdminUserSessionsRoute, middleware: requireScope('admin:users') }, async (c) => {
  const authService = container.resolve(AuthService);
  const sessionService = container.resolve(SessionService);
  const auditService = container.resolve(AuditService);
  const currentUser = c.get('user')!;
  const actorScopes = c.get('effectiveScopes') || [];
  const userId = c.req.param('id')!;
  const targetUser = await authService.getUserById(userId);

  if (!targetUser) return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);

  const denyReason = canManageUser(actorScopes, targetUser.scopes);
  if (denyReason) return c.json({ code: 'PRIVILEGE_BOUNDARY', message: denyReason }, 403);

  await sessionService.destroyAllUserSessions(userId);
  await auditService.log({
    userId: currentUser.id,
    action: 'user.sessions_revoke_all',
    resourceType: 'user',
    resourceId: userId,
    details: {
      targetUserId: targetUser.id,
      targetUserEmail: targetUser.email,
      targetUserName: targetUser.name,
    },
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ message: 'All sessions revoked' });
});
