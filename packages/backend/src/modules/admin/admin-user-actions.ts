import { container } from '@/container.js';
import {
  canManageUser,
  hasScope,
  hasScopeForCreation,
  isScopeSubset,
  privilegeBoundaryScopes,
} from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CreateUserInput, UpdateUserAuthMethodInput } from '@/modules/admin/admin.schemas.js';
import { AdminUserFolderService } from '@/modules/admin/admin-user-folders.service.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { AuthMailService } from '@/modules/auth/auth-mail.service.js';
import { LocalAuthService } from '@/modules/auth/local-auth.service.js';
import { MfaService } from '@/modules/auth/mfa.service.js';
import { isDemoVisitor } from '@/modules/demo/demo-mode.js';
import { GroupService } from '@/modules/groups/group.service.js';
import { SessionService } from '@/services/session.service.js';
import type { User } from '@/types.js';

/**
 * User administration shared by the /api/admin routes and the AI/MCP tools, so
 * both enforce the same privilege boundaries, validation and audit records.
 */
export interface AdminUserActor {
  user: User;
  /** Effective scopes of the request (bounded for programmatic callers). */
  scopes: string[];
  /** Live account scopes behind a programmatic caller; only account-only scopes are taken from them. */
  accountScopes?: string[];
  /**
   * True for API tokens, MCP clients and the AI assistant. They may manage other
   * accounts, but never the sign-in, MFA or sessions of the account they act for.
   */
  programmatic: boolean;
  userAgent?: string;
}

function boundaryScopes(actor: AdminUserActor): string[] {
  return privilegeBoundaryScopes(actor.scopes, actor.accountScopes);
}

/** Boundary for scopes being granted to someone else (groups, additional permissions). */
function grantBoundaryScopes(actor: AdminUserActor): string[] {
  return privilegeBoundaryScopes(actor.scopes, actor.accountScopes, 'grant');
}

/** Only a browser session may change its own sign-in method, MFA or sessions. */
function assertNotOwnSignInFromProgrammaticCaller(actor: AdminUserActor, userId: string): void {
  if (actor.programmatic && userId === actor.user.id) {
    throw new AppError(
      403,
      'SELF_SIGN_IN_PROGRAMMATIC',
      'API tokens, MCP clients and the AI assistant cannot change the sign-in, MFA or sessions of their own account'
    );
  }
}

/** Services the AI runtime injects directly; anything omitted resolves from the container. */
export interface AdminUserActionServices {
  authService?: AuthService;
  auditService?: AuditService;
  groupService?: GroupService;
}

type AuthMethod = UpdateUserAuthMethodInput['authMethod'];

function authServiceOf(services: AdminUserActionServices): AuthService {
  return services.authService ?? container.resolve(AuthService);
}

function auditServiceOf(services: AdminUserActionServices): AuditService {
  return services.auditService ?? container.resolve(AuditService);
}

function effectiveGroupScopes(group: { scopes: string[]; inheritedScopes?: string[] }) {
  return [...new Set([...(group.scopes ?? []), ...(group.inheritedScopes ?? [])])];
}

/** Mirrors requireScopeForResource('admin:users', 'id'). */
export function assertAdminUserScope(scopes: string[], userId: string): void {
  const requiredScope = `admin:users:${userId}`;
  if (!hasScope(scopes, requiredScope)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${requiredScope}`);
  }
}

/** Mirrors requireScope('admin:system') on the deleted-user and MFA routes. */
export function assertSystemAdministrator(scopes: string[]): void {
  if (!hasScope(scopes, 'admin:system')) {
    throw new AppError(403, 'FORBIDDEN', 'Missing required scope: admin:system');
  }
}

async function requireManageableUser(actor: AdminUserActor, userId: string, services: AdminUserActionServices) {
  assertAdminUserScope(actor.scopes, userId);
  const targetUser = await authServiceOf(services).getUserById(userId);
  if (!targetUser) throw new AppError(404, 'NOT_FOUND', 'User not found');
  const denyReason = canManageUser(boundaryScopes(actor), targetUser.scopes);
  if (denyReason) throw new AppError(403, 'PRIVILEGE_BOUNDARY', denyReason);
  return targetUser;
}

async function assertSmtpVerified(message: string): Promise<void> {
  if (!(await container.resolve(AuthMailService).getPublicConfig()).verifiedAt) {
    throw new AppError(409, 'SMTP_NOT_VERIFIED', message);
  }
}

async function sendSignInOnboarding(email: string, authMethod: AuthMethod | undefined): Promise<void> {
  if (authMethod === 'password') {
    await container.resolve(LocalAuthService).requestPasswordLink(email, 'password_setup');
  } else if (authMethod === 'email_otp') {
    await container.resolve(LocalAuthService).sendEmailOtpOnboarding(email);
  }
}

export async function listAdminUsers(
  actor: Pick<AdminUserActor, 'user' | 'scopes'>,
  services: AdminUserActionServices = {}
): Promise<User[]> {
  const userList = await authServiceOf(services).listUsers();
  return userList.filter(
    (user) =>
      hasScope(actor.scopes, `admin:users:${user.id}`) && (!isDemoVisitor(actor.user) || user.id === actor.user.id)
  );
}

export async function listDeletedAdminUsers(actor: AdminUserActor, services: AdminUserActionServices = {}) {
  assertSystemAdministrator(actor.scopes);
  return authServiceOf(services).listDeletedUsers();
}

export async function createAdminUser(
  actor: AdminUserActor,
  input: CreateUserInput,
  services: AdminUserActionServices = {}
): Promise<User> {
  const authService = authServiceOf(services);
  const groupService = services.groupService ?? container.resolve(GroupService);
  if (!hasScopeForCreation(actor.scopes, 'admin:users', input.folderId))
    throw new AppError(403, 'FORBIDDEN', 'Select an authorized destination user folder');
  if (input.folderId) await container.resolve(AdminUserFolderService).assertFolderExists(input.folderId);
  const destGroups = await Promise.all(input.groupIds.map((id) => groupService.getGroup(id)));
  if (!isScopeSubset(destGroups.flatMap(effectiveGroupScopes), grantBoundaryScopes(actor))) {
    throw new AppError(403, 'PRIVILEGE_BOUNDARY', 'Cannot assign a group with permissions you do not possess');
  }

  try {
    if (input.authMethod === 'password' || input.authMethod === 'email_otp') {
      await assertSmtpVerified('SMTP must be verified before creating an email sign-in account');
    }
    const createdUser = await authService.createUser(input);
    await authService.grantCreatedResourcePermissions(actor.user.id, 'admin:users', createdUser.id);
    await sendSignInOnboarding(createdUser.email, input.authMethod);

    await auditServiceOf(services).log({
      userId: actor.user.id,
      action: 'user.create',
      resourceType: 'user',
      resourceId: createdUser.id,
      details: {
        targetUserId: createdUser.id,
        targetUserEmail: createdUser.email,
        targetUserName: createdUser.name,
        groupId: createdUser.groupId,
        groupIds: createdUser.groupIds ?? [createdUser.groupId],
        groupName: createdUser.groupName,
      },
      userAgent: actor.userAgent,
    });

    return createdUser;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create user';
    if (message === 'User with this email already exists') throw new AppError(409, 'CONFLICT', message);
    if (message === 'Permission group not found') throw new AppError(404, 'NOT_FOUND', message);
    throw err;
  }
}

export async function updateAdminUserAuthMethod(
  actor: AdminUserActor,
  userId: string,
  authMethod: AuthMethod,
  services: AdminUserActionServices = {}
): Promise<User> {
  assertNotOwnSignInFromProgrammaticCaller(actor, userId);
  const targetUser = await requireManageableUser(actor, userId, services);
  if (authMethod === 'password' || authMethod === 'email_otp') {
    await assertSmtpVerified('SMTP must be verified before switching to email sign-in');
  }
  const updated = await authServiceOf(services).updateUserAuthMethod(userId, authMethod);
  await sendSignInOnboarding(updated.email, authMethod);
  await auditServiceOf(services).log({
    userId: actor.user.id,
    action: 'user.auth_method_change',
    resourceType: 'user',
    resourceId: updated.id,
    details: { targetUserId: updated.id, previousAuthMethod: targetUser.authMethod, authMethod },
    userAgent: actor.userAgent,
  });
  return updated;
}

export async function renameAdminUser(
  actor: AdminUserActor,
  userId: string,
  name: string,
  services: AdminUserActionServices = {}
): Promise<User> {
  assertAdminUserScope(actor.scopes, userId);
  const authService = authServiceOf(services);
  const targetUser = await authService.getUserById(userId);
  if (!targetUser) throw new AppError(404, 'NOT_FOUND', 'User not found');
  if (targetUser.authMethod === 'oidc') {
    throw new AppError(409, 'OIDC_NAME_MANAGED', 'OIDC user names are managed by the identity provider');
  }
  const denyReason = canManageUser(boundaryScopes(actor), targetUser.scopes);
  if (denyReason) throw new AppError(403, 'PRIVILEGE_BOUNDARY', denyReason);
  const updated = await authService.updateLocalUserName(userId, name);
  await auditServiceOf(services).log({
    userId: actor.user.id,
    action: 'user.rename',
    resourceType: 'user',
    resourceId: updated.id,
    details: { targetUserId: updated.id, previousName: targetUser.name, name: updated.name },
    userAgent: actor.userAgent,
  });
  return updated;
}

export async function resetAdminUserAvatar(
  actor: AdminUserActor,
  userId: string,
  services: AdminUserActionServices = {}
): Promise<User> {
  const targetUser = await requireManageableUser(actor, userId, services);
  const updated = await authServiceOf(services).updateUserAvatar(userId, null);
  await auditServiceOf(services).log({
    userId: actor.user.id,
    action: 'user.avatar_reset',
    resourceType: 'user',
    resourceId: updated.id,
    details: { targetUserId: updated.id, hadAvatar: Boolean(targetUser.avatarUrl) },
    userAgent: actor.userAgent,
  });
  return updated;
}

export async function sendAdminUserPasswordLink(
  actor: AdminUserActor,
  userId: string,
  services: AdminUserActionServices = {}
): Promise<{ message: string; purpose: 'password_setup' | 'password_reset' }> {
  assertNotOwnSignInFromProgrammaticCaller(actor, userId);
  const targetUser = await requireManageableUser(actor, userId, services);
  if (targetUser.authMethod !== 'password') {
    throw new AppError(409, 'PASSWORD_AUTH_REQUIRED', 'User does not use password sign-in');
  }
  await assertSmtpVerified('SMTP must be verified before sending a password setup link');
  const purpose = (await authServiceOf(services).hasCompletedSignIn(targetUser.id))
    ? 'password_reset'
    : 'password_setup';
  await container.resolve(LocalAuthService).requestPasswordLink(targetUser.email, purpose);
  await auditServiceOf(services).log({
    userId: actor.user.id,
    action: 'user.password_link_sent',
    resourceType: 'user',
    resourceId: targetUser.id,
    details: { targetUserId: targetUser.id, purpose },
    userAgent: actor.userAgent,
  });
  return {
    message: purpose === 'password_setup' ? 'Password setup link sent' : 'Password reset link sent',
    purpose,
  };
}

export async function resetAdminUserMfa(
  actor: AdminUserActor,
  userId: string,
  services: AdminUserActionServices = {}
): Promise<{ message: string }> {
  assertSystemAdministrator(actor.scopes);
  assertNotOwnSignInFromProgrammaticCaller(actor, userId);
  const targetUser = await authServiceOf(services).getUserById(userId);
  if (!targetUser) throw new AppError(404, 'NOT_FOUND', 'User not found');
  const denyReason = canManageUser(boundaryScopes(actor), targetUser.scopes);
  if (denyReason) throw new AppError(403, 'PRIVILEGE_BOUNDARY', denyReason);
  await container.resolve(MfaService).resetMfa(targetUser.id);
  await container.resolve(SessionService).destroyAllUserSessions(targetUser.id);
  await auditServiceOf(services).log({
    userId: actor.user.id,
    action: 'user.mfa_reset',
    resourceType: 'user',
    resourceId: targetUser.id,
    details: { targetUserId: targetUser.id },
    userAgent: actor.userAgent,
  });
  return { message: 'MFA reset and browser sessions revoked' };
}

export async function updateAdminUserGroups(
  actor: AdminUserActor,
  userId: string,
  groupIds: string[],
  services: AdminUserActionServices = {}
): Promise<User> {
  assertAdminUserScope(actor.scopes, userId);
  const authService = authServiceOf(services);
  const targetUser = await authService.assertCanUpdateUserGroup(
    actor.user.id,
    grantBoundaryScopes(actor),
    userId,
    groupIds
  );
  const updatedUser = await authService.updateUserGroup(userId, groupIds);
  await auditServiceOf(services).log({
    userId: actor.user.id,
    action: 'user.group_change',
    resourceType: 'user',
    resourceId: userId,
    details: {
      targetUserId: updatedUser.id,
      targetUserEmail: updatedUser.email,
      targetUserName: updatedUser.name,
      previousGroupId: targetUser.groupId,
      previousGroupIds: targetUser.groupIds ?? [targetUser.groupId],
      previousGroupName: targetUser.groupName,
      newGroupId: updatedUser.groupId,
      newGroupIds: updatedUser.groupIds ?? [updatedUser.groupId],
      newGroupName: updatedUser.groupName,
    },
    userAgent: actor.userAgent,
  });
  return updatedUser;
}

export async function updateAdminUserAdditionalPermissions(
  actor: AdminUserActor,
  userId: string,
  requestedScopes: string[],
  services: AdminUserActionServices = {}
): Promise<User> {
  assertAdminUserScope(actor.scopes, userId);
  const authService = authServiceOf(services);
  const { targetUser, additionalScopes } = await authService.assertCanUpdateUserAdditionalScopes(
    actor.user.id,
    grantBoundaryScopes(actor),
    userId,
    requestedScopes
  );
  const previousAdditionalScopes = targetUser.additionalScopes ?? [];
  const updatedUser = await authService.updateUserAdditionalScopes(userId, additionalScopes);
  const previousSet = new Set(previousAdditionalScopes);
  const nextSet = new Set(additionalScopes);
  await auditServiceOf(services).log({
    userId: actor.user.id,
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
    userAgent: actor.userAgent,
  });
  return updatedUser;
}

/** Guards shared by block and delete: never yourself, a deleted account, or the system user. */
async function requireLifecycleTarget(
  actor: AdminUserActor,
  userId: string,
  services: AdminUserActionServices,
  action: 'block' | 'delete'
): Promise<User> {
  assertAdminUserScope(actor.scopes, userId);
  if (userId === actor.user.id) {
    throw action === 'block'
      ? new AppError(400, 'SELF_BLOCK', 'Cannot block yourself')
      : new AppError(400, 'SELF_DELETE', 'Cannot delete your own account');
  }
  const targetUser = await authServiceOf(services).getUserById(userId);
  if (!targetUser) throw new AppError(404, 'NOT_FOUND', 'User not found');
  if (targetUser.isDeleted) {
    throw action === 'block'
      ? new AppError(409, 'USER_DELETED', 'Deleted users must be restored before they can be changed')
      : new AppError(409, 'USER_DELETED', 'User is already deleted');
  }
  if (targetUser.oidcSubject?.startsWith('system:')) {
    throw new AppError(
      403,
      'SYSTEM_USER',
      action === 'block' ? 'Cannot modify the system user' : 'Cannot delete the system user'
    );
  }
  const denyReason = canManageUser(boundaryScopes(actor), targetUser.scopes);
  if (denyReason) throw new AppError(403, 'PRIVILEGE_BOUNDARY', denyReason);
  return targetUser;
}

export async function setAdminUserBlocked(
  actor: AdminUserActor,
  userId: string,
  blocked: boolean,
  services: AdminUserActionServices = {}
): Promise<User> {
  const targetUser = await requireLifecycleTarget(actor, userId, services, 'block');
  const authService = authServiceOf(services);
  const updated = blocked ? await authService.blockUser(userId) : await authService.unblockUser(userId);
  await auditServiceOf(services).log({
    userId: actor.user.id,
    action: blocked ? 'user.block' : 'user.unblock',
    resourceType: 'user',
    resourceId: userId,
    details: {
      targetUserId: targetUser.id,
      targetUserEmail: targetUser.email,
      targetUserName: targetUser.name,
      blocked,
    },
    userAgent: actor.userAgent,
  });
  return updated;
}

export async function deleteAdminUser(
  actor: AdminUserActor,
  userId: string,
  services: AdminUserActionServices = {}
): Promise<void> {
  const targetUser = await requireLifecycleTarget(actor, userId, services, 'delete');
  await authServiceOf(services).deleteUser(userId, actor.user.id);
  await auditServiceOf(services).log({
    userId: actor.user.id,
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
    userAgent: actor.userAgent,
  });
}

/** Restoring deliberately leaves the account blocked; a separate unblock grants access again. */
export async function restoreAdminUser(
  actor: AdminUserActor,
  userId: string,
  groups: { groupId?: string; groupIds?: string[] },
  services: AdminUserActionServices = {}
): Promise<User> {
  assertSystemAdministrator(actor.scopes);
  const restoredUser = await authServiceOf(services).restoreUser(
    userId,
    groups.groupIds ?? groups.groupId,
    grantBoundaryScopes(actor)
  );
  await auditServiceOf(services).log({
    userId: actor.user.id,
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
    userAgent: actor.userAgent,
  });
  return restoredUser;
}

export async function listAdminUserSessions(
  actor: AdminUserActor,
  userId: string,
  currentSessionId: string,
  services: AdminUserActionServices = {}
) {
  assertNotOwnSignInFromProgrammaticCaller(actor, userId);
  await requireManageableUser(actor, userId, services);
  return container.resolve(SessionService).listPublicUserSessions(userId, currentSessionId);
}

export async function revokeAdminUserSession(
  actor: AdminUserActor,
  userId: string,
  sessionId: string,
  services: AdminUserActionServices = {}
): Promise<void> {
  assertNotOwnSignInFromProgrammaticCaller(actor, userId);
  const targetUser = await requireManageableUser(actor, userId, services);
  const revoked = await container.resolve(SessionService).revokeUserSessionByPublicId(userId, sessionId);
  if (!revoked) throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
  await auditServiceOf(services).log({
    userId: actor.user.id,
    action: 'user.session_revoke',
    resourceType: 'session',
    resourceId: sessionId,
    details: {
      targetUserId: targetUser.id,
      targetUserEmail: targetUser.email,
      targetUserName: targetUser.name,
    },
    userAgent: actor.userAgent,
  });
}

export async function revokeAllAdminUserSessions(
  actor: AdminUserActor,
  userId: string,
  services: AdminUserActionServices = {}
): Promise<void> {
  assertNotOwnSignInFromProgrammaticCaller(actor, userId);
  const targetUser = await requireManageableUser(actor, userId, services);
  await container.resolve(SessionService).destroyAllUserSessions(userId);
  await auditServiceOf(services).log({
    userId: actor.user.id,
    action: 'user.sessions_revoke_all',
    resourceType: 'user',
    resourceId: userId,
    details: {
      targetUserId: targetUser.id,
      targetUserEmail: targetUser.email,
      targetUserName: targetUser.name,
    },
    userAgent: actor.userAgent,
  });
}
