/**
 * Curated, pinned image catalog for managed object storage (MinIO). Mirrors
 * the shape of `MANAGED_DATABASE_CATALOG` (see
 * `modules/databases/managed-databases.service.ts`): a nested map of
 * `type -> version -> image ref`, consumed by `StorageWorkloadProvider`.
 */
export const MANAGED_STORAGE_CATALOG = {
  minio: {
    // Immutable runtime references, validated by the Storage node.
    '2025-04-22': 'quay.io/minio/minio@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e',
  },
} as const;

export type ManagedStorageType = keyof typeof MANAGED_STORAGE_CATALOG;
