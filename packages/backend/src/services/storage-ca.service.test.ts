import { describe, expect, it, vi } from 'vitest';
import type { CAService } from '@/modules/pki/ca.service.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import { StorageCAService } from './storage-ca.service.js';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

function createDb(selectResults: unknown[][]) {
  const limit = vi.fn();
  for (const result of selectResults) {
    limit.mockResolvedValueOnce(result);
  }
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const updateWhere = vi.fn(() => Promise.resolve());
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  return { select: vi.fn(() => ({ from })), update, updateSet, updateWhere };
}

function createCertService(overrides: { privateKeyPem?: string | undefined } = {}) {
  const privateKeyPem = 'privateKeyPem' in overrides ? overrides.privateKeyPem : 'DECRYPTED_PRIVATE_KEY_PEM';
  return {
    issueCertificate: vi.fn(async (_input: { sans: string[] }) => ({
      certificate: { id: 'cert-1' },
      privateKeyPem: 'ISSUED_PRIVATE_KEY_PEM',
    })),
    getCertificatePrivateKey: vi.fn(async () => privateKeyPem),
  };
}

describe('StorageCAService', () => {
  describe('getStorageCA', () => {
    it('throws when no storage CA exists', async () => {
      const db = createDb([[]]);
      const service = new StorageCAService(db as never, {} as CAService, {} as CertService);
      await expect(service.getStorageCA()).rejects.toThrow();
    });

    it('returns the existing storage CA', async () => {
      const db = createDb([[{ id: 'ca-storage-1', certificatePem: 'CA_PEM' }]]);
      const service = new StorageCAService(db as never, {} as CAService, {} as CertService);
      const ca = await service.getStorageCA();
      expect(ca).toEqual({ id: 'ca-storage-1', certificatePem: 'CA_PEM' });
    });
  });

  describe('ensureStorageCA', () => {
    it('returns the existing CA id without creating a new one', async () => {
      const db = createDb([[{ id: 'ca-storage-1' }]]);
      const caService = { createRootCA: vi.fn() };
      const service = new StorageCAService(db as never, caService as unknown as CAService, {} as CertService);
      const id = await service.ensureStorageCA();
      expect(id).toBe('ca-storage-1');
      expect(caService.createRootCA).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('creates a new root CA with the expected options when none exists', async () => {
      const db = createDb([[]]);
      const caService = {
        createRootCA: vi.fn(async () => ({ id: 'new-ca-id', certificatePem: 'NEW_CA_PEM' })),
      };
      const service = new StorageCAService(db as never, caService as unknown as CAService, {} as CertService);
      const id = await service.ensureStorageCA();

      expect(id).toBe('new-ca-id');
      expect(caService.createRootCA).toHaveBeenCalledWith(
        {
          commonName: 'Gateway Storage CA',
          keyAlgorithm: 'ecdsa-p256',
          validityYears: 10,
          maxValidityDays: 730,
          pathLengthConstraint: 0,
        },
        SYSTEM_USER_ID
      );
      expect(db.update).toHaveBeenCalled();
      expect(db.updateSet).toHaveBeenCalledWith({ isSystem: true, systemPurpose: 'storage-tls' });
    });
  });

  describe('issueManagedStorageCertificate', () => {
    it('keeps IP and hostname (DNS) SANs and drops malformed ones', async () => {
      const db = createDb([[{ id: 'ca-storage-1', certificatePem: 'CA_PEM' }]]);
      const certService = createCertService();
      const service = new StorageCAService(db as never, {} as CAService, certService as unknown as CertService);
      service.setSystemCertificateLifecycleService({ issueCurrent: certService.issueCertificate } as never);

      // The endpoint uses the hostname when no IP service address is set, so a
      // hostname must be kept as a DNS SAN; only truly-malformed entries drop.
      const result = await service.issueManagedStorageCertificate('cluster-1', [
        '10.0.0.5',
        'storage-node.internal',
        'has space',
      ]);

      expect(certService.issueCertificate).toHaveBeenCalledWith(
        {
          caId: 'ca-storage-1',
          type: 'tls-server',
          commonName: 'managed-storage-cluster-1',
          sans: ['10.0.0.5', 'storage-node.internal', 'localhost', '127.0.0.1'],
          keyAlgorithm: 'ecdsa-p256',
          validityDays: 365,
        },
        SYSTEM_USER_ID,
        { type: 'managed_storage', id: 'cluster-1' },
        undefined
      );
      expect(result.certificate.id).toBe('cert-1');
      expect(result.privateKeyPem).toBe('ISSUED_PRIVATE_KEY_PEM');
    });

    it('dedups repeated valid addresses', async () => {
      const db = createDb([[{ id: 'ca-storage-1', certificatePem: 'CA_PEM' }]]);
      const certService = createCertService();
      const service = new StorageCAService(db as never, {} as CAService, certService as unknown as CertService);
      service.setSystemCertificateLifecycleService({ issueCurrent: certService.issueCertificate } as never);

      await service.issueManagedStorageCertificate('cluster-1', ['10.0.0.5', '10.0.0.5']);

      const callArgs = certService.issueCertificate.mock.calls[0]?.[0] as { sans: string[] };
      expect(callArgs.sans).toEqual(['10.0.0.5', 'localhost', '127.0.0.1']);
    });

    // The backup relay reaches every cluster on loopback, relay-enabled or not.
    it('always adds the loopback names, once, even for a directly published cluster', async () => {
      const db = createDb([[{ id: 'ca-storage-1', certificatePem: 'CA_PEM' }]]);
      const certService = createCertService();
      const service = new StorageCAService(db as never, {} as CAService, certService as unknown as CertService);
      service.setSystemCertificateLifecycleService({ issueCurrent: certService.issueCertificate } as never);

      await service.issueManagedStorageCertificate('cluster-1', ['storage.example', 'localhost']);

      const callArgs = certService.issueCertificate.mock.calls[0]?.[0] as { sans: string[] };
      expect(callArgs.sans).toEqual(['storage.example', 'localhost', '127.0.0.1']);
    });

    it('throws when no usable addresses remain after filtering', async () => {
      const db = createDb([[{ id: 'ca-storage-1', certificatePem: 'CA_PEM' }]]);
      const certService = createCertService();
      const service = new StorageCAService(db as never, {} as CAService, certService as unknown as CertService);
      service.setSystemCertificateLifecycleService({ issueCurrent: certService.issueCertificate } as never);

      await expect(service.issueManagedStorageCertificate('cluster-1', ['bad name!', '  '])).rejects.toThrow(
        'Managed storage node has no addresses for TLS'
      );
      expect(certService.issueCertificate).not.toHaveBeenCalled();
    });

    it('throws when the address list is empty', async () => {
      const db = createDb([[{ id: 'ca-storage-1', certificatePem: 'CA_PEM' }]]);
      const certService = createCertService();
      const service = new StorageCAService(db as never, {} as CAService, certService as unknown as CertService);
      service.setSystemCertificateLifecycleService({ issueCurrent: certService.issueCertificate } as never);

      await expect(service.issueManagedStorageCertificate('cluster-1', [])).rejects.toThrow(
        'Managed storage node has no addresses for TLS'
      );
    });
  });

  describe('managedStorageCertificateServesLoopback', () => {
    it.each([
      [['10.0.0.5', 'localhost', '127.0.0.1'], true],
      // A cluster created without the relay before loopback names were added.
      [['10.0.0.5', 'storage-node.internal'], false],
      [['10.0.0.5', 'localhost'], false],
    ])('checks the certificate the cluster serves (%j)', async (sans, expected) => {
      const db = createDb([[{ certificateId: 'cert-1' }], [{ sans }]]);
      const service = new StorageCAService(db as never, {} as CAService, {} as CertService);

      await expect(service.managedStorageCertificateServesLoopback('cluster-1')).resolves.toBe(expected);
    });

    it('reports false for a cluster without a certificate', async () => {
      const db = createDb([[{ certificateId: null }]]);
      const service = new StorageCAService(db as never, {} as CAService, {} as CertService);

      await expect(service.managedStorageCertificateServesLoopback('cluster-1')).resolves.toBe(false);
    });
  });

  describe('getManagedStorageCertificateMaterial', () => {
    it('returns certificate, private key, and CA material', async () => {
      const db = createDb([
        [{ id: 'cert-1', caId: 'ca-storage-1', certificatePem: 'CERT_PEM' }],
        [{ id: 'ca-storage-1', certificatePem: 'CA_PEM' }],
      ]);
      const certService = createCertService();
      const service = new StorageCAService(db as never, {} as CAService, certService as unknown as CertService);
      service.setSystemCertificateLifecycleService({ issueCurrent: certService.issueCertificate } as never);

      const material = await service.getManagedStorageCertificateMaterial('cert-1');

      expect(material).toEqual({
        certificatePem: 'CERT_PEM',
        privateKeyPem: 'DECRYPTED_PRIVATE_KEY_PEM',
        caCertificatePem: 'CA_PEM',
      });
      expect(certService.getCertificatePrivateKey).toHaveBeenCalledWith('cert-1');
    });

    it('throws when the certificate does not exist', async () => {
      const db = createDb([[]]);
      const certService = createCertService();
      const service = new StorageCAService(db as never, {} as CAService, certService as unknown as CertService);
      service.setSystemCertificateLifecycleService({ issueCurrent: certService.issueCertificate } as never);

      await expect(service.getManagedStorageCertificateMaterial('missing')).rejects.toThrow();
    });

    it('throws when the certificate belongs to a different CA', async () => {
      const db = createDb([
        [{ id: 'cert-1', caId: 'some-other-ca', certificatePem: 'CERT_PEM' }],
        [{ id: 'ca-storage-1', certificatePem: 'CA_PEM' }],
      ]);
      const certService = createCertService();
      const service = new StorageCAService(db as never, {} as CAService, certService as unknown as CertService);
      service.setSystemCertificateLifecycleService({ issueCurrent: certService.issueCertificate } as never);

      await expect(service.getManagedStorageCertificateMaterial('cert-1')).rejects.toThrow('unexpected issuer');
    });

    it('throws when the private key is unavailable', async () => {
      const db = createDb([
        [{ id: 'cert-1', caId: 'ca-storage-1', certificatePem: 'CERT_PEM' }],
        [{ id: 'ca-storage-1', certificatePem: 'CA_PEM' }],
      ]);
      const certService = createCertService({ privateKeyPem: undefined });
      const service = new StorageCAService(db as never, {} as CAService, certService as unknown as CertService);
      service.setSystemCertificateLifecycleService({ issueCurrent: certService.issueCertificate } as never);

      await expect(service.getManagedStorageCertificateMaterial('cert-1')).rejects.toThrow(
        'private key is unavailable'
      );
    });
  });
});

describe('StorageCAService renewal staging', () => {
  it('stages a replacement leaf (never retiring the current one) with the loopback names', async () => {
    const db = createDb([[{ id: 'ca-storage-1', certificatePem: 'CA_PEM' }]]);
    const lifecycle = {
      issuePending: vi.fn().mockResolvedValue({ certificate: { id: 'pending-1' }, privateKeyPem: 'KEY' }),
      issueCurrent: vi.fn(),
    };
    const service = new StorageCAService(db as never, {} as CAService, {} as CertService);
    service.setSystemCertificateLifecycleService(lifecycle as never);

    await service.issuePendingManagedStorageCertificate('cluster-1', ['10.0.0.5', 'storage-1']);

    expect(lifecycle.issueCurrent).not.toHaveBeenCalled();
    expect(lifecycle.issuePending).toHaveBeenCalledWith(
      expect.objectContaining({
        caId: 'ca-storage-1',
        commonName: 'managed-storage-cluster-1',
        sans: ['10.0.0.5', 'storage-1', 'localhost', '127.0.0.1'],
        validityDays: 365,
      }),
      SYSTEM_USER_ID,
      { type: 'managed_storage', id: 'cluster-1' }
    );
  });

  it('points the cluster at the leaf in the promotion transaction', async () => {
    const db = createDb([]);
    const txWhere = vi.fn(() => Promise.resolve());
    const txSet = vi.fn(() => ({ where: txWhere }));
    const tx = { update: vi.fn(() => ({ set: txSet })) };
    const lifecycle = {
      promotePending: vi.fn(
        async (_owner: unknown, _serial: string, bind: (tx: unknown, certificate: unknown) => Promise<void>) => {
          await bind(tx, { id: 'pending-1', serialNumber: 'serial-1' });
          return true;
        }
      ),
    };
    const service = new StorageCAService(db as never, {} as CAService, {} as CertService);
    service.setSystemCertificateLifecycleService(lifecycle as never);

    await expect(service.promoteManagedStorageCertificate('cluster-1', 'serial-1')).resolves.toBe(true);

    expect(lifecycle.promotePending).toHaveBeenCalledWith(
      { type: 'managed_storage', id: 'cluster-1' },
      'serial-1',
      expect.any(Function)
    );
    expect(txSet).toHaveBeenCalledWith(expect.objectContaining({ certificateId: 'pending-1' }));
  });
});
