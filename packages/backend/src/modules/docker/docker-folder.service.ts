import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerContainerFolderAssignments, dockerContainerFolders } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type {
  CreateDockerFolderInput,
  DockerFolderResourceRef,
  DockerFolderResourceType,
  MoveDockerContainersToFolderInput,
  MoveDockerResourcesToFolderInput,
  ReorderDockerContainersInput,
  ReorderDockerFoldersInput,
  ReorderDockerResourcesInput,
  UpdateDockerFolderInput,
} from './docker-folder.schemas.js';

const MAX_DEPTH = 2;
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

type FolderRow = typeof dockerContainerFolders.$inferSelect;
type AssignmentRow = typeof dockerContainerFolderAssignments.$inferSelect;

type DockerContainerLike = {
  id?: string;
  Id?: string;
  name?: string;
  Name?: string;
  labels?: Record<string, string>;
  Labels?: Record<string, string>;
  [key: string]: unknown;
};

export interface DockerFolderTreeNode extends FolderRow {
  children: DockerFolderTreeNode[];
}

function getContainerName(container: DockerContainerLike): string {
  return String(container.name ?? container.Name ?? '').replace(/^\//, '');
}

function getContainerLabels(container: DockerContainerLike): Record<string, string> {
  return (container.labels ?? container.Labels ?? {}) as Record<string, string>;
}

function getComposeProject(container: DockerContainerLike): string | null {
  return getContainerLabels(container)['com.docker.compose.project'] ?? null;
}

function getComposeService(container: DockerContainerLike): string | null {
  return getContainerLabels(container)['com.docker.compose.service'] ?? null;
}

export class DockerFolderService {
  private eventBus?: EventBusService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  private async getAffectedNodeIdsForFolders(folderIds: Array<string | null | undefined>): Promise<string[]> {
    const ids = [...new Set(folderIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return [];

    const allFolders = await this.db.select().from(dockerContainerFolders);
    const affectedFolderIds = new Set(ids);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of allFolders) {
        if (folder.parentId && affectedFolderIds.has(folder.parentId) && !affectedFolderIds.has(folder.id)) {
          affectedFolderIds.add(folder.id);
          changed = true;
        }
      }
    }

    const assignments = await this.db
      .select({ nodeId: dockerContainerFolderAssignments.nodeId })
      .from(dockerContainerFolderAssignments)
      .where(inArray(dockerContainerFolderAssignments.folderId, [...affectedFolderIds]));
    return [...new Set(assignments.map((row) => row.nodeId))];
  }

  private emitLayoutChanged(action: string, folderId?: string | null, nodeIds: string[] = []) {
    this.eventBus?.publish('docker.folder.changed', { action, folderId, nodeIds });
  }

  private async getNextSortOrder(resourceType: DockerFolderResourceType, parentId: string | null): Promise<number> {
    const siblings = await this.db
      .select({ sortOrder: dockerContainerFolders.sortOrder })
      .from(dockerContainerFolders)
      .where(
        and(
          eq(dockerContainerFolders.resourceType, resourceType),
          parentId ? eq(dockerContainerFolders.parentId, parentId) : isNull(dockerContainerFolders.parentId)
        )
      )
      .orderBy(desc(dockerContainerFolders.sortOrder))
      .limit(1);

    return siblings.length > 0 ? siblings[0].sortOrder + 1 : 0;
  }

  private async getFolderOrThrow(id: string, resourceType?: DockerFolderResourceType): Promise<FolderRow> {
    const folder = await this.db.query.dockerContainerFolders.findFirst({
      where: eq(dockerContainerFolders.id, id),
    });
    if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
    if (resourceType && folder.resourceType !== resourceType) {
      throw new AppError(400, 'FOLDER_RESOURCE_TYPE_MISMATCH', 'Folder belongs to a different Docker resource type');
    }
    return folder;
  }

  private assertFolderMutable(folder: FolderRow) {
    if (folder.isSystem) {
      throw new AppError(400, 'SYSTEM_FOLDER_LOCKED', 'Protected compose deployment folders cannot be modified');
    }
  }

  async createFolder(input: CreateDockerFolderInput, userId: string) {
    let depth = 0;
    const resourceType = input.resourceType;

    if (input.parentId) {
      const parent = await this.getFolderOrThrow(input.parentId, resourceType);
      this.assertFolderMutable(parent);
      if (parent.depth >= MAX_DEPTH) {
        throw new AppError(400, 'MAX_DEPTH_EXCEEDED', `Maximum folder nesting depth is ${MAX_DEPTH + 1} levels`);
      }
      depth = parent.depth + 1;
    }

    const [folder] = await this.db
      .insert(dockerContainerFolders)
      .values({
        name: input.name,
        resourceType,
        parentId: input.parentId ?? null,
        sortOrder: await this.getNextSortOrder(resourceType, input.parentId ?? null),
        depth,
        createdById: userId,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'docker_folder.create',
      resourceType: 'docker_folder',
      resourceId: folder.id,
      details: { name: folder.name, parentId: folder.parentId, resourceType },
    });

    this.emitLayoutChanged('folder_created', folder.id);
    return folder;
  }

  async updateFolder(id: string, input: UpdateDockerFolderInput, userId: string) {
    const folder = await this.getFolderOrThrow(id);
    this.assertFolderMutable(folder);

    const [updated] = await this.db
      .update(dockerContainerFolders)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(dockerContainerFolders.id, id))
      .returning();

    await this.auditService.log({
      userId,
      action: 'docker_folder.update',
      resourceType: 'docker_folder',
      resourceId: id,
      details: { oldName: folder.name, newName: input.name },
    });

    this.emitLayoutChanged('folder_updated', id, await this.getAffectedNodeIdsForFolders([id]));
    return updated;
  }

  async deleteFolder(id: string, userId: string) {
    const folder = await this.getFolderOrThrow(id);
    this.assertFolderMutable(folder);

    const nodeIds = await this.getAffectedNodeIdsForFolders([id]);
    await this.db.delete(dockerContainerFolders).where(eq(dockerContainerFolders.id, id));

    await this.auditService.log({
      userId,
      action: 'docker_folder.delete',
      resourceType: 'docker_folder',
      resourceId: id,
      details: { name: folder.name },
    });

    this.emitLayoutChanged('folder_deleted', id, nodeIds);
  }

  async reorderFolders(input: ReorderDockerFoldersInput, _userId: string) {
    const resourceType = input.resourceType;
    const folders = await this.db
      .select()
      .from(dockerContainerFolders)
      .where(
        inArray(
          dockerContainerFolders.id,
          input.items.map((item) => item.id)
        )
      );

    if (folders.length !== input.items.length) {
      throw new AppError(404, 'FOLDER_NOT_FOUND', 'One or more folders were not found');
    }
    if (folders.some((folder) => folder.resourceType !== resourceType)) {
      throw new AppError(400, 'FOLDER_RESOURCE_TYPE_MISMATCH', 'Folders belong to a different Docker resource type');
    }

    const parentIds = [...new Set(folders.map((folder) => folder.parentId ?? null))];
    if (parentIds.length > 1) {
      throw new AppError(400, 'INVALID_REORDER', 'Folders can only be reordered within the same parent');
    }

    for (const item of input.items) {
      await this.db
        .update(dockerContainerFolders)
        .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
        .where(eq(dockerContainerFolders.id, item.id));
    }

    this.emitLayoutChanged(
      'folders_reordered',
      null,
      await this.getAffectedNodeIdsForFolders(input.items.map((item) => item.id))
    );
  }

  async getFolderTree(options?: {
    resourceType?: DockerFolderResourceType;
    includeAllFolders?: boolean;
    allowedNodeIds?: string[];
    allowedResourceRefs?: DockerFolderResourceRef[];
  }): Promise<DockerFolderTreeNode[]> {
    const resourceType = options?.resourceType ?? 'container';
    const allFolders = await this.db
      .select()
      .from(dockerContainerFolders)
      .where(eq(dockerContainerFolders.resourceType, resourceType))
      .orderBy(asc(dockerContainerFolders.depth), asc(dockerContainerFolders.sortOrder));

    if (!options?.includeAllFolders && (options?.allowedNodeIds || options?.allowedResourceRefs)) {
      const allowedNodeIds = options.allowedNodeIds ?? [];
      const allowedResourceRefs = options.allowedResourceRefs ?? [];
      if (allowedNodeIds.length === 0 && allowedResourceRefs.length === 0) return [];
      const visibilityFilters = [
        allowedNodeIds.length > 0 ? inArray(dockerContainerFolderAssignments.nodeId, allowedNodeIds) : undefined,
        ...allowedResourceRefs.map((resource) =>
          and(
            eq(dockerContainerFolderAssignments.nodeId, resource.nodeId),
            eq(dockerContainerFolderAssignments.resourceKey, resource.resourceKey)
          )
        ),
      ].filter((condition): condition is NonNullable<typeof condition> => !!condition);
      const assignments = await this.db
        .select({ folderId: dockerContainerFolderAssignments.folderId })
        .from(dockerContainerFolderAssignments)
        .where(and(eq(dockerContainerFolderAssignments.resourceType, resourceType), or(...visibilityFilters)));
      const visibleIds = new Set(assignments.map((row) => row.folderId).filter((id): id is string => !!id));
      for (const folder of [...allFolders].sort((a, b) => b.depth - a.depth)) {
        if (visibleIds.has(folder.id) && folder.parentId) visibleIds.add(folder.parentId);
      }
      return this.buildTree(allFolders.filter((folder) => visibleIds.has(folder.id)));
    }

    return this.buildTree(allFolders);
  }

  async moveContainersToFolder(input: MoveDockerContainersToFolderInput, userId: string) {
    return this.moveResourcesToFolder(
      {
        resourceType: 'container',
        folderId: input.folderId,
        items: input.items.map((item) => ({ nodeId: item.nodeId, resourceKey: item.containerName })),
      },
      userId
    );
  }

  async moveResourcesToFolder(input: MoveDockerResourcesToFolderInput, userId: string) {
    const resourceType = input.resourceType;
    let targetFolder: FolderRow | null = null;
    if (input.folderId) {
      targetFolder = await this.getFolderOrThrow(input.folderId, resourceType);
      if (targetFolder.isSystem) {
        throw new AppError(
          400,
          'SYSTEM_FOLDER_LOCKED',
          'Resources cannot be moved into protected compose deployment folders'
        );
      }
    }

    const assignmentRows = await this.getAssignmentsForResourceRefs(resourceType, input.items);
    const sourceFolderIds = [...new Set(assignmentRows.map((row) => row.folderId).filter((id): id is string => !!id))];
    if (sourceFolderIds.length > 0) {
      const sourceFolders = await this.db
        .select({ id: dockerContainerFolders.id, isSystem: dockerContainerFolders.isSystem })
        .from(dockerContainerFolders)
        .where(
          and(
            eq(dockerContainerFolders.resourceType, resourceType),
            inArray(dockerContainerFolders.id, sourceFolderIds)
          )
        );
      if (sourceFolders.some((folder) => folder.isSystem)) {
        throw new AppError(
          400,
          'SYSTEM_FOLDER_LOCKED',
          'Resources cannot be moved out of protected compose deployment folders'
        );
      }
    }

    if (!targetFolder) {
      const byNode = new Map<string, string[]>();
      for (const item of input.items) {
        const current = byNode.get(item.nodeId) ?? [];
        current.push(item.resourceKey);
        byNode.set(item.nodeId, current);
      }

      for (const [nodeId, names] of byNode.entries()) {
        const maxSort = await this.db
          .select({ sortOrder: dockerContainerFolderAssignments.sortOrder })
          .from(dockerContainerFolderAssignments)
          .where(
            and(
              eq(dockerContainerFolderAssignments.nodeId, nodeId),
              eq(dockerContainerFolderAssignments.resourceType, resourceType),
              isNull(dockerContainerFolderAssignments.folderId)
            )
          )
          .orderBy(desc(dockerContainerFolderAssignments.sortOrder))
          .limit(1);
        let nextSortOrder = maxSort.length > 0 ? maxSort[0].sortOrder + 1 : 0;

        for (const resourceKey of names) {
          await this.db
            .insert(dockerContainerFolderAssignments)
            .values({
              nodeId,
              resourceType,
              resourceKey,
              containerName: resourceType === 'container' ? resourceKey : null,
              folderId: null,
              sortOrder: nextSortOrder++,
            })
            .onConflictDoUpdate({
              target: [
                dockerContainerFolderAssignments.nodeId,
                dockerContainerFolderAssignments.resourceType,
                dockerContainerFolderAssignments.resourceKey,
              ],
              set: {
                folderId: null,
                sortOrder: nextSortOrder - 1,
                updatedAt: new Date(),
              },
            });
        }
      }
    } else {
      const maxSort = await this.db
        .select({ sortOrder: dockerContainerFolderAssignments.sortOrder })
        .from(dockerContainerFolderAssignments)
        .where(
          and(
            eq(dockerContainerFolderAssignments.resourceType, resourceType),
            eq(dockerContainerFolderAssignments.folderId, targetFolder.id)
          )
        )
        .orderBy(desc(dockerContainerFolderAssignments.sortOrder))
        .limit(1);
      let nextSortOrder = maxSort.length > 0 ? maxSort[0].sortOrder + 1 : 0;

      for (const item of input.items) {
        await this.db
          .insert(dockerContainerFolderAssignments)
          .values({
            nodeId: item.nodeId,
            resourceType,
            resourceKey: item.resourceKey,
            containerName: resourceType === 'container' ? item.resourceKey : null,
            folderId: targetFolder.id,
            sortOrder: nextSortOrder++,
          })
          .onConflictDoUpdate({
            target: [
              dockerContainerFolderAssignments.nodeId,
              dockerContainerFolderAssignments.resourceType,
              dockerContainerFolderAssignments.resourceKey,
            ],
            set: {
              folderId: targetFolder.id,
              sortOrder: nextSortOrder - 1,
              updatedAt: new Date(),
            },
          });
      }
    }

    await this.auditService.log({
      userId,
      action: resourceType === 'container' ? 'docker_container.move_to_folder' : 'docker_resource.move_to_folder',
      resourceType: 'docker-resource',
      details: { items: input.items, folderId: input.folderId, folderResourceType: resourceType },
    });

    this.emitLayoutChanged('resources_moved', input.folderId, [...new Set(input.items.map((item) => item.nodeId))]);
  }

  async reorderContainers(input: ReorderDockerContainersInput, userId: string) {
    return this.reorderResources(
      {
        resourceType: 'container',
        items: input.items.map((item) => ({
          nodeId: item.nodeId,
          resourceKey: item.containerName,
          sortOrder: item.sortOrder,
        })),
      },
      userId
    );
  }

  async reorderResources(input: ReorderDockerResourcesInput, _userId: string) {
    const resourceType = input.resourceType;
    const assignmentRows = await this.getAssignmentsForResourceRefs(resourceType, input.items);
    if (assignmentRows.length !== input.items.length) {
      throw new AppError(400, 'INVALID_REORDER', 'All resources must have persisted placement before reordering');
    }

    const folderIds = [...new Set(assignmentRows.map((row) => row.folderId ?? null))];
    if (folderIds.length > 1) {
      throw new AppError(400, 'INVALID_REORDER', 'Containers can only be reordered within the same parent section');
    }

    const nonNullFolderIds = folderIds.filter((id): id is string => !!id);
    if (nonNullFolderIds.length > 0) {
      const folders = await this.db
        .select({ id: dockerContainerFolders.id, isSystem: dockerContainerFolders.isSystem })
        .from(dockerContainerFolders)
        .where(
          and(
            eq(dockerContainerFolders.resourceType, resourceType),
            inArray(dockerContainerFolders.id, nonNullFolderIds)
          )
        );

      if (folders.some((folder) => folder.isSystem)) {
        throw new AppError(
          400,
          'SYSTEM_FOLDER_LOCKED',
          'Protected compose deployment folders cannot be reordered manually'
        );
      }
    }

    for (const item of input.items) {
      await this.db
        .update(dockerContainerFolderAssignments)
        .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
        .where(
          and(
            eq(dockerContainerFolderAssignments.nodeId, item.nodeId),
            eq(dockerContainerFolderAssignments.resourceType, resourceType),
            eq(dockerContainerFolderAssignments.resourceKey, item.resourceKey)
          )
        );
    }

    this.emitLayoutChanged('resources_reordered', null, [...new Set(input.items.map((item) => item.nodeId))]);
  }

  async getPlacementsForRefs(items: Array<{ nodeId: string; containerName: string }>) {
    const placements = await this.getResourcePlacementsForRefs(
      'container',
      items.map((item) => ({ nodeId: item.nodeId, resourceKey: item.containerName }))
    );
    return placements.map((placement) => ({
      nodeId: placement.nodeId,
      containerName: placement.resourceKey,
      folderId: placement.folderId,
      folderIsSystem: placement.folderIsSystem,
      sortOrder: placement.sortOrder,
    }));
  }

  async getResourcePlacementsForRefs(resourceType: DockerFolderResourceType, items: DockerFolderResourceRef[]) {
    const assignmentRows = await this.getAssignmentsForResourceRefs(resourceType, items);
    if (assignmentRows.length === 0) return [];

    const folderIds = assignmentRows.map((row) => row.folderId).filter((id): id is string => !!id);
    const folders =
      folderIds.length > 0
        ? await this.db
            .select({ id: dockerContainerFolders.id, isSystem: dockerContainerFolders.isSystem })
            .from(dockerContainerFolders)
            .where(
              and(
                eq(dockerContainerFolders.resourceType, resourceType),
                inArray(dockerContainerFolders.id, [...new Set(folderIds)])
              )
            )
        : [];
    const folderById = new Map(folders.map((folder) => [folder.id, folder]));

    return assignmentRows.map((row) => ({
      nodeId: row.nodeId,
      resourceKey: row.resourceKey,
      folderId: row.folderId,
      folderIsSystem: row.folderId ? (folderById.get(row.folderId)?.isSystem ?? false) : false,
      sortOrder: row.sortOrder,
    }));
  }

  async syncNodeContainers(nodeId: string, containers: DockerContainerLike[]) {
    const normalized = containers
      .map((container) => ({
        name: getContainerName(container),
        project: getComposeProject(container),
        service: getComposeService(container),
      }))
      .filter((container) => container.name !== '');

    const composeGroups = new Map<string, Array<{ name: string; service: string | null }>>();
    for (const container of normalized) {
      if (!container.project) continue;
      const group = composeGroups.get(container.project) ?? [];
      group.push({ name: container.name, service: container.service });
      composeGroups.set(container.project, group);
    }

    const existingSystemFolders = await this.db
      .select()
      .from(dockerContainerFolders)
      .where(
        and(
          eq(dockerContainerFolders.nodeId, nodeId),
          eq(dockerContainerFolders.resourceType, 'container'),
          eq(dockerContainerFolders.isSystem, true)
        )
      );

    const activeProjects = [...composeGroups.keys()];
    const systemFoldersByProject = new Map<string, FolderRow>();
    for (const folder of existingSystemFolders) {
      if (folder.composeProject && activeProjects.includes(folder.composeProject)) {
        systemFoldersByProject.set(folder.composeProject, folder);
      }
    }

    for (const project of activeProjects) {
      if (systemFoldersByProject.has(project)) continue;
      const [created] = await this.db
        .insert(dockerContainerFolders)
        .values({
          name: project,
          resourceType: 'container',
          parentId: null,
          sortOrder: await this.getNextSortOrder('container', null),
          depth: 0,
          isSystem: true,
          nodeId,
          composeProject: project,
          createdById: SYSTEM_USER_ID,
        })
        .returning();
      systemFoldersByProject.set(project, created);
    }

    for (const [project, group] of composeGroups.entries()) {
      const folder = systemFoldersByProject.get(project);
      if (!folder) continue;
      const sorted = [...group].sort((a, b) => (a.service ?? a.name).localeCompare(b.service ?? b.name));
      for (const [index, container] of sorted.entries()) {
        await this.db
          .insert(dockerContainerFolderAssignments)
          .values({
            nodeId,
            resourceType: 'container',
            resourceKey: container.name,
            containerName: container.name,
            folderId: folder.id,
            sortOrder: index,
          })
          .onConflictDoUpdate({
            target: [
              dockerContainerFolderAssignments.nodeId,
              dockerContainerFolderAssignments.resourceType,
              dockerContainerFolderAssignments.resourceKey,
            ],
            set: {
              folderId: folder.id,
              sortOrder: index,
              updatedAt: new Date(),
            },
          });
      }
    }

    const staleSystemFolders = existingSystemFolders.filter(
      (folder) => folder.composeProject && !activeProjects.includes(folder.composeProject)
    );
    if (staleSystemFolders.length > 0) {
      const assignmentRows = await this.db
        .select({
          folderId: dockerContainerFolderAssignments.folderId,
        })
        .from(dockerContainerFolderAssignments)
        .where(
          and(
            eq(dockerContainerFolderAssignments.nodeId, nodeId),
            eq(dockerContainerFolderAssignments.resourceType, 'container'),
            inArray(
              dockerContainerFolderAssignments.folderId,
              staleSystemFolders.map((folder) => folder.id)
            )
          )
        );
      const folderIdsWithAssignments = new Set(
        assignmentRows.map((row) => row.folderId).filter((id): id is string => !!id)
      );
      const removableFolderIds = staleSystemFolders
        .filter((folder) => !folderIdsWithAssignments.has(folder.id))
        .map((folder) => folder.id);
      if (removableFolderIds.length > 0) {
        await this.db.delete(dockerContainerFolders).where(inArray(dockerContainerFolders.id, removableFolderIds));
      }
    }

    const folderRows = await this.db
      .select()
      .from(dockerContainerFolders)
      .where(eq(dockerContainerFolders.resourceType, 'container'));
    const folderById = new Map(folderRows.map((folder) => [folder.id, folder]));

    const assignments = await this.db
      .select()
      .from(dockerContainerFolderAssignments)
      .where(
        and(
          eq(dockerContainerFolderAssignments.nodeId, nodeId),
          eq(dockerContainerFolderAssignments.resourceType, 'container')
        )
      );

    const assignmentByName = new Map(assignments.map((assignment) => [assignment.resourceKey, assignment]));

    return normalized.map((container) => {
      const assignment = assignmentByName.get(container.name);
      const folder = assignment?.folderId ? folderById.get(assignment.folderId) : undefined;
      return {
        containerName: container.name,
        folderId: assignment?.folderId ?? null,
        folderIsSystem: folder?.isSystem ?? false,
        sortOrder: assignment?.sortOrder ?? 0,
      };
    });
  }

  async renameContainerAssignment(nodeId: string, oldName: string, newName: string) {
    await this.renameResourceAssignment(nodeId, 'container', oldName, newName);
  }

  async renameResourceAssignment(
    nodeId: string,
    resourceType: DockerFolderResourceType,
    oldName: string,
    newName: string
  ) {
    if (oldName === newName) return;
    const assignment = await this.db.query.dockerContainerFolderAssignments.findFirst({
      where: and(
        eq(dockerContainerFolderAssignments.nodeId, nodeId),
        eq(dockerContainerFolderAssignments.resourceType, resourceType),
        eq(dockerContainerFolderAssignments.resourceKey, oldName)
      ),
    });
    if (!assignment) return;

    await this.db
      .delete(dockerContainerFolderAssignments)
      .where(
        and(
          eq(dockerContainerFolderAssignments.nodeId, nodeId),
          eq(dockerContainerFolderAssignments.resourceType, resourceType),
          eq(dockerContainerFolderAssignments.resourceKey, newName)
        )
      );

    await this.db
      .update(dockerContainerFolderAssignments)
      .set({
        resourceKey: newName,
        containerName: resourceType === 'container' ? newName : null,
        updatedAt: new Date(),
      })
      .where(eq(dockerContainerFolderAssignments.id, assignment.id));
  }

  async deleteContainerAssignment(nodeId: string, containerName: string) {
    await this.db
      .delete(dockerContainerFolderAssignments)
      .where(
        and(
          eq(dockerContainerFolderAssignments.nodeId, nodeId),
          eq(dockerContainerFolderAssignments.resourceType, 'container'),
          eq(dockerContainerFolderAssignments.resourceKey, containerName)
        )
      );
  }

  private async getAssignmentsForResourceRefs(
    resourceType: DockerFolderResourceType,
    items: Array<{ nodeId: string; resourceKey: string }>
  ): Promise<AssignmentRow[]> {
    const byNode = new Map<string, string[]>();
    for (const item of items) {
      const list = byNode.get(item.nodeId) ?? [];
      list.push(item.resourceKey);
      byNode.set(item.nodeId, list);
    }

    const rows: AssignmentRow[] = [];
    for (const [nodeId, names] of byNode.entries()) {
      const found = await this.db
        .select()
        .from(dockerContainerFolderAssignments)
        .where(
          and(
            eq(dockerContainerFolderAssignments.nodeId, nodeId),
            eq(dockerContainerFolderAssignments.resourceType, resourceType),
            inArray(dockerContainerFolderAssignments.resourceKey, [...new Set(names)])
          )
        );
      rows.push(...found);
    }
    return rows;
  }

  private buildTree(folders: FolderRow[]): DockerFolderTreeNode[] {
    const nodeMap = new Map<string, DockerFolderTreeNode>();
    for (const folder of folders) {
      nodeMap.set(folder.id, { ...folder, children: [] });
    }

    const roots: DockerFolderTreeNode[] = [];
    for (const folder of folders) {
      const node = nodeMap.get(folder.id)!;
      if (folder.parentId && nodeMap.has(folder.parentId)) {
        nodeMap.get(folder.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }
}
