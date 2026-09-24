import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrpcIdentityService } from './grpc-identity.service.js';

const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIUPJ9QZSZ8RsM7j4S1caOkw6l2moUwDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMZ2F0ZXdheS10ZXN0MB4XDTI2MDQzMDIyMDkxMVoXDTI2
MDUwMTIyMDkxMVowFzEVMBMGA1UEAwwMZ2F0ZXdheS10ZXN0MIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEArelepQmlcdBvUBF2jiNGYQqdNR0xNUevpVOD
cefWwKUsUzjbYtXaJV1cPM6icSgVih2AWvdqjlshPwP/0vhVdag2NAs1wiQbAVz5
wZlzWB+5nBDoCPviyqgminQpfQoW3iy6N//jgyTsRZ5rVhGrU9keiO/oZMElKnGk
jI6ulQnnOOxGQFeQQ7CGb3SKMA2RVGV2/8Mw8BiMeqlx0o1JG4gzHrIGcXuW1SJn
jZk0R67d8NbQeb6NzNaTDjCQn4bqt6nWK5eG1juzOeWvCmxD8DMXAHOM9/Ae6ZEn
rv+55CqRJKpP0eJPttkzGv7KU0n5VOclwlUjL/Rty/MFTvu0xQIDAQABo1MwUTAd
BgNVHQ4EFgQUP5K56xgR96eU6esZDGEij/6UBDYwHwYDVR0jBBgwFoAUP5K56xgR
96eU6esZDGEij/6UBDYwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEASzhOsntwv7NsZ69mt3MmU351nV247loOb90kZq4vlwd2Msnf3c4ygUlp61qp
kffbZ/11Xu/jiUI3tbNDGn9X3UigZuOTPRuwN3LIDlPmW+8j7s+IKgwqWakSYbtF
DlcImTDsru1Ie5MpS0zddFjTHwRaLi1R49JpQmGSB625oqs/hizZj+IwsXUvccWb
MHXr0RLyciF6ZNhxUsaNpieDvnlAohnChkMhRF9Wq31QIAtZZtnQDqRzw3uVvV4t
xCpoMT/UAaLKU9twJ0mxAqrxb1eHj66tcC/GDTUIlghn5I42QxS2nE+/5/RHHSrc
oD3IhAwaI3ht9c+zdQt5HFAXSA==
-----END CERTIFICATE-----`;

function createCertificatePair(options: { serverAuth?: boolean; clientAuth?: boolean; ca?: boolean } = {}) {
  const { serverAuth = true, clientAuth = false, ca = false } = options;
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
  const extKeyUsage: { name: 'extKeyUsage'; serverAuth?: boolean; clientAuth?: boolean } = { name: 'extKeyUsage' };
  if (serverAuth) extKeyUsage.serverAuth = true;
  if (clientAuth) extKeyUsage.clientAuth = true;
  leafCert.setExtensions([
    { name: 'basicConstraints', cA: ca },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    extKeyUsage,
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] },
  ]);
  leafCert.sign(caKeys.privateKey, forge.md.sha256.create());

  return {
    caPem: forge.pki.certificateToPem(caCert),
    certPem: forge.pki.certificateToPem(leafCert),
    keyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
  };
}

describe('GrpcIdentityService', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeTlsFiles(certPem = TEST_CERT_PEM, keyPem = 'test-key') {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-identity-test-'));
    tempDirs.push(dir);
    const certPath = join(dir, 'grpc-server.crt');
    const keyPath = join(dir, 'grpc-server.key');
    writeFileSync(certPath, certPem);
    writeFileSync(keyPath, keyPem);
    return { certPath, keyPath };
  }

  it('formats the SHA-256 fingerprint of the leaf certificate DER', () => {
    expect(GrpcIdentityService.computeCertificateSha256(TEST_CERT_PEM)).toBe(
      'sha256:46efa7e585760db43184ef4b490741451dd3b62fe50de10e12cd465bf850d9b0'
    );
  });

  it('throws a descriptive error for invalid PEM content', () => {
    expect(() => GrpcIdentityService.computeCertificateSha256('not a certificate')).toThrow(
      'Invalid gRPC TLS certificate PEM'
    );
  });

  it('auto-generates gRPC TLS material in GRPC_TLS_AUTO_DIR when custom paths are omitted', async () => {
    const { certPath, keyPath } = writeTlsFiles();
    const systemCA = {
      ensureGrpcServerCert: vi.fn().mockResolvedValue({ certPath, keyPath }),
      getSystemCACertPem: vi.fn(),
    };
    const service = new GrpcIdentityService({ GRPC_TLS_AUTO_DIR: '/tmp/gateway-tls' } as any, systemCA as any);

    await expect(service.resolve()).resolves.toMatchObject({ certPath, keyPath });
    expect(systemCA.ensureGrpcServerCert).toHaveBeenCalledWith(
      '/tmp/gateway-tls/grpc-server.crt',
      '/tmp/gateway-tls/grpc-server.key'
    );
  });

  it('refreshes auto-generated gRPC TLS identity instead of reusing the cached fingerprint', async () => {
    const { certPath, keyPath } = writeTlsFiles();
    const systemCA = {
      ensureGrpcServerCert: vi.fn().mockResolvedValue({ certPath, keyPath }),
      getSystemCACertPem: vi.fn(),
    };
    const service = new GrpcIdentityService({ GRPC_TLS_AUTO_DIR: '/tmp/gateway-tls' } as any, systemCA as any);

    await service.resolve();
    await service.refresh();

    expect(systemCA.ensureGrpcServerCert).toHaveBeenCalledTimes(2);
  });

  it('advertises the served certificate until a renewed one is marked served', async () => {
    const first = writeTlsFiles(TEST_CERT_PEM);
    const renewed = writeTlsFiles(createCertificatePair().certPem);
    const systemCA = {
      ensureGrpcServerCert: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(renewed),
      getSystemCACertPem: vi.fn(),
    };
    const service = new GrpcIdentityService({ GRPC_TLS_AUTO_DIR: '/tmp/gateway-tls' } as any, systemCA as any);
    const served = (await service.resolve()).gatewayCertSha256;

    const next = await service.refresh({ renewBeforeMs: 30 * 86_400_000 });
    expect(systemCA.ensureGrpcServerCert).toHaveBeenLastCalledWith(
      '/tmp/gateway-tls/grpc-server.crt',
      '/tmp/gateway-tls/grpc-server.key',
      { renewBeforeMs: 30 * 86_400_000 }
    );
    expect(next.gatewayCertSha256).not.toBe(served);
    // Installed, not yet served: enrollment commands keep the fingerprint daemons get today.
    await expect(service.getGatewayCertSha256()).resolves.toBe(served);

    service.markServed(next.gatewayCertSha256);
    await expect(service.getGatewayCertSha256()).resolves.toBe(next.gatewayCertSha256);
  });

  it('keeps the current identity when a refresh fails', async () => {
    const { certPath, keyPath } = writeTlsFiles();
    const systemCA = {
      ensureGrpcServerCert: vi
        .fn()
        .mockResolvedValueOnce({ certPath, keyPath })
        .mockRejectedValueOnce(new Error('issuance failed')),
      getSystemCACertPem: vi.fn(),
    };
    const service = new GrpcIdentityService({ GRPC_TLS_AUTO_DIR: '/tmp/gateway-tls' } as any, systemCA as any);
    const current = await service.resolve();

    await expect(service.refresh()).rejects.toThrow('issuance failed');
    await expect(service.resolve()).resolves.toEqual(current);
    await expect(service.getGatewayCertSha256()).resolves.toBe(current.gatewayCertSha256);
    expect(systemCA.ensureGrpcServerCert).toHaveBeenCalledTimes(2);
  });

  it('never issues two certificates at once', async () => {
    const { certPath, keyPath } = writeTlsFiles();
    let active = 0;
    let overlapped = false;
    const systemCA = {
      ensureGrpcServerCert: vi.fn(async () => {
        active += 1;
        overlapped ||= active > 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { certPath, keyPath };
      }),
      getSystemCACertPem: vi.fn(),
    };
    const service = new GrpcIdentityService({ GRPC_TLS_AUTO_DIR: '/tmp/gateway-tls' } as any, systemCA as any);

    await Promise.all([service.resolve(), service.refresh(), service.getGatewayCertSha256(), service.refresh()]);
    expect(overlapped).toBe(false);
  });

  it('rejects partial custom gRPC TLS configuration', async () => {
    const service = new GrpcIdentityService(
      { GRPC_TLS_CERT: '/tmp/server.crt', GRPC_TLS_AUTO_DIR: '/tmp/gateway-tls' } as any,
      { ensureGrpcServerCert: vi.fn(), getSystemCACertPem: vi.fn() } as any
    );

    await expect(service.resolve()).rejects.toThrow('GRPC_TLS_CERT and GRPC_TLS_KEY must be configured together');
  });

  it('accepts a custom gRPC TLS certificate issued by the Gateway system CA', async () => {
    const { caPem, certPem, keyPem } = createCertificatePair();
    const { certPath, keyPath } = writeTlsFiles(certPem, keyPem);
    const service = new GrpcIdentityService(
      { GRPC_TLS_CERT: certPath, GRPC_TLS_KEY: keyPath, GRPC_TLS_AUTO_DIR: '/tmp/gateway-tls' } as any,
      { ensureGrpcServerCert: vi.fn(), getSystemCACertPem: vi.fn().mockResolvedValue(caPem) } as any
    );

    await expect(service.resolve()).resolves.toMatchObject({ certPath, keyPath });
  });

  it('rejects a custom gRPC TLS certificate not issued by the Gateway system CA', async () => {
    const { certPem, keyPem } = createCertificatePair();
    const { caPem: otherCaPem } = createCertificatePair();
    const { certPath, keyPath } = writeTlsFiles(certPem, keyPem);
    const service = new GrpcIdentityService(
      { GRPC_TLS_CERT: certPath, GRPC_TLS_KEY: keyPath, GRPC_TLS_AUTO_DIR: '/tmp/gateway-tls' } as any,
      { ensureGrpcServerCert: vi.fn(), getSystemCACertPem: vi.fn().mockResolvedValue(otherCaPem) } as any
    );

    await expect(service.resolve()).rejects.toThrow(
      'Invalid custom gRPC TLS certificate: certificate is not signed by the Gateway system CA'
    );
  });

  it('rejects a custom gRPC TLS certificate with a mismatched private key', async () => {
    const { caPem, certPem } = createCertificatePair();
    const { keyPem: otherKeyPem } = createCertificatePair();
    const { certPath, keyPath } = writeTlsFiles(certPem, otherKeyPem);
    const service = new GrpcIdentityService(
      { GRPC_TLS_CERT: certPath, GRPC_TLS_KEY: keyPath, GRPC_TLS_AUTO_DIR: '/tmp/gateway-tls' } as any,
      { ensureGrpcServerCert: vi.fn(), getSystemCACertPem: vi.fn().mockResolvedValue(caPem) } as any
    );

    await expect(service.resolve()).rejects.toThrow(
      'Invalid custom gRPC TLS certificate: private key does not match certificate'
    );
  });

  it('rejects a custom gRPC TLS certificate without server authentication usage', async () => {
    const { caPem, certPem, keyPem } = createCertificatePair({ serverAuth: false, clientAuth: true });
    const { certPath, keyPath } = writeTlsFiles(certPem, keyPem);
    const service = new GrpcIdentityService(
      { GRPC_TLS_CERT: certPath, GRPC_TLS_KEY: keyPath, GRPC_TLS_AUTO_DIR: '/tmp/gateway-tls' } as any,
      { ensureGrpcServerCert: vi.fn(), getSystemCACertPem: vi.fn().mockResolvedValue(caPem) } as any
    );

    await expect(service.resolve()).rejects.toThrow(
      'Invalid custom gRPC TLS certificate: certificate must allow TLS server authentication'
    );
  });
});
