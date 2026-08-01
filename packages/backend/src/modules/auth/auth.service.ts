import { and, count, eq, isNotNull, isNull, not } from 'drizzle-orm';
import * as client from 'openid-client';
import { inject, injectable } from 'tsyringe';
import { getEnv } from '@/config/env.js';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  apiTokens,
  gitLabUserCredentials,
  inferenceOAuthSessions,
  inferenceTokens,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthRefreshTokens,
  permissionGroups,
  users,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { canManageUser, isScopeSubset } from '@/lib/permissions.js';
import { canonicalizeScopes, isValidBaseScope } from '@/lib/scopes.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AISandboxService } from '@/modules/ai/ai.sandbox.service.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { SessionService } from '@/services/session.service.js';
import type { User } from '@/types.js';
import type { AuthSettingsService } from './auth.settings.service.js';
import {
  computeEffectiveGroupAccess,
  computeEffectiveUserAccess,
  fetchGroupScopeMap,
  resolveEffectiveUserAccess,
} from './live-session-user.js';

const logger = createChildLogger('AuthService');

const PKCE_STATE_PREFIX = 'oidc:pkce:';
const PRECREATED_SUBJECT_PREFIX = 'manual:';
const SYSTEM_SUBJECT_PREFIX = 'system:';
const GATEWAY_SYSTEM_OIDC_SUBJECT = 'system:gateway-setup';
export const AI_APPROVAL_MODES = ['always-ask', 'normal', 'bypass-non-destructive', 'bypass-everything'] as const;
export type AIApprovalMode = (typeof AI_APPROVAL_MODES)[number];

export interface DeletedUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  deletedAt: string;
  deletedByUserId: string | null;
  deletedFromGroupId: string | null;
  originalGroupExists: boolean;
}

export interface NormalizedOidcClaims {
  oidcSubject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
}

export function normalizeOidcClaims(claims: Record<string, unknown> | undefined | null): NormalizedOidcClaims {
  const subject = typeof claims?.sub === 'string' ? claims.sub : '';
  if (!subject) {
    throw new Error('No subject claim in ID token');
  }
  if (subject.startsWith(SYSTEM_SUBJECT_PREFIX)) {
    throw new Error('OIDC subject uses a reserved Gateway namespace');
  }

  const email = typeof claims?.email === 'string' ? claims.email.trim().toLowerCase() : '';

  return {
    oidcSubject: subject,
    email: email || null,
    emailVerified: claims?.email_verified === true,
    name: typeof claims?.name === 'string' && claims.name.trim() ? claims.name : null,
    avatarUrl: typeof claims?.picture === 'string' && claims.picture.trim() ? claims.picture : null,
  };
}

interface OIDCState {
  codeVerifier: string;
  state: string;
  returnTo?: string;
}

@injectable()
export class AuthService {
  private oidcConfig: client.Configuration | null = null;

  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly sessionService: SessionService,
    private readonly cacheService: CacheService,
    private readonly authSettingsService: AuthSettingsService,
    private readonly auditService: AuditService
  ) {}

  private eventBus?: import('@/services/event-bus.service.js').EventBusService;
  private sandboxService?: AISandboxService;
  setEventBus(bus: import('@/services/event-bus.service.js').EventBusService) {
    this.eventBus = bus;
  }
  setSandboxService(service: AISandboxService) {
    this.sandboxService = service;
  }
  private emitUser(id: string, action: 'created' | 'updated' | 'deleted') {
    this.eventBus?.publish('user.changed', { id, action });
  }
  private emitPermissions(userId: string, scopes: string[], groupId: string | null, reason = 'permissions_changed') {
    this.eventBus?.publish(`permissions.changed.${userId}`, { scopes, groupId, reason });
    void this.sandboxService?.revokeUserAccess(userId, scopes, reason).catch((error) => {
      logger.warn('Failed to revoke sandbox jobs after permission change', { userId, reason, error });
    });
  }

  private async getOIDCConfig(): Promise<client.Configuration> {
    if (this.oidcConfig) {
      return this.oidcConfig;
    }

    const env = getEnv();

    try {
      this.oidcConfig = await client.discovery(new URL(env.OIDC_ISSUER), env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET);

      logger.info('OIDC configuration discovered', {
        issuer: env.OIDC_ISSUER,
      });

      return this.oidcConfig;
    } catch (error) {
      logger.error('Failed to discover OIDC configuration', { error });
      throw new Error('OIDC configuration discovery failed');
    }
  }

  async getAuthorizationUrl(returnTo?: string): Promise<string> {
    const env = getEnv();
    const config = await this.getOIDCConfig();

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();

    const oidcState: OIDCState = {
      codeVerifier,
      state,
      returnTo,
    };

    await this.cacheService.set(`${PKCE_STATE_PREFIX}${state}`, oidcState, 300);

    const parameters: Record<string, string> = {
      redirect_uri: env.OIDC_REDIRECT_URI,
      scope: env.OIDC_SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    };

    const authorizationUrl = client.buildAuthorizationUrl(config, parameters);

    return authorizationUrl.href;
  }

  async handleCallback(
    callbackUrl: string,
    state: string
  ): Promise<{ sessionId: string; user: User; returnTo?: string }> {
    const config = await this.getOIDCConfig();

    const oidcState = await this.cacheService.get<OIDCState>(`${PKCE_STATE_PREFIX}${state}`);

    if (!oidcState) {
      throw new Error('Invalid or expired state parameter');
    }

    await this.cacheService.delete(`${PKCE_STATE_PREFIX}${state}`);

    if (oidcState.state !== state) {
      throw new Error('State mismatch');
    }

    try {
      const tokens = await client.authorizationCodeGrant(config, new URL(callbackUrl), {
        pkceCodeVerifier: oidcState.codeVerifier,
        expectedState: state,
      });

      const normalizedClaims = normalizeOidcClaims(tokens.claims() as Record<string, unknown> | undefined | null);
      const user = await this.findOrCreateUser(normalizedClaims);

      const { sessionId } = await this.sessionService.createSession(user, tokens.access_token, tokens.refresh_token);

      logger.info('User logged in', { userId: user.id, email: user.email });

      return {
        sessionId,
        user,
        returnTo: oidcState.returnTo,
      };
    } catch (error) {
      logger.error('OIDC callback handling failed', { error });
      throw error;
    }
  }

  private async findOrCreateUser(data: NormalizedOidcClaims): Promise<User> {
    const normalizedEmail = data.email;

    const existingUser = await this.db.query.users.findFirst({
      where: eq(users.oidcSubject, data.oidcSubject),
    });

    if (existingUser) {
      if (existingUser.deletedAt) {
        throw new AppError(
          403,
          'ACCOUNT_DELETED',
          'This account has been deleted and must be restored by a system administrator'
        );
      }
      const authSettings = await this.authSettingsService.getConfig();
      const canSyncEmail =
        normalizedEmail !== null &&
        (!authSettings.oidcRequireVerifiedEmail || data.emailVerified || existingUser.email === normalizedEmail);
      const nextEmail = canSyncEmail ? normalizedEmail : existingUser.email;

      if (
        existingUser.email !== nextEmail ||
        existingUser.name !== data.name ||
        existingUser.avatarUrl !== data.avatarUrl
      ) {
        const [updatedUser] = await this.db
          .update(users)
          .set({
            email: nextEmail,
            name: data.name,
            avatarUrl: data.avatarUrl,
            updatedAt: new Date(),
          })
          .where(eq(users.id, existingUser.id))
          .returning();

        await this.auditService.log({
          userId: updatedUser.id,
          action: 'auth.user_profile_sync',
          resourceType: 'user',
          resourceId: updatedUser.id,
          details: {
            oidcSubject: data.oidcSubject,
            emailChanged: existingUser.email !== nextEmail,
            emailClaimIgnored:
              normalizedEmail !== null && existingUser.email !== normalizedEmail && nextEmail === existingUser.email,
            emailClaimMissing: normalizedEmail === null,
            emailVerified: data.emailVerified,
            nameChanged: existingUser.name !== data.name,
            avatarChanged: existingUser.avatarUrl !== data.avatarUrl,
          },
        });

        return this.mapDbUserToUser(updatedUser);
      }

      return this.mapDbUserToUser(existingUser);
    }

    if (!normalizedEmail) {
      throw new Error('No email claim in ID token');
    }

    const precreatedUser = await this.db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
    });

    if (precreatedUser?.oidcSubject.startsWith(PRECREATED_SUBJECT_PREFIX)) {
      await this.requireVerifiedEmailForNonBootstrap(data);
      const previousSubject = precreatedUser.oidcSubject;
      const [claimedUser] = await this.db
        .update(users)
        .set({
          oidcSubject: data.oidcSubject,
          email: normalizedEmail,
          name: data.name,
          avatarUrl: data.avatarUrl,
          updatedAt: new Date(),
        })
        .where(eq(users.id, precreatedUser.id))
        .returning();

      logger.info('Claimed pre-created user on first login', {
        userId: claimedUser.id,
        email: claimedUser.email,
      });

      await this.auditService.log({
        userId: claimedUser.id,
        action: 'auth.user_claimed',
        resourceType: 'user',
        resourceId: claimedUser.id,
        details: {
          email: claimedUser.email,
          previousOidcSubject: previousSubject,
          oidcSubject: data.oidcSubject,
          emailVerified: data.emailVerified,
        },
      });

      this.emitUser(claimedUser.id, 'updated');
      const mapped = await this.mapDbUserToUser(claimedUser);
      this.emitPermissions(mapped.id, mapped.scopes, mapped.groupId);
      return mapped;
    }

    // Check if this is the first real user — assign system-admin group.
    // Exclude only Gateway's own deterministic system user from the count.
    const [{ count: userCount }] = await this.db
      .select({ count: count() })
      .from(users)
      .where(not(eq(users.oidcSubject, GATEWAY_SYSTEM_OIDC_SUBJECT)));

    const isBootstrapUser = userCount === 0;
    if (!isBootstrapUser) {
      await this.requireVerifiedEmailForNonBootstrap(data);
    }

    const group = isBootstrapUser
      ? await this.db.query.permissionGroups.findFirst({
          where: eq(permissionGroups.name, 'system-admin'),
        })
      : await this.resolveOidcProvisioningGroup();

    if (!group) {
      throw new Error('Default OIDC group not found. Has the migration been run?');
    }

    const [createdUser] = await this.db
      .insert(users)
      .values({
        oidcSubject: data.oidcSubject,
        email: normalizedEmail,
        name: data.name,
        avatarUrl: data.avatarUrl,
        groupId: group.id,
      })
      .returning();

    logger.info('Created new user', { userId: createdUser.id, email: createdUser.email, group: group.name });
    await this.auditService.log({
      userId: createdUser.id,
      action: 'auth.user_provisioned',
      resourceType: 'user',
      resourceId: createdUser.id,
      details: {
        email: createdUser.email,
        group: group.name,
        oidcSubject: data.oidcSubject,
        emailVerified: data.emailVerified,
        bootstrap: isBootstrapUser,
      },
    });
    this.emitUser(createdUser.id, 'created');
    const mapped = await this.mapDbUserToUser(createdUser);
    this.emitPermissions(mapped.id, mapped.scopes, mapped.groupId);
    return mapped;
  }

  private async requireVerifiedEmailForNonBootstrap(data: NormalizedOidcClaims): Promise<void> {
    const authSettings = await this.authSettingsService.getConfig();
    if (!authSettings.oidcRequireVerifiedEmail || data.emailVerified) return;

    throw new AppError(
      403,
      'OIDC_EMAIL_NOT_VERIFIED',
      'OIDC email verification is required for this account. Contact an administrator.'
    );
  }

  private async resolveOidcProvisioningGroup() {
    const authSettings = await this.authSettingsService.getConfig();
    if (!authSettings.oidcAutoCreateUsers) {
      throw new Error('Your account has not been provisioned yet. Contact an administrator.');
    }

    const group = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.id, authSettings.oidcDefaultGroupId),
    });
    return group ?? null;
  }

  async createUser(data: { email: string; name?: string | null; groupId: string }): Promise<User> {
    const normalizedEmail = data.email.trim().toLowerCase();

    const group = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.id, data.groupId),
    });
    if (!group) {
      throw new Error('Permission group not found');
    }

    const existingByEmail = await this.db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
    });
    if (existingByEmail) {
      throw new Error('User with this email already exists');
    }

    const [createdUser] = await this.db
      .insert(users)
      .values({
        oidcSubject: `${PRECREATED_SUBJECT_PREFIX}${normalizedEmail}`,
        email: normalizedEmail,
        name: data.name?.trim() || null,
        avatarUrl: null,
        groupId: data.groupId,
      })
      .returning();

    logger.info('Pre-created user', {
      userId: createdUser.id,
      email: createdUser.email,
      groupId: createdUser.groupId,
    });

    this.emitUser(createdUser.id, 'created');
    const mapped = await this.mapDbUserToUser(createdUser);
    this.emitPermissions(mapped.id, mapped.scopes, mapped.groupId);
    return mapped;
  }

  private async mapDbUserToUser(dbUser: typeof users.$inferSelect): Promise<User> {
    const effective = await resolveEffectiveUserAccess(this.db, dbUser.groupId, dbUser.additionalScopes);
    const isDeleted = Boolean(dbUser.deletedAt);

    return {
      id: dbUser.id,
      oidcSubject: dbUser.oidcSubject,
      email: dbUser.email,
      name: dbUser.name,
      avatarUrl: dbUser.avatarUrl,
      groupId: dbUser.groupId,
      groupName: effective.groupName,
      groupScopes: isDeleted ? [] : effective.groupScopes,
      additionalScopes: effective.additionalScopes,
      scopes: isDeleted ? [] : effective.scopes,
      isBlocked: dbUser.isBlocked || isDeleted,
      isDeleted,
      aiApprovalMode: dbUser.aiApprovalMode,
    };
  }

  async logout(sessionId: string): Promise<string | null> {
    await this.sessionService.destroySession(sessionId);

    const config = await this.getOIDCConfig();
    const env = getEnv();

    try {
      const metadata = config.serverMetadata();
      if (metadata.end_session_endpoint) {
        const logoutUrl = new URL(metadata.end_session_endpoint);
        logoutUrl.searchParams.set('post_logout_redirect_uri', env.APP_URL);
        return logoutUrl.href;
      }
    } catch {
      // No end_session_endpoint available
    }

    return null;
  }

  async getUserById(userId: string): Promise<User | null> {
    const dbUser = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    return dbUser ? this.mapDbUserToUser(dbUser) : null;
  }

  async getUserPreferences(userId: string): Promise<{ aiApprovalMode: AIApprovalMode } | null> {
    const dbUser = await this.db.query.users.findFirst({
      columns: { aiApprovalMode: true },
      where: eq(users.id, userId),
    });

    return dbUser ? { aiApprovalMode: dbUser.aiApprovalMode } : null;
  }

  async updateUserPreferences(
    userId: string,
    input: { aiApprovalMode: AIApprovalMode }
  ): Promise<{ aiApprovalMode: AIApprovalMode }> {
    const [updated] = await this.db
      .update(users)
      .set({
        aiApprovalMode: input.aiApprovalMode,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({ aiApprovalMode: users.aiApprovalMode });

    if (!updated) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }

    this.emitUser(userId, 'updated');
    return updated;
  }

  async listUsers(): Promise<User[]> {
    const allUsers = await this.db.query.users.findMany({
      where: isNull(users.deletedAt),
      orderBy: (users, { asc }) => [asc(users.sortOrder), asc(users.createdAt)],
    });

    const groupMap = await fetchGroupScopeMap(this.db);

    return allUsers.map((u) => {
      const effective = computeEffectiveUserAccess(u.groupId, groupMap, u.additionalScopes);
      return {
        id: u.id,
        oidcSubject: u.oidcSubject,
        email: u.email,
        name: u.name,
        avatarUrl: u.avatarUrl,
        groupId: u.groupId,
        groupName: effective.groupName,
        groupScopes: effective.groupScopes,
        additionalScopes: effective.additionalScopes,
        scopes: effective.scopes,
        isBlocked: u.isBlocked,
        isDeleted: false,
        aiApprovalMode: u.aiApprovalMode,
        folderId: u.folderId,
        sortOrder: u.sortOrder,
      };
    });
  }

  async updateUserGroup(userId: string, groupId: string): Promise<User> {
    // Verify the group exists
    const group = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.id, groupId),
    });
    if (!group) {
      throw new Error('Permission group not found');
    }

    const [updatedUser] = await this.db
      .update(users)
      .set({ groupId, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning();

    if (!updatedUser) {
      throw new Error('User not found');
    }

    const mapped = await this.mapDbUserToUser(updatedUser);
    this.emitUser(userId, 'updated');
    this.emitPermissions(userId, mapped.isBlocked ? [] : mapped.scopes, groupId);
    return mapped;
  }

  async assertCanUpdateUserAdditionalScopes(
    actorUserId: string,
    actorScopes: string[],
    userId: string,
    requestedScopes: string[]
  ): Promise<{ targetUser: User; additionalScopes: string[] }> {
    if (userId === actorUserId) {
      throw new AppError(400, 'SELF_PERMISSION_CHANGE', 'Cannot change your own additional permissions');
    }

    const targetUser = await this.getUserById(userId);
    if (!targetUser) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }
    if (targetUser.isDeleted) {
      throw new AppError(409, 'USER_DELETED', 'Deleted users must be restored before they can be changed');
    }
    if (targetUser.oidcSubject.startsWith(SYSTEM_SUBJECT_PREFIX)) {
      throw new AppError(403, 'SYSTEM_USER', 'Cannot modify the system user');
    }

    const denyReason = canManageUser(actorScopes, targetUser.scopes);
    if (denyReason) {
      throw new AppError(403, 'PRIVILEGE_BOUNDARY', denyReason);
    }

    const trimmedScopes = requestedScopes.map((scope) => scope.trim());
    const invalidScopes = trimmedScopes.filter((scope) => !isValidBaseScope(scope));
    if (invalidScopes.length > 0) {
      throw new AppError(400, 'INVALID_SCOPE', `Invalid permission scopes: ${[...new Set(invalidScopes)].join(', ')}`);
    }

    const additionalScopes = canonicalizeScopes(trimmedScopes);
    if (additionalScopes.includes('admin:system')) {
      throw new AppError(403, 'SCOPE_NOT_ALLOWED', 'admin:system cannot be assigned as an additional permission');
    }
    if (!isScopeSubset(additionalScopes, actorScopes)) {
      const disallowedScopes = additionalScopes.filter((scope) => !isScopeSubset([scope], actorScopes));
      throw new AppError(
        403,
        'PRIVILEGE_BOUNDARY',
        `Cannot grant permissions you do not possess: ${disallowedScopes.join(', ')}`
      );
    }

    const effectiveScopes = canonicalizeScopes([...(targetUser.groupScopes ?? []), ...additionalScopes]);
    if (!isScopeSubset(effectiveScopes, actorScopes)) {
      throw new AppError(403, 'PRIVILEGE_BOUNDARY', 'Cannot manage the resulting user permissions');
    }

    return { targetUser, additionalScopes };
  }

  async updateUserAdditionalScopes(userId: string, additionalScopes: string[]): Promise<User> {
    const [updatedUser] = await this.db
      .update(users)
      .set({ additionalScopes: canonicalizeScopes(additionalScopes), updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning();

    if (!updatedUser) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    const mapped = await this.mapDbUserToUser(updatedUser);
    this.emitUser(userId, 'updated');
    this.emitPermissions(userId, mapped.isBlocked ? [] : mapped.scopes, mapped.groupId);
    return mapped;
  }

  async assertCanUpdateUserGroup(
    actorUserId: string,
    actorScopes: string[],
    userId: string,
    groupId: string
  ): Promise<User> {
    if (userId === actorUserId) {
      throw new AppError(400, 'SELF_DEMOTION', 'Cannot change your own group');
    }

    const targetUser = await this.getUserById(userId);
    if (!targetUser) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }
    if (targetUser.isDeleted) {
      throw new AppError(409, 'USER_DELETED', 'Deleted users must be restored before they can be changed');
    }

    if (targetUser.oidcSubject.startsWith('system:')) {
      throw new AppError(403, 'SYSTEM_USER', 'Cannot modify the system user');
    }

    const denyReason = canManageUser(actorScopes, targetUser.scopes);
    if (denyReason) {
      throw new AppError(403, 'PRIVILEGE_BOUNDARY', denyReason);
    }

    const groupMap = await fetchGroupScopeMap(this.db);
    if (!groupMap.has(groupId)) {
      throw new AppError(404, 'NOT_FOUND', 'Permission group not found');
    }

    const destScopes = computeEffectiveGroupAccess(groupId, groupMap).scopes;
    if (!isScopeSubset(destScopes, actorScopes)) {
      throw new AppError(403, 'PRIVILEGE_BOUNDARY', 'Cannot assign a group with permissions you do not possess');
    }

    return targetUser;
  }

  async blockUser(userId: string): Promise<User> {
    const [updatedUser] = await this.db
      .update(users)
      .set({ isBlocked: true, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning();

    if (!updatedUser) {
      throw new Error('User not found');
    }

    this.emitUser(userId, 'updated');
    this.emitPermissions(userId, [], null, 'user_blocked');
    return this.mapDbUserToUser(updatedUser);
  }

  async unblockUser(userId: string): Promise<User> {
    const [updatedUser] = await this.db
      .update(users)
      .set({ isBlocked: false, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning();

    if (!updatedUser) {
      throw new Error('User not found');
    }

    const mapped = await this.mapDbUserToUser(updatedUser);
    this.emitUser(userId, 'updated');
    this.emitPermissions(userId, mapped.scopes, mapped.groupId ?? null);
    return mapped;
  }

  async deleteUser(userId: string, deletedByUserId: string): Promise<void> {
    const target = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    if (target.deletedAt) throw new AppError(409, 'USER_DELETED', 'User is already deleted');

    const systemAdminGroup = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.name, 'system-admin'),
    });
    if (!systemAdminGroup) throw new Error('System administrator group not found');

    const deletedAt = new Date();
    const [deleted] = await this.db
      .update(users)
      .set({
        isBlocked: true,
        deletedAt,
        deletedByUserId,
        deletedFromGroupId: target.groupId,
        groupId: systemAdminGroup.id,
        updatedAt: deletedAt,
      })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning({ id: users.id });
    if (!deleted) throw new AppError(409, 'USER_DELETED', 'User is already deleted');

    await this.sessionService.destroyAllUserSessions(userId);
    await Promise.all([
      this.db.delete(apiTokens).where(eq(apiTokens.userId, userId)),
      this.db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.userId, userId)),
      this.db.update(oauthAccessTokens).set({ revokedAt: deletedAt }).where(eq(oauthAccessTokens.userId, userId)),
      this.db.update(oauthRefreshTokens).set({ revokedAt: deletedAt }).where(eq(oauthRefreshTokens.userId, userId)),
      this.db.update(inferenceTokens).set({ revokedAt: deletedAt }).where(eq(inferenceTokens.userId, userId)),
      this.db.delete(gitLabUserCredentials).where(eq(gitLabUserCredentials.userId, userId)),
      this.db.delete(inferenceOAuthSessions).where(eq(inferenceOAuthSessions.userId, userId)),
    ]);

    logger.info('User soft-deleted', { userId, deletedByUserId });
    this.emitUser(userId, 'deleted');
    this.emitPermissions(userId, [], null, 'user_deleted');
  }

  async listDeletedUsers(): Promise<DeletedUser[]> {
    const deletedUsers = await this.db.query.users.findMany({
      where: isNotNull(users.deletedAt),
      orderBy: (users, { desc }) => [desc(users.deletedAt)],
    });
    const groupMap = await fetchGroupScopeMap(this.db);

    return deletedUsers.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      deletedAt: user.deletedAt!.toISOString(),
      deletedByUserId: user.deletedByUserId,
      deletedFromGroupId: user.deletedFromGroupId,
      originalGroupExists: Boolean(user.deletedFromGroupId && groupMap.has(user.deletedFromGroupId)),
    }));
  }

  async restoreUser(userId: string, requestedGroupId?: string): Promise<User> {
    const deletedUser = await this.db.query.users.findFirst({
      where: and(eq(users.id, userId), isNotNull(users.deletedAt)),
    });
    if (!deletedUser) throw new AppError(404, 'USER_NOT_FOUND', 'Deleted user not found');

    const groupId = requestedGroupId ?? deletedUser.deletedFromGroupId;
    if (!groupId) {
      throw new AppError(409, 'RESTORE_GROUP_REQUIRED', 'Choose a permission group before restoring this user');
    }
    const group = await this.db.query.permissionGroups.findFirst({ where: eq(permissionGroups.id, groupId) });
    if (!group) {
      if (!requestedGroupId) {
        throw new AppError(409, 'RESTORE_GROUP_REQUIRED', 'The original permission group no longer exists');
      }
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Permission group not found');
    }

    const [restored] = await this.db
      .update(users)
      .set({
        groupId: group.id,
        isBlocked: true,
        deletedAt: null,
        deletedByUserId: null,
        deletedFromGroupId: null,
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, userId), isNotNull(users.deletedAt)))
      .returning();
    if (!restored) throw new AppError(404, 'USER_NOT_FOUND', 'Deleted user not found');

    const mapped = await this.mapDbUserToUser(restored);
    this.emitUser(userId, 'updated');
    this.emitPermissions(userId, [], group.id, 'user_restored');
    return mapped;
  }

  async validateSession(sessionId: string): Promise<User | null> {
    return this.sessionService.validateSession(sessionId);
  }
}
