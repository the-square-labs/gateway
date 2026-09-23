import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/settings/environment-settings.service.js', () => ({
  getEnvironmentSettingsSnapshot: () => ({ pkiDefaults: { crlValidityHours: 24 } }),
}));

import { x509 } from '@/lib/x509.js';
import { CryptoService } from '@/services/crypto.service.js';
import { CAService } from './ca.service.js';
import { CertService } from './cert.service.js';
import { CRLService } from './crl.service.js';

const cryptoService = new CryptoService('ab'.repeat(32));
const audit = { log: vi.fn().mockResolvedValue(true) };

function updateChain() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where, returning: vi.fn() }));
  return { update: vi.fn(() => ({ set })), set };
}

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where']) chain[method] = vi.fn(() => chain);
  chain.limit = vi.fn().mockResolvedValue(rows);
  return vi.fn(() => chain);
}

async function createRoot() {
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
  const created = await caService.createRootCA(
    { commonName: 'Test Root', keyAlgorithm: 'ecdsa-p256', validityYears: 5, maxValidityDays: 365 } as never,
    'user-1'
  );
  const privateKeyPem = cryptoService.decryptPrivateKey({
    encryptedPrivateKey: inserted.encryptedPrivateKey as string,
    encryptedDek: inserted.encryptedDek as string,
    dekIv: inserted.dekIv as string,
  });
  return { created, row: inserted as any, privateKeyPem };
}

describe('PKI key material is never returned', () => {
  it('returns a created CA without its encrypted key', async () => {
    const { created, row } = await createRoot();

    expect(row.encryptedPrivateKey).toEqual(expect.any(String));
    expect(created).toMatchObject({ id: 'root-1', certificatePem: row.certificatePem });
    expect(created).not.toHaveProperty('encryptedPrivateKey');
    expect(created).not.toHaveProperty('encryptedDek');
    expect(created).not.toHaveProperty('dekIv');
    expect(JSON.parse(JSON.stringify(created))).not.toHaveProperty('encryptedPrivateKey');
  });

  it('returns an issued certificate without its encrypted key', async () => {
    const { row, privateKeyPem } = await createRoot();
    const caService = new CAService({} as never, cryptoService, audit as never);
    vi.spyOn(caService, 'getCASigningMaterials').mockResolvedValue({ ca: row, privateKeyPem });
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => ({
          returning: vi.fn().mockResolvedValue([{ id: 'cert-1', ...values }]),
        })),
      })),
    };
    const certService = new CertService(db as never, cryptoService, caService, audit as never);

    const issued = await certService.issueCertificate(
      {
        caId: '11111111-1111-4111-8111-111111111111',
        type: 'tls-server',
        commonName: 'app.test',
        sans: ['app.test'],
        keyAlgorithm: 'ecdsa-p256',
        validityDays: 30,
      },
      'user-1'
    );

    expect(issued.privateKeyPem).toContain('PRIVATE KEY');
    expect(issued.certificate.id).toBe('cert-1');
    expect(issued.certificate).not.toHaveProperty('encryptedPrivateKey');
    expect(issued.certificate).not.toHaveProperty('encryptedDek');
  });
});

describe('CRL publication on revocation', () => {
  it('lists revoked child CAs in the parent CRL and stores the published CRL', async () => {
    const { row, privateKeyPem } = await createRoot();
    const caService = new CAService({} as never, cryptoService, audit as never);
    const signing = vi.spyOn(caService, 'getCASigningMaterials').mockResolvedValue({ ca: row, privateKeyPem });
    const { update, set } = updateChain();
    const db = {
      query: {
        certificates: {
          findMany: vi.fn().mockResolvedValue([{ serialNumber: '0a01', revokedAt: new Date() }]),
        },
        certificateAuthorities: {
          findMany: vi.fn().mockResolvedValue([{ serialNumber: '0b02', revokedAt: new Date() }]),
        },
      },
      update,
    };
    const cache = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
    const crlService = new CRLService(db as never, caService, cache as never);

    const der = await crlService.generateCRL('root-1');

    expect(signing).toHaveBeenCalledWith('root-1', undefined);
    const serials = new x509.X509Crl(der).entries.map((entry) => entry.serialNumber.toLowerCase());
    expect(serials).toEqual(expect.arrayContaining(['0a01', '0b02']));
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ lastCrlDer: der.toString('base64') }));
  });

  it('keeps serving a revoked CA its final CRL instead of failing', async () => {
    const stored = Buffer.from('final-crl').toString('base64');
    const caService = new CAService({} as never, cryptoService, audit as never);
    const signing = vi.spyOn(caService, 'getCASigningMaterials');
    const db = {
      query: {
        certificateAuthorities: {
          findFirst: vi.fn().mockResolvedValue({ id: 'int-1', status: 'revoked', lastCrlDer: stored }),
        },
      },
    };
    const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() };
    const crlService = new CRLService(db as never, caService, cache as never);

    await expect(crlService.getCRL('int-1')).resolves.toEqual(Buffer.from('final-crl'));
    expect(signing).not.toHaveBeenCalled();
  });

  // Regression: a system CA's CRL was served from the cache an internal refresh
  // wrote, then failed with 500 (SYSTEM_CA) once that entry expired.
  it.each([
    ['cached', Buffer.from('system-crl').toString('base64')],
    ['expired from the cache', null],
  ])('reports a system CA as not found whether its CRL is %s', async (_label, cached) => {
    const caService = new CAService({} as never, cryptoService, audit as never);
    const signing = vi.spyOn(caService, 'getCASigningMaterials');
    const db = {
      query: {
        certificateAuthorities: {
          findFirst: vi.fn().mockResolvedValue({ id: 'sys-1', status: 'active', lastCrlDer: null, isSystem: true }),
        },
      },
    };
    const cache = { get: vi.fn().mockResolvedValue(cached), set: vi.fn(), delete: vi.fn() };
    const crlService = new CRLService(db as never, caService, cache as never);

    await expect(crlService.getCRL('sys-1')).rejects.toMatchObject({ statusCode: 404, code: 'CA_NOT_FOUND' });
    expect(signing).not.toHaveBeenCalled();
  });

  it('serves a cached CRL for a user CA without signing again', async () => {
    const caService = new CAService({} as never, cryptoService, audit as never);
    const signing = vi.spyOn(caService, 'getCASigningMaterials');
    const db = {
      query: {
        certificateAuthorities: {
          findFirst: vi.fn().mockResolvedValue({ id: 'root-1', status: 'active', lastCrlDer: null, isSystem: false }),
        },
      },
    };
    const cache = {
      get: vi.fn().mockResolvedValue(Buffer.from('cached-crl').toString('base64')),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const crlService = new CRLService(db as never, caService, cache as never);

    await expect(crlService.getCRL('root-1')).resolves.toEqual(Buffer.from('cached-crl'));
    expect(signing).not.toHaveBeenCalled();
  });

  // Regression: when publishing at revocation failed, the stored pre-revocation CRL was served forever.
  it('regenerates a revoked CA CRL stored before the revocation, bypassing the cache', async () => {
    const caService = new CAService({} as never, cryptoService, audit as never);
    const db = {
      query: {
        certificateAuthorities: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'int-1',
            status: 'revoked',
            lastCrlDer: Buffer.from('pre-revocation').toString('base64'),
            lastCrlAt: new Date('2026-09-01T00:00:00Z'),
            revokedAt: new Date('2026-09-10T00:00:00Z'),
          }),
        },
      },
    };
    const cache = {
      get: vi.fn().mockResolvedValue(Buffer.from('pre-revocation').toString('base64')),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const crlService = new CRLService(db as never, caService, cache as never);
    const generate = vi.spyOn(crlService, 'generateCRL').mockResolvedValue(Buffer.from('final-crl'));

    await expect(crlService.getCRL('int-1')).resolves.toEqual(Buffer.from('final-crl'));
    expect(generate).toHaveBeenCalledWith('int-1', { allowInactive: true });
  });

  it('serves a revoked CA CRL published after the revocation', async () => {
    const caService = new CAService({} as never, cryptoService, audit as never);
    const db = {
      query: {
        certificateAuthorities: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'int-1',
            status: 'revoked',
            lastCrlDer: Buffer.from('final-crl').toString('base64'),
            lastCrlAt: new Date('2026-09-10T00:00:01Z'),
            revokedAt: new Date('2026-09-10T00:00:00Z'),
          }),
        },
      },
    };
    const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() };
    const crlService = new CRLService(db as never, caService, cache as never);
    const generate = vi.spyOn(crlService, 'generateCRL');

    await expect(crlService.getCRL('int-1')).resolves.toEqual(Buffer.from('final-crl'));
    expect(generate).not.toHaveBeenCalled();
  });

  it('publishes a final CRL for a revoked CA that has none stored yet', async () => {
    const caService = new CAService({} as never, cryptoService, audit as never);
    const db = {
      query: {
        certificateAuthorities: {
          findFirst: vi.fn().mockResolvedValue({ id: 'int-1', status: 'revoked', lastCrlDer: null }),
        },
      },
    };
    const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() };
    const crlService = new CRLService(db as never, caService, cache as never);
    const generate = vi.spyOn(crlService, 'generateCRL').mockResolvedValue(Buffer.from('crl'));

    await crlService.getCRL('int-1');

    expect(generate).toHaveBeenCalledWith('int-1', { allowInactive: true });
  });

  it('publishes the revoked CA final CRL and regenerates the parent CRL', async () => {
    const { update, set } = updateChain();
    const db = {
      query: {
        certificateAuthorities: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'int-1',
            parentId: 'root-1',
            type: 'intermediate',
            status: 'active',
            isSystem: false,
          }),
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
      update,
    };
    const caService = new CAService(db as never, cryptoService, audit as never);
    const publisher = { generateCRL: vi.fn().mockResolvedValue(Buffer.alloc(0)), invalidateCache: vi.fn() };
    caService.setCrlPublisher(publisher);

    await caService.revokeCA('int-1', 'keyCompromise', 'user-1');

    expect(publisher.generateCRL).toHaveBeenNthCalledWith(1, 'int-1', { allowInactive: true });
    expect(publisher.generateCRL).toHaveBeenNthCalledWith(2, 'root-1', undefined);
    expect(set.mock.invocationCallOrder[0]).toBeLessThan(publisher.generateCRL.mock.invocationCallOrder[0]!);
  });

  it('attaches itself to CAService so every revocation republishes', () => {
    const caService = new CAService({} as never, cryptoService, audit as never);
    const attach = vi.spyOn(caService, 'setCrlPublisher');

    const crlService = new CRLService({} as never, caService, {} as never);

    expect(attach).toHaveBeenCalledWith(crlService);
  });

  it('regenerates the CRL when a certificate is revoked through CertService (AI/MCP included)', async () => {
    const { update } = updateChain();
    const db = {
      query: {
        certificates: { findFirst: vi.fn().mockResolvedValue({ id: 'cert-1', caId: 'ca-1', status: 'active' }) },
      },
      select: selectChain([{ isSystem: false }]),
      update,
    };
    const caService = { publishCRL: vi.fn().mockResolvedValue(true) };
    const certService = new CertService(db as never, cryptoService, caService as never, audit as never);

    await expect(certService.revokeCertificate('cert-1', 'keyCompromise', 'user-1')).resolves.toBe('ca-1');
    expect(caService.publishCRL).toHaveBeenCalledWith('ca-1');
  });
});
