import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { relayInstances, relayPolicySigningKeys } from '@/db/schema/index.js';
import type { CryptoService } from './crypto.service.js';

const KEY_ROTATION_MS = 30 * 24 * 60 * 60 * 1000;
const KEY_OVERLAP_MS = 30 * 60 * 1000;

function allPolicyKeysAcknowledged(
  instances: Array<{ health: { policySigningKeyIds?: string[] } | null }>,
  keyId: string
): boolean {
  return instances.every(({ health }) => health?.policySigningKeyIds?.includes(keyId));
}

export interface RelayPolicyTrustAnchor {
  keyId: string;
  publicKey: Buffer;
  fingerprint: string;
}

export interface RelayPublishedPolicyKey extends RelayPolicyTrustAnchor {
  status: 'pending' | 'active' | 'verification_only';
  activatedAt: Date | null;
  verifyUntil: Date | null;
}

export class RelayPolicySigningKeyService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService
  ) {}

  async ensureInitialized(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-policy-signing-bootstrap'))`);
      const [active] = await tx
        .select({ id: relayPolicySigningKeys.id })
        .from(relayPolicySigningKeys)
        .where(eq(relayPolicySigningKeys.status, 'active'))
        .limit(1);
      if (active) return;
      const generated = this.generateKey();
      await tx.insert(relayPolicySigningKeys).values({
        ...generated,
        status: 'active',
        activatedAt: new Date(),
      });
    });
  }

  async getEnrollmentTrust(): Promise<RelayPolicyTrustAnchor> {
    const [active] = await this.db
      .select()
      .from(relayPolicySigningKeys)
      .where(eq(relayPolicySigningKeys.status, 'active'))
      .limit(1);
    if (!active) throw new Error('Relay policy signing key is not initialized');
    return {
      keyId: active.keyId,
      publicKey: Buffer.from(active.publicKey, 'base64'),
      fingerprint: active.publicKeyFingerprint,
    };
  }

  async listPublishedKeys(): Promise<RelayPublishedPolicyKey[]> {
    const rows = await this.db
      .select()
      .from(relayPolicySigningKeys)
      .where(inArray(relayPolicySigningKeys.status, ['pending', 'active', 'verification_only']));
    return rows
      .map((row) => ({
        keyId: row.keyId,
        publicKey: Buffer.from(row.publicKey, 'base64'),
        fingerprint: row.publicKeyFingerprint,
        status: row.status as RelayPublishedPolicyKey['status'],
        activatedAt: row.activatedAt,
        verifyUntil: row.verifyUntil,
      }))
      .sort((left, right) => left.keyId.localeCompare(right.keyId));
  }

  async signPayload(payload: Buffer): Promise<{ signingKeyId: string; signature: Buffer }> {
    const [active] = await this.db
      .select()
      .from(relayPolicySigningKeys)
      .where(
        and(
          eq(relayPolicySigningKeys.status, 'active'),
          sql`${relayPolicySigningKeys.encryptedPrivateKey} is not null`,
          sql`${relayPolicySigningKeys.encryptedDek} is not null`
        )
      )
      .limit(1);
    if (!active?.encryptedPrivateKey || !active.encryptedDek) {
      throw new Error('Active relay policy signing private key is unavailable');
    }
    const privateKeyPem = this.cryptoService.decryptPrivateKey({
      encryptedPrivateKey: active.encryptedPrivateKey,
      encryptedDek: active.encryptedDek,
      dekIv: '',
    });
    return {
      signingKeyId: active.keyId,
      signature: sign(null, payload, createPrivateKey(privateKeyPem)),
    };
  }

  async beginRotationIfDue(now = new Date()): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-policy-key-rotation'))`);
      const [pending] = await tx
        .select({ keyId: relayPolicySigningKeys.keyId })
        .from(relayPolicySigningKeys)
        .where(eq(relayPolicySigningKeys.status, 'pending'))
        .limit(1);
      if (pending) return pending.keyId;
      const [active] = await tx
        .select({ activatedAt: relayPolicySigningKeys.activatedAt })
        .from(relayPolicySigningKeys)
        .where(eq(relayPolicySigningKeys.status, 'active'))
        .limit(1);
      if (!active?.activatedAt || now.getTime() - active.activatedAt.getTime() < KEY_ROTATION_MS) return null;
      const generated = this.generateKey();
      await tx.insert(relayPolicySigningKeys).values({ ...generated, status: 'pending' });
      return generated.keyId;
    });
  }

  async promoteAcknowledgedPending(now = new Date()): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-policy-key-rotation'))`);
      const [pending] = await tx
        .select({ id: relayPolicySigningKeys.id, keyId: relayPolicySigningKeys.keyId })
        .from(relayPolicySigningKeys)
        .where(eq(relayPolicySigningKeys.status, 'pending'))
        .limit(1);
      if (!pending) return false;
      const readyRemoteInstances = await tx
        .select({ health: relayInstances.health })
        .from(relayInstances)
        .where(
          and(eq(relayInstances.kind, 'remote'), inArray(relayInstances.state, ['synchronizing', 'ready', 'draining']))
        );
      if (!allPolicyKeysAcknowledged(readyRemoteInstances, pending.keyId)) return false;
      await tx
        .update(relayPolicySigningKeys)
        .set({
          status: 'verification_only',
          verifyUntil: new Date(now.getTime() + KEY_OVERLAP_MS),
          encryptedPrivateKey: null,
          encryptedDek: null,
          privateKeyDestroyedAt: now,
        })
        .where(eq(relayPolicySigningKeys.status, 'active'));
      await tx
        .update(relayPolicySigningKeys)
        .set({ status: 'active', activatedAt: now })
        .where(eq(relayPolicySigningKeys.id, pending.id));
      return true;
    });
  }

  async retireExpiredVerificationKeys(now = new Date()): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-policy-key-rotation'))`);
      const retired = await tx
        .update(relayPolicySigningKeys)
        .set({ status: 'retired', retiredAt: now })
        .where(
          and(eq(relayPolicySigningKeys.status, 'verification_only'), lte(relayPolicySigningKeys.verifyUntil, now))
        )
        .returning({ id: relayPolicySigningKeys.id });
      return retired.length > 0;
    });
  }

  private generateKey() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' });
    if (!jwk.x) throw new Error('Generated relay policy Ed25519 public key is missing x coordinate');
    const rawPublicKey = Buffer.from(jwk.x, 'base64url');
    const encrypted = this.cryptoService.encryptPrivateKey(
      privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    );
    return {
      keyId: randomUUID(),
      publicKey: rawPublicKey.toString('base64'),
      publicKeyFingerprint: `sha256:${createHash('sha256').update(rawPublicKey).digest('hex')}`,
      encryptedPrivateKey: encrypted.encryptedPrivateKey,
      encryptedDek: encrypted.encryptedDek,
    };
  }
}

export const relayPolicySigningKeyInternals = { allPolicyKeysAcknowledged };
