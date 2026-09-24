import { createHash, X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { certificates } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import type { GrpcIdentityService } from './grpc-identity.service.js';
import { GATEWAY_IDENTITY_RENEW_BEFORE_MS } from './grpc-server-certificate.js';
import type { SystemCAService } from './system-ca.service.js';
import type { SystemCertificateLifecycleService } from './system-certificate-lifecycle.service.js';

const logger = createChildLogger('RelayIdentityProvisioner');
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const RENEW_BEFORE_MS = GATEWAY_IDENTITY_RENEW_BEFORE_MS;

type ServiceOwnerId = 'app-internal-server' | 'app-relay-client' | 'relay-app-client';

interface ServiceLeaf {
  certificatePem: string;
  privateKeyPem: string;
}

export interface AppRelayIdentity {
  internalServerCertPath: string;
  internalServerKeyPath: string;
  appClientCertPath: string;
  appClientKeyPath: string;
  relayClientFingerprint: string;
  appClientFingerprint: string;
  /** The client pair the running relay may still trust after a renewal; see RelayControlClient. */
  previousAppClientCertPath?: string;
  previousAppClientKeyPath?: string;
  /** Digest of every certificate the relay loads: equal digests need no relay reload. */
  materialDigest: string;
  /** The external server certificate the relay serves to daemons, which enrollment commands pin. */
  externalFingerprint: string;
}

export interface InstalledRelayCertificatePaths {
  /** Copy of Gateway's gRPC listener certificate, served by the relay to daemons. */
  externalServer: string;
  /** Served by Gateway's own gRPC listener to the relay. */
  appInternalServer: string;
  /** Gateway's client certificate toward the relay admin and broker. */
  appRelayClient: string;
  /** The relay's client certificate toward Gateway. */
  relayAppClient: string;
}

function fingerprint(certificatePem: string | Buffer): string {
  const certificate = new X509Certificate(certificatePem);
  return `sha256:${createHash('sha256').update(certificate.raw).digest('hex')}`;
}

function safelyUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function readIfExists(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parsedFingerprint(certificatePem: string): string | null {
  try {
    return fingerprint(certificatePem);
  } catch {
    return null;
  }
}

/** The fingerprint of a still-valid certificate, or null. */
function validFingerprint(certificatePem: Buffer | null, now = Date.now()): string | null {
  if (!certificatePem) return null;
  try {
    const certificate = new X509Certificate(certificatePem);
    return Date.parse(certificate.validTo) > now ? fingerprint(certificatePem) : null;
  } catch {
    return null;
  }
}

function atomicWrite(path: string, content: string | Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.pending-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, path);
}

export class RelayIdentityProvisionerService {
  private identity: AppRelayIdentity | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly certService: CertService,
    private readonly lifecycle: SystemCertificateLifecycleService,
    private readonly systemCA: SystemCAService,
    private readonly grpcIdentity: GrpcIdentityService,
    private readonly identityDir: string
  ) {}

  async ensure(): Promise<AppRelayIdentity> {
    if (this.identity) return this.identity;
    const marker = resolve(this.identityDir, '.updating');
    mkdirSync(this.identityDir, { recursive: true });
    writeFileSync(marker, `${process.pid}\n`, { mode: 0o600 });
    try {
      const [systemCa, externalIdentity, appServer, appClient, relayClient] = await Promise.all([
        this.systemCA.getSystemCACertPem(),
        this.grpcIdentity.resolve(),
        this.ensureLeaf('app-internal-server', 'tls-server', 'app', ['app']),
        this.ensureLeaf('app-relay-client', 'tls-client', 'app-relay-client', []),
        this.ensureLeaf('relay-app-client', 'tls-client', 'relay-app-client', []),
      ]);
      if (!systemCa) throw new Error('Gateway system CA certificate is unavailable');

      const paths = {
        systemCa: resolve(this.identityDir, 'system-ca.crt'),
        externalCertificate: resolve(this.identityDir, 'external-server.crt'),
        externalPrivateKey: resolve(this.identityDir, 'external-server.key'),
        appServerCertificate: resolve(this.identityDir, 'app-internal-server.crt'),
        appServerPrivateKey: resolve(this.identityDir, 'app-internal-server.key'),
        appClientCertificate: resolve(this.identityDir, 'app-relay-client.crt'),
        appClientPrivateKey: resolve(this.identityDir, 'app-relay-client.key'),
        relayClientCertificate: resolve(this.identityDir, 'relay-app-client.crt'),
        relayClientPrivateKey: resolve(this.identityDir, 'relay-app-client.key'),
        trustManifest: resolve(this.identityDir, 'trust-manifest.json'),
        previousAppClientCertificate: resolve(this.identityDir, 'app-relay-client.previous.crt'),
        previousAppClientPrivateKey: resolve(this.identityDir, 'app-relay-client.previous.key'),
      };
      // A running relay trusts the client pair it loaded, and it reloads only when a client it
      // trusts asks. Keep the pair a renewal replaces, so Gateway can still ask.
      const installedClient = readIfExists(paths.appClientCertificate);
      const installedKey = readIfExists(paths.appClientPrivateKey);
      const renewedFingerprint = fingerprint(appClient.certificatePem);
      if (
        installedKey &&
        validFingerprint(installedClient) &&
        validFingerprint(installedClient) !== renewedFingerprint
      ) {
        atomicWrite(paths.previousAppClientCertificate, installedClient!, 0o644);
        atomicWrite(paths.previousAppClientPrivateKey, installedKey, 0o600);
      }
      const previousFingerprint = validFingerprint(readIfExists(paths.previousAppClientCertificate));
      if (!previousFingerprint) {
        safelyUnlink(paths.previousAppClientCertificate);
        safelyUnlink(paths.previousAppClientPrivateKey);
      }
      atomicWrite(paths.systemCa, systemCa, 0o644);
      atomicWrite(paths.externalCertificate, readFileSync(externalIdentity.certPath), 0o644);
      atomicWrite(paths.externalPrivateKey, readFileSync(externalIdentity.keyPath), 0o600);
      atomicWrite(paths.appServerCertificate, appServer.certificatePem, 0o644);
      atomicWrite(paths.appServerPrivateKey, appServer.privateKeyPem, 0o600);
      atomicWrite(paths.appClientCertificate, appClient.certificatePem, 0o644);
      atomicWrite(paths.appClientPrivateKey, appClient.privateKeyPem, 0o600);
      atomicWrite(paths.relayClientCertificate, relayClient.certificatePem, 0o644);
      atomicWrite(paths.relayClientPrivateKey, relayClient.privateKeyPem, 0o600);

      const appClientFingerprint = fingerprint(appClient.certificatePem);
      const relayClientFingerprint = fingerprint(relayClient.certificatePem);
      atomicWrite(
        paths.trustManifest,
        `${JSON.stringify(
          {
            version: 1,
            appRelayClientFingerprint: appClientFingerprint,
            relayAppClientFingerprint: relayClientFingerprint,
          },
          null,
          2
        )}\n`,
        0o644
      );
      const externalCertificate = readFileSync(paths.externalCertificate, 'utf8');
      const materialDigest = createHash('sha256')
        .update(
          [
            systemCa,
            externalCertificate,
            appServer.certificatePem,
            appClient.certificatePem,
            relayClient.certificatePem,
          ].join('\n')
        )
        .digest('hex');
      logger.info('Provisioned relay service identities and trust manifest');
      this.identity = {
        internalServerCertPath: paths.appServerCertificate,
        internalServerKeyPath: paths.appServerPrivateKey,
        appClientCertPath: paths.appClientCertificate,
        appClientKeyPath: paths.appClientPrivateKey,
        relayClientFingerprint,
        appClientFingerprint,
        materialDigest,
        externalFingerprint: parsedFingerprint(externalCertificate) ?? '',
        ...(previousFingerprint && previousFingerprint !== appClientFingerprint
          ? {
              previousAppClientCertPath: paths.previousAppClientCertificate,
              previousAppClientKeyPath: paths.previousAppClientPrivateKey,
            }
          : {}),
      };
      return this.identity;
    } finally {
      safelyUnlink(marker);
    }
  }

  /** Re-provisions, renewing leaves that are due. A failure keeps the current identity. */
  async refresh(): Promise<AppRelayIdentity> {
    const previous = this.identity;
    this.identity = null;
    try {
      return await this.ensure();
    } catch (error) {
      this.identity = previous;
      throw error;
    }
  }

  /** The certificates installed for the local relay and Gateway's internal listener, for expiry checks. */
  installedCertificatePaths(): InstalledRelayCertificatePaths {
    return {
      externalServer: resolve(this.identityDir, 'external-server.crt'),
      appInternalServer: resolve(this.identityDir, 'app-internal-server.crt'),
      appRelayClient: resolve(this.identityDir, 'app-relay-client.crt'),
      relayAppClient: resolve(this.identityDir, 'relay-app-client.crt'),
    };
  }

  private async ensureLeaf(
    ownerId: ServiceOwnerId,
    type: 'tls-server' | 'tls-client',
    commonName: string,
    sans: string[]
  ): Promise<ServiceLeaf> {
    const [current] = await this.db
      .select({ id: certificates.id, certificatePem: certificates.certificatePem, notAfter: certificates.notAfter })
      .from(certificates)
      .where(
        and(
          eq(certificates.systemOwnerType, 'gateway_service'),
          eq(certificates.systemOwnerId, ownerId),
          eq(certificates.systemLifecycleState, 'current'),
          eq(certificates.status, 'active')
        )
      )
      .limit(1);
    if (current && current.notAfter.getTime() - Date.now() > RENEW_BEFORE_MS) {
      const privateKeyPem = await this.certService.getCertificatePrivateKey(current.id);
      if (privateKeyPem) return { certificatePem: current.certificatePem, privateKeyPem };
    }

    const issued = await this.lifecycle.issueCurrent(
      {
        caId: await this.systemCA.getSystemCAId(),
        type,
        commonName,
        sans,
        keyAlgorithm: 'ecdsa-p256',
        validityDays: 365,
      },
      SYSTEM_USER_ID,
      { type: 'gateway_service', id: ownerId }
    );
    return { certificatePem: issued.certificate.certificatePem, privateKeyPem: issued.privateKeyPem };
  }
}
