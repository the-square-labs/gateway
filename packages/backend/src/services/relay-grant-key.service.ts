import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { relayGrantSigningKeys, relayPolicyState } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CryptoService } from './crypto.service.js';
import { bumpRelayPolicyRevision } from './relay-policy-reconciler.js';

const logger = createChildLogger('RelayGrantKeyService');
const POLICY_ID = 'current';
const KEY_ROTATION_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLIC_KEY_RETENTION_MS = 48 * 60 * 60 * 1000 + 5 * 60 * 1000;

export class RelayGrantKeyService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService
  ) {}

  async ensureInitialized(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-policy-bootstrap'))`);
      await tx
        .insert(relayPolicyState)
        .values({ id: POLICY_ID, gatewayInstanceId: randomUUID(), revision: 0 })
        .onConflictDoNothing();
      const [active] = await tx
        .select({ id: relayGrantSigningKeys.id })
        .from(relayGrantSigningKeys)
        .where(eq(relayGrantSigningKeys.status, 'active'))
        .limit(1);
      if (!active) {
        await this.insertKey(tx, 'active', new Date());
        await bumpRelayPolicyRevision(tx);
      }
    });
  }

  async rotateIfDue(
    now: Date,
    syncSnapshot: () => Promise<number>,
    refreshGrants: () => Promise<void>
  ): Promise<boolean> {
    const pendingId = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-signing-key-rotation'))`);
      const [existingPending] = await tx
        .select({ id: relayGrantSigningKeys.id })
        .from(relayGrantSigningKeys)
        .where(eq(relayGrantSigningKeys.status, 'pending'))
        .limit(1);
      if (existingPending) return existingPending.id;

      const [active] = await tx
        .select({ activatedAt: relayGrantSigningKeys.activatedAt })
        .from(relayGrantSigningKeys)
        .where(eq(relayGrantSigningKeys.status, 'active'))
        .limit(1);
      if (!active?.activatedAt || now.getTime() - active.activatedAt.getTime() < KEY_ROTATION_MS) return null;

      const [created] = await this.insertKey(tx, 'pending', null);
      await bumpRelayPolicyRevision(tx);
      return created.id;
    });

    if (!pendingId) {
      if (await this.retireExpiredVerificationKeys(now)) await syncSnapshot();
      return false;
    }

    await syncSnapshot();
    const activated = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-signing-key-rotation'))`);
      const [pending] = await tx
        .select({ status: relayGrantSigningKeys.status })
        .from(relayGrantSigningKeys)
        .where(eq(relayGrantSigningKeys.id, pendingId))
        .limit(1);
      if (pending?.status !== 'pending') return false;

      const verifyUntil = new Date(now.getTime() + PUBLIC_KEY_RETENTION_MS);
      await tx
        .update(relayGrantSigningKeys)
        .set({
          status: 'verification_only',
          verifyUntil,
          encryptedPrivateKey: null,
          encryptedDek: null,
          privateKeyDestroyedAt: now,
        })
        .where(eq(relayGrantSigningKeys.status, 'active'));
      await tx
        .update(relayGrantSigningKeys)
        .set({ status: 'active', activatedAt: now })
        .where(eq(relayGrantSigningKeys.id, pendingId));
      return true;
    });
    if (activated) {
      logger.info('Rotated relay grant signing key', { pendingId });
      await refreshGrants().catch((error) => {
        logger.warn('Relay signing key rotated; some daemon grants will refresh on reconnect or retry', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return activated;
  }

  private async insertKey(tx: any, status: 'pending' | 'active', activatedAt: Date | null) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' });
    if (!jwk.x) throw new Error('Generated Ed25519 public key is missing x coordinate');
    const publicKeyRaw = Buffer.from(jwk.x, 'base64url');
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const encrypted = this.cryptoService.encryptPrivateKey(privateKeyPem);
    return tx
      .insert(relayGrantSigningKeys)
      .values({
        keyId: randomUUID(),
        publicKey: publicKeyRaw.toString('base64'),
        encryptedPrivateKey: encrypted.encryptedPrivateKey,
        encryptedDek: encrypted.encryptedDek,
        status,
        activatedAt,
      })
      .returning({ id: relayGrantSigningKeys.id });
  }

  private async retireExpiredVerificationKeys(now: Date): Promise<boolean> {
    const retiredCount = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-signing-key-rotation'))`);
      const retired = await tx
        .update(relayGrantSigningKeys)
        .set({ status: 'retired', retiredAt: now })
        .where(and(eq(relayGrantSigningKeys.status, 'verification_only'), lte(relayGrantSigningKeys.verifyUntil, now)))
        .returning({ id: relayGrantSigningKeys.id });
      if (retired.length) await bumpRelayPolicyRevision(tx);
      return retired.length;
    });
    return retiredCount > 0;
  }
}
