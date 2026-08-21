import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { beforeAll, describe, expect, it } from 'vitest';
import { CryptoService } from '@/services/crypto.service.js';
import { ExportService } from './export.service.js';

async function createEcdsaCertificatePair() {
  const now = Date.now();
  const signingAlgorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = await webcrypto.subtle.generateKey(signingAlgorithm, true, ['sign', 'verify']);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=ecdsa-export-test',
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    keys,
    signingAlgorithm,
  });
  const privateKey = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  return {
    certificatePem: certificate.toString('pem'),
    privateKeyPem: x509.PemConverter.encode(privateKey, 'PRIVATE KEY'),
  };
}

function zipEntryNames(zip: Buffer): string[] {
  const endOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(endOffset).toBeGreaterThanOrEqual(0);
  const count = zip.readUInt16LE(endOffset + 10);
  let offset = zip.readUInt32LE(endOffset + 16);
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

describe('ExportService', () => {
  let exportService: ExportService;
  let cryptoService: CryptoService;

  beforeAll(() => {
    cryptoService = new CryptoService('a'.repeat(64));
    exportService = new ExportService(cryptoService);
  });

  describe('exportPEM', () => {
    it('should return trimmed PEM certificate', () => {
      const certPem = '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----\n';
      const result = exportService.exportPEM(certPem);
      expect(result).toBe(certPem.trim());
    });

    it('should concatenate chain PEMs', () => {
      const certPem = '-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----';
      const chain = [
        '-----BEGIN CERTIFICATE-----\nintermediate\n-----END CERTIFICATE-----',
        '-----BEGIN CERTIFICATE-----\nroot\n-----END CERTIFICATE-----',
      ];

      const result = exportService.exportPEM(certPem, chain);
      expect(result).toContain('leaf');
      expect(result).toContain('intermediate');
      expect(result).toContain('root');
      // Verify order: leaf first, then chain
      const leafIdx = result.indexOf('leaf');
      const intIdx = result.indexOf('intermediate');
      const rootIdx = result.indexOf('root');
      expect(leafIdx).toBeLessThan(intIdx);
      expect(intIdx).toBeLessThan(rootIdx);
    });
  });

  describe('exportDER', () => {
    it('should convert PEM to DER Buffer', () => {
      // Simple base64 content
      const base64Content = Buffer.from('test certificate binary data').toString('base64');
      const certPem = `-----BEGIN CERTIFICATE-----\n${base64Content}\n-----END CERTIFICATE-----`;

      const der = exportService.exportDER(certPem);
      expect(Buffer.isBuffer(der)).toBe(true);
      expect(der.length).toBeGreaterThan(0);

      // Verify DER content matches the base64
      expect(der.toString()).toBe('test certificate binary data');
    });

    it('should handle multi-line PEM', () => {
      const data = 'A'.repeat(100);
      const base64 = Buffer.from(data).toString('base64');
      // Split into 64-char lines like real PEM
      const lines = base64.match(/.{1,64}/g)?.join('\n') || base64;
      const certPem = `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----`;

      const der = exportService.exportDER(certPem);
      expect(der.toString()).toBe(data);
    });
  });

  describe('exportPEMBundle', () => {
    it('contains the required PEM files and skips chain.pem when no intermediate exists', () => {
      const archive = exportService.exportPEMBundle({
        certificatePem: '-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----',
        privateKeyPem: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
        chainPems: [],
      });

      expect(zipEntryNames(archive)).toEqual(['certificate.pem', 'private-key.pem', 'fullchain.pem']);
    });

    it('includes an intermediate-only chain and leaf-first fullchain', () => {
      const archive = exportService.exportPEMBundle({
        certificatePem: '-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----',
        privateKeyPem: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
        chainPems: ['-----BEGIN CERTIFICATE-----\nintermediate\n-----END CERTIFICATE-----'],
      });

      expect(zipEntryNames(archive)).toEqual(['certificate.pem', 'private-key.pem', 'chain.pem', 'fullchain.pem']);
      expect(archive.toString('utf8')).toContain(
        'leaf\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nintermediate'
      );
    });
  });

  describe('exportPKCS12', () => {
    it('exports an ECDSA certificate and private key', async () => {
      const { certificatePem, privateKeyPem } = await createEcdsaCertificatePair();

      const archive = await exportService.exportPKCS12(certificatePem, privateKeyPem, 'test-passphrase', [
        certificatePem,
      ]);

      expect(archive.subarray(0, 2).toString('hex')).toBe('3082');
      expect(archive.length).toBeGreaterThan(512);
    });
  });
});
