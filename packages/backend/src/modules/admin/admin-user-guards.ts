import { container } from '@/container.js';
import { canManageUser, hasScope, privilegeBoundaryScopes } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import type { GroupService } from '@/modules/groups/group.service.js';
import type { User } from '@/types.js';

/**
 * Caller, services and privilege checks shared by the user administration
 * actions, so the /api/admin routes and the AI/MCP tools enforce the same
 * boundaries.
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

/** Services the AI runtime injects directly; anything omitted resolves from the container. */
export interface AdminUserActionServices {
  authService?: AuthService;
  auditService?: AuditService;
  groupService?: GroupService;
}

export function boundaryScopes(actor: AdminUserActor): string[] {
  return privilegeBoundaryScopes(actor.scopes, actor.accountScopes);
}

/** Boundary for scopes being granted to someone else (groups, additional permissions). */
export function grantBoundaryScopes(actor: AdminUserActor): string[] {
  return privilegeBoundaryScopes(actor.scopes, actor.accountScopes, 'grant');
}

/** Only a browser session may change its own sign-in method, MFA or sessions. */
export function assertNotOwnSignInFromProgrammaticCaller(actor: AdminUserActor, userId: string): void {
  if (actor.programmatic && userId === actor.user.id) {
    throw new AppError(
      403,
      'SELF_SIGN_IN_PROGRAMMATIC',
      'API tokens, MCP clients and the AI assistant cannot change the sign-in, MFA or sessions of their own account'
    );
  }
}

export function authServiceOf(services: AdminUserActionServices): AuthService {
  return services.authService ?? container.resolve(AuthService);
}

export function auditServiceOf(services: AdminUserActionServices): AuditService {
  return services.auditService ?? container.resolve(AuditService);
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

export async function requireManageableUser(
  actor: AdminUserActor,
  userId: string,
  services: AdminUserActionServices
): Promise<User> {
  assertAdminUserScope(actor.scopes, userId);
  const targetUser = await authServiceOf(services).getUserById(userId);
  if (!targetUser) throw new AppError(404, 'NOT_FOUND', 'User not found');
  const denyReason = canManageUser(boundaryScopes(actor), targetUser.scopes);
  if (denyReason) throw new AppError(403, 'PRIVILEGE_BOUNDARY', denyReason);
  return targetUser;
}
