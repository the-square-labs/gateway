import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor, DrizzleTransaction } from '@/db/client.js';
import { hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
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

/** Caller permissions for moving a whole folder subtree. */
export interface FolderMoveAccess {
  scopes: readonly string[];
  /** Scope that authorizes changing where a resource lives, e.g. `databases:edit`. */
  editScope: string;
}

/**
 * A folder move re-parents every resource inside the folder and its
 * subfolders. Folder-scoped grants on the destination (for example
 * `databases:credentials:reveal:folder/F`) then extend to all of them, so the
 * caller must be allowed to edit every moved resource and to place resources
 * in the destination, exactly as for moving the resources one by one.
 */
export function assertFolderMoveAccess(
  access: FolderMoveAccess,
  resourceIds: readonly string[],
  destinationFolderId: string | null
): void {
  const scopes = [...access.scopes];
  if (!resourceIds.every((resourceId) => hasScopeForResource(scopes, access.editScope, resourceId))) {
    throw new AppError(
      403,
      'FORBIDDEN',
      `Missing ${access.editScope} for one or more resources inside the moved folder`
    );
  }
  if (!hasScopeForCreation(scopes, access.editScope, destinationFolderId)) {
    throw new AppError(403, 'FORBIDDEN', `Missing ${access.editScope} for the move destination`);
  }
}

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

  /**
   * Folder create, move and delete run one at a time per folder tree, in one
   * transaction under an advisory lock. Two concurrent moves (A under B, B
   * under A) would otherwise both pass the descendant check and commit a
   * parent cycle, and depth bookkeeping would drift.
   */
  private withTreeLock<T>(fn: (tx: DrizzleTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`resource-folders:${this.config.auditResourceType}`}))`
      );
      return fn(tx);
    });
  }

  private async getFolderOrThrow(id: string, db: DrizzleExecutor = this.db): Promise<FolderRow> {
    const [folder] = await db
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

  private async getNextSortOrder(parentId: string | null, db: DrizzleExecutor = this.db): Promise<number> {
    const siblings = await db
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
    const folder = await this.withTreeLock(async (tx) => {
      let depth = 0;
      if (input.parentId) {
        const parent = await this.getFolderOrThrow(input.parentId, tx);
        if (parent.depth >= MAX_DEPTH) {
          throw new AppError(400, 'MAX_DEPTH_EXCEEDED', `Maximum folder nesting depth is ${MAX_DEPTH + 1} levels`);
        }
        depth = parent.depth + 1;
      }

      const rows = (await tx
        .insert(this.config.folderTable)
        .values({
          ...this.config.folderDefaults,
          name: input.name,
          parentId: input.parentId ?? null,
          sortOrder: await this.getNextSortOrder(input.parentId ?? null, tx),
          depth,
          createdById: userId,
        })
        .returning()) as FolderRow[];
      const created = rows[0];
      if (!created) throw new AppError(500, 'FOLDER_CREATE_FAILED', 'Folder was not created');
      return created;
    });

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

  async moveFolder(id: string, input: MoveResourceFolderInput, userId: string, access?: FolderMoveAccess) {
    const result = await this.withTreeLock(async (tx) => {
      const folder = await this.getFolderOrThrow(id, tx);
      if (folder.parentId === input.parentId) return { folder, moved: false as const };

      // Read inside the lock: a concurrent move has either committed or not started.
      const descendants = await this.getDescendantIds(id, tx);
      let newDepth = 0;
      if (input.parentId) {
        const parent = await this.getFolderOrThrow(input.parentId, tx);
        if (input.parentId === id || descendants.includes(input.parentId)) {
          throw new AppError(400, 'CIRCULAR_REFERENCE', 'Cannot move folder into its own descendant');
        }
        newDepth = parent.depth + 1;
      }

      const subtreeHeight = (await this.getMaxSubtreeDepth(id, tx)) - folder.depth;
      if (newDepth + subtreeHeight > MAX_DEPTH) {
        throw new AppError(
          400,
          'MAX_DEPTH_EXCEEDED',
          `Moving this folder would exceed the maximum nesting depth of ${MAX_DEPTH + 1} levels`
        );
      }

      if (access) {
        const movedResources = (await tx
          .select({ id: this.config.resourceTable.id })
          .from(this.config.resourceTable)
          .where(
            and(this.config.resourceScope, inArray(this.config.resourceTable.folderId, [id, ...descendants]))
          )) as Array<{ id: string }>;
        assertFolderMoveAccess(
          access,
          movedResources.map((resource) => resource.id),
          input.parentId
        );
      }

      const depthDelta = newDepth - folder.depth;
      const [updated] = await tx
        .update(this.config.folderTable)
        .set({
          parentId: input.parentId,
          depth: newDepth,
          sortOrder: await this.getNextSortOrder(input.parentId, tx),
          updatedAt: new Date(),
        })
        .where(and(this.config.folderScope, eq(this.config.folderTable.id, id)))
        .returning();

      if (depthDelta !== 0 && descendants.length > 0) {
        await tx
          .update(this.config.folderTable)
          .set({
            depth: sql`${this.config.folderTable.depth} + ${depthDelta}`,
            updatedAt: new Date(),
          })
          .where(and(this.config.folderScope, inArray(this.config.folderTable.id, descendants)));
      }
      return { folder, moved: true as const, updated };
    });
    if (!result.moved) return result.folder;

    await this.auditService.log({
      userId,
      action: `${this.config.auditResourceType}.move`,
      resourceType: this.config.auditResourceType,
      resourceId: id,
      details: { oldParentId: result.folder.parentId, newParentId: input.parentId },
    });
    this.emitLayoutChanged('folder_updated', id);
    return result.updated;
  }

  async deleteFolder(id: string, userId: string) {
    const { folder, descendantIds, affected } = await this.withTreeLock(async (tx) => {
      const folder = await this.getFolderOrThrow(id, tx);
      const descendantIds = await this.getDescendantIds(id, tx);
      const folderIds = [id, ...descendantIds];
      const affected = await tx
        .select({ id: this.config.resourceTable.id })
        .from(this.config.resourceTable)
        .where(and(this.config.resourceScope, inArray(this.config.resourceTable.folderId, folderIds)));

      await tx.delete(this.config.folderTable).where(and(this.config.folderScope, eq(this.config.folderTable.id, id)));
      return { folder, descendantIds, affected };
    });
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

  /**
   * Every folder below `folderId`. The visited set keeps this finite even if
   * the stored tree already contains a parent cycle (written before moves were
   * serialized), instead of walking the cycle forever.
   */
  private async getDescendantIds(folderId: string, db: DrizzleExecutor = this.db): Promise<string[]> {
    const visited = new Set<string>([folderId]);
    const descendants: string[] = [];
    let currentLevel = [folderId];
    while (currentLevel.length > 0) {
      const children = await db
        .select({ id: this.config.folderTable.id })
        .from(this.config.folderTable)
        .where(and(this.config.folderScope, inArray(this.config.folderTable.parentId, currentLevel)));
      const nextLevel: string[] = [];
      for (const child of children as Array<{ id: string }>) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        descendants.push(child.id);
        nextLevel.push(child.id);
      }
      currentLevel = nextLevel;
    }
    return descendants;
  }

  private async getMaxSubtreeDepth(folderId: string, db: DrizzleExecutor = this.db): Promise<number> {
    const descendantIds = await this.getDescendantIds(folderId, db);
    const ids = [folderId, ...descendantIds];
    const [result] = await db
      .select({ maxDepth: sql<number>`max(${this.config.folderTable.depth})` })
      .from(this.config.folderTable)
      .where(and(this.config.folderScope, inArray(this.config.folderTable.id, ids)));
    return result?.maxDepth ?? 0;
  }
}
