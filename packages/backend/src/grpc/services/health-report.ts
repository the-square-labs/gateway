const managedStorageRootFilesystem = 'gateway-managed-storage-root';

type DecodedHealthDiskMount = {
  mountPoint: string;
  filesystem: string;
  device: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
};

export function decodeHealthDiskMounts(rawMounts: unknown): {
  diskMounts: DecodedHealthDiskMount[];
  managedStorageCapacity?: { storageRoot: string; availableBytes: number };
} {
  const diskMounts: DecodedHealthDiskMount[] = [];
  let managedStorageCapacity: { storageRoot: string; availableBytes: number } | undefined;

  for (const mount of Array.isArray(rawMounts) ? rawMounts : []) {
    const value = mount as Record<string, unknown>;
    const mountPoint = typeof value.mountPoint === 'string' ? value.mountPoint : '';
    const filesystem = typeof value.filesystem === 'string' ? value.filesystem : '';
    if (filesystem === managedStorageRootFilesystem) {
      const availableBytes = Number(value.freeBytes ?? 0);
      if (!managedStorageCapacity && mountPoint && Number.isFinite(availableBytes) && availableBytes >= 0) {
        managedStorageCapacity = { storageRoot: mountPoint, availableBytes };
      }
      continue;
    }
    diskMounts.push({
      mountPoint,
      filesystem,
      device: typeof value.device === 'string' ? value.device : '',
      totalBytes: Number(value.totalBytes ?? 0),
      usedBytes: Number(value.usedBytes ?? 0),
      freeBytes: Number(value.freeBytes ?? 0),
      usagePercent: Number(value.usagePercent ?? 0),
    });
  }

  return managedStorageCapacity ? { diskMounts, managedStorageCapacity } : { diskMounts };
}
