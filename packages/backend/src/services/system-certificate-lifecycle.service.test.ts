import { describe, expect, it, vi } from 'vitest';
import { certificates } from '@/db/schema/index.js';
import { SystemCertificateLifecycleService } from './system-certificate-lifecycle.service.js';

describe('SystemCertificateLifecycleService private-key cleanup', () => {
  it('only clears encrypted key fields and never deletes certificate or CA records', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'retired-cert' }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const auditValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn(() => ({ values: auditValues }));
    const remove = vi.fn();
    const tx = { update, insert };
    const db = {
      delete: remove,
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn() })) })),
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    const service = new SystemCertificateLifecycleService(db as any, {} as any, {} as any);

    await expect(service.destroyRetiredPrivateKeys(30)).resolves.toBe(1);

    expect(update).toHaveBeenCalledWith(certificates);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedPrivateKey: null,
        encryptedDek: null,
        dekIv: null,
        privateKeyDestroyedAt: expect.any(Date),
      })
    );
    expect(remove).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalled();
    expect(auditValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ action: 'certificate.system_private_key.destroy', resourceId: 'retired-cert' }),
      ])
    );
  });
});

describe('SystemCertificateLifecycleService lifecycle binding', () => {
  it('runs a binding compensation when promotion transaction aborts after material installation', async () => {
    const rollback = vi.fn();
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
        })),
      })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ isSystem: true }]) })),
        })),
      })),
      transaction: vi.fn(async (callback) => {
        await callback(tx);
        throw new Error('transaction commit failed');
      }),
    };
    const certService = {
      issueCertificate: vi.fn().mockResolvedValue({
        certificate: {
          id: 'new-cert',
          serialNumber: 'serial',
          notAfter: new Date(),
          certificatePem: 'certificate',
        },
        privateKeyPem: 'private-key',
      }),
    };
    const service = new SystemCertificateLifecycleService(db as any, certService as any, {} as any);

    await expect(
      service.issueCurrent(
        {
          caId: 'system-ca',
          type: 'tls-server',
          commonName: 'gateway',
          sans: [],
          keyAlgorithm: 'ecdsa-p256',
          validityDays: 1,
        },
        'system-user',
        { type: 'gateway_listener', id: 'grpc' },
        async () => ({ onRollback: rollback })
      )
    ).rejects.toThrow('transaction commit failed');

    expect(rollback).toHaveBeenCalledOnce();
  });
});

describe('SystemCertificateLifecycleService CRL retry', () => {
  it('retries persisted system-CA CRL work and clears the marker only after success', async () => {
    const where = vi.fn().mockResolvedValue([{ id: 'system-ca-id' }]);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    };
    const generateCRL = vi.fn().mockResolvedValue(undefined);
    const service = new SystemCertificateLifecycleService(db as any, {} as any, { generateCRL } as any);

    await expect(service.retryPendingCRLs()).resolves.toBe(1);

    expect(generateCRL).toHaveBeenCalledWith('system-ca-id', { allowSystem: true });
  });

  it('does not clear or replace the transactionally persisted retry marker after publication fails', async () => {
    const db = { update: vi.fn() };
    const service = new SystemCertificateLifecycleService(
      db as any,
      {} as any,
      { generateCRL: vi.fn().mockRejectedValue(new Error('temporary CRL outage')) } as any
    );

    await expect((service as any).refreshCRL('system-ca-id')).resolves.toBeUndefined();

    expect(db.update).not.toHaveBeenCalled();
  });
});

describe('SystemCertificateLifecycleService staged (pending) leaves', () => {
  const input = {
    caId: 'system-ca',
    type: 'tls-client' as const,
    commonName: 'node-1',
    sans: ['node-1'],
    keyAlgorithm: 'ecdsa-p256' as const,
    validityDays: 365,
  };

  function makeDb(options: { reusable?: any[]; txSelects?: any[][] }) {
    const sets: any[] = [];
    const txSelects = [...(options.txSelects ?? [])];
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const rows = txSelects.shift() ?? [];
            return Object.assign(Promise.resolve(rows), { limit: vi.fn().mockResolvedValue(rows) });
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((value: unknown) => {
          sets.push(value);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([{ isSystem: true }]),
            orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(options.reusable ?? []) })),
          })),
        })),
      })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    return { db, tx, sets };
  }

  it('stages a new leaf as pending without retiring the current one', async () => {
    const { db, sets } = makeDb({ txSelects: [[]] });
    const certService = {
      issueCertificate: vi.fn().mockResolvedValue({
        certificate: { id: 'new-cert', serialNumber: 'bb02', notAfter: new Date(), certificatePem: 'pem' },
        privateKeyPem: 'key',
      }),
    };
    const bind = vi.fn(async () => undefined);
    const service = new SystemCertificateLifecycleService(db as any, certService as any, {} as any);

    const issued = await service.issuePending(input, 'system-user', { type: 'node', id: 'node-1' }, bind);

    expect(issued.certificate.id).toBe('new-cert');
    expect(bind).toHaveBeenCalledOnce();
    expect(sets).toContainEqual(expect.objectContaining({ systemLifecycleState: 'pending' }));
    expect(sets).not.toContainEqual(expect.objectContaining({ status: 'revoked' }));
  });

  it('returns the same staged leaf again instead of issuing another one', async () => {
    const pending = {
      id: 'pending-cert',
      serialNumber: 'bb02',
      certificatePem: 'pem',
      notAfter: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000),
      status: 'active',
    };
    const { db } = makeDb({ reusable: [pending] });
    const certService = {
      issueCertificate: vi.fn(),
      getCertificatePrivateKey: vi.fn().mockResolvedValue('same-key'),
    };
    const bind = vi.fn(async () => undefined);
    const service = new SystemCertificateLifecycleService(db as any, certService as any, {} as any);

    const issued = await service.issuePending(input, 'system-user', { type: 'node', id: 'node-1' }, bind);

    expect(certService.issueCertificate).not.toHaveBeenCalled();
    expect(issued.certificate.id).toBe('pending-cert');
    expect(issued.privateKeyPem).toBe('same-key');
    expect(bind).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ serialNumber: 'bb02' }));
  });

  it('promotes the staged leaf and only then revokes the previous current leaf', async () => {
    const pending = {
      id: 'pending-cert',
      caId: 'system-ca',
      serialNumber: 'bb02',
      notAfter: new Date(),
      certificatePem: 'pem',
    };
    const { db, sets } = makeDb({ txSelects: [[pending], [{ id: 'current-cert', caId: 'system-ca' }]] });
    const generateCRL = vi.fn().mockResolvedValue(undefined);
    const bind = vi.fn(async () => undefined);
    const service = new SystemCertificateLifecycleService(db as any, {} as any, { generateCRL } as any);

    await expect(service.promotePending({ type: 'node', id: 'node-1' }, 'bb02', bind)).resolves.toBe(true);

    expect(sets).toContainEqual(
      expect.objectContaining({ status: 'revoked', revocationReason: 'superseded', systemLifecycleState: 'superseded' })
    );
    expect(sets).toContainEqual(expect.objectContaining({ systemLifecycleState: 'current' }));
    expect(bind).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'pending-cert' }));
    expect(generateCRL).toHaveBeenCalledWith('system-ca', { allowSystem: true });
  });

  it('does not touch certificates when no staged leaf matches the serial', async () => {
    const { db, sets } = makeDb({ txSelects: [[]] });
    const bind = vi.fn(async () => undefined);
    const service = new SystemCertificateLifecycleService(db as any, {} as any, { generateCRL: vi.fn() } as any);

    await expect(service.promotePending({ type: 'node', id: 'node-1' }, 'bb02', bind)).resolves.toBe(false);

    expect(sets).toEqual([]);
    expect(bind).toHaveBeenCalledWith(expect.anything(), null);
  });
});
