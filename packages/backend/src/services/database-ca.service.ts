import { isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { certificateAuthorities, certificates } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CAService } from '@/modules/pki/ca.service.js';
import type { CertService } from '@/modules/pki/cert.service.js';

const logger = createChildLogger('DatabaseCA');
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const DATABASE_CA_CN = 'Gateway Database CA';

/**
 * Purpose-specific CA for direct managed-database TLS. It intentionally does
 * not reuse the daemon-node mTLS CA: users may need this public CA to verify
 * an externally published database endpoint.
 */
export class DatabaseCAService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly caService: CAService,
    private readonly certService: CertService
  ) {}

  async ensureDatabaseCA(): Promise<string> {
    const [existing] = await this.db
      .select({ id: certificateAuthorities.id })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'database-tls'))
      .limit(1);
    if (existing) return existing.id;

    logger.info('Creating system Database CA for managed direct TLS');
    const ca = await this.caService.createRootCA(
      {
        commonName: DATABASE_CA_CN,
        keyAlgorithm: 'ecdsa-p256',
        validityYears: 10,
        maxValidityDays: 730,
        pathLengthConstraint: 0,
      },
      SYSTEM_USER_ID
    );
    await this.db
      .update(certificateAuthorities)
      .set({ isSystem: true, systemPurpose: 'database-tls' })
      .where(eq(certificateAuthorities.id, ca.id));
    logger.info('System Database CA created', { caId: ca.id });
    return ca.id;
  }

  async getDatabaseCA() {
    const [ca] = await this.db
      .select({ id: certificateAuthorities.id, certificatePem: certificateAuthorities.certificatePem })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'database-tls'))
      .limit(1);
    if (!ca) throw new Error('Database CA not found — run ensureDatabaseCA first');
    return ca;
  }

  async issueManagedDatabaseCertificate(managedDatabaseId: string, serviceAddresses: readonly string[]) {
    const sans = [
      ...new Set(serviceAddresses.map((address) => address.trim()).filter((address) => isIP(address) !== 0)),
    ];
    if (sans.length === 0) throw new Error('Managed database node has no configured IP addresses for TLS');
    const ca = await this.getDatabaseCA();
    return this.certService.issueCertificate(
      {
        caId: ca.id,
        type: 'tls-server',
        commonName: `managed-db-${managedDatabaseId}`,
        sans,
        keyAlgorithm: 'ecdsa-p256',
        validityDays: 365,
      },
      SYSTEM_USER_ID,
      { allowSystem: true }
    );
  }

  async getManagedDatabaseCertificateMaterial(certificateId: string) {
    const [certificate] = await this.db
      .select({ id: certificates.id, caId: certificates.caId, certificatePem: certificates.certificatePem })
      .from(certificates)
      .where(eq(certificates.id, certificateId))
      .limit(1);
    if (!certificate) throw new Error('Managed database TLS certificate not found');
    const ca = await this.getDatabaseCA();
    if (certificate.caId !== ca.id) throw new Error('Managed database TLS certificate has an unexpected issuer');
    const privateKeyPem = await this.certService.getCertificatePrivateKey(certificate.id);
    if (!privateKeyPem) throw new Error('Managed database TLS private key is unavailable');
    return { certificatePem: certificate.certificatePem, privateKeyPem, caCertificatePem: ca.certificatePem };
  }
}
