import crypto from 'node:crypto';
import { and, count, desc, eq, ilike, inArray, lte, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { certificates, proxyHosts, sslCertificates } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere, escapeLike, sleep } from '@/lib/utils.js';
import { x509 } from '@/lib/x509.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NginxCertificateDistributionService } from '@/services/nginx-certificate-distribution.service.js';
import type { PaginatedResponse } from '@/types.js';
import type { ACMEService } from './acme.service.js';
import type {
  LinkInternalCertInput,
  RequestACMECertInput,
  SetSslAutoRenewInput,
  SSLCertListQuery,
  UploadCertInput,
} from './ssl.schemas.js';

const logger = createChildLogger('SSLService');
const CLOUDFLARE_DNS01_PROPAGATION_DELAY_MS = process.env.NODE_ENV === 'test' ? 0 : 10_000;

type DNSChallenge = {
  domain: string;
  recordName: string;
  recordValue: string;
  cloudflare?: {
    connectorId: string;
    zoneId: string;
    zoneName: string;
    recordId: string;
    created: boolean;
  };
};

type AutoRenewDnsBinding = {
  domain: string;
  connectorId: string;
  connectorName: string;
  zoneId: string;
  zoneName: string;
};

export class SSLService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly acmeService: ACMEService,
    private readonly cryptoService: CryptoService,
    private readonly auditService: AuditService,
    private readonly certificateDistribution: NginxCertificateDistributionService
  ) {}

  private eventBus?: EventBusService;
  private integrationsService?: IntegrationsService;
  private proxyService?: ProxyService;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }
  setIntegrationsService(service: IntegrationsService) {
    this.integrationsService = service;
  }
  setProxyService(service: ProxyService) {
    this.proxyService = service;
  }

  /**
   * Certificate issuance changes canonical material first, then every active
   * Proxy Host receives its own atomic TLS bundle. This also upgrades legacy
   * hosts that predate deployment records; failures remain a distribution
   * status on that host instead of invalidating an otherwise valid renewal.
   */
  private async refreshGatewayAssetAndSyncProxyHosts(certId: string, userId: string): Promise<number> {
    await this.certificateDistribution.upsertGatewayAsset({ type: 'ssl', id: certId });
    return this.resyncActiveProxyHosts(certId, userId);
  }

  private async resyncActiveProxyHosts(certId: string, userId: string): Promise<number> {
    if (!this.proxyService) return 0;

    const activeHosts = await this.db.query.proxyHosts.findMany({
      where: and(eq(proxyHosts.sslCertificateId, certId), eq(proxyHosts.enabled, true)),
      columns: { id: true },
    });
    let synchronized = 0;
    for (const host of activeHosts) {
      try {
        await this.proxyService.resyncTlsHost(host.id, userId);
        synchronized += 1;
      } catch (error) {
        logger.warn('TLS certificate refresh could not yet synchronize a proxy host', {
          certId,
          hostId: host.id,
          error: error instanceof Error ? error.message : 'unknown error',
        });
      }
    }
    return synchronized;
  }

  private emitCert(
    id: string,
    action: 'created' | 'renewed' | 'deleted' | 'updated' | 'renewal_failed' | 'expired',
    name?: string
  ) {
    this.eventBus?.publish('ssl.cert.changed', { id, action, name });
  }

  // ---------------------------------------------------------------------------
  // ACME certificate request
  // ---------------------------------------------------------------------------

  async requestACMECert(input: RequestACMECertInput, userId: string) {
    const isStaging = input.provider === 'letsencrypt-staging';
    const name = input.domains[0];

    if (input.challengeType === 'http-01') {
      // Full automatic flow
      const result = await this.acmeService.requestCertHTTP01(input.domains, isStaging);

      // Encrypt private key before storing
      const encrypted = this.cryptoService.encryptPrivateKey(result.privateKeyPem);

      // Encrypt ACME account key before storing
      const acmeKeyEncrypted = this.cryptoService.encryptPrivateKey(result.accountKey);
      const acmeAccountKeyBlob = JSON.stringify({
        encrypted: acmeKeyEncrypted.encryptedPrivateKey,
        encryptedDek: acmeKeyEncrypted.encryptedDek,
        dekIv: acmeKeyEncrypted.dekIv,
      });

      const [cert] = await this.db
        .insert(sslCertificates)
        .values({
          name,
          type: 'acme',
          domainNames: input.domains,
          certificatePem: result.certificatePem,
          privateKeyPem: encrypted.encryptedPrivateKey,
          encryptedDek: encrypted.encryptedDek,
          dekIv: encrypted.dekIv,
          chainPem: result.chainPem,
          acmeProvider: input.provider,
          acmeChallengeType: 'http-01',
          acmeAccountKey: acmeAccountKeyBlob,
          notBefore: result.notBefore,
          notAfter: result.notAfter,
          autoRenew: input.autoRenew,
          status: 'active',
          createdById: userId,
        })
        .returning();

      // Deploy cert files to nginx
      try {
        await this.refreshGatewayAssetAndSyncProxyHosts(cert.id, userId);
      } catch (deployError) {
        const deployMessage = deployError instanceof Error ? deployError.message : 'Unknown deploy error';
        await this.db
          .update(sslCertificates)
          .set({
            status: 'error',
            renewalError: `Certificate deploy failed: ${deployMessage}`,
            updatedAt: new Date(),
          })
          .where(eq(sslCertificates.id, cert.id));
        throw deployError;
      }

      await this.auditService.log({
        userId,
        action: 'ssl.acme_request',
        resourceType: 'ssl_certificate',
        resourceId: cert.id,
        details: {
          domains: input.domains,
          challengeType: 'http-01',
          provider: input.provider,
        },
      });

      logger.info('ACME certificate issued via HTTP-01', { certId: cert.id, domains: input.domains });
      this.emitCert(cert.id, 'created', input.domains.join(', '));

      return {
        certificate: this.sanitizeCert(cert),
        status: 'issued' as const,
      };
    }

    // DNS-01: start flow, return challenges
    const result = await this.acmeService.requestCertDNS01Start(input.domains, isStaging);

    // Encrypt ACME account key before storing
    const dns01AcmeKeyEncrypted = this.cryptoService.encryptPrivateKey(result.accountKey);
    const dns01AcmeAccountKeyBlob = JSON.stringify({
      encrypted: dns01AcmeKeyEncrypted.encryptedPrivateKey,
      encryptedDek: dns01AcmeKeyEncrypted.encryptedDek,
      dekIv: dns01AcmeKeyEncrypted.dekIv,
    });

    // Save pending cert with ACME state
    const [cert] = await this.db
      .insert(sslCertificates)
      .values({
        name,
        type: 'acme',
        domainNames: input.domains,
        acmeProvider: input.provider,
        acmeChallengeType: 'dns-01',
        acmeAccountKey: dns01AcmeAccountKeyBlob,
        acmeOrderUrl: result.orderUrl,
        acmePendingOperation: 'issue',
        acmePendingChallenges: result.challenges,
        autoRenew: input.dnsProvider === 'cloudflare' ? false : input.autoRenew,
        status: 'pending',
        createdById: userId,
      })
      .returning();

    if (input.dnsProvider === 'cloudflare') {
      let cloudflareChallenges: DNSChallenge[] | null = null;
      try {
        const autoRenewBindings = input.autoRenew
          ? await this.resolveCloudflareAutoRenewBindings({
              id: cert.id,
              domainNames: input.domains,
              autoRenewDnsBindings: null,
              autoRenewProvider: 'cloudflare',
            })
          : null;
        cloudflareChallenges = await this.tryProvisionCloudflareDnsChallenges(
          cert.id,
          result.challenges,
          autoRenewBindings
        );
        if (!cloudflareChallenges) {
          throw new AppError(
            409,
            'CLOUDFLARE_DNS_NOT_CONFIGURED',
            'Cloudflare DNS automation is not available for this certificate'
          );
        }

        await this.db
          .update(sslCertificates)
          .set({
            acmePendingChallenges: cloudflareChallenges,
            autoRenew: input.autoRenew,
            autoRenewProvider: autoRenewBindings ? 'cloudflare' : null,
            autoRenewDnsBindings: autoRenewBindings,
            updatedAt: new Date(),
          })
          .where(eq(sslCertificates.id, cert.id));

        await this.auditService.log({
          userId,
          action: 'ssl.acme_dns01_cloudflare_provision',
          resourceType: 'ssl_certificate',
          resourceId: cert.id,
          details: {
            domains: input.domains,
            challengeType: 'dns-01',
            provider: input.provider,
            autoRenew: input.autoRenew,
          },
        });
      } catch (error) {
        if (cloudflareChallenges) {
          await this.cleanupCloudflareDnsChallenges(cloudflareChallenges);
        }
        const message = error instanceof Error ? error.message : 'Cloudflare DNS automation failed';
        await this.db
          .update(sslCertificates)
          .set({
            status: 'error',
            renewalError: message,
            acmeOrderUrl: null,
            acmePendingOperation: null,
            acmePendingChallenges: null,
            autoRenew: false,
            autoRenewProvider: null,
            autoRenewDnsBindings: null,
            updatedAt: new Date(),
          })
          .where(eq(sslCertificates.id, cert.id));
        throw error;
      }

      await sleep(CLOUDFLARE_DNS01_PROPAGATION_DELAY_MS);
      const issued = await this.completeDNS01Verification(cert.id, userId, {
        cleanupCloudflare: true,
        clearPendingOnFailure: true,
      });
      return {
        certificate: issued,
        status: 'issued' as const,
      };
    }

    await this.auditService.log({
      userId,
      action: 'ssl.acme_dns01_start',
      resourceType: 'ssl_certificate',
      resourceId: cert.id,
      details: {
        domains: input.domains,
        challengeType: 'dns-01',
        provider: input.provider,
      },
    });

    logger.info('ACME DNS-01 challenge started', { certId: cert.id, domains: input.domains });

    return {
      certificate: this.sanitizeCert(cert),
      status: 'pending_dns_verification' as const,
      challenges: result.challenges,
    };
  }

  // ---------------------------------------------------------------------------
  // Complete DNS-01 verification
  // ---------------------------------------------------------------------------

  async completeDNS01Verification(
    certId: string,
    userId: string,
    options: { cleanupCloudflare?: boolean; clearPendingOnFailure?: boolean } = {}
  ) {
    const cert = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, certId),
    });

    if (!cert) throw new AppError(404, 'SSL_CERT_NOT_FOUND', 'SSL certificate not found');
    if (cert.acmeChallengeType !== 'dns-01')
      throw new AppError(400, 'NOT_DNS01', 'Certificate is not a DNS-01 challenge');
    if (!cert.acmeAccountKey || !cert.acmeOrderUrl) {
      throw new AppError(400, 'MISSING_ACME_STATE', 'Missing ACME state data for verification');
    }
    const pendingOperation = cert.acmePendingOperation ?? (cert.status === 'pending' ? 'issue' : null);
    if (pendingOperation !== 'issue' && pendingOperation !== 'renewal') {
      throw new AppError(400, 'NOT_PENDING', 'Certificate is not pending DNS verification');
    }
    if (pendingOperation === 'issue' && cert.status !== 'pending' && cert.status !== 'error') {
      throw new AppError(400, 'NOT_PENDING', 'Certificate is not pending DNS verification');
    }
    if (pendingOperation === 'renewal' && cert.status !== 'active' && cert.status !== 'error') {
      throw new AppError(400, 'CERT_NOT_RENEWABLE', 'Certificate is not in a renewable state');
    }

    let cloudflareCleanupDone = false;
    try {
      // Decrypt the stored ACME account key
      const acmeKeyBlob = JSON.parse(cert.acmeAccountKey);
      const decryptedAccountKey = this.cryptoService.decryptPrivateKey({
        encryptedPrivateKey: acmeKeyBlob.encrypted,
        encryptedDek: acmeKeyBlob.encryptedDek,
        dekIv: acmeKeyBlob.dekIv,
      });

      const dns01IsStaging = cert.acmeProvider === 'letsencrypt-staging';
      const result = await this.acmeService.requestCertDNS01Verify(
        decryptedAccountKey,
        cert.acmeOrderUrl,
        cert.domainNames,
        dns01IsStaging
      );

      // Encrypt private key
      const encrypted = this.cryptoService.encryptPrivateKey(result.privateKeyPem);

      try {
        // Update cert in DB
        await this.db
          .update(sslCertificates)
          .set({
            certificatePem: result.certificatePem,
            privateKeyPem: encrypted.encryptedPrivateKey,
            encryptedDek: encrypted.encryptedDek,
            dekIv: encrypted.dekIv,
            chainPem: result.chainPem,
            notBefore: result.notBefore,
            notAfter: result.notAfter,
            status: 'active',
            lastRenewedAt: pendingOperation === 'renewal' ? new Date() : cert.lastRenewedAt,
            renewalError: null,
            acmeOrderUrl: null, // Clear order URL after completion
            acmePendingOperation: null,
            acmePendingChallenges: null,
            updatedAt: new Date(),
          })
          .where(eq(sslCertificates.id, certId));

        // Deploy to nginx — separate try/catch since cert is already valid at this point
        try {
          await this.refreshGatewayAssetAndSyncProxyHosts(certId, userId);
        } catch (deployError) {
          const deployMsg = deployError instanceof Error ? deployError.message : 'Unknown deploy error';
          logger.error('Certificate obtained but deploy to nginx failed', { certId, error: deployMsg });
          // Keep status as 'active' — cert is valid, just not deployed yet
          await this.db
            .update(sslCertificates)
            .set({
              renewalError: `Deploy failed: ${deployMsg}`,
              updatedAt: new Date(),
            })
            .where(eq(sslCertificates.id, certId));
          throw new AppError(500, 'DEPLOY_FAILED', `Certificate obtained but deploy failed: ${deployMsg}`);
        }

        await this.auditService.log({
          userId,
          action: pendingOperation === 'renewal' ? 'ssl.acme_dns01_renew_verify' : 'ssl.acme_dns01_verify',
          resourceType: 'ssl_certificate',
          resourceId: certId,
          details: { domains: cert.domainNames },
        });

        logger.info('ACME DNS-01 certificate verified', { certId, domains: cert.domainNames, pendingOperation });
        this.emitCert(certId, pendingOperation === 'renewal' ? 'renewed' : 'created', cert.name);

        const updated = await this.db.query.sslCertificates.findFirst({
          where: eq(sslCertificates.id, certId),
        });

        return this.sanitizeCert(updated!);
      } finally {
        if (options.cleanupCloudflare) {
          await this.cleanupCloudflareDnsChallenges((cert.acmePendingChallenges ?? []) as DNSChallenge[]);
          cloudflareCleanupDone = true;
        }
      }
    } catch (error) {
      if (options.cleanupCloudflare && !cloudflareCleanupDone) {
        await this.cleanupCloudflareDnsChallenges((cert.acmePendingChallenges ?? []) as DNSChallenge[]);
      }
      if (error instanceof AppError) throw error;
      const message = error instanceof Error ? error.message : 'Unknown verification error';
      if (pendingOperation === 'renewal') {
        await this.db
          .update(sslCertificates)
          .set({
            renewalError: `Renewal failed: ${message}`,
            ...(options.clearPendingOnFailure
              ? {
                  acmeOrderUrl: null,
                  acmePendingOperation: null,
                  acmePendingChallenges: null,
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(sslCertificates.id, certId));
        this.emitCert(certId, 'renewal_failed', cert.name);
      } else {
        await this.db
          .update(sslCertificates)
          .set({
            status: 'error',
            renewalError: message,
            ...(options.clearPendingOnFailure
              ? {
                  acmeOrderUrl: null,
                  acmePendingOperation: null,
                  acmePendingChallenges: null,
                  autoRenew: false,
                  autoRenewProvider: null,
                  autoRenewDnsBindings: null,
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(sslCertificates.id, certId));
      }

      throw new AppError(400, 'DNS01_VERIFICATION_FAILED', `DNS-01 verification failed: ${message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Upload certificate
  // ---------------------------------------------------------------------------

  async uploadCert(input: UploadCertInput, userId: string) {
    // Parse PEM to extract domains and validity dates
    let parsedCert: x509.X509Certificate;
    try {
      parsedCert = new x509.X509Certificate(input.certificatePem);
    } catch {
      throw new AppError(400, 'INVALID_CERT', 'Failed to parse certificate PEM');
    }

    // Check not expired
    if (parsedCert.notAfter < new Date()) {
      throw new AppError(400, 'CERT_EXPIRED', 'Certificate is already expired');
    }

    // Extract domains from SAN extension
    const domains = this.extractDomains(parsedCert);

    // Validate that the private key matches the certificate
    this.validateKeyMatchesCert(input.privateKeyPem, parsedCert);

    // Encrypt private key
    const encrypted = this.cryptoService.encryptPrivateKey(input.privateKeyPem);

    const [cert] = await this.db
      .insert(sslCertificates)
      .values({
        name: input.name,
        type: 'upload',
        domainNames: domains,
        certificatePem: input.certificatePem,
        privateKeyPem: encrypted.encryptedPrivateKey,
        encryptedDek: encrypted.encryptedDek,
        dekIv: encrypted.dekIv,
        chainPem: input.chainPem || null,
        notBefore: parsedCert.notBefore,
        notAfter: parsedCert.notAfter,
        autoRenew: false,
        status: 'active',
        createdById: userId,
      })
      .returning();

    // Deploy cert files to nginx
    try {
      await this.refreshGatewayAssetAndSyncProxyHosts(cert.id, userId);
    } catch (deployError) {
      const deployMessage = deployError instanceof Error ? deployError.message : 'Unknown deploy error';
      await this.db
        .update(sslCertificates)
        .set({
          status: 'error',
          renewalError: `Certificate deploy failed: ${deployMessage}`,
          updatedAt: new Date(),
        })
        .where(eq(sslCertificates.id, cert.id));
      throw deployError;
    }

    await this.auditService.log({
      userId,
      action: 'ssl.upload',
      resourceType: 'ssl_certificate',
      resourceId: cert.id,
      details: { name: input.name, domains },
    });

    logger.info('Certificate uploaded', { certId: cert.id, name: input.name, domains });
    this.emitCert(cert.id, 'created', input.name);

    return this.sanitizeCert(cert);
  }

  // ---------------------------------------------------------------------------
  // Link internal CA certificate
  // ---------------------------------------------------------------------------

  async linkInternalCert(input: LinkInternalCertInput, userId: string) {
    // Look up PKI certificate
    const pkiCert = await this.db.query.certificates.findFirst({
      where: eq(certificates.id, input.internalCertId),
    });

    if (!pkiCert) throw new AppError(404, 'PKI_CERT_NOT_FOUND', 'Internal PKI certificate not found');
    if (pkiCert.status !== 'active')
      throw new AppError(400, 'PKI_CERT_NOT_ACTIVE', 'Internal PKI certificate is not active');

    // Auto-generate name from cert CN if not provided
    const name = input.name || pkiCert.commonName;

    // Extract domains from the PKI cert
    let domains: string[] = [];
    try {
      const parsed = new x509.X509Certificate(pkiCert.certificatePem);
      domains = this.extractDomains(parsed);
    } catch {
      // Fallback to commonName
      if (pkiCert.commonName) {
        domains = [pkiCert.commonName];
      }
    }

    // We need the private key to deploy — decrypt it if available
    let privateKeyPem: string | null = null;
    if (pkiCert.encryptedPrivateKey && pkiCert.encryptedDek) {
      privateKeyPem = this.cryptoService.decryptPrivateKey({
        encryptedPrivateKey: pkiCert.encryptedPrivateKey,
        encryptedDek: pkiCert.encryptedDek,
        dekIv: pkiCert.dekIv || '',
      });
    }

    // Re-encrypt for the SSL cert entry
    let encryptedData: { encryptedPrivateKey: string; encryptedDek: string; dekIv: string } | null = null;
    if (privateKeyPem) {
      encryptedData = this.cryptoService.encryptPrivateKey(privateKeyPem);
    }

    const [cert] = await this.db
      .insert(sslCertificates)
      .values({
        name,
        type: 'internal',
        domainNames: domains,
        certificatePem: pkiCert.certificatePem,
        privateKeyPem: encryptedData?.encryptedPrivateKey || null,
        encryptedDek: encryptedData?.encryptedDek || null,
        dekIv: encryptedData?.dekIv || null,
        internalCertId: input.internalCertId,
        notBefore: pkiCert.notBefore,
        notAfter: pkiCert.notAfter,
        autoRenew: false,
        status: 'active',
        createdById: userId,
      })
      .returning();

    // Store the linked certificate canonically. Active hosts are synchronized
    // through their atomic TLS bundle; no default-node predeployment occurs.
    if (privateKeyPem) {
      await this.refreshGatewayAssetAndSyncProxyHosts(cert.id, userId);
    }

    await this.auditService.log({
      userId,
      action: 'ssl.link_internal',
      resourceType: 'ssl_certificate',
      resourceId: cert.id,
      details: { internalCertId: input.internalCertId, name },
    });

    logger.info('Internal certificate linked', { certId: cert.id, internalCertId: input.internalCertId });
    this.emitCert(cert.id, 'created', name);

    return this.sanitizeCert(cert);
  }

  // ---------------------------------------------------------------------------
  // Renew certificate
  // ---------------------------------------------------------------------------

  async renewCert(certId: string, userId: string) {
    const cert = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, certId),
    });

    if (!cert) throw new AppError(404, 'SSL_CERT_NOT_FOUND', 'SSL certificate not found');
    if (cert.type !== 'acme') throw new AppError(400, 'NOT_ACME', 'Only ACME certificates can be renewed');
    if (cert.status !== 'active' && cert.status !== 'error') {
      throw new AppError(400, 'CERT_NOT_RENEWABLE', 'Certificate is not in a renewable state');
    }

    try {
      let result: {
        certificatePem: string;
        privateKeyPem: string;
        chainPem: string;
        notBefore: Date;
        notAfter: Date;
        accountKey?: string;
      };

      if (cert.acmeChallengeType === 'http-01') {
        const renewIsStaging = cert.acmeProvider === 'letsencrypt-staging';
        result = await this.acmeService.requestCertHTTP01(cert.domainNames, renewIsStaging);
      } else {
        const dnsRenewal = await this.startDNS01Renewal(cert, userId);
        return dnsRenewal;
      }

      // Encrypt private key
      const encrypted = this.cryptoService.encryptPrivateKey(result.privateKeyPem);

      // Encrypt updated ACME account key if present
      const renewUpdateData: Record<string, unknown> = {
        certificatePem: result.certificatePem,
        privateKeyPem: encrypted.encryptedPrivateKey,
        encryptedDek: encrypted.encryptedDek,
        dekIv: encrypted.dekIv,
        chainPem: result.chainPem,
        notBefore: result.notBefore,
        notAfter: result.notAfter,
        status: 'active',
        lastRenewedAt: new Date(),
        renewalError: null,
        acmeOrderUrl: null,
        acmePendingOperation: null,
        acmePendingChallenges: null,
        updatedAt: new Date(),
      };

      if (result.accountKey) {
        const renewAcmeKeyEncrypted = this.cryptoService.encryptPrivateKey(result.accountKey);
        renewUpdateData.acmeAccountKey = JSON.stringify({
          encrypted: renewAcmeKeyEncrypted.encryptedPrivateKey,
          encryptedDek: renewAcmeKeyEncrypted.encryptedDek,
          dekIv: renewAcmeKeyEncrypted.dekIv,
        });
      }

      // Update cert data in DB
      await this.db.update(sslCertificates).set(renewUpdateData).where(eq(sslCertificates.id, certId));

      // Refresh the canonical asset and atomically synchronize active hosts.
      await this.refreshGatewayAssetAndSyncProxyHosts(certId, userId);

      await this.auditService.log({
        userId,
        action: 'ssl.renew',
        resourceType: 'ssl_certificate',
        resourceId: certId,
        details: { domains: cert.domainNames },
      });

      logger.info('Certificate renewed', { certId, domains: cert.domainNames });
      this.emitCert(certId, 'renewed', cert.name);

      const updated = await this.db.query.sslCertificates.findFirst({
        where: eq(sslCertificates.id, certId),
      });

      return this.sanitizeCert(updated!);
    } catch (error) {
      if (error instanceof AppError) throw error;

      const message = error instanceof Error ? error.message : 'Unknown renewal error';

      await this.db
        .update(sslCertificates)
        .set({
          status: 'error',
          renewalError: `Renewal failed: ${message}`,
          updatedAt: new Date(),
        })
        .where(eq(sslCertificates.id, certId));

      throw new AppError(500, 'RENEWAL_FAILED', `Certificate renewal failed: ${message}`);
    }
  }

  async setAutoRenew(certId: string, input: SetSslAutoRenewInput, userId: string) {
    const cert = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, certId),
    });

    if (!cert) throw new AppError(404, 'SSL_CERT_NOT_FOUND', 'SSL certificate not found');
    if (cert.type !== 'acme') throw new AppError(400, 'NOT_ACME', 'Only ACME certificates support auto-renewal');

    const updates: Partial<typeof sslCertificates.$inferInsert> = {
      autoRenew: false,
      autoRenewProvider: null,
      autoRenewDnsBindings: null,
      autoRenewDisabledReason: null,
      autoRenewDisabledAt: null,
      updatedAt: new Date(),
    };

    if (input.enabled) {
      updates.renewalError = null;
      if (cert.acmeChallengeType === 'http-01') {
        updates.autoRenew = true;
      } else if (cert.acmeChallengeType === 'dns-01') {
        if (input.provider !== 'cloudflare') {
          throw new AppError(400, 'CLOUDFLARE_PROVIDER_REQUIRED', 'DNS-01 auto-renewal requires Cloudflare');
        }
        if (cert.status !== 'active') {
          throw new AppError(400, 'CERT_NOT_ACTIVE', 'DNS-01 auto-renewal can only be enabled for active certificates');
        }
        const bindings = await this.resolveCloudflareAutoRenewBindings(cert);
        updates.autoRenew = true;
        updates.autoRenewProvider = 'cloudflare';
        updates.autoRenewDnsBindings = bindings;
      } else {
        throw new AppError(400, 'UNSUPPORTED_ACME_CHALLENGE', 'Unsupported ACME challenge type');
      }
    }

    await this.db.update(sslCertificates).set(updates).where(eq(sslCertificates.id, certId));

    await this.auditService.log({
      userId,
      action: input.enabled ? 'ssl.auto_renew_enable' : 'ssl.auto_renew_disable',
      resourceType: 'ssl_certificate',
      resourceId: certId,
      details: {
        domains: cert.domainNames,
        provider: input.enabled && cert.acmeChallengeType === 'dns-01' ? input.provider : null,
      },
    });

    this.emitCert(certId, 'updated', cert.name);
    return this.getCert(certId);
  }

  async revalidateCloudflareAutoRenewForConnector(connectorId: string) {
    await this.revalidateCloudflareAutoRenew((bindings) =>
      bindings.some((binding) => binding.connectorId === connectorId)
    );
  }

  async revalidateCloudflareAutoRenew(shouldCheck?: (bindings: AutoRenewDnsBinding[]) => boolean) {
    const certs = await this.db.query.sslCertificates.findMany({
      where: eq(sslCertificates.autoRenewProvider, 'cloudflare'),
      columns: {
        privateKeyPem: false,
        encryptedDek: false,
        dekIv: false,
        acmeAccountKey: false,
      },
    });

    for (const cert of certs) {
      const bindings = (cert.autoRenewDnsBindings ?? []) as AutoRenewDnsBinding[];
      if (shouldCheck && !shouldCheck(bindings)) continue;
      try {
        await this.resolveCloudflareAutoRenewBindings(cert, { requireExistingMatch: true });
      } catch (error) {
        await this.disableCloudflareAutoRenew(cert, 'cloudflare_zone_unavailable', error);
      }
    }
  }

  async disableCloudflareAutoRenewForConnector(connectorId: string, reason = 'cloudflare_connector_unavailable') {
    const certs = await this.db.query.sslCertificates.findMany({
      where: eq(sslCertificates.autoRenewProvider, 'cloudflare'),
      columns: {
        privateKeyPem: false,
        encryptedDek: false,
        dekIv: false,
        acmeAccountKey: false,
      },
    });

    for (const cert of certs) {
      const bindings = (cert.autoRenewDnsBindings ?? []) as AutoRenewDnsBinding[];
      if (bindings.some((binding) => binding.connectorId === connectorId)) {
        await this.disableCloudflareAutoRenew(cert, reason);
      }
    }
  }

  private async startDNS01Renewal(cert: typeof sslCertificates.$inferSelect, userId: string) {
    const cloudflareAutoRenewBindings =
      cert.autoRenewProvider === 'cloudflare'
        ? await this.resolveCloudflareAutoRenewBindings(cert, { requireExistingMatch: true }).catch(async (error) => {
            await this.disableCloudflareAutoRenew(cert, 'cloudflare_zone_unavailable', error);
            throw error;
          })
        : null;
    const renewIsStaging = cert.acmeProvider === 'letsencrypt-staging';
    const result = await this.acmeService.requestCertDNS01Start(cert.domainNames, renewIsStaging);

    const acmeKeyEncrypted = this.cryptoService.encryptPrivateKey(result.accountKey);
    const acmeAccountKeyBlob = JSON.stringify({
      encrypted: acmeKeyEncrypted.encryptedPrivateKey,
      encryptedDek: acmeKeyEncrypted.encryptedDek,
      dekIv: acmeKeyEncrypted.dekIv,
    });

    const cloudflareChallenges = await this.tryProvisionCloudflareDnsChallenges(
      cert.id,
      result.challenges,
      cloudflareAutoRenewBindings
    );
    if (cert.autoRenewProvider === 'cloudflare' && !cloudflareChallenges) {
      await this.disableCloudflareAutoRenew(cert, 'cloudflare_zone_unavailable');
      throw new AppError(
        409,
        'CLOUDFLARE_ZONE_NOT_FOUND',
        'Cloudflare DNS automation is no longer available for this certificate'
      );
    }
    const pendingChallenges = cloudflareChallenges ?? result.challenges;

    await this.db
      .update(sslCertificates)
      .set({
        acmeAccountKey: acmeAccountKeyBlob,
        acmeOrderUrl: result.orderUrl,
        acmePendingOperation: 'renewal',
        acmePendingChallenges: pendingChallenges,
        renewalError: null,
        updatedAt: new Date(),
      })
      .where(eq(sslCertificates.id, cert.id));

    await this.auditService.log({
      userId,
      action: 'ssl.acme_dns01_renew_start',
      resourceType: 'ssl_certificate',
      resourceId: cert.id,
      details: { domains: cert.domainNames, challengeType: 'dns-01', cloudflare: Boolean(cloudflareChallenges) },
    });

    logger.info('ACME DNS-01 renewal challenge started', { certId: cert.id, domains: cert.domainNames });

    if (cloudflareChallenges) {
      await sleep(CLOUDFLARE_DNS01_PROPAGATION_DELAY_MS);
      return this.completeDNS01Verification(cert.id, userId, {
        cleanupCloudflare: true,
        clearPendingOnFailure: true,
      });
    }

    const updated = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, cert.id),
    });

    return {
      certificate: this.sanitizeCert(updated!),
      status: 'pending_dns_verification' as const,
      challenges: result.challenges as DNSChallenge[],
    };
  }

  private async tryProvisionCloudflareDnsChallenges(
    certId: string,
    challenges: DNSChallenge[],
    expectedBindings?: AutoRenewDnsBinding[] | null
  ): Promise<DNSChallenge[] | null> {
    if (!this.integrationsService) return null;

    const provisioned: DNSChallenge[] = [];
    const createdRecords: Array<{ zoneId: string; recordId: string; challenge: DNSChallenge }> = [];
    const expectedByDomain = new Map(
      (expectedBindings ?? []).map((binding) => [this.normalizeAcmeDomain(binding.domain), binding])
    );

    try {
      for (const challenge of challenges) {
        const context = await this.integrationsService.resolveCloudflareDnsContext(challenge.domain);
        const expected = expectedByDomain.get(this.normalizeAcmeDomain(challenge.domain));
        if (expected && (context.connector.id !== expected.connectorId || context.zone.remoteId !== expected.zoneId)) {
          throw new AppError(409, 'CLOUDFLARE_ZONE_CHANGED', 'Cloudflare zone binding changed for this certificate', {
            domain: challenge.domain,
            expectedConnectorId: expected.connectorId,
            expectedZoneId: expected.zoneId,
            actualConnectorId: context.connector.id,
            actualZoneId: context.zone.remoteId,
          });
        }
        const records = await context.client.listDnsRecords(context.zone.remoteId, challenge.recordName);
        const existing = records.find((record) => record.type === 'TXT' && record.content === challenge.recordValue);
        const record =
          existing ??
          (await context.client.createDnsRecord(context.zone.remoteId, {
            type: 'TXT',
            name: challenge.recordName,
            content: challenge.recordValue,
            ttl: 60,
            comment: `Gateway ACME DNS-01 challenge for SSL certificate ${certId}`,
          }));
        const created = !existing;
        const nextChallenge: DNSChallenge = {
          ...challenge,
          cloudflare: {
            connectorId: context.connector.id,
            zoneId: context.zone.remoteId,
            zoneName: context.zone.name,
            recordId: record.id,
            created,
          },
        };
        provisioned.push(nextChallenge);
        if (created) {
          createdRecords.push({ zoneId: context.zone.remoteId, recordId: record.id, challenge: nextChallenge });
        }
      }
      return provisioned;
    } catch (error) {
      for (const created of createdRecords.reverse()) {
        try {
          const context = await this.integrationsService.getCloudflareDnsContextForRecord(
            created.challenge.cloudflare!.connectorId,
            created.zoneId
          );
          await context.client.deleteDnsRecord(created.zoneId, created.recordId);
        } catch (cleanupError) {
          logger.warn('Failed to clean up Cloudflare ACME challenge after provisioning failure', {
            certId,
            zoneId: created.zoneId,
            recordId: created.recordId,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      if (error instanceof AppError && error.code === 'CLOUDFLARE_ZONE_NOT_FOUND') {
        return null;
      }
      throw error;
    }
  }

  private async cleanupCloudflareDnsChallenges(challenges: DNSChallenge[]) {
    if (!this.integrationsService) return;
    for (const challenge of challenges) {
      const cloudflare = challenge.cloudflare;
      if (!cloudflare?.created) continue;
      try {
        const context = await this.integrationsService.getCloudflareDnsContextForRecord(
          cloudflare.connectorId,
          cloudflare.zoneId
        );
        await context.client.deleteDnsRecord(cloudflare.zoneId, cloudflare.recordId);
      } catch (error) {
        logger.warn('Failed to clean up Cloudflare ACME challenge record', {
          domain: challenge.domain,
          recordName: challenge.recordName,
          zoneId: cloudflare.zoneId,
          recordId: cloudflare.recordId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async resolveCloudflareAutoRenewBindings(
    cert: Pick<
      typeof sslCertificates.$inferSelect,
      'id' | 'domainNames' | 'autoRenewDnsBindings' | 'autoRenewProvider'
    >,
    options: { requireExistingMatch?: boolean } = {}
  ): Promise<AutoRenewDnsBinding[]> {
    if (!this.integrationsService) {
      throw new AppError(409, 'CLOUDFLARE_DNS_NOT_CONFIGURED', 'Cloudflare DNS integration is not configured');
    }

    const bindings: AutoRenewDnsBinding[] = [];
    for (const domain of cert.domainNames) {
      const context = await this.integrationsService.resolveCloudflareDnsContext(domain);
      bindings.push({
        domain,
        connectorId: context.connector.id,
        connectorName: context.connector.name,
        zoneId: context.zone.remoteId,
        zoneName: context.zone.name,
      });
    }

    const connectorIds = new Set(bindings.map((binding) => binding.connectorId));
    if (connectorIds.size > 1) {
      throw new AppError(
        409,
        'CLOUDFLARE_CONNECTOR_MISMATCH',
        'All certificate domains must resolve through the same Cloudflare connector',
        {
          certId: cert.id,
          connectors: [...connectorIds],
        }
      );
    }

    if (options.requireExistingMatch) {
      const existingByDomain = new Map(
        ((cert.autoRenewDnsBindings ?? []) as AutoRenewDnsBinding[]).map((binding) => [
          this.normalizeAcmeDomain(binding.domain),
          binding,
        ])
      );
      for (const binding of bindings) {
        const existing = existingByDomain.get(this.normalizeAcmeDomain(binding.domain));
        if (!existing || existing.connectorId !== binding.connectorId || existing.zoneId !== binding.zoneId) {
          throw new AppError(409, 'CLOUDFLARE_ZONE_CHANGED', 'Cloudflare zone binding changed for this certificate', {
            certId: cert.id,
            domain: binding.domain,
          });
        }
      }
    }

    return bindings;
  }

  private async disableCloudflareAutoRenew(
    cert: Pick<typeof sslCertificates.$inferSelect, 'id' | 'name' | 'domainNames'>,
    reason: string,
    cause?: unknown
  ) {
    const message = cause instanceof Error ? cause.message : cause ? String(cause) : reason;
    await this.db
      .update(sslCertificates)
      .set({
        autoRenew: false,
        autoRenewProvider: null,
        autoRenewDnsBindings: null,
        autoRenewDisabledReason: reason,
        autoRenewDisabledAt: new Date(),
        renewalError: `Cloudflare auto-renew disabled: ${message}`,
        updatedAt: new Date(),
      })
      .where(eq(sslCertificates.id, cert.id));

    await this.auditService.log({
      userId: null,
      action: 'ssl.auto_renew_disabled',
      resourceType: 'ssl_certificate',
      resourceId: cert.id,
      details: { domains: cert.domainNames, provider: 'cloudflare', reason, message },
    });

    this.emitCert(cert.id, 'updated', cert.name);
  }

  private normalizeAcmeDomain(domain: string) {
    return domain.trim().toLowerCase().replace(/^\*\./, '');
  }

  // ---------------------------------------------------------------------------
  // Delete certificate
  // ---------------------------------------------------------------------------

  async deleteCert(certId: string, userId: string) {
    const cert = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, certId),
    });

    if (!cert) throw new AppError(404, 'SSL_CERT_NOT_FOUND', 'SSL certificate not found');
    if (cert.isSystem) throw new AppError(403, 'SYSTEM_CERT', 'System certificates cannot be deleted');

    // Check no proxy hosts reference this cert
    const { proxyHosts } = await import('@/db/schema/index.js');
    const referencingHosts = await this.db.query.proxyHosts.findMany({
      where: eq(proxyHosts.sslCertificateId, certId),
      columns: { id: true, domainNames: true },
    });

    if (referencingHosts.length > 0) {
      throw new AppError(409, 'CERT_IN_USE', 'Certificate is in use by proxy hosts', {
        proxyHostIds: referencingHosts.map((h) => h.id),
      });
    }

    await this.certificateDistribution.removeSslCertificateAsset(certId);

    // Delete from DB
    await this.db.delete(sslCertificates).where(eq(sslCertificates.id, certId));

    await this.auditService.log({
      userId,
      action: 'ssl.delete',
      resourceType: 'ssl_certificate',
      resourceId: certId,
      details: { name: cert.name, domains: cert.domainNames },
    });

    logger.info('Certificate deleted', { certId, name: cert.name });
    this.emitCert(certId, 'deleted', cert.name);
  }

  async resyncDistribution(certId: string, userId: string): Promise<{ synchronized: number }> {
    const cert = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, certId),
      columns: { id: true, name: true },
    });
    if (!cert) throw new AppError(404, 'SSL_CERT_NOT_FOUND', 'SSL certificate not found');
    const result = await this.certificateDistribution.syncCertificate({ type: 'ssl', id: certId });
    const synchronized = Math.max(result.synchronized, await this.resyncActiveProxyHosts(certId, userId));
    await this.auditService.log({
      userId,
      action: 'ssl.distribution_resync',
      resourceType: 'ssl_certificate',
      resourceId: certId,
      details: { synchronized },
    });
    return { synchronized };
  }

  // ---------------------------------------------------------------------------
  // List certificates
  // ---------------------------------------------------------------------------

  async listCerts(params: SSLCertListQuery, options?: { allowedIds?: string[] }): Promise<PaginatedResponse<any>> {
    const conditions = [];

    if (options?.allowedIds) {
      if (options.allowedIds.length === 0) {
        return {
          data: [],
          pagination: { page: params.page, limit: params.limit, total: 0, totalPages: 0 },
        };
      }
      conditions.push(inArray(sslCertificates.id, options.allowedIds));
    }

    if (!params.showSystem) conditions.push(eq(sslCertificates.isSystem, false));
    if (params.type) conditions.push(eq(sslCertificates.type, params.type));
    if (params.status) conditions.push(eq(sslCertificates.status, params.status));
    if (params.search) {
      conditions.push(or(ilike(sslCertificates.name, `%${escapeLike(params.search)}%`))!);
    }

    const where = buildWhere(conditions);

    const [entries, [{ count: totalCount }]] = await Promise.all([
      this.db.query.sslCertificates.findMany({
        where: where ? () => where : undefined,
        orderBy: [desc(sslCertificates.createdAt)],
        limit: params.limit,
        offset: (params.page - 1) * params.limit,
        columns: {
          privateKeyPem: false,
          encryptedDek: false,
          dekIv: false,
          acmeAccountKey: false,
        },
      }),
      this.db.select({ count: count() }).from(sslCertificates).where(where),
    ]);

    const total = Number(totalCount);

    const distribution = await this.certificateDistribution.getStatusesForSslCertificates(
      entries.map((entry) => entry.id)
    );
    return {
      data: entries.map((entry) => ({ ...entry, distribution: distribution.get(entry.id) })),
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages: Math.ceil(total / params.limit),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Get single certificate
  // ---------------------------------------------------------------------------

  async getCert(certId: string) {
    const cert = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, certId),
    });

    if (!cert) throw new AppError(404, 'SSL_CERT_NOT_FOUND', 'SSL certificate not found');

    return {
      ...this.sanitizeCert(cert),
      distribution: await this.certificateDistribution.getStatusForSslCertificate(certId),
    };
  }

  // ---------------------------------------------------------------------------
  // Get certificates expiring soon (for renewal job)
  // ---------------------------------------------------------------------------

  async getCertsExpiringSoon(days: number, options?: { allowedIds?: string[] }) {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() + days);

    if (options?.allowedIds?.length === 0) return [];

    return this.db.query.sslCertificates.findMany({
      where: and(
        options?.allowedIds ? inArray(sslCertificates.id, options.allowedIds) : undefined,
        eq(sslCertificates.status, 'active'),
        eq(sslCertificates.autoRenew, true),
        lte(sslCertificates.notAfter, threshold)
      ),
      columns: {
        privateKeyPem: false,
        encryptedDek: false,
        dekIv: false,
        acmeAccountKey: false,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract domain names from a certificate's Subject Alternative Names.
   */
  private extractDomains(cert: x509.X509Certificate): string[] {
    const domains: string[] = [];

    // Try SAN extension first
    const sanExtension = cert.extensions.find((ext) => ext.type === '2.5.29.17');

    if (sanExtension) {
      try {
        const san = new x509.SubjectAlternativeNameExtension(sanExtension.rawData);
        for (const name of san.names.items) {
          if (name.type === 'dns') {
            domains.push(name.value);
          }
        }
      } catch {
        // Fall through to CN extraction
      }
    }

    // Fallback: extract CN from subject
    if (domains.length === 0) {
      const cnMatch = cert.subject.match(/CN=([^,]+)/);
      if (cnMatch) {
        domains.push(cnMatch[1]);
      }
    }

    return domains;
  }

  /**
   * Validate that a private key matches a certificate's public key.
   */
  private validateKeyMatchesCert(privateKeyPem: string, cert: x509.X509Certificate): void {
    try {
      // Create a KeyObject from the private key to verify it's valid
      const keyObject = crypto.createPrivateKey(privateKeyPem);
      const publicKeyFromPrivate = crypto.createPublicKey(keyObject);

      // Export both public keys and compare
      const pubKeyFromPrivateDer = publicKeyFromPrivate.export({ type: 'spki', format: 'der' });
      const certPublicKeyDer = Buffer.from(cert.publicKey.rawData);

      if (!pubKeyFromPrivateDer.equals(certPublicKeyDer)) {
        throw new AppError(400, 'KEY_MISMATCH', 'Private key does not match the certificate');
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(400, 'INVALID_KEY', 'Failed to validate private key against certificate');
    }
  }

  /**
   * Strip sensitive fields from a certificate before returning to the client.
   */
  private sanitizeCert(cert: typeof sslCertificates.$inferSelect) {
    return {
      ...cert,
      privateKeyPem: undefined,
      encryptedDek: undefined,
      dekIv: undefined,
      acmeAccountKey: undefined,
    };
  }
}
