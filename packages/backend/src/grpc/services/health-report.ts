import type { NodeManagedLinkReport } from '@/db/schema/nodes.js';

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

/**
 * Relay round trips of a daemon health report, in milliseconds. Absent when the daemon measured
 * none, so reports of nodes without relays keep their shape.
 */
export function relayLatencyHealth(rawSamples: unknown): {
  relayLatencies?: Array<{ relayInstanceId: string; rttMs: number }>;
} {
  const relayLatencies = (Array.isArray(rawSamples) ? rawSamples : []).flatMap((sample) => {
    const relayInstanceId = (sample as { relayInstanceId?: unknown })?.relayInstanceId;
    const micros = Number((sample as { rttMicros?: unknown })?.rttMicros);
    if (typeof relayInstanceId !== 'string' || !relayInstanceId || !Number.isFinite(micros) || micros <= 0) return [];
    return [{ relayInstanceId, rttMs: Math.round(micros) / 1000 }];
  });
  return relayLatencies.length ? { relayLatencies } : {};
}

const MANAGED_LINK_OWNER_KINDS = new Set(['managed_database_binding', 'managed_storage_binding']);

/**
 * The managed links of a docker daemon health report (managed_link_runtime_v1). Absent when the node reported none,
 * so reports of other nodes keep their shape.
 */
export function managedLinkHealth(rawLinks: unknown): { managedLinks?: NodeManagedLinkReport[] } {
  const managedLinks = (Array.isArray(rawLinks) ? rawLinks : []).flatMap((raw): NodeManagedLinkReport[] => {
    const value = (raw ?? {}) as Record<string, unknown>;
    const ownerKind = typeof value.ownerKind === 'string' ? value.ownerKind : '';
    const ownerId = typeof value.ownerId === 'string' ? value.ownerId : '';
    if (!MANAGED_LINK_OWNER_KINDS.has(ownerKind) || !ownerId) return [];
    const count = (field: unknown) => {
      const parsed = Number(field ?? 0);
      return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
    };
    const lastRejectedAtMs = count(value.lastRejectedAtUnixMs);
    const lastRejectionReason = typeof value.lastRejectionReason === 'string' ? value.lastRejectionReason : '';
    return [
      {
        ownerKind,
        ownerId,
        activeConnections: count(value.activeConnections),
        connectionLimit: count(value.connectionLimit),
        rejectedTotal: count(value.rejectedTotal),
        lastRejectionReason: lastRejectionReason || null,
        lastRejectedAt: lastRejectedAtMs > 0 ? new Date(lastRejectedAtMs).toISOString() : null,
        openedTotal: count(value.openedTotal),
        sourceToTargetBytes: count(value.sourceToTargetBytes),
        targetToSourceBytes: count(value.targetToSourceBytes),
      },
    ];
  });
  return managedLinks.length ? { managedLinks } : {};
}
