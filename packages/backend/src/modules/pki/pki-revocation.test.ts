import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/settings/environment-settings.service.js', () => ({
  getEnvironmentSettingsSnapshot: () => ({ pkiDefaults: { crlValidityHours: 24 } }),
}));

import { createFakeAdvisoryLockDb } from '@/db/advisory-lock.test-helpers.js';
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

type RevokedRow = { serialNumber: string; revokedAt: Date };

/**
 * In-memory CA row for CRL generation, behind fake transaction-scoped advisory
 * locks. `events` records transaction boundaries and cache writes in order.
 */
function crlStore(
  initial: { revoked?: RevokedRow[]; childCAs?: RevokedRow[] },
  options: { failStoringCrl?: boolean } = {}
) {
  const state = {
    crlNumber: 0,
    lastCrlDer: null as string | null,
    revoked: [...(initial.revoked ?? [])],
    childCAs: [...(initial.childCAs ?? [])],
  };
  const events: string[] = [];
  const findRevoked = vi.fn(async () => [...state.revoked]);
  const makeTx = () => {
    // Writes become visible at commit, as in Postgres.
    const pending: Array<() => void> = [];
    let numbered = state.crlNumber;
    const tx = {
      pending,
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            if ('lastCrlDer' in values) {
              if (options.failStoringCrl) return Promise.reject(new Error('database went away'));
              pending.push(() => {
                state.lastCrlDer = values.lastCrlDer as string;
              });
            }
            return Object.assign(Promise.resolve(undefined), {
              returning: async () => {
                numbered = state.crlNumber + 1;
                pending.push(() => {
                  state.crlNumber = numbered;
                });
                return [{ crlNumber: numbered, status: 'active', notAfter: new Date('2099-01-01T00:00:00Z') }];
              },
            });
          },
        }),
      })),
      query: {
        certificates: { findMany: findRevoked },
        certificateAuthorities: { findMany: vi.fn(async () => [...state.childCAs]) },
      },
    };
    return tx;
  };
  const locks = createFakeAdvisoryLockDb(makeTx);
  const db = {
    transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => {
      events.push('begin');
      try {
        const result = await locks.transaction(async (tx) => {
          const value = await fn(tx);
          for (const apply of tx.pending) apply();
          return value;
        });
        events.push('commit');
        return result;
      } catch (error) {
        events.push('rollback');
        throw error;
      }
    }),
    // Re-read of the stored CRL after the cache write.
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ lastCrlDer: state.lastCrlDer }] }) }),
    })),
  };
  const cached = new Map<string, string>();
  const cache = {
    get: vi.fn(async (key: string) => cached.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      events.push('cache');
      cached.set(key, value);
    }),
    delete: vi.fn(async (key: string) => void cached.delete(key)),
  };
  return { state, events, findRevoked, locks, db, cache, cached };
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
    const store = crlStore({
      revoked: [{ serialNumber: '0a01', revokedAt: new Date() }],
      childCAs: [{ serialNumber: '0b02', revokedAt: new Date() }],
    });
    const cache = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
    const crlService = new CRLService(store.db as never, caService, cache as never);

    const der = await crlService.generateCRL('root-1');

    expect(signing).toHaveBeenCalledWith('root-1', undefined);
    const serials = new x509.X509Crl(der).entries.map((entry) => entry.serialNumber.toLowerCase());
    expect(serials).toEqual(expect.arrayContaining(['0a01', '0b02']));
    expect(store.state.lastCrlDer).toBe(der.toString('base64'));
    expect(store.state.crlNumber).toBe(1);
    expect(store.locks.acquired).toEqual(['pki-crl:root-1']);
  });

  // Regression (rc10 audit F1): a slower generation that read the revoked set
  // before a second revocation overwrote the newer CRL, and both used one number.
  it('serializes concurrent CRL generations so the published CRL lists every revocation', async () => {
    const { row, privateKeyPem } = await createRoot();
    const caService = new CAService({} as never, cryptoService, audit as never);
    vi.spyOn(caService, 'getCASigningMaterials').mockResolvedValue({ ca: row, privateKeyPem });
    const store = crlStore({ revoked: [{ serialNumber: '0a01', revokedAt: new Date() }] });
    let firstReadStarted!: () => void;
    const firstReading = new Promise<void>((resolve) => {
      firstReadStarted = resolve;
    });
    let releaseFirstRead!: () => void;
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let reads = 0;
    store.findRevoked.mockImplementation(async () => {
      const snapshot = [...store.state.revoked];
      reads += 1;
      if (reads === 1) {
        firstReadStarted();
        await firstReadGate;
      }
      return snapshot;
    });
    const crlService = new CRLService(store.db as never, caService, store.cache as never);

    const first = crlService.generateCRL('root-1');
    await firstReading;
    // A second certificate is revoked and republishes while the first
    // generation still holds its revoked set: it must not reuse that CRL.
    store.state.revoked.push({ serialNumber: '0b02', revokedAt: new Date() });
    const second = crlService.generateCRL('root-1');

    releaseFirstRead();
    const [firstCrl, secondCrl] = await Promise.all([first, second]);

    const serials = (der: Buffer) => new x509.X509Crl(der).entries.map((entry) => entry.serialNumber.toLowerCase());
    expect(serials(firstCrl)).toEqual(['0a01']);
    expect(serials(secondCrl).sort()).toEqual(['0a01', '0b02']);
    expect(store.state.crlNumber).toBe(2);
    expect(store.state.lastCrlDer).toBe(secondCrl.toString('base64'));
    expect(store.cached.get('crl:root-1')).toBe(secondCrl.toString('base64'));
    // The second waited in process, without a transaction, and cached after its commit.
    expect(store.events).toEqual(['begin', 'commit', 'cache', 'begin', 'commit', 'cache']);
  });

  // Review follow-up: a burst of public cache misses each held a pool
  // connection at the lock, then re-signed and bumped the CRL number.
  it('signs once for a burst of concurrent requests and hands the others that CRL', async () => {
    const { row, privateKeyPem } = await createRoot();
    const caService = new CAService({} as never, cryptoService, audit as never);
    vi.spyOn(caService, 'getCASigningMaterials').mockResolvedValue({ ca: row, privateKeyPem });
    const store = crlStore({ revoked: [{ serialNumber: '0a01', revokedAt: new Date() }] });
    const crlService = new CRLService(store.db as never, caService, store.cache as never);

    const crls = await Promise.all([
      crlService.generateCRL('root-1'),
      crlService.generateCRL('root-1'),
      crlService.generateCRL('root-1'),
    ]);

    expect(crls[1]).toBe(crls[0]);
    expect(crls[2]).toBe(crls[0]);
    expect(store.db.transaction).toHaveBeenCalledTimes(1);
    expect(store.findRevoked).toHaveBeenCalledTimes(1);
    expect(store.state.crlNumber).toBe(1);

    // A later call started after that snapshot, so it signs a fresh CRL.
    await crlService.generateCRL('root-1');
    expect(store.state.crlNumber).toBe(2);
  });

  it('never caches a CRL whose transaction rolled back', async () => {
    const { row, privateKeyPem } = await createRoot();
    const caService = new CAService({} as never, cryptoService, audit as never);
    vi.spyOn(caService, 'getCASigningMaterials').mockResolvedValue({ ca: row, privateKeyPem });
    const store = crlStore({ revoked: [{ serialNumber: '0a01', revokedAt: new Date() }] }, { failStoringCrl: true });
    const crlService = new CRLService(store.db as never, caService, store.cache as never);

    await expect(crlService.generateCRL('root-1')).rejects.toThrow('database went away');

    expect(store.cache.set).not.toHaveBeenCalled();
    expect(store.events).toEqual(['begin', 'rollback']);
    expect(store.state.crlNumber).toBe(0);
  });

  it('caches the stored CRL when another process committed a newer one meanwhile', async () => {
    const { row, privateKeyPem } = await createRoot();
    const caService = new CAService({} as never, cryptoService, audit as never);
    vi.spyOn(caService, 'getCASigningMaterials').mockResolvedValue({ ca: row, privateKeyPem });
    const store = crlStore({});
    const crlService = new CRLService(store.db as never, caService, store.cache as never);
    store.cache.set.mockImplementationOnce(async (key: string, value: string) => {
      store.cached.set(key, value);
      store.state.lastCrlDer = 'newer-crl-from-another-process';
    });

    await crlService.generateCRL('root-1');

    expect(store.cached.get('crl:root-1')).toBe('newer-crl-from-another-process');
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
