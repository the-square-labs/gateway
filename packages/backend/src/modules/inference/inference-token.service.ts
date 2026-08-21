import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { inferenceTokens } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import { inferenceTokenChangedChannel } from '@/modules/auth/user-resource-events.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import type { CreateInferenceTokenInput } from './inference.schemas.js';

const logger = createChildLogger('InferenceTokenService');

function hashInferenceToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function serializeToken(token: typeof inferenceTokens.$inferSelect) {
  return {
    id: token.id,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    status: token.revokedAt ? ('revoked' as const) : ('active' as const),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
    createdAt: token.createdAt.toISOString(),
  };
}

function serializeManagedToken(token: typeof inferenceTokens.$inferSelect) {
  return {
    id: token.id,
    name: token.name,
    prefix: token.tokenPrefix,
    harness: token.harness!,
    deviceName: token.deviceName!,
    installationId: token.installationId!,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
  };
}

export interface ManagedInferenceTokenInput {
  harness: 'codex' | 'claude-code';
  deviceName: string;
  installationId: string;
  replaceExisting?: boolean;
}

@injectable()
export class InferenceTokenService {
  private eventBus?: EventBusService;

  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  async createToken(userId: string, input: CreateInferenceTokenInput) {
    const raw = `gwi_${randomBytes(32).toString('hex')}`;
    const [token] = await this.db
      .insert(inferenceTokens)
      .values({
        userId,
        name: input.name.trim(),
        tokenHash: hashInferenceToken(raw),
        tokenPrefix: raw.slice(0, 12),
      })
      .returning();

    logger.info('Created inference token', { tokenId: token.id, userId });
    await this.auditService.log({
      userId,
      action: 'inference_token.create',
      resourceType: 'inference-token',
      resourceId: token.id,
      details: { name: token.name, tokenPrefix: token.tokenPrefix },
    });
    this.eventBus?.publish(inferenceTokenChangedChannel(userId), { action: 'create', id: token.id, userId });

    return { ...serializeToken(token), token: raw };
  }

  async createManagedToken(userId: string, input: ManagedInferenceTokenInput) {
    const raw = `gwi_${randomBytes(32).toString('hex')}`;
    const token = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`gateway-cli:${userId}:${input.harness}:${input.installationId}`}, 0))`
      );
      const existing = await tx.query.inferenceTokens.findFirst({
        where: and(
          eq(inferenceTokens.userId, userId),
          eq(inferenceTokens.managedBy, 'gateway-cli'),
          eq(inferenceTokens.harness, input.harness),
          eq(inferenceTokens.installationId, input.installationId),
          isNull(inferenceTokens.revokedAt)
        ),
      });
      if (existing && !input.replaceExisting) {
        throw new AppError(
          409,
          'INFERENCE_SETUP_TOKEN_EXISTS',
          'An active token already exists for this installation',
          {
            tokenId: existing.id,
          }
        );
      }
      if (existing) {
        await tx.update(inferenceTokens).set({ revokedAt: new Date() }).where(eq(inferenceTokens.id, existing.id));
      }
      const [created] = await tx
        .insert(inferenceTokens)
        .values({
          userId,
          name: `${input.harness === 'codex' ? 'Codex' : 'Claude Code'} · ${input.deviceName.trim()}`,
          managedBy: 'gateway-cli',
          harness: input.harness,
          deviceName: input.deviceName.trim(),
          installationId: input.installationId,
          tokenHash: hashInferenceToken(raw),
          tokenPrefix: raw.slice(0, 12),
        })
        .returning();
      return created;
    });

    logger.info('Created managed inference token', { tokenId: token.id, userId, harness: token.harness });
    await this.auditService.log({
      userId,
      action: 'inference_token.create',
      resourceType: 'inference-token',
      resourceId: token.id,
      details: {
        name: token.name,
        tokenPrefix: token.tokenPrefix,
        managedBy: token.managedBy,
        harness: token.harness,
        installationId: token.installationId,
        replaced: input.replaceExisting === true,
      },
    });
    this.eventBus?.publish(inferenceTokenChangedChannel(userId), {
      action: input.replaceExisting ? 'replace' : 'create',
      id: token.id,
      userId,
    });
    return { ...serializeManagedToken(token), token: raw };
  }

  async listTokens(userId: string) {
    const tokens = await this.db.query.inferenceTokens.findMany({
      where: eq(inferenceTokens.userId, userId),
      orderBy: [desc(inferenceTokens.createdAt)],
    });
    return tokens.map(serializeToken);
  }

  async listManagedTokens(userId: string) {
    const tokens = await this.db.query.inferenceTokens.findMany({
      where: and(
        eq(inferenceTokens.userId, userId),
        eq(inferenceTokens.managedBy, 'gateway-cli'),
        isNull(inferenceTokens.revokedAt)
      ),
      orderBy: [desc(inferenceTokens.createdAt)],
    });
    return tokens.map(serializeManagedToken);
  }

  async revokeManagedToken(userId: string, tokenId: string): Promise<void> {
    const token = await this.db.query.inferenceTokens.findFirst({
      where: and(
        eq(inferenceTokens.id, tokenId),
        eq(inferenceTokens.userId, userId),
        eq(inferenceTokens.managedBy, 'gateway-cli'),
        isNull(inferenceTokens.revokedAt)
      ),
    });
    if (!token) throw new AppError(404, 'INFERENCE_TOKEN_NOT_FOUND', 'Managed inference token not found');
    await this.revokeToken(userId, tokenId);
  }

  async revokeToken(userId: string, tokenId: string): Promise<void> {
    const token = await this.db.query.inferenceTokens.findFirst({
      where: and(
        eq(inferenceTokens.id, tokenId),
        eq(inferenceTokens.userId, userId),
        isNull(inferenceTokens.revokedAt)
      ),
    });
    if (!token) throw new AppError(404, 'INFERENCE_TOKEN_NOT_FOUND', 'Inference token not found');

    const revokedAt = new Date();
    await this.db.update(inferenceTokens).set({ revokedAt }).where(eq(inferenceTokens.id, token.id));
    logger.info('Revoked inference token', { tokenId: token.id, userId });
    await this.auditService.log({
      userId,
      action: 'inference_token.revoke',
      resourceType: 'inference-token',
      resourceId: token.id,
      details: { name: token.name, tokenPrefix: token.tokenPrefix },
    });
    this.eventBus?.publish(inferenceTokenChangedChannel(userId), { action: 'revoke', id: token.id, userId });
  }

  async validateToken(rawToken: string): Promise<{ user: User; tokenId: string; tokenPrefix: string } | null> {
    if (!rawToken.startsWith('gwi_')) return null;

    const token = await this.db.query.inferenceTokens.findFirst({
      where: and(eq(inferenceTokens.tokenHash, hashInferenceToken(rawToken)), isNull(inferenceTokens.revokedAt)),
    });
    if (!token) return null;

    const user = await resolveLiveUser(this.db, token.userId);
    if (!user || user.isBlocked || !hasScope(user.scopes, 'feat:ai:use')) return null;

    this.db
      .update(inferenceTokens)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(inferenceTokens.id, token.id), isNull(inferenceTokens.revokedAt)))
      .execute()
      .catch((error) => logger.error('Failed to update inference token lastUsedAt', { tokenId: token.id, error }));

    return { user, tokenId: token.id, tokenPrefix: token.tokenPrefix };
  }
}

export const __testOnly = { hashInferenceToken };
