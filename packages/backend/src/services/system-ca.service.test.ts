import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPublicIPs } from '@/modules/domains/dns.utils.js';
import { SystemCAService } from './system-ca.service.js';

vi.mock('@/modules/domains/dns.utils.js', () => ({
  getPublicIPs: vi.fn(() => ({ ipv4: [], ipv6: [] })),
}));

const originalGrpcSanEnv = {
  APP_URL: process.env.APP_URL,
  PUBLIC_IPV4: process.env.PUBLIC_IPV4,
  PUBLIC_IPV6: process.env.PUBLIC_IPV6,
  GRPC_TLS_EXTRA_SANS: process.env.GRPC_TLS_EXTRA_SANS,
  GATEWAY_LOCAL_HOSTS: process.env.GATEWAY_LOCAL_HOSTS,
};

function createCertificatePair(
  options: {
    serverAuth?: boolean;
    clientAuth?: boolean;
    altNames?: Array<{ type: 2; value: string } | { type: 7; ip: string }>;
  } = {}
) {
  const {
    serverAuth = true,
    clientAuth = false,
    altNames = [
      { type: 2, value: 'localhost' },
      { type: 2, value: 'relay' },
      { type: 7, ip: '127.0.0.1' },
    ],
  } = options;
  const now = Date.now();
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date(now - 60_000);
  caCert.validity.notAfter = new Date(now + 30 * 86_400_000);
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
  leafCert.validity.notAfter = new Date(now + 30 * 86_400_000);
  leafCert.setSubject([{ name: 'commonName', value: 'gateway-grpc' }]);
  leafCert.setIssuer(caCert.subject.attributes);
  const extKeyUsage: { name: 'extKeyUsage'; serverAuth?: boolean; clientAuth?: boolean } = { name: 'extKeyUsage' };
  if (serverAuth) extKeyUsage.serverAuth = true;
  if (clientAuth) extKeyUsage.clientAuth = true;
  leafCert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    extKeyUsage,
    { name: 'subjectAltName', altNames },
  ]);
  leafCert.sign(caKeys.privateKey, forge.md.sha256.create());

  return {
    caPem: forge.pki.certificateToPem(caCert),
    certPem: forge.pki.certificateToPem(leafCert),
    keyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
  };
}

function createDb(results: unknown[][]) {
  const limit = vi.fn();
  for (const result of results) {
    limit.mockResolvedValueOnce(result);
  }
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { select: vi.fn(() => ({ from })) };
}

describe('SystemCAService.ensureGrpcServerCert', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    delete process.env.APP_URL;
    delete process.env.PUBLIC_IPV4;
    delete process.env.PUBLIC_IPV6;
    delete process.env.GRPC_TLS_EXTRA_SANS;
    delete process.env.GATEWAY_LOCAL_HOSTS;
    vi.mocked(getPublicIPs).mockReturnValue({ ipv4: [], ipv6: [] });
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const [key, value] of Object.entries(originalGrpcSanEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function writeTlsFiles(certPem: string, keyPem: string) {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-system-ca-test-'));
    tempDirs.push(dir);
    const certPath = join(dir, 'grpc-server.crt');
    const keyPath = join(dir, 'grpc-server.key');
    writeFileSync(certPath, certPem);
    writeFileSync(keyPath, keyPem);
    return { certPath, keyPath };
  }

  function createService(dbResults: unknown[][], issueResult = createCertificatePair()) {
    const certService = {
      issueCertificate: vi.fn().mockResolvedValue({
        certificate: { certificatePem: issueResult.certPem, serialNumber: 'serial-1' },
        privateKeyPem: issueResult.keyPem,
      }),
    };
    const service = new SystemCAService(createDb(dbResults) as any, {} as any, certService as any, {} as any);
    service.setSystemCertificateLifecycleService({
      issueCurrent: (input: unknown, issuedById: string) =>
        certService.issueCertificate(input, issuedById, { allowSystem: true }),
    } as any);
    return { service, certService };
  }

  it('reuses existing auto gRPC TLS material when it is valid for the current system CA', async () => {
    const { caPem, certPem, keyPem } = createCertificatePair();
    const { certPath, keyPath } = writeTlsFiles(certPem, keyPem);
    const { service, certService } = createService([[{ certificatePem: caPem }]]);

    await expect(service.ensureGrpcServerCert(certPath, keyPath)).resolves.toEqual({ certPath, keyPath });
    expect(certService.issueCertificate).not.toHaveBeenCalled();
  });

  it('includes configured public gateway names and addresses in issued gRPC TLS SANs', async () => {
    process.env.APP_URL = 'https://gateway.example.com';
    process.env.PUBLIC_IPV4 = '203.0.113.10';
    process.env.GRPC_TLS_EXTRA_SANS = 'gateway.internal,10.0.0.5';
    const dir = mkdtempSync(join(tmpdir(), 'gateway-system-ca-test-'));
    tempDirs.push(dir);
    const certPath = join(dir, 'grpc-server.crt');
    const keyPath = join(dir, 'grpc-server.key');
    const { service, certService } = createService([[{ id: 'system-ca-id' }]]);

    await expect(service.ensureGrpcServerCert(certPath, keyPath)).resolves.toEqual({ certPath, keyPath });

    expect(certService.issueCertificate).toHaveBeenCalledWith(
      expect.objectContaining({
        sans: expect.arrayContaining([
          'localhost',
          '127.0.0.1',
          'gateway.example.com',
          '203.0.113.10',
          'gateway.internal',
          '10.0.0.5',
        ]),
      }),
      expect.any(String),
      { allowSystem: true }
    );
  });

  it('does not include the process hostname in automatic gRPC TLS SANs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-system-ca-test-'));
    tempDirs.push(dir);
    const certPath = join(dir, 'grpc-server.crt');
    const keyPath = join(dir, 'grpc-server.key');
    const { service, certService } = createService([[{ id: 'system-ca-id' }]]);

    await service.ensureGrpcServerCert(certPath, keyPath);

    expect(certService.issueCertificate.mock.calls[0]?.[0].sans).not.toContain(hostname());
  });

  it('combines gRPC endpoint settings with existing environment SANs', async () => {
    process.env.APP_URL = 'https://gateway.example.com';
    process.env.PUBLIC_IPV4 = '203.0.113.10';
    process.env.PUBLIC_IPV6 = '2001:db8::10';
    process.env.GRPC_TLS_EXTRA_SANS = 'gateway.internal,10.0.0.5';
    const dir = mkdtempSync(join(tmpdir(), 'gateway-system-ca-test-'));
    tempDirs.push(dir);
    const certPath = join(dir, 'grpc-server.crt');
    const keyPath = join(dir, 'grpc-server.key');
    const { service, certService } = createService([[{ id: 'system-ca-id' }]]);

    service.setGeneralSettingsService({
      getGatewayEndpointSettings: vi.fn(async () => ({
        gatewayGrpcPublicTarget: 'new.gateway.example.com:9443',
        gatewayGrpcLocalIp: '10.1.2.3:9443',
      })),
    } as any);

    await expect(service.ensureGrpcServerCert(certPath, keyPath)).resolves.toEqual({ certPath, keyPath });

    expect(certService.issueCertificate).toHaveBeenCalledWith(
      expect.objectContaining({
        sans: expect.arrayContaining([
          'localhost',
          '127.0.0.1',
          'gateway.example.com',
          '203.0.113.10',
          '2001:db8::10',
          'gateway.internal',
          '10.0.0.5',
          'new.gateway.example.com',
          '10.1.2.3',
        ]),
      }),
      expect.any(String),
      { allowSystem: true }
    );
  });

  it('includes installer-discovered host addresses in the initial web certificate', async () => {
    process.env.GATEWAY_LOCAL_HOSTS = '192.168.1.10,fd00::10';
    const dir = mkdtempSync(join(tmpdir(), 'gateway-system-ca-test-'));
    tempDirs.push(dir);
    const certPath = join(dir, 'web-server.crt');
    const keyPath = join(dir, 'web-server.key');
    const { service, certService } = createService([[{ id: 'system-ca-id' }]]);

    await service.ensureWebServerCert(certPath, keyPath);

    expect(certService.issueCertificate).toHaveBeenCalledWith(
      expect.objectContaining({ sans: expect.arrayContaining(['192.168.1.10', 'fd00::10']) }),
      expect.any(String),
      { allowSystem: true }
    );
  });

  it('includes bootstrap-discovered public NAT addresses in the initial web certificate', async () => {
    vi.mocked(getPublicIPs).mockReturnValue({ ipv4: ['8.8.8.8'], ipv6: ['2001:4860:4860::8888'] });
    const dir = mkdtempSync(join(tmpdir(), 'gateway-system-ca-test-'));
    tempDirs.push(dir);
    const certPath = join(dir, 'web-server.crt');
    const keyPath = join(dir, 'web-server.key');
    const { service, certService } = createService([[{ id: 'system-ca-id' }]]);

    await service.ensureWebServerCert(certPath, keyPath);

    expect(certService.issueCertificate).toHaveBeenCalledWith(
      expect.objectContaining({ sans: expect.arrayContaining(['8.8.8.8', '2001:4860:4860::8888']) }),
      expect.any(String),
      { allowSystem: true }
    );
  });

  it('strips URL brackets from IPv6 APP_URL hosts before issuing gRPC TLS SANs', async () => {
    process.env.APP_URL = 'https://[2001:db8::1]:8443';
    const dir = mkdtempSync(join(tmpdir(), 'gateway-system-ca-test-'));
    tempDirs.push(dir);
    const certPath = join(dir, 'grpc-server.crt');
    const keyPath = join(dir, 'grpc-server.key');
    const { service, certService } = createService([[{ id: 'system-ca-id' }]]);

    await expect(service.ensureGrpcServerCert(certPath, keyPath)).resolves.toEqual({ certPath, keyPath });

    expect(certService.issueCertificate).toHaveBeenCalledWith(
      expect.objectContaining({
        sans: expect.arrayContaining(['2001:db8::1']),
      }),
      expect.any(String),
      { allowSystem: true }
    );
    expect(certService.issueCertificate.mock.calls[0]?.[0].sans).not.toContain('[2001:db8::1]');
  });

  it('regenerates existing auto gRPC TLS material when configured SANs are missing', async () => {
    process.env.APP_URL = 'https://gateway.example.com';
    const { caPem, certPem, keyPem } = createCertificatePair();
    const replacement = createCertificatePair();
    const { certPath, keyPath } = writeTlsFiles(certPem, keyPem);
    const { service, certService } = createService(
      [[{ certificatePem: caPem }], [{ id: 'system-ca-id' }]],
      replacement
    );

    await expect(service.ensureGrpcServerCert(certPath, keyPath)).resolves.toEqual({ certPath, keyPath });
    expect(certService.issueCertificate).toHaveBeenCalledTimes(1);
  });

  it('regenerates when an expected IP address exists only as a DNS SAN', async () => {
    process.env.PUBLIC_IPV4 = '203.0.113.10';
    const { caPem, certPem, keyPem } = createCertificatePair({
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        { type: 2, value: '203.0.113.10' },
      ],
    });
    const replacement = createCertificatePair();
    const { certPath, keyPath } = writeTlsFiles(certPem, keyPem);
    const { service, certService } = createService(
      [[{ certificatePem: caPem }], [{ id: 'system-ca-id' }]],
      replacement
    );

    await expect(service.ensureGrpcServerCert(certPath, keyPath)).resolves.toEqual({ certPath, keyPath });
    expect(certService.issueCertificate).toHaveBeenCalledTimes(1);
  });

  it('regenerates when existing gRPC TLS material contains stale extra SANs', async () => {
    const { caPem, certPem, keyPem } = createCertificatePair({
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        { type: 2, value: 'old.example.com' },
      ],
    });
    const replacement = createCertificatePair();
    const { certPath, keyPath } = writeTlsFiles(certPem, keyPem);
    const { service, certService } = createService(
      [[{ certificatePem: caPem }], [{ id: 'system-ca-id' }]],
      replacement
    );

    await expect(service.ensureGrpcServerCert(certPath, keyPath)).resolves.toEqual({ certPath, keyPath });
    expect(certService.issueCertificate).toHaveBeenCalledTimes(1);
  });

  it('regenerates existing auto gRPC TLS material when it was issued by a different CA', async () => {
    const { certPem, keyPem } = createCertificatePair();
    const { caPem: currentCaPem } = createCertificatePair();
    const replacement = createCertificatePair();
    const { certPath, keyPath } = writeTlsFiles(certPem, keyPem);
    const { service, certService } = createService(
      [[{ certificatePem: currentCaPem }], [{ id: 'system-ca-id' }]],
      replacement
    );

    await expect(service.ensureGrpcServerCert(certPath, keyPath)).resolves.toEqual({ certPath, keyPath });
    expect(certService.issueCertificate).toHaveBeenCalledTimes(1);
  });

  it('regenerates existing auto gRPC TLS material when the key does not match', async () => {
    const { caPem, certPem } = createCertificatePair();
    const { keyPem: otherKeyPem } = createCertificatePair();
    const replacement = createCertificatePair();
    const { certPath, keyPath } = writeTlsFiles(certPem, otherKeyPem);
    const { service, certService } = createService(
      [[{ certificatePem: caPem }], [{ id: 'system-ca-id' }]],
      replacement
    );

    await expect(service.ensureGrpcServerCert(certPath, keyPath)).resolves.toEqual({ certPath, keyPath });
    expect(certService.issueCertificate).toHaveBeenCalledTimes(1);
  });

  it('regenerates existing auto gRPC TLS material when the certificate lacks serverAuth', async () => {
    const { caPem, certPem, keyPem } = createCertificatePair({ serverAuth: false, clientAuth: true });
    const replacement = createCertificatePair();
    const { certPath, keyPath } = writeTlsFiles(certPem, keyPem);
    const { service, certService } = createService(
      [[{ certificatePem: caPem }], [{ id: 'system-ca-id' }]],
      replacement
    );

    await expect(service.ensureGrpcServerCert(certPath, keyPath)).resolves.toEqual({ certPath, keyPath });
    expect(certService.issueCertificate).toHaveBeenCalledTimes(1);
  });

  it('binds reissued gateway listener material through the system lifecycle service', async () => {
    const replacement = createCertificatePair();
    const dir = mkdtempSync(join(tmpdir(), 'gateway-system-ca-test-'));
    tempDirs.push(dir);
    const certPath = join(dir, 'grpc-server.crt');
    const keyPath = join(dir, 'grpc-server.key');
    const { service, certService } = createService([[{ id: 'system-ca-id' }]], replacement);
    const issueCurrent = vi.fn(async (_input, _userId, _owner, bindCurrent) => {
      const issued = {
        certificate: { certificatePem: replacement.certPem, serialNumber: 'lifecycle-serial', notAfter: new Date() },
        privateKeyPem: replacement.keyPem,
      };
      await bindCurrent({}, { ...issued.certificate, privateKeyPem: issued.privateKeyPem });
      return issued;
    });
    service.setSystemCertificateLifecycleService({ issueCurrent } as any);

    await service.ensureGrpcServerCert(certPath, keyPath);

    expect(issueCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ caId: 'system-ca-id', commonName: 'gateway-grpc' }),
      expect.any(String),
      { type: 'gateway_listener', id: 'grpc' },
      expect.any(Function)
    );
    expect(readFileSync(certPath, 'utf8')).toBe(replacement.certPem);
    expect(readFileSync(keyPath, 'utf8')).toBe(replacement.keyPem);
    expect(certService.issueCertificate).not.toHaveBeenCalled();
  });

  it('refuses direct system-listener issuance when lifecycle ownership is unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-system-ca-test-'));
    tempDirs.push(dir);
    const service = new SystemCAService(
      createDb([[{ id: 'system-ca-id' }]]) as any,
      {} as any,
      { issueCertificate: vi.fn() } as any,
      {} as any
    );

    await expect(
      service.ensureGrpcServerCert(join(dir, 'grpc-server.crt'), join(dir, 'grpc-server.key'))
    ).rejects.toThrow('System certificate lifecycle service is required');
  });
});
