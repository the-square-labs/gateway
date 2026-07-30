import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { oauthAccessTokens, oauthClients, oauthRefreshTokens } from '@/db/schema/index.js';
import { canonicalizeScopes, isValidBaseScope } from '@/lib/scopes.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import type { User } from '@/types.js';
import type { OAuthTokenRequest } from './oauth.schemas.js';

const ACCESS_TOKEN_TTL_SECONDS = 900;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export type OAuthTokenResponse = {
  access_token: string;
  token_type: 'Bearer';
  scope: string;
  expires_in?: number;
  refresh_token?: string;
};

type IssuedTokens = {
  refreshTokenId: string | null;
  response: OAuthTokenResponse;
};

type OAuthClientRecord = {
  clientId: string;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
};

type OAuthTokenLifecycleDeps = {
  db: DrizzleClient;
  auditService: AuditService;
  getApiResourceUrl: () => string;
  getMcpResourceUrl: () => string;
  getClient: (clientId: string) => Promise<OAuthClientRecord | undefined>;
  isSupportedResource: (resource: string) => boolean;
  assertResourceAllowed: (user: User, resource: string) => void;
  grantScopes: (user: User, resource: string, requestedScopes: string[]) => string[];
};

export function hashSecret(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function randomSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

function stripNonDelegableMcpScope(scopes: string[]): string[] {
  return scopes.filter((scope) => scope !== 'mcp:use');
}

function resourceWhere(
  table: typeof oauthAccessTokens | typeof oauthRefreshTokens,
  resource: string,
  apiResource: string
) {
  return resource === apiResource
    ? or(isNull(table.resource), eq(table.resource, resource))
    : eq(table.resource, resource);
}

function activeAccessTokenWhere(now: Date) {
  return or(isNull(oauthAccessTokens.expiresAt), gt(oauthAccessTokens.expiresAt, now));
}

export class OAuthTokenLifecycle {
  constructor(private readonly deps: OAuthTokenLifecycleDeps) {}

  private isMcpResource(resource: string): boolean {
    return resource === this.deps.getMcpResourceUrl();
  }

  async exchangeRefreshToken(input: OAuthTokenRequest): Promise<OAuthTokenResponse> {
    if (!input.refresh_token) throw new AppError(400, 'INVALID_REQUEST', 'Refresh token is required');
    const existing = await this.deps.db.query.oauthRefreshTokens.findFirst({
      where: eq(oauthRefreshTokens.tokenHash, hashSecret(input.refresh_token)),
    });
    if (!existing || existing.clientId !== input.client_id || existing.expiresAt.getTime() < Date.now()) {
      throw new AppError(400, 'INVALID_GRANT', 'Invalid refresh token');
    }
    if (existing.revokedAt || existing.replacedByTokenId) {
      await this.revokeRefreshTokenFamily(existing);
      throw new AppError(400, 'INVALID_GRANT', 'Invalid refresh token');
    }
    if (input.resource && input.resource !== (existing.resource ?? this.deps.getApiResourceUrl())) {
      throw new AppError(400, 'INVALID_TARGET', 'Resource does not match the refresh token');
    }

    const user = await resolveLiveUser(this.deps.db, existing.userId);
    if (!user || user.isBlocked) throw new AppError(400, 'INVALID_GRANT', 'User is no longer active');

    const resource = existing.resource ?? this.deps.getApiResourceUrl();
    this.deps.assertResourceAllowed(user, resource);
    const scopes = this.deps.grantScopes(user, resource, existing.scopes);
    if (scopes.length === 0) throw new AppError(400, 'INVALID_GRANT', 'User can no longer grant these scopes');

    const issued = await this.deps.db
      .transaction(async (tx) => {
        const now = new Date();
        const [rotatedToken] = await tx
          .update(oauthRefreshTokens)
          .set({ revokedAt: now })
          .where(
            and(
              eq(oauthRefreshTokens.id, existing.id),
              isNull(oauthRefreshTokens.revokedAt),
              isNull(oauthRefreshTokens.replacedByTokenId)
            )
          )
          .returning({ id: oauthRefreshTokens.id });
        if (!rotatedToken) {
          throw new AppError(400, 'REFRESH_TOKEN_REPLAY', 'Refresh token already used');
        }

        const issuedTokens = await this.issueTokens(
          {
            clientId: existing.clientId,
            userId: existing.userId,
            scopes,
            resource,
          },
          tx
        );
        await tx
          .update(oauthRefreshTokens)
          .set({ replacedByTokenId: issuedTokens.refreshTokenId })
          .where(eq(oauthRefreshTokens.id, existing.id));
        return issuedTokens;
      })
      .catch(async (error) => {
        if (error instanceof AppError && error.code === 'REFRESH_TOKEN_REPLAY') {
          await this.revokeRefreshTokenFamily(existing);
          throw new AppError(400, 'INVALID_GRANT', 'Refresh token already used');
        }
        throw error;
      });

    await this.deps.auditService.log({
      userId: existing.userId,
      action: 'oauth.token_refresh',
      resourceType: 'oauth-client',
      resourceId: existing.clientId,
      details: { scopes },
    });
    return issued.response;
  }

  async issueTokens(
    input: { clientId: string; userId: string; scopes: string[]; resource: string },
    db: Pick<DrizzleClient, 'insert'> = this.deps.db
  ): Promise<IssuedTokens> {
    const accessToken = randomSecret('gwo_');
    const now = Date.now();
    const scopes = canonicalizeScopes(input.scopes);
    if (this.isMcpResource(input.resource)) {
      // Accepted MCP design: access-only, long-lived bearer token. MCP clients do
      // not use refresh-token rotation during normal operation; explicit
      // authorization/token revocation is the lifecycle boundary.
      await db.insert(oauthAccessTokens).values({
        tokenHash: hashSecret(accessToken),
        tokenPrefix: accessToken.slice(0, 12),
        clientId: input.clientId,
        userId: input.userId,
        refreshTokenId: null,
        scopes,
        resource: input.resource,
        expiresAt: null,
      });

      return {
        refreshTokenId: null,
        response: {
          access_token: accessToken,
          token_type: 'Bearer',
          scope: scopes.join(' '),
        },
      };
    }

    const refreshToken = randomSecret('gwr_');
    const [refresh] = await db
      .insert(oauthRefreshTokens)
      .values({
        tokenHash: hashSecret(refreshToken),
        tokenPrefix: refreshToken.slice(0, 12),
        clientId: input.clientId,
        userId: input.userId,
        scopes,
        resource: input.resource,
        expiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000),
      })
      .returning();
    await db.insert(oauthAccessTokens).values({
      tokenHash: hashSecret(accessToken),
      tokenPrefix: accessToken.slice(0, 12),
      clientId: input.clientId,
      userId: input.userId,
      refreshTokenId: refresh.id,
      scopes,
      resource: input.resource,
      expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
    });

    return {
      refreshTokenId: refresh.id,
      response: {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: scopes.join(' '),
        refresh_token: refreshToken,
      },
    };
  }

  async validateAccessToken(rawToken: string, options: { resource?: string } = {}) {
    const token = await this.deps.db.query.oauthAccessTokens.findFirst({
      where: and(eq(oauthAccessTokens.tokenHash, hashSecret(rawToken)), isNull(oauthAccessTokens.revokedAt)),
    });
    if (!token || (token.expiresAt && token.expiresAt.getTime() < Date.now())) return null;
    if (options.resource && (token.resource ?? this.deps.getApiResourceUrl()) !== options.resource) return null;

    const user = await resolveLiveUser(this.deps.db, token.userId);
    if (!user || user.isBlocked) return null;
    const resource = token.resource ?? this.deps.getApiResourceUrl();
    this.deps.assertResourceAllowed(user, resource);
    const scopes = this.deps.grantScopes(user, resource, token.scopes);
    if (scopes.length === 0) return null;

    this.deps.db
      .update(oauthAccessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(oauthAccessTokens.id, token.id))
      .execute()
      .catch(() => {});

    return {
      user,
      scopes,
      tokenId: token.id,
      tokenPrefix: token.tokenPrefix,
      clientId: token.clientId,
    };
  }

  async revokeToken(rawToken: string, clientId?: string): Promise<void> {
    const tokenHash = hashSecret(rawToken);
    const now = new Date();
    const accessWhere = clientId
      ? and(eq(oauthAccessTokens.tokenHash, tokenHash), eq(oauthAccessTokens.clientId, clientId))
      : eq(oauthAccessTokens.tokenHash, tokenHash);
    const refreshWhere = clientId
      ? and(eq(oauthRefreshTokens.tokenHash, tokenHash), eq(oauthRefreshTokens.clientId, clientId))
      : eq(oauthRefreshTokens.tokenHash, tokenHash);
    const revokedRefreshTokens = await this.deps.db
      .update(oauthRefreshTokens)
      .set({ revokedAt: now })
      .where(refreshWhere)
      .returning({
        id: oauthRefreshTokens.id,
        clientId: oauthRefreshTokens.clientId,
        userId: oauthRefreshTokens.userId,
        resource: oauthRefreshTokens.resource,
      });
    const accessRevocations = [this.deps.db.update(oauthAccessTokens).set({ revokedAt: now }).where(accessWhere)];
    if (revokedRefreshTokens.length > 0) {
      await Promise.all(revokedRefreshTokens.map((token) => this.revokeRefreshTokenFamily(token, now)));
    }
    await Promise.all(accessRevocations);
  }

  async listUserAuthorizations(userId: string) {
    const now = new Date();
    const [refreshTokens, accessTokens, user] = await Promise.all([
      this.deps.db.query.oauthRefreshTokens.findMany({
        where: and(
          eq(oauthRefreshTokens.userId, userId),
          isNull(oauthRefreshTokens.revokedAt),
          gt(oauthRefreshTokens.expiresAt, now)
        ),
      }),
      this.deps.db.query.oauthAccessTokens.findMany({
        where: and(
          eq(oauthAccessTokens.userId, userId),
          isNull(oauthAccessTokens.revokedAt),
          activeAccessTokenWhere(now)
        ),
      }),
      resolveLiveUser(this.deps.db, userId),
    ]);
    const clientIds = [...new Set([...refreshTokens, ...accessTokens].map((token) => token.clientId))];
    if (clientIds.length === 0) return [];

    const clients = await this.deps.db.query.oauthClients.findMany({
      where: inArray(oauthClients.clientId, clientIds),
    });
    const clientById = new Map(clients.map((client) => [client.clientId, client]));
    const groups = new Map<
      string,
      {
        clientId: string;
        resource: string;
        scopes: Set<string>;
        createdAt: Date;
        expiresAt: Date | null;
        lastUsedAt: Date | null;
        activeAccessTokens: number;
        activeRefreshTokens: number;
      }
    >();

    const apiResource = this.deps.getApiResourceUrl();
    const ensure = (clientId: string, resource: string, createdAt: Date) => {
      const key = `${clientId}\0${resource}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          clientId,
          resource,
          scopes: new Set(),
          createdAt,
          expiresAt: null,
          lastUsedAt: null,
          activeAccessTokens: 0,
          activeRefreshTokens: 0,
        };
        groups.set(key, group);
      }
      if (createdAt < group.createdAt) group.createdAt = createdAt;
      return group;
    };

    for (const token of refreshTokens) {
      const group = ensure(token.clientId, token.resource ?? apiResource, token.createdAt);
      for (const scope of user ? this.deps.grantScopes(user, token.resource ?? apiResource, token.scopes ?? []) : []) {
        group.scopes.add(scope);
      }
      group.activeRefreshTokens += 1;
      if (!group.expiresAt || token.expiresAt > group.expiresAt) group.expiresAt = token.expiresAt;
    }

    for (const token of accessTokens) {
      const group = ensure(token.clientId, token.resource ?? apiResource, token.createdAt);
      for (const scope of user ? this.deps.grantScopes(user, token.resource ?? apiResource, token.scopes ?? []) : []) {
        group.scopes.add(scope);
      }
      group.activeAccessTokens += 1;
      if (token.expiresAt && (!group.expiresAt || token.expiresAt > group.expiresAt)) group.expiresAt = token.expiresAt;
      if (token.lastUsedAt && (!group.lastUsedAt || token.lastUsedAt > group.lastUsedAt)) {
        group.lastUsedAt = token.lastUsedAt;
      }
    }

    return [...groups.values()]
      .map((group) => {
        const client = clientById.get(group.clientId);
        return {
          clientId: group.clientId,
          clientName: client?.clientName ?? 'Unknown OAuth Client',
          clientUri: client?.clientUri ?? null,
          logoUri: client?.logoUri ?? null,
          scopes: canonicalizeScopes([...group.scopes]),
          resource: group.resource,
          resources: [group.resource],
          activeAccessTokens: group.activeAccessTokens,
          activeRefreshTokens: group.activeRefreshTokens,
          createdAt: group.createdAt.toISOString(),
          lastUsedAt: group.lastUsedAt?.toISOString() ?? null,
          expiresAt: group.expiresAt?.toISOString() ?? null,
        };
      })
      .sort((a, b) => {
        const aTime = Date.parse(a.lastUsedAt ?? a.createdAt);
        const bTime = Date.parse(b.lastUsedAt ?? b.createdAt);
        return bTime - aTime;
      });
  }

  async revokeUserAuthorization(userId: string, clientId: string, resource: string): Promise<void> {
    const client = await this.deps.getClient(clientId);
    const now = new Date();
    const apiResource = this.deps.getApiResourceUrl();
    await Promise.all([
      this.deps.db
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(oauthAccessTokens.userId, userId),
            eq(oauthAccessTokens.clientId, clientId),
            resourceWhere(oauthAccessTokens, resource, apiResource)
          )
        ),
      this.deps.db
        .update(oauthRefreshTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(oauthRefreshTokens.userId, userId),
            eq(oauthRefreshTokens.clientId, clientId),
            resourceWhere(oauthRefreshTokens, resource, apiResource)
          )
        ),
    ]);
    await this.deps.auditService.log({
      userId,
      action: 'oauth.authorization_revoke',
      resourceType: 'oauth-client',
      resourceId: clientId,
      details: { clientName: client?.clientName ?? 'Unknown OAuth Client', resource },
    });
  }

  async updateUserAuthorizationScopes(user: User, clientId: string, resource: string, requestedScopes: string[]) {
    const client = await this.deps.getClient(clientId);
    if (!client) throw new AppError(404, 'OAUTH_CLIENT_NOT_FOUND', 'OAuth client not found');
    if (!this.deps.isSupportedResource(resource)) {
      throw new AppError(400, 'INVALID_TARGET', 'OAuth authorization is not available for this resource');
    }

    const canonicalRequestedScopes = canonicalizeScopes(stripNonDelegableMcpScope(requestedScopes));
    if (canonicalRequestedScopes.length === 0) {
      throw new AppError(400, 'INVALID_SCOPE', 'At least one scope is required');
    }

    const invalidScopes = requestedScopes.filter((scope) => !isValidBaseScope(scope));
    if (invalidScopes.length > 0) {
      throw new AppError(400, 'INVALID_SCOPE', `Scopes are not recognized: ${invalidScopes.join(', ')}`);
    }

    const now = new Date();
    const apiResource = this.deps.getApiResourceUrl();
    const [refreshTokens, accessTokens] = await Promise.all([
      this.deps.db.query.oauthRefreshTokens.findMany({
        where: and(
          eq(oauthRefreshTokens.userId, user.id),
          eq(oauthRefreshTokens.clientId, clientId),
          isNull(oauthRefreshTokens.revokedAt),
          gt(oauthRefreshTokens.expiresAt, now),
          resourceWhere(oauthRefreshTokens, resource, apiResource)
        ),
      }),
      this.deps.db.query.oauthAccessTokens.findMany({
        where: and(
          eq(oauthAccessTokens.userId, user.id),
          eq(oauthAccessTokens.clientId, clientId),
          isNull(oauthAccessTokens.revokedAt),
          activeAccessTokenWhere(now),
          resourceWhere(oauthAccessTokens, resource, apiResource)
        ),
      }),
    ]);
    if (refreshTokens.length === 0 && accessTokens.length === 0) {
      throw new AppError(404, 'OAUTH_AUTHORIZATION_NOT_FOUND', 'OAuth authorization not found');
    }

    this.deps.assertResourceAllowed(user, resource);
    const scopes = this.deps.grantScopes(user, resource, canonicalRequestedScopes);
    if (scopes.length === 0) {
      throw new AppError(400, 'INVALID_SCOPE', `No selected scopes are grantable for resource ${resource}`);
    }

    await Promise.all([
      this.deps.db
        .update(oauthRefreshTokens)
        .set({ scopes })
        .where(
          and(
            eq(oauthRefreshTokens.userId, user.id),
            eq(oauthRefreshTokens.clientId, clientId),
            isNull(oauthRefreshTokens.revokedAt),
            gt(oauthRefreshTokens.expiresAt, now),
            resourceWhere(oauthRefreshTokens, resource, apiResource)
          )
        ),
      this.deps.db
        .update(oauthAccessTokens)
        .set({ scopes })
        .where(
          and(
            eq(oauthAccessTokens.userId, user.id),
            eq(oauthAccessTokens.clientId, clientId),
            isNull(oauthAccessTokens.revokedAt),
            activeAccessTokenWhere(now),
            resourceWhere(oauthAccessTokens, resource, apiResource)
          )
        ),
    ]);

    await this.deps.auditService.log({
      userId: user.id,
      action: 'oauth.authorization_update',
      resourceType: 'oauth-client',
      resourceId: clientId,
      details: { clientName: client.clientName, resource, scopes },
    });

    const [authorization] = (await this.listUserAuthorizations(user.id)).filter(
      (item) => item.clientId === clientId && item.resource === resource
    );
    return authorization;
  }

  private async revokeRefreshTokenFamily(
    seed: { id: string; clientId: string; userId: string; resource: string | null },
    now = new Date()
  ): Promise<string[]> {
    const apiResource = this.deps.getApiResourceUrl();
    const familyTokens = await this.deps.db.query.oauthRefreshTokens.findMany({
      where: and(
        eq(oauthRefreshTokens.clientId, seed.clientId),
        eq(oauthRefreshTokens.userId, seed.userId),
        resourceWhere(oauthRefreshTokens, seed.resource ?? apiResource, apiResource)
      ),
    });
    const family = new Set<string>([seed.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const token of familyTokens) {
        if (family.has(token.id) || (token.replacedByTokenId && family.has(token.replacedByTokenId))) {
          if (!family.has(token.id)) {
            family.add(token.id);
            changed = true;
          }
          if (token.replacedByTokenId && !family.has(token.replacedByTokenId)) {
            family.add(token.replacedByTokenId);
            changed = true;
          }
        }
      }
    }

    const ids = [...family];
    await Promise.all([
      this.deps.db.update(oauthRefreshTokens).set({ revokedAt: now }).where(inArray(oauthRefreshTokens.id, ids)),
      this.deps.db
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(inArray(oauthAccessTokens.refreshTokenId, ids)),
    ]);
    return ids;
  }
}
