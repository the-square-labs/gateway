import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import forge from 'node-forge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGrpcServerCredentials, refreshGrpcServerCredentials } from './server.js';

function createCertificatePair() {
  const now = Date.now();
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date(now - 60_000);
  caCert.validity.notAfter = new Date(now + 86_400_000);
  caCert.setSubject([{ name: 'commonName', value: 'gateway-system-ca' }]);
  caCert.setIssuer(caCert.subject.attributes);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const leafKeys = forge.pki.rsa.generateKeyPair(2048);
  const leafCert = forge.pki.createCertificate();
  leafCert.publicKey = leafKeys.publicKey;
  leafCert.serialNumber = '02';
  leafCert.validity.notBefore = new Date(now - 60_000);
  leafCert.validity.notAfter = new Date(now + 86_400_000);
  leafCert.setSubject([{ name: 'commonName', value: 'gateway-grpc' }]);
  leafCert.setIssuer(caCert.subject.attributes);
  leafCert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] },
  ]);
  leafCert.sign(caKeys.privateKey, forge.md.sha256.create());

  return {
    caPem: forge.pki.certificateToPem(caCert),
    certPem: forge.pki.certificateToPem(leafCert),
    keyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
  };
}

describe('createGrpcServerCredentials', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeTlsFiles(certPem = 'server-cert', keyPem = 'server-key') {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-grpc-test-'));
    tempDirs.push(dir);
    const certPath = join(dir, 'server.crt');
    const keyPath = join(dir, 'server.key');
    writeFileSync(certPath, certPem);
    writeFileSync(keyPath, keyPem);
    return { certPath, keyPath };
  }

  it('rejects missing TLS material instead of creating plaintext credentials', async () => {
    const createInsecure = vi.spyOn(grpc.ServerCredentials, 'createInsecure');

    await expect(
      createGrpcServerCredentials(undefined, undefined, { getSystemCACertPem: vi.fn() } as any)
    ).rejects.toThrow('gRPC server requires TLS certificate and key paths');

    expect(createInsecure).not.toHaveBeenCalled();
  });

  it('requires the Gateway system CA for daemon mTLS validation', async () => {
    const { certPath, keyPath } = writeTlsFiles();

    await expect(
      createGrpcServerCredentials(certPath, keyPath, { getSystemCACertPem: vi.fn().mockResolvedValue(null) } as any)
    ).rejects.toThrow('gRPC server requires the Gateway system CA certificate for daemon mTLS');
  });

  it('creates certificate-provider credentials from TLS material and the Gateway system CA', async () => {
    const { caPem, certPem, keyPem } = createCertificatePair();
    const { certPath, keyPath } = writeTlsFiles(certPem, keyPem);
    const credentials = {} as grpc.ServerCredentials;
    const createProviderCredentials = vi
      .spyOn(grpc.experimental as any, 'createCertificateProviderServerCredentials')
      .mockReturnValue(credentials);

    await expect(
      createGrpcServerCredentials(certPath, keyPath, {
        getSystemCACertPem: vi.fn().mockResolvedValue(caPem),
      } as any)
    ).resolves.toBe(credentials);

    expect(createProviderCredentials).toHaveBeenCalledTimes(1);
    expect(createProviderCredentials.mock.calls[0]?.[2]).toBe(false);
  });

  it('can require the relay service client certificate on the internal listener', async () => {
    const { caPem, certPem, keyPem } = createCertificatePair();
    const { certPath, keyPath } = writeTlsFiles(certPem, keyPem);
    const credentials = {} as grpc.ServerCredentials;
    const createProviderCredentials = vi
      .spyOn(grpc.experimental as any, 'createCertificateProviderServerCredentials')
      .mockReturnValue(credentials);

    await createGrpcServerCredentials(
      certPath,
      keyPath,
      { getSystemCACertPem: vi.fn().mockResolvedValue(caPem) } as any,
      true
    );

    expect(createProviderCredentials.mock.calls[0]?.[2]).toBe(true);
  });

  it('notifies active certificate provider listeners when TLS material is refreshed', async () => {
    const { caPem, certPem, keyPem } = createCertificatePair();
    const { certPath, keyPath } = writeTlsFiles(certPem, keyPem);
    let provider: any;
    vi.spyOn(grpc.experimental as any, 'createCertificateProviderServerCredentials').mockImplementation(
      (caProvider) => {
        provider = caProvider;
        return {} as grpc.ServerCredentials;
      }
    );
    const systemCA = { getSystemCACertPem: vi.fn().mockResolvedValue(caPem) };

    await createGrpcServerCredentials(certPath, keyPath, systemCA as any);
    const caListener = vi.fn();
    const identityListener = vi.fn();
    provider.addCaCertificateListener(caListener);
    provider.addIdentityCertificateListener(identityListener);
    await new Promise((resolve) => setImmediate(resolve));
    caListener.mockClear();
    identityListener.mockClear();

    await refreshGrpcServerCredentials(certPath, keyPath, systemCA as any);

    expect(caListener).toHaveBeenCalledWith({ caCertificate: Buffer.from(caPem) });
    expect(identityListener).toHaveBeenCalledWith({
      certificate: Buffer.from(certPem),
      privateKey: Buffer.from(keyPem),
    });
  });
});
