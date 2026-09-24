import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSecureContext, type SecureContextOptions } from 'node:tls';
import type { Env } from '@/config/env.js';
import { createChildLogger } from '@/lib/logger.js';
import { validateGrpcServerCertificate } from './grpc-server-certificate.js';
import type { SystemCAService } from './system-ca.service.js';

const logger = createChildLogger('WebIdentity');

export interface WebIdentity {
  certPath: string;
  keyPath: string;
  certSha256: string;
}

interface SecureContextServer {
  setSecureContext(options: SecureContextOptions): void;
}

export class WebIdentityService {
  private identity: WebIdentity | null = null;
  private served: { server: SecureContextServer; certificate: Buffer } | null = null;
  /**
   * Settings changes, first-run setup and renewal all refresh this identity. Their certificate
   * issuances never overlap: each stages and backs up the listener files, and two at once
   * would undo each other's backups.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly env: Env,
    private readonly systemCA: SystemCAService
  ) {}

  async resolve(): Promise<WebIdentity> {
    if (this.identity) return this.identity;
    return this.exclusive(async () => {
      if (!this.identity) this.identity = await this.load();
      return this.identity;
    });
  }

  /** Re-reads the identity, renewing it when due. A failure keeps the current identity. */
  async refresh(): Promise<WebIdentity> {
    return this.exclusive(async () => {
      this.identity = await this.load();
      return this.identity;
    });
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<WebIdentity> {
    const { certPath, keyPath } = await this.systemCA.ensureWebServerCert(
      `${this.env.WEB_TLS_AUTO_DIR}/web-server.crt`,
      `${this.env.WEB_TLS_AUTO_DIR}/web-server.key`
    );
    const certificate = new X509Certificate(readFileSync(certPath));
    const identity = {
      certPath,
      keyPath,
      certSha256: `sha256:${createHash('sha256').update(certificate.raw).digest('hex')}`,
    };
    logger.info('Resolved native web server identity', { certPath, certSha256: identity.certSha256 });
    return identity;
  }

  /** Hands the running HTTPS listener, which serves the resolved identity, to reloadServed(). */
  attachServer(server: object): void {
    const candidate = server as Partial<SecureContextServer>;
    if (typeof candidate.setSecureContext !== 'function' || !this.identity) return;
    this.served = { server: candidate as SecureContextServer, certificate: readFileSync(this.identity.certPath) };
  }

  /** The certificate the running HTTPS listener presents to new connections, or null without one. */
  servedCertificate(): Buffer | null {
    return this.served?.certificate ?? null;
  }

  /**
   * Re-resolves the identity, which renews it when due, and switches the running HTTPS listener
   * to it without a restart. The material is validated first: on failure the listener keeps its
   * current certificate. Established connections keep the certificate they were opened with.
   */
  async reloadServed(): Promise<WebIdentity> {
    // One step in the queue: a settings refresh cannot replace the files between reading and serving them.
    return this.exclusive(async () => {
      const identity = await this.load();
      this.identity = identity;
      const served = this.served;
      if (!served) return identity;
      const cert = readFileSync(identity.certPath);
      const key = readFileSync(identity.keyPath);
      try {
        validateGrpcServerCertificate(cert, key, await this.systemCA.getSystemCACertPem());
        createSecureContext({ cert, key });
      } catch (error) {
        const message = (error as Error).message.replace(/^Invalid gRPC TLS certificate: /, '');
        throw new Error(`Invalid web TLS certificate: ${message}`);
      }
      served.server.setSecureContext({ cert, key });
      served.certificate = cert;
      logger.info('Reloaded native web server identity', { certSha256: identity.certSha256 });
      return identity;
    });
  }
}
