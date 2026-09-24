import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type ClientHttp2Session, connect as connectHttp2 } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import forge from 'node-forge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGrpcServerCredentials, currentGrpcServerCertificate, refreshGrpcServerCredentials } from './server.js';

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

/** One CA and two successive leaves for the same key, as a renewal produces them. */
function createRenewedCertificates() {
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
  const leaf = (serialNumber: string) => {
    const leafCert = forge.pki.createCertificate();
    leafCert.publicKey = leafKeys.publicKey;
    leafCert.serialNumber = serialNumber;
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
    return forge.pki.certificateToPem(leafCert);
  };
  return {
    caPem: forge.pki.certificateToPem(caCert),
    keyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
    foreignKeyPem: forge.pki.privateKeyToPem(caKeys.privateKey),
    currentPem: leaf('02'),
    renewedPem: leaf('03'),
  };
}

function fingerprint(certificatePem: string | Buffer): string {
  return createHash('sha256').update(new X509Certificate(certificatePem).raw).digest('hex');
}

function openSession(port: number, caPem: string): Promise<ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    const session = connectHttp2(`https://localhost:${port}`, { ca: caPem, servername: 'localhost' });
    session.once('connect', () => resolve(session));
    session.once('error', reject);
  });
}

function servedFingerprint(session: ClientHttp2Session): string {
  const peer = (session.socket as unknown as { getPeerCertificate(): { raw: Buffer } }).getPeerCertificate();
  return createHash('sha256').update(peer.raw).digest('hex');
}

/** Calls a method the server does not implement: a live connection answers UNIMPLEMENTED (12). */
function grpcStatus(session: ClientHttp2Session): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let status: string | undefined;
    const stream = session.request({
      ':method': 'POST',
      ':path': '/gateway.v1.Probe/Missing',
      'content-type': 'application/grpc',
      te: 'trailers',
    });
    stream.on('response', (headers) => {
      status = (headers['grpc-status'] as string | undefined) ?? status;
    });
    stream.on('trailers', (trailers) => {
      status = (trailers['grpc-status'] as string | undefined) ?? status;
    });
    stream.on('close', () => resolve(status));
    stream.on('error', reject);
    stream.resume();
    stream.end(Buffer.alloc(5));
  });
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

describe('gRPC server certificate hot reload', () => {
  const tempDirs: string[] = [];
  const servers: grpc.Server[] = [];
  const sessions: ClientHttp2Session[] = [];

  afterEach(() => {
    for (const session of sessions.splice(0)) session.destroy();
    for (const server of servers.splice(0)) server.forceShutdown();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function serve(certPem: string, keyPem: string, caPem: string) {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-grpc-reload-'));
    tempDirs.push(dir);
    const certPath = join(dir, 'server.crt');
    const keyPath = join(dir, 'server.key');
    writeFileSync(certPath, certPem);
    writeFileSync(keyPath, keyPem);
    const systemCA = { getSystemCACertPem: vi.fn().mockResolvedValue(caPem) } as any;
    const server = new grpc.Server();
    servers.push(server);
    const credentials = await createGrpcServerCredentials(certPath, keyPath, systemCA);
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync('127.0.0.1:0', credentials, (error, bound) => (error ? reject(error) : resolve(bound)))
    );
    return { port, certPath, keyPath, systemCA };
  }

  async function session(port: number, caPem: string) {
    const opened = await openSession(port, caPem);
    sessions.push(opened);
    return opened;
  }

  it('serves a renewed certificate to new connections while established connections continue', async () => {
    const certificates = createRenewedCertificates();
    const { port, certPath, keyPath, systemCA } = await serve(
      certificates.currentPem,
      certificates.keyPem,
      certificates.caPem
    );
    const established = await session(port, certificates.caPem);
    expect(servedFingerprint(established)).toBe(fingerprint(certificates.currentPem));

    writeFileSync(certPath, certificates.renewedPem);
    await refreshGrpcServerCredentials(certPath, keyPath, systemCA);

    expect(currentGrpcServerCertificate()).toEqual(Buffer.from(certificates.renewedPem));
    const renewed = await session(port, certificates.caPem);
    expect(servedFingerprint(renewed)).toBe(fingerprint(certificates.renewedPem));
    // The connection opened before the switch was not dropped and keeps serving calls.
    expect(established.closed).toBe(false);
    expect(established.destroyed).toBe(false);
    await expect(grpcStatus(established)).resolves.toBe('12');
    expect(servedFingerprint(established)).toBe(fingerprint(certificates.currentPem));
  });

  it('keeps serving the current certificate when renewed material fails validation', async () => {
    const certificates = createRenewedCertificates();
    const { port, certPath, keyPath, systemCA } = await serve(
      certificates.currentPem,
      certificates.keyPem,
      certificates.caPem
    );

    writeFileSync(certPath, certificates.renewedPem);
    writeFileSync(keyPath, certificates.foreignKeyPem);
    await expect(refreshGrpcServerCredentials(certPath, keyPath, systemCA)).rejects.toThrow(
      'private key does not match certificate'
    );

    expect(currentGrpcServerCertificate()).toEqual(Buffer.from(certificates.currentPem));
    const next = await session(port, certificates.caPem);
    expect(servedFingerprint(next)).toBe(fingerprint(certificates.currentPem));
    await expect(grpcStatus(next)).resolves.toBe('12');
  });
});
