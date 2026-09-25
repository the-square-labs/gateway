import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { x509 } from '@/lib/x509.js';
import { CryptoService } from '@/services/crypto.service.js';
import { CAService } from './ca.service.js';
import { IssueCertFromCSRSchema, IssueCertificateSchema } from './cert.schemas.js';
import { CertService, resolveLeafNotAfter } from './cert.service.js';

const cryptoService = new CryptoService('ab'.repeat(32));
const audit = { log: vi.fn().mockResolvedValue(true) };

async function signingCA(overrides: { notAfter: Date; isSystem: boolean }) {
  let inserted: Record<string, unknown> = {};
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        inserted = { id: 'root-1', type: 'root', status: 'active', crlNumber: 0, ...values };
        return { returning: vi.fn().mockResolvedValue([inserted]) };
      }),
    })),
  };
  const caService = new CAService(db as never, cryptoService, audit as never);
  await caService.createRootCA(
    { commonName: 'Clamp Root', keyAlgorithm: 'ecdsa-p256', validityYears: 5, maxValidityDays: 3650 } as never,
    'user-1'
  );
  const privateKeyPem = cryptoService.decryptPrivateKey({
    encryptedPrivateKey: inserted.encryptedPrivateKey as string,
    encryptedDek: inserted.encryptedDek as string,
    dekIv: inserted.dekIv as string,
  });
  vi.spyOn(caService, 'getCASigningMaterials').mockResolvedValue({
    ca: { ...(inserted as any), ...overrides },
    privateKeyPem,
  });
  const values = vi.fn((row: Record<string, unknown>) => ({
    returning: vi.fn().mockResolvedValue([{ id: 'cert-1', ...row }]),
  }));
  const certService = new CertService(
    { insert: vi.fn(() => ({ values })) } as never,
    cryptoService,
    caService,
    audit as never
  );
  return { certService, values };
}

const leafInput = {
  caId: '11111111-1111-4111-8111-111111111111',
  type: 'tls-server' as const,
  commonName: 'node.test',
  sans: ['node.test'],
  keyAlgorithm: 'ecdsa-p256' as const,
  validityDays: 365,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date('2035-01-01T00:00:00.000Z');

describe('resolveLeafNotAfter', () => {
  it('keeps a leaf that ends before its CA', () => {
    const requested = new Date(now.getTime() + 365 * DAY_MS);
    const ca = { notAfter: new Date(now.getTime() + 400 * DAY_MS), isSystem: false };
    expect(resolveLeafNotAfter(requested, ca, false, now)).toEqual({ notAfter: requested, clamped: false });
  });

  it('refuses a user leaf that outlives its CA unless clamping was requested', () => {
    const requested = new Date(now.getTime() + 365 * DAY_MS);
    const ca = { notAfter: new Date(now.getTime() + 100 * DAY_MS), isSystem: false };
    expect(() => resolveLeafNotAfter(requested, ca, false, now)).toThrow(
      expect.objectContaining({ code: 'VALIDITY_EXCEEDS_CA' })
    );
    expect(resolveLeafNotAfter(requested, ca, true, now)).toEqual({ notAfter: ca.notAfter, clamped: true });
  });

  it('always clamps system leaves so renewals keep working through the CA final year', () => {
    const requested = new Date(now.getTime() + 365 * DAY_MS);
    const ca = { notAfter: new Date(now.getTime() + 200 * DAY_MS), isSystem: true };
    const result = resolveLeafNotAfter(requested, ca, false, now);
    expect(result.clamped).toBe(true);
    expect(result.notAfter.getTime()).toBe(ca.notAfter.getTime());
  });

  it('refuses to clamp to a CA that ends within the hour', () => {
    const requested = new Date(now.getTime() + 365 * DAY_MS);
    const ca = { notAfter: new Date(now.getTime() + 10 * 60 * 1000), isSystem: true };
    expect(() => resolveLeafNotAfter(requested, ca, true, now)).toThrow(
      expect.objectContaining({ code: 'CA_EXPIRING' })
    );
  });

  it('accepts the clamp option on both issue schemas', () => {
    const caId = '00000000-0000-4000-8000-000000000001';
    expect(
      IssueCertificateSchema.parse({
        caId,
        type: 'tls-server',
        commonName: 'api.example.com',
        keyAlgorithm: 'ecdsa-p256',
        validityDays: 365,
        clampToCaValidity: true,
      }).clampToCaValidity
    ).toBe(true);
    expect(
      IssueCertFromCSRSchema.parse({
        caId,
        type: 'tls-server',
        csrPem: 'csr',
        validityDays: 365,
        clampToCaValidity: true,
      }).clampToCaValidity
    ).toBe(true);
  });
});

describe('CertService leaf validity near the CA end', () => {
  it('issues a system leaf that ends with the CA instead of failing', async () => {
    const caEnd = new Date(Date.now() + 100 * DAY_MS);
    const { certService } = await signingCA({ notAfter: caEnd, isSystem: true });

    const issued = await certService.issueCertificate(leafInput, 'system', { allowSystem: true });

    expect(issued.certificate.notAfter.getTime()).toBe(caEnd.getTime());
    const parsed = new x509.X509Certificate(issued.certificate.certificatePem);
    expect(Math.abs(parsed.notAfter.getTime() - caEnd.getTime())).toBeLessThan(1000);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ clampedToCaValidity: true }) })
    );
  });

  it('still refuses a user leaf past the CA end unless the caller asks to clamp', async () => {
    const caEnd = new Date(Date.now() + 100 * DAY_MS);
    const { certService } = await signingCA({ notAfter: caEnd, isSystem: false });

    await expect(certService.issueCertificate(leafInput, 'user-1')).rejects.toMatchObject({
      code: 'VALIDITY_EXCEEDS_CA',
    });
    const clamped = await certService.issueCertificate({ ...leafInput, clampToCaValidity: true }, 'user-1');
    expect(clamped.certificate.notAfter.getTime()).toBe(caEnd.getTime());
  });
});
