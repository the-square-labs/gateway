vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn(async () => {}) }));

import { describe, expect, it, vi } from 'vitest';
import { objectStorageConnections } from '@/db/schema/object-storage.js';
import { MANAGED_STORAGE_CATALOG } from './managed-storage-catalog.js';
import { StorageWorkloadProvider } from './storage-workload-provider.js';

/**
 * Fake drizzle client mirroring the db-double pattern used in
 * `storage-workload-store.test.ts`: `.insert(table).values(values).returning()`
 * resolving to a single-row array, with `values` exposed so tests can assert
 * on the exact row shape passed through.
 */
function fakeDb(rows: Record<string, unknown>[]) {
  const returning = vi.fn(async () => rows);
  const values = vi.fn((_values: Record<string, unknown>) => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const db = { insert };
  return { db, insert, values, returning };
}

const fakeCrypto = {
  encryptString: vi.fn((_plaintext: string) => ({
    encryptedKey: 'enc(opaque-ciphertext-marker)',
    encryptedDek: 'dek',
  })),
};

describe('StorageWorkloadProvider', () => {
  it('exposes kind=storage', () => {
    const provider = new StorageWorkloadProvider({} as never, {} as never);
    expect(provider.kind).toBe('storage');
  });

  it('listCatalog returns the minio catalog entry with its pinned versions', () => {
    const provider = new StorageWorkloadProvider({} as never, {} as never);
    expect(provider.listCatalog()).toEqual([{ type: 'minio', versions: Object.keys(MANAGED_STORAGE_CATALOG.minio) }]);
  });

  it('resolveImage returns the pinned image for a known type/version', () => {
    const provider = new StorageWorkloadProvider({} as never, {} as never);
    expect(provider.resolveImage('minio', '2025-04-22')).toBe(MANAGED_STORAGE_CATALOG.minio['2025-04-22']);
  });

  it('resolveImage throws INVALID_MANAGED_STORAGE_VERSION for an unknown version', () => {
    const provider = new StorageWorkloadProvider({} as never, {} as never);
    try {
      provider.resolveImage('minio', 'nope');
      expect.unreachable('resolveImage should have thrown');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('INVALID_MANAGED_STORAGE_VERSION');
    }
  });

  it('registerCanonicalConnection inserts a managed object_storage_connections row with the encrypted secret', async () => {
    const insertedRow = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'my-bucket-store',
      slug: 'my-bucket-store',
      provider: 'minio',
      origin: 'managed',
    };
    const { db, insert, values } = fakeDb([insertedRow]);
    const provider = new StorageWorkloadProvider(db as never, fakeCrypto as never);

    const id = await provider.registerCanonicalConnection({
      name: 'my-bucket-store',
      type: 'minio',
      credentials: { username: 'root-user', password: 'super-secret-password' },
      storageSizeBytes: 1024,
      userId: '22222222-2222-4222-8222-222222222222',
      tags: ['prod'],
      storage: {
        endpoint: 'http://minio.internal:9000',
        region: 'us-east-1',
        forcePathStyle: true,
        s3Provider: 'minio',
      },
    });

    expect(id).toBe(insertedRow.id);
    expect(insert).toHaveBeenCalledWith(objectStorageConnections);
    expect(values).toHaveBeenCalledTimes(1);
    const inserted = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      name: 'my-bucket-store',
      provider: 'minio',
      origin: 'managed',
      tags: ['prod'],
      endpoint: 'http://minio.internal:9000',
      region: 'us-east-1',
      accessKeyId: 'root-user',
      forcePathStyle: true,
      createdById: '22222222-2222-4222-8222-222222222222',
    });
    // The secret must be encrypted (via cryptoService), never stored raw.
    expect(fakeCrypto.encryptString).toHaveBeenCalledWith(JSON.stringify({ secretAccessKey: 'super-secret-password' }));
    expect(inserted.encryptedConfig).not.toContain('super-secret-password');
    expect(inserted.encryptedConfig).toContain('enc(');
  });

  it('registerCanonicalConnection throws MANAGED_STORAGE_REGISTRATION_INVALID when ctx.storage is missing', async () => {
    const provider = new StorageWorkloadProvider({} as never, fakeCrypto as never);
    await expect(
      provider.registerCanonicalConnection({
        name: 'no-storage-ctx',
        type: 'minio',
        credentials: { username: 'root-user', password: 'pw' },
        storageSizeBytes: 1024,
        userId: '22222222-2222-4222-8222-222222222222',
      })
    ).rejects.toMatchObject({ code: 'MANAGED_STORAGE_REGISTRATION_INVALID' });
  });

  it('syncCanonicalConnection is a no-op when connectionId is null', async () => {
    const provider = new StorageWorkloadProvider({} as never, fakeCrypto as never);
    await expect(
      provider.syncCanonicalConnection({ connectionId: null, updatedById: null, name: 'irrelevant' })
    ).resolves.toBeUndefined();
  });

  it('ensureCertificate returns null when no storageCA is injected (TLS disabled)', async () => {
    const provider = new StorageWorkloadProvider({} as never, fakeCrypto as never);
    await expect(
      provider.ensureCertificate({
        workloadId: 'w-1',
        existingCertificateId: null,
        node: { serviceAddress: '10.0.0.5', lastHealthReport: null },
      })
    ).resolves.toBeNull();
  });

  it('ensureCertificate returns null when the row already has a certificateId', async () => {
    const storageCA = {
      issueManagedStorageCertificate: vi.fn().mockResolvedValue({ certificate: { id: 'cert-1' } }),
    };
    const provider = new StorageWorkloadProvider({} as never, fakeCrypto as never, storageCA as never);
    await expect(
      provider.ensureCertificate({
        workloadId: 'w-1',
        existingCertificateId: 'existing-cert',
        node: { serviceAddress: '10.0.0.5', lastHealthReport: null },
      })
    ).resolves.toBeNull();
    expect(storageCA.issueManagedStorageCertificate).not.toHaveBeenCalled();
  });

  it('ensureCertificate issues a certificate via storageCA and returns its id when the node has a service address', async () => {
    const storageCA = {
      issueManagedStorageCertificate: vi.fn().mockResolvedValue({ certificate: { id: 'cert-1' } }),
    };
    const provider = new StorageWorkloadProvider({} as never, fakeCrypto as never, storageCA as never);

    const result = await provider.ensureCertificate({
      workloadId: 'w-1',
      existingCertificateId: null,
      node: { serviceAddress: '10.0.0.5', lastHealthReport: null },
    });

    expect(result).toEqual({ certificateId: 'cert-1' });
    expect(storageCA.issueManagedStorageCertificate).toHaveBeenCalledWith('w-1', ['10.0.0.5'], expect.any(Function));
  });

  it('ensureCertificate collects addresses from the node health report too', async () => {
    const storageCA = {
      issueManagedStorageCertificate: vi.fn().mockResolvedValue({ certificate: { id: 'cert-2' } }),
    };
    const provider = new StorageWorkloadProvider({} as never, fakeCrypto as never, storageCA as never);

    const result = await provider.ensureCertificate({
      workloadId: 'w-2',
      existingCertificateId: null,
      node: {
        serviceAddress: null,
        lastHealthReport: { publicIpAddresses: ['203.0.113.5'], localIpAddresses: ['10.0.0.9'] },
      },
    });

    expect(result).toEqual({ certificateId: 'cert-2' });
    expect(storageCA.issueManagedStorageCertificate).toHaveBeenCalledWith(
      'w-2',
      ['203.0.113.5', '10.0.0.9'],
      expect.any(Function)
    );
  });

  it('ensureCertificate adds 127.0.0.1 + localhost SANs when ctx.relay is true', async () => {
    const storageCA = {
      issueManagedStorageCertificate: vi.fn().mockResolvedValue({ certificate: { id: 'cert-relay' } }),
    };
    const provider = new StorageWorkloadProvider({} as never, fakeCrypto as never, storageCA as never);

    const result = await provider.ensureCertificate({
      workloadId: 'w-relay',
      existingCertificateId: null,
      node: { serviceAddress: '10.0.0.5', lastHealthReport: null },
      relay: true,
    });

    expect(result).toEqual({ certificateId: 'cert-relay' });
    const sans = vi.mocked(storageCA.issueManagedStorageCertificate).mock.calls[0]![1];
    expect(sans).toEqual(expect.arrayContaining(['10.0.0.5', '127.0.0.1', 'localhost']));
  });

  it('ensureCertificate throws MANAGED_STORAGE_TLS_IDENTITY_UNAVAILABLE when the node has no IP addresses', async () => {
    const storageCA = {
      issueManagedStorageCertificate: vi.fn(),
    };
    const provider = new StorageWorkloadProvider({} as never, fakeCrypto as never, storageCA as never);

    await expect(
      provider.ensureCertificate({
        workloadId: 'w-3',
        existingCertificateId: null,
        node: { serviceAddress: null, lastHealthReport: null },
      })
    ).rejects.toMatchObject({ code: 'MANAGED_STORAGE_TLS_IDENTITY_UNAVAILABLE' });
    expect(storageCA.issueManagedStorageCertificate).not.toHaveBeenCalled();
  });
});
