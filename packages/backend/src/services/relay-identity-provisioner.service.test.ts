import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayIdentityProvisionerService } from './relay-identity-provisioner.service.js';

const DAY = 24 * 60 * 60 * 1000;
let serial = 10;

function certificatePem(commonName: string, notAfter: Date): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  serial += 1;
  certificate.serialNumber = serial.toString(16);
  certificate.validity.notBefore = new Date(Date.now() - 2 * DAY);
  certificate.validity.notAfter = notAfter;
  certificate.setSubject([{ name: 'commonName', value: commonName }]);
  certificate.setIssuer([{ name: 'commonName', value: 'gateway-system-ca' }]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(certificate);
}

describe('RelayIdentityProvisionerService', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'relay-identity-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function provisioner() {
    const external = { certPath: join(directory, 'grpc.crt'), keyPath: join(directory, 'grpc.key') };
    writeFileSync(external.certPath, 'external-certificate');
    writeFileSync(external.keyPath, 'external-key');
    const db = {
      select: () => {
        const query: any = Promise.resolve([]);
        for (const method of ['from', 'where', 'limit']) query[method] = () => query;
        return query;
      },
    };
    const lifecycle = {
      issueCurrent: vi.fn(async (input: { commonName: string }) => ({
        certificate: { certificatePem: certificatePem(input.commonName, new Date(Date.now() + 365 * DAY)) },
        privateKeyPem: `${input.commonName}-renewed-key`,
      })),
    };
    return new RelayIdentityProvisionerService(
      db as never,
      {} as never,
      lifecycle as never,
      { getSystemCACertPem: async () => 'system-ca', getSystemCAId: async () => 'ca-1' } as never,
      { resolve: async () => external } as never,
      join(directory, 'identity')
    );
  }

  it('keeps the client pair a renewal replaces so the running relay can still be asked to reload', async () => {
    const identityDir = join(directory, 'identity');
    const installed = certificatePem('app-relay-client', new Date(Date.now() + 3 * DAY));
    await provisioner().ensure(); // creates the directory layout
    writeFileSync(join(identityDir, 'app-relay-client.crt'), installed);
    writeFileSync(join(identityDir, 'app-relay-client.key'), 'installed-key');

    const identity = await provisioner().ensure();

    expect(identity.previousAppClientCertPath).toBe(join(identityDir, 'app-relay-client.previous.crt'));
    expect(readFileSync(identity.previousAppClientCertPath!, 'utf8')).toBe(installed);
    expect(readFileSync(identity.previousAppClientKeyPath!, 'utf8')).toBe('installed-key');
    expect(readFileSync(identity.appClientCertPath, 'utf8')).not.toBe(installed);
  });

  it('drops a previous pair that expired: no relay can still trust it', async () => {
    const identityDir = join(directory, 'identity');
    await provisioner().ensure();
    writeFileSync(
      join(identityDir, 'app-relay-client.crt'),
      certificatePem('app-relay-client', new Date(Date.now() - DAY))
    );
    writeFileSync(
      join(identityDir, 'app-relay-client.previous.crt'),
      certificatePem('old', new Date(Date.now() - DAY))
    );
    writeFileSync(join(identityDir, 'app-relay-client.previous.key'), 'old-key');

    const identity = await provisioner().ensure();

    expect(identity.previousAppClientCertPath).toBeUndefined();
    expect(existsSync(join(identityDir, 'app-relay-client.previous.crt'))).toBe(false);
  });
});
