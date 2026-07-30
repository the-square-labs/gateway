import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { inferenceProviderConnections, inferenceProviderCredentials } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { InferenceCredentialVault } from '../inference-credential-vault.js';
import type { InferenceOAuthService } from './inference-oauth.service.js';
import type { InferenceCredentialPayload } from './inference-provider.types.js';

const REFRESH_SKEW_MS = 5 * 60_000;
const REFRESH_LOCK_SECONDS = 30;

@injectable()
export class InferenceProviderCredentialService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    @inject(TOKENS.RedisClient) private readonly redis: Redis,
    private readonly vault: InferenceCredentialVault,
    private readonly oauth: InferenceOAuthService
  ) {}

  async get(connectionId: string): Promise<InferenceCredentialPayload> {
    const record = await this.read(connectionId);
    const credential = this.decrypt(record.credential);
    if (!needsRefresh(record.credential.expiresAt, credential)) return credential;
    return this.refreshLocked(connectionId, record.connection.providerId, credential);
  }

  async replace(connectionId: string, kind: 'oauth' | 'api_key' | 'local', payload: InferenceCredentialPayload) {
    const sealed = this.vault.seal(payload);
    await this.db
      .insert(inferenceProviderCredentials)
      .values({
        connectionId,
        credentialKind: kind,
        encryptedPayload: sealed.encryptedPayload,
        encryptedDek: sealed.encryptedDek,
        keyVersion: sealed.keyVersion,
        secretLast4: (payload.apiKey ?? payload.accessToken)?.slice(-4),
        expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
        refreshedAt: kind === 'oauth' ? new Date() : null,
      })
      .onConflictDoUpdate({
        target: [inferenceProviderCredentials.connectionId, inferenceProviderCredentials.credentialKind],
        set: {
          encryptedPayload: sealed.encryptedPayload,
          encryptedDek: sealed.encryptedDek,
          keyVersion: sealed.keyVersion,
          secretLast4: (payload.apiKey ?? payload.accessToken)?.slice(-4),
          expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
          refreshedAt: kind === 'oauth' ? new Date() : null,
          updatedAt: new Date(),
        },
      });
  }

  private async refreshLocked(
    connectionId: string,
    providerId: string,
    current: InferenceCredentialPayload
  ): Promise<InferenceCredentialPayload> {
    if (!current.refreshToken) {
      await this.markReauth(connectionId, 'OAuth credential cannot be refreshed');
      throw new AppError(401, 'INFERENCE_PROVIDER_REAUTH_REQUIRED', 'Provider connection needs reauthentication');
    }

    const lockKey = `inference:provider-refresh:${connectionId}`;
    const lockValue = crypto.randomUUID();
    const acquired = await this.redis.set(lockKey, lockValue, 'EX', REFRESH_LOCK_SECONDS, 'NX');
    if (!acquired) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const reread = await this.read(connectionId);
      const credential = this.decrypt(reread.credential);
      if (!needsRefresh(reread.credential.expiresAt, credential)) return credential;
      throw new AppError(409, 'INFERENCE_PROVIDER_REFRESH_BUSY', 'Provider credential refresh is already in progress');
    }

    try {
      const refreshed = await this.oauth.refresh(providerId, current);
      await this.replace(connectionId, 'oauth', refreshed);
      return refreshed;
    } catch (error) {
      if (error instanceof AppError && error.code === 'INFERENCE_OAUTH_REFRESH_REJECTED') {
        await this.markReauth(connectionId, 'OAuth refresh token was rejected');
        throw new AppError(401, 'INFERENCE_PROVIDER_REAUTH_REQUIRED', 'Provider connection needs reauthentication', {
          cause: error,
        });
      }
      throw new AppError(
        503,
        'INFERENCE_PROVIDER_REFRESH_UNAVAILABLE',
        'Provider credential refresh is temporarily unavailable',
        {
          cause: error,
        }
      );
    } finally {
      await this.redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        lockKey,
        lockValue
      );
    }
  }

  private async read(connectionId: string) {
    const connection = await this.db.query.inferenceProviderConnections.findFirst({
      where: eq(inferenceProviderConnections.id, connectionId),
    });
    const credential = await this.db.query.inferenceProviderCredentials.findFirst({
      where: eq(inferenceProviderCredentials.connectionId, connectionId),
    });
    if (!connection || connection.deletedAt || !credential) {
      throw new AppError(404, 'INFERENCE_PROVIDER_NOT_FOUND', 'Provider connection not found');
    }
    return { connection, credential };
  }

  private decrypt(credential: typeof inferenceProviderCredentials.$inferSelect): InferenceCredentialPayload {
    return this.vault.open<InferenceCredentialPayload>({
      encryptedPayload: credential.encryptedPayload,
      encryptedDek: credential.encryptedDek,
      keyVersion: credential.keyVersion,
    });
  }

  private async markReauth(connectionId: string, reason: string) {
    await this.db
      .update(inferenceProviderConnections)
      .set({ status: 'reauth_required', healthReason: reason, updatedAt: new Date() })
      .where(eq(inferenceProviderConnections.id, connectionId));
  }
}

function needsRefresh(expiresAt: Date | null, credential: InferenceCredentialPayload): boolean {
  if (!credential.refreshToken) return false;
  const expiry = credential.expiresAt ?? expiresAt?.getTime();
  return typeof expiry === 'number' && expiry <= Date.now() + REFRESH_SKEW_MS;
}

export const __testOnly = { needsRefresh };
