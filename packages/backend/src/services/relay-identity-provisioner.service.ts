import { createHash, X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { certificates } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import type { GrpcIdentityService } from './grpc-identity.service.js';
import type { SystemCAService } from './system-ca.service.js';
import type { SystemCertificateLifecycleService } from './system-certificate-lifecycle.service.js';

const logger = createChildLogger('RelayIdentityProvisioner');
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

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
      };
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
      logger.info('Provisioned relay service identities and trust manifest');
      this.identity = {
        internalServerCertPath: paths.appServerCertificate,
        internalServerKeyPath: paths.appServerPrivateKey,
        appClientCertPath: paths.appClientCertificate,
        appClientKeyPath: paths.appClientPrivateKey,
        relayClientFingerprint,
        appClientFingerprint,
      };
      return this.identity;
    } finally {
      safelyUnlink(marker);
    }
  }

  async refresh(): Promise<AppRelayIdentity> {
    this.identity = null;
    return this.ensure();
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
