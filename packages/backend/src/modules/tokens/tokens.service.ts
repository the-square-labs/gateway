import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { apiTokens } from '@/db/schema/index.js';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import { createChildLogger } from '@/lib/logger.js';
import { boundScopes, hasScope as permissionHasScope } from '@/lib/permissions.js';
import { canonicalizeScopes, isApiTokenScope } from '@/lib/scopes.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import { apiTokenChangedChannel } from '@/modules/auth/user-resource-events.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import type { CreateTokenInput, UpdateTokenInput } from './tokens.schemas.js';

const logger = createChildLogger('TokensService');

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

@injectable()
export class TokensService {
  private eventBus?: EventBusService;

  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  async createToken(userId: string, input: CreateTokenInput) {
    const raw = `gw_${randomBytes(32).toString('hex')}`;
    const tokenHash = hashToken(raw);
    const tokenPrefix = raw.slice(0, 10);
    const scopes = canonicalizeScopes(input.scopes).filter(isApiTokenScope);

    const [token] = await this.db
      .insert(apiTokens)
      .values({
        userId,
        name: input.name,
        tokenHash,
        tokenPrefix,
        scopes,
      })
      .returning();

    logger.info('Created API token', { tokenId: token.id, userId, scopes });
    await this.auditService.log({
      userId,
      action: 'api_token.create',
      resourceType: 'api-token',
      resourceId: token.id,
      details: { name: token.name, scopes: token.scopes },
    });
    this.eventBus?.publish(apiTokenChangedChannel(userId), { action: 'create', id: token.id, userId });

    return {
      id: token.id,
      name: token.name,
      tokenPrefix: token.tokenPrefix,
      scopes: token.scopes.filter(isApiTokenScope),
      lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
      createdAt: token.createdAt.toISOString(),
      token: raw,
    };
  }

  async listTokens(userId: string) {
    const [tokens, user] = await Promise.all([
      this.db.query.apiTokens.findMany({
        where: eq(apiTokens.userId, userId),
      }),
      resolveLiveUser(this.db, userId),
    ]);
    const ownerScopes = user?.scopes ?? [];

    return tokens.map((t) => ({
      id: t.id,
      name: t.name,
      tokenPrefix: t.tokenPrefix,
      scopes: canonicalizeScopes(boundScopes(t.scopes, ownerScopes)).filter(isApiTokenScope),
      lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    }));
  }

  async renameToken(userId: string, tokenId: string, name: string): Promise<void> {
    await this.updateToken(userId, tokenId, { name });
  }

  async updateToken(userId: string, tokenId: string, input: UpdateTokenInput): Promise<void> {
    const token = await this.db.query.apiTokens.findFirst({
      where: and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)),
    });
    if (!token) throw new AppError(404, 'TOKEN_NOT_FOUND', 'Token not found');
    const patch: Partial<typeof apiTokens.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.scopes !== undefined) patch.scopes = canonicalizeScopes(input.scopes).filter(isApiTokenScope);
    await this.db.update(apiTokens).set(patch).where(eq(apiTokens.id, tokenId));
    await this.auditService.log({
      userId,
      action: input.scopes === undefined ? 'api_token.rename' : 'api_token.update',
      resourceType: 'api-token',
      resourceId: tokenId,
      details: {
        name: input.name ?? token.name,
        ...(input.scopes !== undefined ? { previousScopes: token.scopes, scopes: patch.scopes } : {}),
      },
    });
    this.eventBus?.publish(apiTokenChangedChannel(userId), { action: 'update', id: tokenId, userId });
  }

  async revokeToken(userId: string, tokenId: string): Promise<void> {
    const token = await this.db.query.apiTokens.findFirst({
      where: and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)),
    });

    if (!token) {
      throw new AppError(404, 'TOKEN_NOT_FOUND', 'Token not found');
    }

    await this.db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
    logger.info('Revoked API token', { tokenId, userId });
    await this.auditService.log({
      userId,
      action: 'api_token.revoke',
      resourceType: 'api-token',
      resourceId: tokenId,
      details: { name: token.name, scopes: token.scopes },
    });
    this.eventBus?.publish(apiTokenChangedChannel(userId), { action: 'revoke', id: tokenId, userId });
  }

  async validateToken(
    rawToken: string
  ): Promise<{ user: User; scopes: string[]; tokenId: string; tokenPrefix: string } | null> {
    const tokenHash = hashToken(rawToken);

    const token = await this.db.query.apiTokens.findFirst({
      where: eq(apiTokens.tokenHash, tokenHash),
    });

    if (!token) return null;

    this.db
      .update(apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiTokens.id, token.id))
      .execute()
      .catch((err) => logger.error('Failed to update lastUsedAt', { err }));

    const user = await resolveLiveUser(this.db, token.userId);

    if (!user) return null;
    if (user.isBlocked) return null;

    const scopes = await expandFolderScopes(
      this.db,
      boundScopes(token.scopes || [], user.scopes).filter(isApiTokenScope)
    );
    return {
      user,
      scopes,
      tokenId: token.id,
      tokenPrefix: token.tokenPrefix,
    };
  }

  /**
   * Check if scopes grant a required permission.
   * Supports hierarchical matching: 'cert:issue' grants 'cert:issue:ca-123'
   */
  static hasScope(scopes: string[], requiredScope: string): boolean {
    return permissionHasScope(scopes, requiredScope);
  }
}
