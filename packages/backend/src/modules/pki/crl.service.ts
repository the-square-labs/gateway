import { and, eq } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { certificateAuthorities, certificates } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { x509 } from '@/lib/x509.js';
import { AppError } from '@/middleware/error-handler.js';
import { getEnvironmentSettingsSnapshot } from '@/modules/settings/environment-settings.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { CAService } from './ca.service.js';

const logger = createChildLogger('CRLService');

const CRL_CACHE_PREFIX = 'crl:';

@injectable()
export class CRLService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly caService: CAService,
    private readonly cacheService: CacheService
  ) {
    // CAService and CertService republish CRLs after revocations through this.
    this.caService.setCrlPublisher?.(this);
  }

  /**
   * Public CRL for a user CA. System CAs are hidden from the public PKI
   * endpoints, so they are always "not found" here, whether or not an internal
   * refresh cached their CRL. The CA row is read before the cache for that
   * reason; the cache still saves the signing work.
   */
  async getCRL(caId: string): Promise<Buffer> {
    const ca = await this.db.query.certificateAuthorities.findFirst({
      where: eq(certificateAuthorities.id, caId),
      columns: { id: true, status: true, lastCrlDer: true, isSystem: true },
    });
    if (!ca || ca.isSystem) throw new AppError(404, 'CA_NOT_FOUND', 'CA not found');

    const cached = await this.cacheService.get<string>(`${CRL_CACHE_PREFIX}${caId}`);
    if (cached) {
      return Buffer.from(cached, 'base64');
    }

    if (ca.status !== 'active') {
      // A revoked CA keeps serving its final CRL. One revoked before final
      // CRLs were stored gets it published on first request.
      if (ca.lastCrlDer) {
        await this.cacheCrl(caId, ca.lastCrlDer);
        return Buffer.from(ca.lastCrlDer, 'base64');
      }
      return this.generateCRL(caId, { allowInactive: true });
    }

    return this.generateCRL(caId);
  }

  async generateCRL(caId: string, options?: { allowSystem?: boolean; allowInactive?: boolean }): Promise<Buffer> {
    const validityHours = getEnvironmentSettingsSnapshot().pkiDefaults.crlValidityHours;
    const { ca, privateKeyPem } = await this.caService.getCASigningMaterials(caId, options);

    // Get all revoked certificates for this CA
    const revokedCerts = await this.db.query.certificates.findMany({
      where: and(eq(certificates.caId, caId), eq(certificates.status, 'revoked')),
      columns: {
        serialNumber: true,
        revokedAt: true,
        revocationReason: true,
      },
    });
    // A revoked intermediate CA is a certificate this CA issued, so it belongs
    // in this CA's CRL as well.
    const revokedChildCAs = await this.db.query.certificateAuthorities.findMany({
      where: and(eq(certificateAuthorities.parentId, caId), eq(certificateAuthorities.status, 'revoked')),
      columns: {
        serialNumber: true,
        revokedAt: true,
      },
    });

    const algorithm = this.caService.getAlgorithm(ca.keyAlgorithm);
    const caKeys = await this.caService.importKeyPair(ca.certificatePem, privateKeyPem, algorithm, true);

    // Increment CRL number
    const newCrlNumber = ca.crlNumber + 1;

    // Build CRL entries
    const entries = [...revokedCerts, ...revokedChildCAs].map((revoked) => ({
      serialNumber: revoked.serialNumber,
      revocationDate: revoked.revokedAt || new Date(),
    })) as unknown as x509.X509CrlEntry[];

    const thisUpdate = new Date();
    const nextUpdate = new Date();
    nextUpdate.setHours(nextUpdate.getHours() + validityHours);
    // A CA that is no longer active publishes no further CRL, so its final
    // CRL stays current until the CA itself expires.
    if (ca.status !== 'active' && ca.notAfter > nextUpdate) {
      nextUpdate.setTime(ca.notAfter.getTime());
    }

    const crl = await x509.X509CrlGenerator.create({
      issuer: ca.subjectDn,
      thisUpdate,
      nextUpdate,
      entries,
      signingKey: caKeys.privateKey,
      signingAlgorithm: algorithm,
    });

    const crlDer = Buffer.from(crl.rawData);
    const crlBase64 = crlDer.toString('base64');

    // Update CA CRL tracking and keep the published CRL for later serving.
    await this.db
      .update(certificateAuthorities)
      .set({ crlNumber: newCrlNumber, lastCrlAt: new Date(), lastCrlDer: crlBase64, updatedAt: new Date() })
      .where(eq(certificateAuthorities.id, caId));

    await this.cacheCrl(caId, crlBase64);

    logger.info('Generated CRL', { caId, entries: entries.length, crlNumber: newCrlNumber });

    return crlDer;
  }

  async invalidateCache(caId: string): Promise<void> {
    await this.cacheService.delete(`${CRL_CACHE_PREFIX}${caId}`);
  }

  private async cacheCrl(caId: string, crlBase64: string): Promise<void> {
    const ttlSeconds = getEnvironmentSettingsSnapshot().pkiDefaults.crlValidityHours * 3600;
    await this.cacheService.set(`${CRL_CACHE_PREFIX}${caId}`, crlBase64, ttlSeconds);
  }
}
