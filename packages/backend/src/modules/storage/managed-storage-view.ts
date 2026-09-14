import type { ManagedStorageClusterRow } from '@/db/schema/managed-storage.js';

/**
 * The safe, client-facing view of a managed storage cluster row. Mirrors
 * `safeManagedDatabaseView` (see `modules/databases/managed-databases.service.ts`)
 * — deliberately omits `encryptedRootCredentials`, the only secret this row
 * carries. It also currently omits the non-secret `runtimeConfig` (CPU/memory
 * limits): unlike the DB view (which surfaces derived `cpuCores`/`memoryMb`),
 * no consumer needs it yet this phase.
 *
 * Kept minimal + correct for this task; a later task may extend it (e.g. with
 * derived runtime fields) without touching this shape's existing contract.
 */
export function safeManagedStorageView(row: ManagedStorageClusterRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    nodeId: row.nodeId,
    version: row.version,
    imageRef: row.imageRef,
    storageSizeBytes: row.storageSizeBytes,
    publishedPort: row.publishedPort,
    publishS3: row.publishS3,
    relayEnabled: row.relayEnabled,
    tlsEnabled: row.tlsEnabled,
    runtimeConfig: row.runtimeConfig,
    sftpEnabled: row.sftpEnabled,
    sftpPort: row.sftpPort,
    ftpEnabled: row.ftpEnabled,
    ftpPort: row.ftpPort,
    ftpPassivePortStart: row.ftpPassivePortStart,
    ftpPassivePortCount: row.ftpPassivePortCount,
    status: row.status,
    pendingOperation: row.pendingOperation,
    lastError: row.lastError,
    objectStorageConnectionId: row.objectStorageConnectionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
  };
}
