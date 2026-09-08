import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type {
  CreateResourceFolderInput,
  MoveResourceFolderInput,
  MoveResourcesToFolderInput,
  ReorderResourceFoldersInput,
  ReorderResourcesInput,
  UpdateResourceFolderInput,
} from './resource-folder.schemas.js';

const MAX_DEPTH = 2;

type FolderRow = {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  depth: number;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
};

export interface ResourceFolderTreeNode extends FolderRow {
  children: ResourceFolderTreeNode[];
}

interface ResourceFolderConfig {
  folderTable: any;
  resourceTable: any;
  resourceName: string;
  resourcePlural: string;
  auditResourceType: string;
  eventName: string;
  folderScope?: SQL;
  resourceScope?: SQL;
  folderDefaults?: Record<string, unknown>;
}

export class FolderedResourceService {
  private eventBus?: EventBusService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly config: ResourceFolderConfig
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  private emitLayoutChanged(action: string, folderId?: string | null) {
    this.eventBus?.publish(this.config.eventName, { action, folderId });
  }

  private async getFolderOrThrow(id: string): Promise<FolderRow> {
    const [folder] = await this.db
      .select()
      .from(this.config.folderTable)
      .where(and(this.config.folderScope, eq(this.config.folderTable.id, id)))
      .limit(1);
    if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
    return folder as FolderRow;
  }

  async assertFolderExists(id: string | null | undefined): Promise<void> {
    if (id) await this.getFolderOrThrow(id);
  }

  private async getNextSortOrder(parentId: string | null): Promise<number> {
    const siblings = await this.db
      .select({ sortOrder: this.config.folderTable.sortOrder })
      .from(this.config.folderTable)
      .where(
        and(
          this.config.folderScope,
          parentId ? eq(this.config.folderTable.parentId, parentId) : isNull(this.config.folderTable.parentId)
        )
      )
      .orderBy(desc(this.config.folderTable.sortOrder))
      .limit(1);
    return siblings.length > 0 ? siblings[0].sortOrder + 1 : 0;
  }

  async createFolder(input: CreateResourceFolderInput, userId: string) {
    let depth = 0;
    if (input.parentId) {
      const parent = await this.getFolderOrThrow(input.parentId);
      if (parent.depth >= MAX_DEPTH) {
        throw new AppError(400, 'MAX_DEPTH_EXCEEDED', `Maximum folder nesting depth is ${MAX_DEPTH + 1} levels`);
      }
      depth = parent.depth + 1;
    }

    const rows = (await this.db
      .insert(this.config.folderTable)
      .values({
        ...this.config.folderDefaults,
        name: input.name,
        parentId: input.parentId ?? null,
        sortOrder: await this.getNextSortOrder(input.parentId ?? null),
        depth,
        createdById: userId,
      })
      .returning()) as FolderRow[];
    const folder = rows[0];
    if (!folder) throw new AppError(500, 'FOLDER_CREATE_FAILED', 'Folder was not created');

    await this.auditService.log({
      userId,
      action: `${this.config.auditResourceType}.create`,
      resourceType: this.config.auditResourceType,
      resourceId: folder.id,
      details: { name: folder.name, parentId: folder.parentId },
    });
    this.emitLayoutChanged('folder_created', folder.id);
    return folder;
  }

  async updateFolder(id: string, input: UpdateResourceFolderInput, userId: string) {
    const existing = await this.getFolderOrThrow(id);
    const [folder] = await this.db
      .update(this.config.folderTable)
      .set({ name: input.name, updatedAt: new Date() })
      .where(and(this.config.folderScope, eq(this.config.folderTable.id, id)))
      .returning();

    await this.auditService.log({
      userId,
      action: `${this.config.auditResourceType}.update`,
      resourceType: this.config.auditResourceType,
      resourceId: id,
      details: { oldName: existing.name, newName: input.name },
    });
    this.emitLayoutChanged('folder_updated', id);
    return folder;
  }

  async moveFolder(id: string, input: MoveResourceFolderInput, userId: string) {
    const folder = await this.getFolderOrThrow(id);
    if (folder.parentId === input.parentId) return folder;

    let newDepth = 0;
    if (input.parentId) {
      const parent = await this.getFolderOrThrow(input.parentId);
      const descendants = await this.getDescendantIds(id);
      if (descendants.includes(input.parentId)) {
        throw new AppError(400, 'CIRCULAR_REFERENCE', 'Cannot move folder into its own descendant');
      }
      newDepth = parent.depth + 1;
    }

    const subtreeHeight = (await this.getMaxSubtreeDepth(id)) - folder.depth;
    if (newDepth + subtreeHeight > MAX_DEPTH) {
      throw new AppError(
        400,
        'MAX_DEPTH_EXCEEDED',
        `Moving this folder would exceed the maximum nesting depth of ${MAX_DEPTH + 1} levels`
      );
    }

    const depthDelta = newDepth - folder.depth;
    const [updated] = await this.db
      .update(this.config.folderTable)
      .set({
        parentId: input.parentId,
        depth: newDepth,
        sortOrder: await this.getNextSortOrder(input.parentId),
        updatedAt: new Date(),
      })
      .where(and(this.config.folderScope, eq(this.config.folderTable.id, id)))
      .returning();

    if (depthDelta !== 0) {
      const descendantIds = await this.getDescendantIds(id);
      if (descendantIds.length > 0) {
        await this.db
          .update(this.config.folderTable)
          .set({
            depth: sql`${this.config.folderTable.depth} + ${depthDelta}`,
            updatedAt: new Date(),
          })
          .where(and(this.config.folderScope, inArray(this.config.folderTable.id, descendantIds)));
      }
    }

    await this.auditService.log({
      userId,
      action: `${this.config.auditResourceType}.move`,
      resourceType: this.config.auditResourceType,
      resourceId: id,
      details: { oldParentId: folder.parentId, newParentId: input.parentId },
    });
    this.emitLayoutChanged('folder_updated', id);
    return updated;
  }

  async deleteFolder(id: string, userId: string) {
    const folder = await this.getFolderOrThrow(id);
    const descendantIds = await this.getDescendantIds(id);
    const folderIds = [id, ...descendantIds];
    const affected = await this.db
      .select({ id: this.config.resourceTable.id })
      .from(this.config.resourceTable)
      .where(and(this.config.resourceScope, inArray(this.config.resourceTable.folderId, folderIds)));

    await this.db
      .delete(this.config.folderTable)
      .where(and(this.config.folderScope, eq(this.config.folderTable.id, id)));
    await this.auditService.log({
      userId,
      action: `${this.config.auditResourceType}.delete`,
      resourceType: this.config.auditResourceType,
      resourceId: id,
      details: { name: folder.name, subfoldersDeleted: descendantIds.length, resourcesUngrouped: affected.length },
    });
    this.emitLayoutChanged('folder_deleted', id);
  }

  async reorderFolders(input: ReorderResourceFoldersInput) {
    for (const item of input.items) {
      await this.db
        .update(this.config.folderTable)
        .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
        .where(and(this.config.folderScope, eq(this.config.folderTable.id, item.id)));
    }
    this.emitLayoutChanged('folders_reordered');
  }

  async getFolderTree(options?: {
    allowedResourceIds?: string[];
    allowedFolderIds?: string[];
    includeAllFolders?: boolean;
  }) {
    const allFolders = await this.db
      .select()
      .from(this.config.folderTable)
      .where(this.config.folderScope)
      .orderBy(asc(this.config.folderTable.depth), asc(this.config.folderTable.sortOrder));

    if (options?.includeAllFolders || (!options?.allowedResourceIds && !options?.allowedFolderIds))
      return this.buildTree(allFolders as FolderRow[]);
    if (!options.allowedResourceIds?.length && !options.allowedFolderIds?.length) return [];

    const visibleResources = !options.allowedResourceIds?.length
      ? []
      : await this.db
          .select({ id: this.config.resourceTable.id, folderId: this.config.resourceTable.folderId })
          .from(this.config.resourceTable)
          .where(and(this.config.resourceScope, inArray(this.config.resourceTable.id, options.allowedResourceIds)));
    return this.pruneEmptyBranches(
      this.buildTree(allFolders as FolderRow[]),
      new Set([...visibleResources.map((item) => item.folderId as string | null), ...(options.allowedFolderIds ?? [])])
    );
  }

  async moveResourcesToFolder(input: MoveResourcesToFolderInput, userId: string) {
    if (input.folderId) await this.getFolderOrThrow(input.folderId);
    await this.db
      .update(this.config.resourceTable)
      .set({ folderId: input.folderId, updatedAt: new Date() })
      .where(and(this.config.resourceScope, inArray(this.config.resourceTable.id, input.ids)));

    await this.auditService.log({
      userId,
      action: `${this.config.resourceName}.move_to_folder`,
      resourceType: this.config.resourceName,
      details: { ids: input.ids, folderId: input.folderId },
    });
    this.emitLayoutChanged(`${this.config.resourcePlural}_moved`, input.folderId);
  }

  async reorderResources(input: ReorderResourcesInput) {
    for (const item of input.items) {
      await this.db
        .update(this.config.resourceTable)
        .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
        .where(and(this.config.resourceScope, eq(this.config.resourceTable.id, item.id)));
    }
    this.emitLayoutChanged(`${this.config.resourcePlural}_reordered`);
  }

  private buildTree(folders: FolderRow[]): ResourceFolderTreeNode[] {
    const nodeMap = new Map<string, ResourceFolderTreeNode>();
    for (const folder of folders) nodeMap.set(folder.id, { ...folder, children: [] });
    const roots: ResourceFolderTreeNode[] = [];
    for (const node of nodeMap.values()) {
      if (node.parentId && nodeMap.has(node.parentId)) nodeMap.get(node.parentId)!.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  private pruneEmptyBranches(
    nodes: ResourceFolderTreeNode[],
    folderIdsWithResources: Set<string | null>
  ): ResourceFolderTreeNode[] {
    return nodes
      .map((node) => ({ ...node, children: this.pruneEmptyBranches(node.children, folderIdsWithResources) }))
      .filter((node) => folderIdsWithResources.has(node.id) || node.children.length > 0);
  }

  private async getDescendantIds(folderId: string): Promise<string[]> {
    const descendants: string[] = [];
    let currentLevel = [folderId];
    while (currentLevel.length > 0) {
      const children = await this.db
        .select({ id: this.config.folderTable.id })
        .from(this.config.folderTable)
        .where(and(this.config.folderScope, inArray(this.config.folderTable.parentId, currentLevel)));
      const childIds = children.map((child) => child.id);
      descendants.push(...childIds);
      currentLevel = childIds;
    }
    return descendants;
  }

  private async getMaxSubtreeDepth(folderId: string): Promise<number> {
    const descendantIds = await this.getDescendantIds(folderId);
    const ids = [folderId, ...descendantIds];
    const [result] = await this.db
      .select({ maxDepth: sql<number>`max(${this.config.folderTable.depth})` })
      .from(this.config.folderTable)
      .where(and(this.config.folderScope, inArray(this.config.folderTable.id, ids)));
    return result?.maxDepth ?? 0;
  }
}
