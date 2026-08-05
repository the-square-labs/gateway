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
