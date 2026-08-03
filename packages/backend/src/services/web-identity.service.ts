import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Env } from '@/config/env.js';
import { createChildLogger } from '@/lib/logger.js';
import type { SystemCAService } from './system-ca.service.js';

const logger = createChildLogger('WebIdentity');

export interface WebIdentity {
  certPath: string;
  keyPath: string;
  certSha256: string;
}

export class WebIdentityService {
  private identity: WebIdentity | null = null;

  constructor(
    private readonly env: Env,
    private readonly systemCA: SystemCAService
  ) {}

  async resolve(): Promise<WebIdentity> {
    if (this.identity) return this.identity;

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
    this.identity = identity;
    logger.info('Resolved native web server identity', { certPath, certSha256: identity.certSha256 });
    return identity;
  }

  async refresh(): Promise<WebIdentity> {
    this.identity = null;
    return this.resolve();
  }
}
