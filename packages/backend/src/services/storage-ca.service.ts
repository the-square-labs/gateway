import { isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import { certificateAuthorities, certificates } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CAService } from '@/modules/pki/ca.service.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import type {
  SystemCertificateCurrentBinding,
  SystemCertificateLifecycleService,
} from './system-certificate-lifecycle.service.js';

const logger = createChildLogger('StorageCA');
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const STORAGE_CA_CN = 'Gateway Storage CA';

/**
 * Purpose-specific CA for direct managed-storage TLS. It intentionally does
 * not reuse the daemon-node mTLS CA: users may need this public CA to verify
 * an externally published storage endpoint.
 */
export class StorageCAService {
  private systemCertificateLifecycle?: SystemCertificateLifecycleService;
  constructor(
    private readonly db: DrizzleClient,
    private readonly caService: CAService,
    private readonly certService: CertService
  ) {}

  setSystemCertificateLifecycleService(service: SystemCertificateLifecycleService) {
    this.systemCertificateLifecycle = service;
  }

  async ensureStorageCA(): Promise<string> {
    const [existing] = await this.db
      .select({ id: certificateAuthorities.id })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'storage-tls'))
      .limit(1);
    if (existing) return existing.id;

    logger.info('Creating system Storage CA for managed direct TLS');
    const ca = await this.caService.createRootCA(
      {
        commonName: STORAGE_CA_CN,
        keyAlgorithm: 'ecdsa-p256',
        validityYears: 10,
        maxValidityDays: 730,
        pathLengthConstraint: 0,
      },
      SYSTEM_USER_ID
    );
    await this.db
      .update(certificateAuthorities)
      .set({ isSystem: true, systemPurpose: 'storage-tls' })
      .where(eq(certificateAuthorities.id, ca.id));
    logger.info('System Storage CA created', { caId: ca.id });
    return ca.id;
  }

  async getStorageCA() {
    const [ca] = await this.db
      .select({ id: certificateAuthorities.id, certificatePem: certificateAuthorities.certificatePem })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'storage-tls'))
      .limit(1);
    if (!ca) throw new Error('Storage CA not found — run ensureStorageCA first');
    return ca;
  }

  async issueManagedStorageCertificate(
    managedStorageId: string,
    serviceAddresses: readonly string[],
    bindCurrent?: SystemCertificateCurrentBinding
  ) {
    const sans = [
      ...new Set(
        serviceAddresses
          .map((address) => address.trim())
          .filter(
            (address) => isIP(address) !== 0 || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(address)
          )
      ),
    ];
    if (sans.length === 0) throw new Error('Managed storage node has no addresses for TLS');
    const ca = await this.getStorageCA();
    const issueInput = {
      caId: ca.id,
      type: 'tls-server' as const,
      commonName: `managed-storage-${managedStorageId}`,
      sans,
      keyAlgorithm: 'ecdsa-p256' as const,
      validityDays: 365,
    };
    return this.requireSystemCertificateLifecycle().issueCurrent(
      issueInput,
      SYSTEM_USER_ID,
      { type: 'managed_storage', id: managedStorageId },
      bindCurrent
    );
  }

  async retireManagedStorageCertificates(managedStorageId: string, transaction?: DrizzleTransaction) {
    return (
      this.systemCertificateLifecycle?.retireOwner(
        { type: 'managed_storage', id: managedStorageId },
        'cessationOfOperation',
        transaction
      ) ?? 0
    );
  }

  async retryPendingSystemCRLs() {
    return this.systemCertificateLifecycle?.retryPendingCRLs() ?? 0;
  }

  private requireSystemCertificateLifecycle(): SystemCertificateLifecycleService {
    if (!this.systemCertificateLifecycle) {
      throw new Error('System certificate lifecycle service is required before issuing system leaves');
    }
    return this.systemCertificateLifecycle;
  }

  async getManagedStorageCertificateMaterial(certificateId: string) {
    const [certificate] = await this.db
      .select({ id: certificates.id, caId: certificates.caId, certificatePem: certificates.certificatePem })
      .from(certificates)
      .where(eq(certificates.id, certificateId))
      .limit(1);
    if (!certificate) throw new Error('Managed storage TLS certificate not found');
    const ca = await this.getStorageCA();
    if (certificate.caId !== ca.id) throw new Error('Managed storage TLS certificate has an unexpected issuer');
    const privateKeyPem = await this.certService.getCertificatePrivateKey(certificate.id);
    if (!privateKeyPem) throw new Error('Managed storage TLS private key is unavailable');
    return { certificatePem: certificate.certificatePem, privateKeyPem, caCertificatePem: ca.certificatePem };
  }
}
