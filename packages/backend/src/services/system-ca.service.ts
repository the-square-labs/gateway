import { X509Certificate as NodeX509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import * as x509 from '@peculiar/x509';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { certificateAuthorities } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { getPublicIPs } from '@/modules/domains/dns.utils.js';
import type { CAService } from '@/modules/pki/ca.service.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CryptoService } from './crypto.service.js';
import { validateGrpcServerCertificate } from './grpc-server-certificate.js';

const logger = createChildLogger('SystemCA');

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const SYSTEM_CA_CN = 'Gateway Node CA';

function collectGrpcServerSans(): string[] {
  const values = ['localhost', hostname(), '127.0.0.1'];

  const appUrl = process.env.APP_URL;
  if (appUrl) {
    try {
      values.push(new URL(appUrl).hostname);
    } catch {
      logger.warn('Ignoring invalid APP_URL while building gRPC TLS SANs', { appUrl });
    }
  }

  if (process.env.PUBLIC_IPV4) values.push(process.env.PUBLIC_IPV4);
  if (process.env.PUBLIC_IPV6) values.push(process.env.PUBLIC_IPV6);
  values.push(
    ...(process.env.GRPC_TLS_EXTRA_SANS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? [])
  );

  return [...new Set(values.map(normalizeGrpcServerSan).filter(Boolean))];
}

function normalizeGrpcServerSan(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.slice(1, -1).includes(':')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractGrpcTargetHost(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  const bracketed = trimmed.match(/^\[([^\]]+)](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  const hostPort = trimmed.match(/^([^:]+):\d+$/);
  if (hostPort) return hostPort[1];
  return trimmed;
}

function certificateHasExpectedSans(certPem: string, expectedSans: readonly string[]): boolean {
  const subjectAltName = new NodeX509Certificate(certPem).subjectAltName ?? '';
  const dnsSans = new Set<string>();
  const ipSans = new Set<string>();
  for (const entry of subjectAltName.split(/,\s*/)) {
    if (entry.startsWith('DNS:')) dnsSans.add(entry.slice('DNS:'.length).trim());
    if (entry.startsWith('IP Address:')) ipSans.add(entry.slice('IP Address:'.length).trim());
  }
  const expectedDnsSans = new Set<string>();
  const expectedIpSans = new Set<string>();
  for (const san of expectedSans) {
    (/^[\d.]+$/.test(san) || san.includes(':') ? expectedIpSans : expectedDnsSans).add(san);
  }
  return (
    dnsSans.size === expectedDnsSans.size &&
    ipSans.size === expectedIpSans.size &&
    [...expectedDnsSans].every((san) => dnsSans.has(san)) &&
    [...expectedIpSans].every((san) => ipSans.has(san))
  );
}

export class SystemCAService {
  private generalSettingsService?: GeneralSettingsService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly caService: CAService,
    private readonly certService: CertService,
    readonly _cryptoService: CryptoService
  ) {}

  setGeneralSettingsService(service: GeneralSettingsService) {
    this.generalSettingsService = service;
  }

  /** Ensure the system CA exists. Creates it on first startup. Returns its ID. */
  async ensureSystemCA(): Promise<string> {
    const [existing] = await this.db
      .select({ id: certificateAuthorities.id })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'node-mtls'))
      .limit(1);

    if (existing) return existing.id;

    // Installations created before purpose-scoped system CAs have exactly one
    // locked CA: it is the node mTLS CA. Adopt it instead of minting a second
    // root during the migration to database TLS.
    const [legacy] = await this.db
      .select({ id: certificateAuthorities.id })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.isSystem, true))
      .limit(1);
    if (legacy) {
      await this.db
        .update(certificateAuthorities)
        .set({ systemPurpose: 'node-mtls' })
        .where(eq(certificateAuthorities.id, legacy.id));
      return legacy.id;
    }

    logger.info('Creating system CA for node mTLS...');

    const ca = await this.caService.createRootCA(
      {
        commonName: SYSTEM_CA_CN,
        keyAlgorithm: 'ecdsa-p256',
        validityYears: 10,
        maxValidityDays: 3650,
        pathLengthConstraint: 0,
      },
      SYSTEM_USER_ID
    );

    await this.db
      .update(certificateAuthorities)
      .set({ isSystem: true, systemPurpose: 'node-mtls' })
      .where(eq(certificateAuthorities.id, ca.id));

    logger.info('System CA created', { caId: ca.id });
    return ca.id;
  }

  /** Get the system CA certificate PEM (for gRPC mTLS verification). */
  async getSystemCACertPem(): Promise<string | null> {
    const [ca] = await this.db
      .select({ certificatePem: certificateAuthorities.certificatePem })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'node-mtls'))
      .limit(1);
    return ca?.certificatePem ?? null;
  }

  /** Get the system CA ID (throws if not found). */
  async getSystemCAId(): Promise<string> {
    const [ca] = await this.db
      .select({ id: certificateAuthorities.id })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'node-mtls'))
      .limit(1);

    if (!ca) throw new Error('System CA not found — run ensureSystemCA first');
    return ca.id;
  }

  /**
   * Ensure the gRPC server has a TLS certificate issued by the system CA.
   * Returns the cert/key file paths. Reuses existing files if still valid.
   */
  async ensureGrpcServerCert(certPath: string, keyPath: string): Promise<{ certPath: string; keyPath: string }> {
    const expectedSans = await this.collectGrpcServerSans();
    return this.ensureServerCert(certPath, keyPath, 'gateway-grpc', expectedSans, 'gRPC');
  }

  /** Ensure the native web listener has its own leaf issued by the existing system CA. */
  async ensureWebServerCert(certPath: string, keyPath: string): Promise<{ certPath: string; keyPath: string }> {
    const expectedSans = await this.collectWebServerSans();
    return this.ensureServerCert(certPath, keyPath, 'gateway-web', expectedSans, 'web');
  }

  private async ensureServerCert(
    certPath: string,
    keyPath: string,
    commonName: string,
    expectedSans: string[],
    listener: 'gRPC' | 'web'
  ): Promise<{ certPath: string; keyPath: string }> {
    // Reuse if files exist and cert is still valid (> 7 days remaining)
    if (existsSync(certPath) && existsSync(keyPath)) {
      try {
        const certPem = readFileSync(certPath, 'utf-8');
        const keyPem = readFileSync(keyPath, 'utf-8');
        if (certPem.includes('BEGIN CERTIFICATE')) {
          const cert = new x509.X509Certificate(certPem);
          validateGrpcServerCertificate(certPem, keyPem, await this.getSystemCACertPem());
          if (!certificateHasExpectedSans(certPem, expectedSans)) {
            logger.info(`Existing ${listener} server cert is missing required SANs, regenerating`, { expectedSans });
          } else {
            const remaining = cert.notAfter.getTime() - Date.now();
            if (remaining > 7 * 24 * 60 * 60 * 1000) {
              logger.debug(`Reusing existing ${listener} server cert`, {
                expiresAt: cert.notAfter.toISOString(),
              });
              return { certPath, keyPath };
            }
            logger.info(`${listener} server cert expiring soon, regenerating`, {
              remaining: `${Math.round(remaining / 3600000)}h`,
            });
          }
        }
      } catch (err) {
        logger.warn(`Existing ${listener} server TLS material is invalid; regenerating`, {
          error: (err as Error).message,
        });
      }
    }

    logger.info(`Issuing ${listener} server TLS certificate from system CA...`);

    const caId = await this.getSystemCAId();

    const result = await this.certService.issueCertificate(
      {
        caId,
        type: 'tls-server',
        commonName,
        sans: expectedSans,
        keyAlgorithm: 'ecdsa-p256',
        validityDays: 365,
      },
      SYSTEM_USER_ID,
      { allowSystem: true }
    );

    // Write cert and key to disk
    mkdirSync(dirname(certPath), { recursive: true });
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(certPath, result.certificate.certificatePem, { mode: 0o644 });
    writeFileSync(keyPath, result.privateKeyPem, { mode: 0o600 });

    logger.info(`${listener} server cert issued`, { serial: result.certificate.serialNumber, certPath });
    return { certPath, keyPath };
  }

  private async collectGrpcServerSans(): Promise<string[]> {
    const values = collectGrpcServerSans();
    const settings = await this.generalSettingsService?.getGatewayEndpointSettings();
    const publicHost = extractGrpcTargetHost(settings?.gatewayGrpcPublicTarget);
    const localHost = extractGrpcTargetHost(settings?.gatewayGrpcLocalIp);
    if (publicHost) values.push(publicHost);
    if (localHost) values.push(localHost);
    return [...new Set(values.map(normalizeGrpcServerSan).filter(Boolean))];
  }

  private async collectWebServerSans(): Promise<string[]> {
    const values = ['localhost', hostname(), '127.0.0.1'];
    if (process.env.PUBLIC_IPV4) values.push(process.env.PUBLIC_IPV4);
    if (process.env.PUBLIC_IPV6) values.push(process.env.PUBLIC_IPV6);
    values.push(
      ...(process.env.GATEWAY_LOCAL_HOSTS?.split(',')
        .map((value) => value.trim())
        .filter(Boolean) ?? [])
    );
    const discoveredPublicIps = getPublicIPs();
    values.push(...discoveredPublicIps.ipv4, ...discoveredPublicIps.ipv6);

    const general = await this.generalSettingsService?.getConfig();
    values.push(...(general?.gatewayPublicIps ?? []));
    if (general?.publicUrl) values.push(new URL(general.publicUrl).hostname);

    return [...new Set(values.map(normalizeGrpcServerSan).filter(Boolean))];
  }

  /** Issue a TLS client cert for a daemon node using the system CA. */
  async issueNodeCert(
    nodeId: string,
    hostname: string
  ): Promise<{
    caCertPem: string;
    certPem: string;
    keyPem: string;
    serial: string;
    expiresAt: Date;
  }> {
    const caId = await this.getSystemCAId();

    const [ca] = await this.db
      .select({ certificatePem: certificateAuthorities.certificatePem })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.id, caId))
      .limit(1);

    const result = await this.certService.issueCertificate(
      {
        caId,
        type: 'tls-client',
        commonName: nodeId,
        sans: [hostname],
        keyAlgorithm: 'ecdsa-p256',
        validityDays: 365,
      },
      SYSTEM_USER_ID,
      { allowSystem: true }
    );

    return {
      caCertPem: ca!.certificatePem,
      certPem: result.certificate.certificatePem,
      keyPem: result.privateKeyPem,
      serial: result.certificate.serialNumber,
      expiresAt: result.certificate.notAfter,
    };
  }
}
