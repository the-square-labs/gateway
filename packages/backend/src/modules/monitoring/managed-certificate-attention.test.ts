import { describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import type { CertificateAttentionItem } from '@/services/system-certificate-renewal.service.js';
import { visibleManagedCertificateAttention } from './managed-certificate-attention.js';

const ITEMS: CertificateAttentionItem[] = [
  { ownerType: 'managed_storage', ownerId: 'cluster-1', reason: 'renewal_failed', daysRemaining: 20, notAfter: 'x' },
  { ownerType: 'managed_storage', ownerId: 'cluster-2', reason: 'expiring', daysRemaining: 3, notAfter: 'y' },
  { ownerType: 'managed_database', ownerId: 'instance-1', reason: 'ca_limited', daysRemaining: 40, notAfter: 'z' },
];

/** A Drizzle stand-in: the first select answers storage owners, the second database owners. */
function fakeDb(storages: unknown[], databases: unknown[]) {
  const queue = [storages, databases];
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => Promise.resolve(queue.shift() ?? []),
  };
  return { select: () => chain } as unknown as DrizzleClient;
}

const STORAGES = [
  { ownerId: 'cluster-1', id: 'storage-conn-1', slug: 'backups', name: 'Backups' },
  { ownerId: 'cluster-2', id: 'storage-conn-2', slug: 'media', name: 'Media' },
];
const DATABASES = [{ ownerId: 'instance-1', id: 'db-conn-1', slug: 'orders', name: 'Orders' }];

describe('visibleManagedCertificateAttention', () => {
  it('links every certificate to its connection for a viewer of all storage and databases', async () => {
    const result = await visibleManagedCertificateAttention(fakeDb(STORAGES, DATABASES), ITEMS, [
      'storage:view',
      'databases:view',
    ]);
    expect(result).toEqual([
      expect.objectContaining({ kind: 'storage', id: 'storage-conn-1', slug: 'backups', reason: 'renewal_failed' }),
      expect.objectContaining({ kind: 'storage', id: 'storage-conn-2', slug: 'media', reason: 'expiring' }),
      expect.objectContaining({ kind: 'database', id: 'db-conn-1', slug: 'orders', reason: 'ca_limited' }),
    ]);
  });

  it('keeps only the resources a scoped viewer may see', async () => {
    const result = await visibleManagedCertificateAttention(fakeDb(STORAGES, DATABASES), ITEMS, [
      'storage:view:storage-conn-2',
    ]);
    expect(result).toEqual([expect.objectContaining({ kind: 'storage', id: 'storage-conn-2' })]);
  });

  it('returns nothing without storage or database access', async () => {
    expect(await visibleManagedCertificateAttention(fakeDb(STORAGES, DATABASES), ITEMS, ['nodes:details'])).toEqual([]);
  });
});
