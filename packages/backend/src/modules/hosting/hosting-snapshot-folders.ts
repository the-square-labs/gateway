import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { hostingSnapshotFolders, hostingSnapshotPlacements } from '@/db/schema/index.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { FolderedResourceService } from '@/modules/resource-folders/resource-folder.service.js';
import type { HostingVmSnapshot } from './hosting-snapshot.types.js';
export function snapshotLayoutId(resourceId: string, fingerprint: string) {
  const hex = createHash('sha256')
    .update(JSON.stringify([resourceId, fingerprint]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function snapshotFolderService(db: DrizzleClient, audit: AuditService, resourceId: string) {
  return new FolderedResourceService(db, audit, {
    folderTable: hostingSnapshotFolders,
    resourceTable: hostingSnapshotPlacements,
    resourceName: 'hosting_snapshot',
    resourcePlural: 'hosting_snapshots',
    auditResourceType: 'hosting_snapshot_folder',
    eventName: 'hosting.snapshot.folder.changed',
    folderScope: eq(hostingSnapshotFolders.resourceId, resourceId),
    resourceScope: eq(hostingSnapshotPlacements.resourceId, resourceId),
    folderDefaults: { resourceId },
  });
}
export async function snapshotPlacements(db: DrizzleClient, resourceId: string, snapshots: HostingVmSnapshot[]) {
  const rows = await db
    .select()
    .from(hostingSnapshotPlacements)
    .where(eq(hostingSnapshotPlacements.resourceId, resourceId));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return snapshots.map((s) => {
    const layoutId = s.layoutId ?? s.entityId ?? snapshotLayoutId(resourceId, s.fingerprint);
    const placement = byId.get(layoutId);
    return { ...s, layoutId, folderId: placement?.folderId ?? null, sortOrder: placement?.sortOrder ?? 0 };
  });
}
