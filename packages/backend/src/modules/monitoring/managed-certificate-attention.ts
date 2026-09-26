import { eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  databaseConnections,
  managedDatabaseInstances,
  managedStorageClusters,
  objectStorageConnections,
} from '@/db/schema/index.js';
import { hasScopeBase, hasScopeForResource } from '@/lib/permissions.js';
import type {
  CertificateAttentionItem,
  CertificateAttentionReason,
} from '@/services/system-certificate-renewal.service.js';

/** A managed database or storage whose TLS certificate needs attention, as the dashboard lists it. */
export interface DashboardManagedCertificate {
  kind: 'storage' | 'database';
  /** The canonical connection the UI links to and permissions are issued for. */
  id: string;
  slug: string;
  name: string;
  reason: CertificateAttentionReason;
  daysRemaining: number;
  notAfter: string;
}

interface OwnerResource {
  ownerId: string;
  id: string | null;
  slug: string;
  name: string;
}

/**
 * Resolves the certificates that need attention to the user-facing storage
 * and database connections, and keeps only those the viewer may see
 * (`storage:view` / `databases:view`, broad or for that connection).
 */
export async function visibleManagedCertificateAttention(
  db: DrizzleClient,
  items: readonly CertificateAttentionItem[],
  scopes: string[]
): Promise<DashboardManagedCertificate[]> {
  const canViewStorage = hasScopeBase(scopes, 'storage:view');
  const canViewDatabases = hasScopeBase(scopes, 'databases:view');
  const storageIds = canViewStorage
    ? items.filter((item) => item.ownerType === 'managed_storage').map((item) => item.ownerId)
    : [];
  const databaseIds = canViewDatabases
    ? items.filter((item) => item.ownerType === 'managed_database').map((item) => item.ownerId)
    : [];
  if (storageIds.length === 0 && databaseIds.length === 0) return [];

  const [storages, databases] = await Promise.all([
    storageIds.length
      ? db
          .select({
            ownerId: managedStorageClusters.id,
            id: objectStorageConnections.id,
            slug: objectStorageConnections.slug,
            name: objectStorageConnections.name,
          })
          .from(managedStorageClusters)
          .innerJoin(
            objectStorageConnections,
            eq(objectStorageConnections.id, managedStorageClusters.objectStorageConnectionId)
          )
          .where(inArray(managedStorageClusters.id, storageIds))
      : Promise.resolve([] as OwnerResource[]),
    databaseIds.length
      ? db
          .select({
            ownerId: managedDatabaseInstances.id,
            id: databaseConnections.id,
            slug: databaseConnections.slug,
            name: databaseConnections.name,
          })
          .from(managedDatabaseInstances)
          .innerJoin(databaseConnections, eq(databaseConnections.id, managedDatabaseInstances.databaseConnectionId))
          .where(inArray(managedDatabaseInstances.id, databaseIds))
      : Promise.resolve([] as OwnerResource[]),
  ]);
  const storageByOwner = new Map(storages.map((row) => [row.ownerId, row]));
  const databaseByOwner = new Map(databases.map((row) => [row.ownerId, row]));

  return items.flatMap((item): DashboardManagedCertificate[] => {
    const storage = item.ownerType === 'managed_storage';
    const resource = (storage ? storageByOwner : databaseByOwner).get(item.ownerId);
    if (!resource?.id) return [];
    if (!hasScopeForResource(scopes, storage ? 'storage:view' : 'databases:view', resource.id)) return [];
    return [
      {
        kind: storage ? 'storage' : 'database',
        id: resource.id,
        slug: resource.slug,
        name: resource.name,
        reason: item.reason,
        daysRemaining: item.daysRemaining,
        notAfter: item.notAfter,
      },
    ];
  });
}
