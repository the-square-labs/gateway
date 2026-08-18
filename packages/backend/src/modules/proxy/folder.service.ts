import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { proxyHostFolders } from '@/db/schema/proxy-host-folders.js';
import { proxyHosts } from '@/db/schema/proxy-hosts.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type {
  CreateFolderInput,
  GroupedHostsQuery,
  MoveFolderInput,
  MoveHostsToFolderInput,
  ReorderFoldersInput,
  ReorderHostsInput,
  UpdateFolderInput,
} from './folder.schemas.js';
import type { PageUpstreamDisplayTarget } from './proxy-upstream-display.js';
import { attachDockerUpstreamDisplay } from './proxy-upstream-display.js';

const logger = createChildLogger('FolderService');

const MAX_DEPTH = 2; // 0, 1, 2 = three levels

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FolderRow = typeof proxyHostFolders.$inferSelect;
type ProxyHostRow = typeof proxyHosts.$inferSelect;

/** Compute effective health status and return a plain object (Drizzle rows are class instances) */
function toPlainHost(
  host: ProxyHostRow & {
    dockerDeploymentName?: string | null;
    dockerNodeSlug?: string | null;
    dockerNodeAppearanceColor?: string | null;
    pageTarget?: PageUpstreamDisplayTarget | null;
  }
): Record<string, unknown> {
  const plain: Record<string, unknown> = {};
  for (const key of Object.keys(proxyHosts) as Array<keyof typeof proxyHosts>) {
    if (key in host) plain[key] = (host as any)[key];
  }

  delete plain.healthHistory;
  plain.dockerDeploymentName = host.dockerDeploymentName;
  plain.dockerNodeSlug = host.dockerNodeSlug;
  plain.dockerNodeAppearanceColor = host.dockerNodeAppearanceColor;
  plain.pageTarget = host.pageTarget ?? null;
  let effectiveStatus = host.rawConfigEnabled ? 'disabled' : (host.healthStatus as string);
  if (
    !host.rawConfigEnabled &&
    host.healthStatus === 'online' &&
    Array.isArray(host.healthHistory) &&
    host.healthHistory.length > 0
  ) {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const recent = (host.healthHistory as Array<{ ts?: string; status: string }>).filter(
      (h) => h.ts && new Date(h.ts).getTime() >= fiveMinAgo
    );
    if (recent.some((h) => h.status === 'offline' || h.status === 'degraded')) {
      effectiveStatus = 'recovering';
    }
  }
  plain.effectiveHealthStatus = effectiveStatus;
  return plain;
}

export interface FolderTreeNode extends FolderRow {
  children: FolderTreeNode[];
  hosts: ProxyHostRow[];
}

export interface GroupedHostsResponse {
  folders: FolderTreeNode[];
  ungroupedHosts: ProxyHostRow[];
  totalHosts: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FolderService {
  private eventBus?: EventBusService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  private emitLayoutChanged(action: string, folderId?: string | null) {
    this.eventBus?.publish('proxy.host.changed', { action, folderId });
  }

  // -----------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------

  async createFolder(input: CreateFolderInput, userId: string) {
    let depth = 0;

    if (input.parentId) {
      const parent = await this.db.query.proxyHostFolders.findFirst({
        where: eq(proxyHostFolders.id, input.parentId),
      });
      if (!parent) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Parent folder not found');
      if (parent.depth >= MAX_DEPTH) {
        throw new AppError(400, 'MAX_DEPTH_EXCEEDED', `Maximum folder nesting depth is ${MAX_DEPTH + 1} levels`);
      }
      depth = parent.depth + 1;
    }

    // Get next sort order within same parent
    const siblings = await this.db
      .select({ sortOrder: proxyHostFolders.sortOrder })
      .from(proxyHostFolders)
      .where(input.parentId ? eq(proxyHostFolders.parentId, input.parentId) : isNull(proxyHostFolders.parentId))
      .orderBy(desc(proxyHostFolders.sortOrder))
      .limit(1);

    const nextSortOrder = siblings.length > 0 ? siblings[0].sortOrder + 1 : 0;

    const [folder] = await this.db
      .insert(proxyHostFolders)
      .values({
        name: input.name,
        parentId: input.parentId ?? null,
        sortOrder: nextSortOrder,
        depth,
        createdById: userId,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'proxy_host_folder.create',
      resourceType: 'proxy_host_folder',
      resourceId: folder.id,
      details: { name: folder.name, parentId: folder.parentId },
    });

    logger.info('Created folder', { folderId: folder.id, name: folder.name });
    this.emitLayoutChanged('folder_created', folder.id);
    return folder;
  }

  // -----------------------------------------------------------------------
  // Update (rename)
  // -----------------------------------------------------------------------

  async updateFolder(id: string, input: UpdateFolderInput, userId: string) {
    const existing = await this.db.query.proxyHostFolders.findFirst({
      where: eq(proxyHostFolders.id, id),
    });
    if (!existing) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');

    const [updated] = await this.db
      .update(proxyHostFolders)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(proxyHostFolders.id, id))
      .returning();

    await this.auditService.log({
      userId,
      action: 'proxy_host_folder.update',
      resourceType: 'proxy_host_folder',
      resourceId: id,
      details: { oldName: existing.name, newName: input.name },
    });

    logger.info('Renamed folder', { folderId: id, name: input.name });
    this.emitLayoutChanged('folder_updated', id);
    return updated;
  }

  // -----------------------------------------------------------------------
  // Move folder to new parent
  // -----------------------------------------------------------------------

  async moveFolder(id: string, input: MoveFolderInput, userId: string) {
    const folder = await this.db.query.proxyHostFolders.findFirst({
      where: eq(proxyHostFolders.id, id),
    });
    if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');

    // Same parent — no-op
    if (folder.parentId === input.parentId) return folder;

    // Validate new parent
    let newDepth = 0;
    if (input.parentId) {
      const newParent = await this.db.query.proxyHostFolders.findFirst({
        where: eq(proxyHostFolders.id, input.parentId),
      });
      if (!newParent) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Target parent folder not found');

      // Circular reference check: target parent must not be a descendant
      const descendants = await this.getDescendantIds(id);
      if (descendants.includes(input.parentId)) {
        throw new AppError(400, 'CIRCULAR_REFERENCE', 'Cannot move folder into its own descendant');
      }

      newDepth = newParent.depth + 1;
    }

    // Check depth constraints for entire subtree
    const maxSubtreeDepth = await this.getMaxSubtreeDepth(id);
    const subtreeHeight = maxSubtreeDepth - folder.depth;
    if (newDepth + subtreeHeight > MAX_DEPTH) {
      throw new AppError(
        400,
        'MAX_DEPTH_EXCEEDED',
        `Moving this folder would exceed the maximum nesting depth of ${MAX_DEPTH + 1} levels`
      );
    }

    // Update folder and all descendants' depths
    const depthDelta = newDepth - folder.depth;

    // Get next sort order in new parent
    const siblings = await this.db
      .select({ sortOrder: proxyHostFolders.sortOrder })
      .from(proxyHostFolders)
      .where(input.parentId ? eq(proxyHostFolders.parentId, input.parentId) : isNull(proxyHostFolders.parentId))
      .orderBy(desc(proxyHostFolders.sortOrder))
      .limit(1);
    const nextSortOrder = siblings.length > 0 ? siblings[0].sortOrder + 1 : 0;

    // Update the folder itself
    const [updated] = await this.db
      .update(proxyHostFolders)
      .set({
        parentId: input.parentId,
        depth: newDepth,
        sortOrder: nextSortOrder,
        updatedAt: new Date(),
      })
      .where(eq(proxyHostFolders.id, id))
      .returning();

    // Update descendants' depths if delta != 0
    if (depthDelta !== 0) {
      const descendantIds = await this.getDescendantIds(id);
      if (descendantIds.length > 0) {
        await this.db
          .update(proxyHostFolders)
          .set({
            depth: sql`${proxyHostFolders.depth} + ${depthDelta}`,
            updatedAt: new Date(),
          })
          .where(inArray(proxyHostFolders.id, descendantIds));
      }
    }

    await this.auditService.log({
      userId,
      action: 'proxy_host_folder.move',
      resourceType: 'proxy_host_folder',
      resourceId: id,
      details: { oldParentId: folder.parentId, newParentId: input.parentId },
    });

    logger.info('Moved folder', { folderId: id, newParentId: input.parentId });
    this.emitLayoutChanged('folder_updated', id);
    return updated;
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  async deleteFolder(id: string, userId: string) {
    const folder = await this.db.query.proxyHostFolders.findFirst({
      where: eq(proxyHostFolders.id, id),
    });
    if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');

    // Count affected items for audit log
    const descendantIds = await this.getDescendantIds(id);
    const allFolderIds = [id, ...descendantIds];

    const affectedHosts = await this.db
      .select({ id: proxyHosts.id })
      .from(proxyHosts)
      .where(inArray(proxyHosts.folderId, allFolderIds));

    // CASCADE deletes subfolders, SET NULL ungroups hosts
    await this.db.delete(proxyHostFolders).where(eq(proxyHostFolders.id, id));

    await this.auditService.log({
      userId,
      action: 'proxy_host_folder.delete',
      resourceType: 'proxy_host_folder',
      resourceId: id,
      details: {
        name: folder.name,
        subfoldersDeleted: descendantIds.length,
        hostsUngrouped: affectedHosts.length,
      },
    });

    logger.info('Deleted folder', {
      folderId: id,
      subfoldersDeleted: descendantIds.length,
      hostsUngrouped: affectedHosts.length,
    });

    this.emitLayoutChanged('folder_deleted', id);
  }

  // -----------------------------------------------------------------------
  // Reorder
  // -----------------------------------------------------------------------

  async reorderFolders(input: ReorderFoldersInput) {
    for (const item of input.items) {
      await this.db
        .update(proxyHostFolders)
        .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
        .where(eq(proxyHostFolders.id, item.id));
    }

    this.emitLayoutChanged('folders_reordered');
  }

  // -----------------------------------------------------------------------
  // Get folder tree
  // -----------------------------------------------------------------------

  async getFolderTree(options?: { allowedHostIds?: string[]; includeAllFolders?: boolean }): Promise<FolderTreeNode[]> {
    const allFolders = await this.db
      .select()
      .from(proxyHostFolders)
      .orderBy(asc(proxyHostFolders.depth), asc(proxyHostFolders.sortOrder));

    if (options?.includeAllFolders) return this.buildTree(allFolders, []);
    if (options?.allowedHostIds) {
      if (options.allowedHostIds.length === 0) return [];
      const visibleHosts = await this.db
        .select()
        .from(proxyHosts)
        .where(inArray(proxyHosts.id, options.allowedHostIds));
      return this.pruneEmptyBranches(this.buildTree(allFolders, visibleHosts));
    }

    return this.buildTree(allFolders, []);
  }

  // -----------------------------------------------------------------------
  // Get grouped hosts (main endpoint for the proxy hosts page)
  // -----------------------------------------------------------------------

  async getGroupedHosts(
    query: GroupedHostsQuery,
    options?: { allowedHostIds?: string[]; includeAllFolders?: boolean }
  ): Promise<GroupedHostsResponse> {
    // 1. Fetch all folders
    const allFolders = await this.db
      .select()
      .from(proxyHostFolders)
      .orderBy(asc(proxyHostFolders.depth), asc(proxyHostFolders.sortOrder));

    // 2. Fetch all hosts (with optional filters)
    const conditions = [eq(proxyHosts.isSystem, false)];
    if (options?.allowedHostIds) {
      if (options.allowedHostIds.length === 0) {
        return {
          folders: options.includeAllFolders ? this.buildTree(allFolders, []) : [],
          ungroupedHosts: [],
          totalHosts: 0,
        };
      }
      conditions.push(inArray(proxyHosts.id, options.allowedHostIds));
    }
    if (query.type) {
      conditions.push(eq(proxyHosts.type, query.type));
    }
    if (query.enabled !== undefined) {
      conditions.push(eq(proxyHosts.enabled, query.enabled));
    }
    if (query.healthStatus) {
      conditions.push(
        query.healthStatus === 'disabled'
          ? or(eq(proxyHosts.healthStatus, 'disabled'), eq(proxyHosts.rawConfigEnabled, true))!
          : and(eq(proxyHosts.healthStatus, query.healthStatus), eq(proxyHosts.rawConfigEnabled, false))!
      );
    }
    if (query.search) {
      conditions.push(ilike(sql`${proxyHosts.domainNames}::text`, `%${query.search}%`));
    }

    const where = buildWhere(conditions);

    const hostRows = await this.db
      .select()
      .from(proxyHosts)
      .where(where)
      .orderBy(asc(proxyHosts.sortOrder), desc(proxyHosts.createdAt));
    const allHosts = await attachDockerUpstreamDisplay(this.db, hostRows);

    // 3. Group hosts by folderId
    const hostsByFolder = new Map<string | null, ProxyHostRow[]>();
    for (const host of allHosts) {
      const key = host.folderId;
      if (!hostsByFolder.has(key)) hostsByFolder.set(key, []);
      hostsByFolder.get(key)!.push(host);
    }

    // 4. Build tree with hosts attached
    const tree = this.buildTree(allFolders, allHosts);

    // 5. Ungrouped hosts (folderId = null)
    const ungroupedHosts = hostsByFolder.get(null) ?? [];

    // 6. Convert to plain objects with effectiveHealthStatus
    const mapTree = (nodes: FolderTreeNode[]): any[] =>
      nodes.map((n) => ({
        ...n,
        hosts: n.hosts.map(toPlainHost),
        children: mapTree(n.children),
      }));

    return {
      folders: mapTree(options?.includeAllFolders ? tree : this.pruneEmptyBranches(tree)),
      ungroupedHosts: ungroupedHosts.map(toPlainHost) as any,
      totalHosts: allHosts.length,
    };
  }

  // -----------------------------------------------------------------------
  // Move hosts to folder (batch)
  // -----------------------------------------------------------------------

  async moveHostsToFolder(input: MoveHostsToFolderInput, userId: string) {
    // Validate folder exists if not null
    if (input.folderId) {
      const folder = await this.db.query.proxyHostFolders.findFirst({
        where: eq(proxyHostFolders.id, input.folderId),
      });
      if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Target folder not found');
    }

    const selectedHosts = await this.db
      .select({ id: proxyHosts.id, isSystem: proxyHosts.isSystem })
      .from(proxyHosts)
      .where(inArray(proxyHosts.id, input.hostIds));
    if (selectedHosts.some((host) => host.isSystem)) {
      throw new AppError(403, 'SYSTEM_HOST', 'System proxy hosts cannot be moved');
    }

    await this.db
      .update(proxyHosts)
      .set({ folderId: input.folderId, updatedAt: new Date() })
      .where(inArray(proxyHosts.id, input.hostIds));

    await this.auditService.log({
      userId,
      action: 'proxy_host.move_to_folder',
      resourceType: 'proxy_host',
      details: { hostIds: input.hostIds, folderId: input.folderId },
    });

    logger.info('Moved hosts to folder', {
      hostCount: input.hostIds.length,
      folderId: input.folderId,
    });

    this.emitLayoutChanged('hosts_moved', input.folderId);
  }

  // -----------------------------------------------------------------------
  // Reorder hosts within a folder
  // -----------------------------------------------------------------------

  async reorderHosts(input: ReorderHostsInput) {
    const selectedHosts = await this.db
      .select({ id: proxyHosts.id, isSystem: proxyHosts.isSystem })
      .from(proxyHosts)
      .where(
        inArray(
          proxyHosts.id,
          input.items.map((item) => item.id)
        )
      );
    if (selectedHosts.some((host) => host.isSystem)) {
      throw new AppError(403, 'SYSTEM_HOST', 'System proxy hosts cannot be reordered');
    }

    for (const item of input.items) {
      await this.db
        .update(proxyHosts)
        .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
        .where(eq(proxyHosts.id, item.id));
    }

    this.emitLayoutChanged('hosts_reordered');
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private buildTree(folders: FolderRow[], hosts: ProxyHostRow[]): FolderTreeNode[] {
    // Group hosts by folderId
    const hostsByFolder = new Map<string, ProxyHostRow[]>();
    for (const host of hosts) {
      if (host.folderId) {
        if (!hostsByFolder.has(host.folderId)) hostsByFolder.set(host.folderId, []);
        hostsByFolder.get(host.folderId)!.push(host);
      }
    }

    // Build nodes
    const nodeMap = new Map<string, FolderTreeNode>();
    for (const folder of folders) {
      nodeMap.set(folder.id, {
        ...folder,
        children: [],
        hosts: hostsByFolder.get(folder.id) ?? [],
      });
    }

    // Build tree
    const roots: FolderTreeNode[] = [];
    for (const node of nodeMap.values()) {
      if (node.parentId && nodeMap.has(node.parentId)) {
        nodeMap.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  private pruneEmptyBranches(nodes: FolderTreeNode[]): FolderTreeNode[] {
    return nodes
      .map((node) => ({ ...node, children: this.pruneEmptyBranches(node.children) }))
      .filter((node) => node.hosts.length > 0 || node.children.length > 0);
  }

  private async getDescendantIds(folderId: string): Promise<string[]> {
    // BFS to collect all descendant IDs
    const descendants: string[] = [];
    let currentLevel = [folderId];

    while (currentLevel.length > 0) {
      const children = await this.db
        .select({ id: proxyHostFolders.id })
        .from(proxyHostFolders)
        .where(inArray(proxyHostFolders.parentId, currentLevel));

      const childIds = children.map((c) => c.id);
      descendants.push(...childIds);
      currentLevel = childIds;
    }

    return descendants;
  }

  private async getMaxSubtreeDepth(folderId: string): Promise<number> {
    const descendantIds = await this.getDescendantIds(folderId);
    if (descendantIds.length === 0) {
      const folder = await this.db.query.proxyHostFolders.findFirst({
        where: eq(proxyHostFolders.id, folderId),
      });
      return folder?.depth ?? 0;
    }

    const maxDepthResult = await this.db
      .select({ maxDepth: sql<number>`max(${proxyHostFolders.depth})` })
      .from(proxyHostFolders)
      .where(inArray(proxyHostFolders.id, [folderId, ...descendantIds]));

    return maxDepthResult[0]?.maxDepth ?? 0;
  }
}
