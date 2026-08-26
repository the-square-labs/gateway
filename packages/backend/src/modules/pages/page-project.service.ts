import { and, asc, count, desc, eq, ilike, inArray, isNull, max, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerSourceBindings,
  nodes,
  pageDeployments,
  pageProjectFolders,
  pageProjects,
  pageRouteTargets,
  pageRuntimeConfigs,
  pageTagActivations,
  pageTags,
} from '@/db/schema/index.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { PAGE_EVENT_CHANNELS, pageProjectEvent } from './page-events.js';
import type {
  CreatePageProjectInput,
  MigratePageProjectInput,
  PageProjectListQuery,
  UpdatePageProjectInput,
} from './page-project.schemas.js';
import { hasRequiredNginxPagesCapabilities } from './profile/page-node-capability.js';
import type { PageRetentionService } from './retention/page-retention.service.js';

export interface PageProjectRuntimeAdapter {
  stageProjectMigration(projectId: string, targetNodeId: string): Promise<void>;
  cleanupProjectNode(projectId: string, nodeId: string): Promise<void>;
}

export class PageProjectService {
  private eventBus?: EventBusService;
  private retentionService?: PageRetentionService;
  private runtimeAdapter?: PageProjectRuntimeAdapter;
  private readonly migrationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  setRetentionService(retentionService: PageRetentionService): void {
    this.retentionService = retentionService;
  }

  setRuntimeAdapter(runtimeAdapter: PageProjectRuntimeAdapter): void {
    this.runtimeAdapter = runtimeAdapter;
  }

  private emit(projectId: string, action: string): void {
    this.eventBus?.publish(PAGE_EVENT_CHANNELS.project, pageProjectEvent(projectId, action, { id: projectId }));
  }

  async list(query: PageProjectListQuery, options?: { allowedIds?: string[] }) {
    const conditions = [];
    if (options?.allowedIds) conditions.push(inArray(pageProjects.id, options.allowedIds));
    if (query.search) conditions.push(ilike(pageProjects.name, `%${query.search}%`));
    if (query.folderId !== undefined) {
      conditions.push(
        query.folderId === null ? isNull(pageProjects.folderId) : eq(pageProjects.folderId, query.folderId)
      );
    }
    const where = buildWhere(conditions);
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(pageProjects)
        .where(where)
        .orderBy(asc(pageProjects.sortOrder), asc(pageProjects.name), desc(pageProjects.createdAt))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
      this.db.select({ total: count() }).from(pageProjects).where(where),
    ]);
    const data = await Promise.all(rows.map((project) => this.withCounts(project)));
    return {
      data,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async get(id: string) {
    const [project] = await this.db.select().from(pageProjects).where(eq(pageProjects.id, id)).limit(1);
    if (!project) throw new AppError(404, 'PAGE_PROJECT_NOT_FOUND', 'Page Project not found');
    return this.withCounts(project);
  }

  async getBySlug(slug: string) {
    const [project] = await this.db.select().from(pageProjects).where(eq(pageProjects.slug, slug)).limit(1);
    if (!project) throw new AppError(404, 'PAGE_PROJECT_NOT_FOUND', 'Page Project not found');
    return this.withCounts(project);
  }

  async create(input: CreatePageProjectInput, userId: string) {
    if (input.folderId) await this.assertFolderExists(input.folderId);
    await this.requirePlacementNode(input.nodeId);
    const [{ nextSortOrder }] = await this.db
      .select({ nextSortOrder: max(pageProjects.sortOrder) })
      .from(pageProjects)
      .where(input.folderId ? eq(pageProjects.folderId, input.folderId) : isNull(pageProjects.folderId));

    const project = await writeWithAllocatedSlug({
      source: input.name,
      fallback: 'page',
      constraint: 'page_projects_slug_unique',
      write: async (slug) => {
        return this.db.transaction(async (tx) => {
          const [created] = await tx
            .insert(pageProjects)
            .values({
              name: input.name,
              slug,
              description: input.description ?? null,
              nodeId: input.nodeId,
              folderId: input.folderId ?? null,
              sortOrder: (nextSortOrder ?? -1) + 1,
              maxDeployments: input.maxDeployments,
              storageQuotaBytes: input.storageQuotaBytes,
              createdById: userId,
              updatedById: userId,
            })
            .returning();
          if (!created) throw new AppError(500, 'PAGE_PROJECT_CREATE_FAILED', 'Page Project was not created');
          await tx.insert(pageTags).values({
            projectId: created.id,
            name: 'latest',
            system: true,
            updatedById: userId,
          });
          await tx.insert(pageRuntimeConfigs).values({
            projectId: created.id,
            value: {},
            updatedById: userId,
          });
          return created;
        });
      },
    });

    await this.auditService.log({
      userId,
      action: 'page_project.create',
      resourceType: 'page_project',
      resourceId: project.id,
      details: { name: project.name, slug: project.slug, folderId: project.folderId, nodeId: project.nodeId },
    });
    this.emit(project.id, 'created');
    return this.withCounts(project);
  }

  async placementOptions() {
    const rows = await this.db
      .select({
        id: nodes.id,
        displayName: nodes.displayName,
        hostname: nodes.hostname,
        status: nodes.status,
        capabilities: nodes.capabilities,
      })
      .from(nodes)
      .where(eq(nodes.type, 'nginx'))
      .orderBy(asc(nodes.displayName), asc(nodes.hostname));
    return rows.map(({ capabilities, ...node }) => ({
      ...node,
      pagesCapable: hasRequiredNginxPagesCapabilities(capabilities),
    }));
  }

  private async requirePlacementNode(nodeId: string) {
    const [node] = await this.db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node || node.type !== 'nginx' || node.status !== 'online') {
      throw new AppError(409, 'PAGES_PROJECT_NODE_UNAVAILABLE', 'Select an online Nginx node');
    }
    if (!hasRequiredNginxPagesCapabilities(node.capabilities)) {
      throw new AppError(409, 'PAGES_DAEMON_UPDATE_REQUIRED', 'Update the selected Nginx daemon to use Pages');
    }
    return node;
  }

  async migrate(id: string, input: MigratePageProjectInput, userId: string) {
    return this.withMigrationLock(id, async () => {
      const target = await this.requirePlacementNode(input.targetNodeId);
      const project = await this.get(id);
      if (!this.runtimeAdapter) {
        throw new AppError(503, 'PAGES_RUNTIME_UNAVAILABLE', 'Pages runtime is unavailable');
      }
      if (project.nodeId === target.id && !project.migrationStatus) return project;
      if (project.migrationStatus === 'staging' || project.migrationStatus === 'cleanup_pending') {
        throw new AppError(409, 'PAGE_PROJECT_MIGRATION_IN_PROGRESS', 'Page Project migration is already in progress');
      }
      if (
        project.migrationStatus === 'failed' &&
        project.migrationTargetNodeId &&
        project.migrationTargetNodeId !== project.nodeId
      ) {
        await this.runtimeAdapter.cleanupProjectNode(id, project.migrationTargetNodeId);
      }
      const generation = project.migrationGeneration + 1;
      const [claimed] = await this.db
        .update(pageProjects)
        .set({
          migrationSourceNodeId: project.nodeId,
          migrationTargetNodeId: target.id,
          migrationStatus: 'staging',
          migrationGeneration: generation,
          migrationError: null,
          updatedById: userId,
          updatedAt: new Date(),
        })
        .where(and(eq(pageProjects.id, id), eq(pageProjects.migrationGeneration, project.migrationGeneration)))
        .returning();
      if (!claimed) {
        throw new AppError(409, 'PAGE_PROJECT_MIGRATION_CONFLICT', 'Page Project placement changed concurrently');
      }
      this.emit(id, 'migration.staging');
      try {
        await this.runtimeAdapter.stageProjectMigration(id, target.id);
      } catch (error) {
        await this.db
          .update(pageProjects)
          .set({
            migrationStatus: 'failed',
            migrationError: error instanceof Error ? error.message.slice(0, 1000) : 'Migration staging failed',
            updatedAt: new Date(),
          })
          .where(and(eq(pageProjects.id, id), eq(pageProjects.migrationGeneration, generation)));
        this.emit(id, 'migration.failed');
        throw error;
      }
      const [activated] = await this.db
        .update(pageProjects)
        .set({ nodeId: target.id, migrationStatus: 'cleanup_pending', updatedById: userId, updatedAt: new Date() })
        .where(
          and(
            eq(pageProjects.id, id),
            eq(pageProjects.migrationGeneration, generation),
            eq(pageProjects.migrationStatus, 'staging')
          )
        )
        .returning();
      if (!activated) {
        throw new AppError(409, 'PAGE_PROJECT_MIGRATION_CONFLICT', 'Page Project placement changed during migration');
      }
      this.emit(id, 'migration.activated');
      if (project.nodeId) {
        try {
          await this.runtimeAdapter.cleanupProjectNode(id, project.nodeId);
        } catch (error) {
          await this.db
            .update(pageProjects)
            .set({
              migrationError: error instanceof Error ? error.message.slice(0, 1000) : 'Source cleanup failed',
              updatedAt: new Date(),
            })
            .where(and(eq(pageProjects.id, id), eq(pageProjects.migrationGeneration, generation)));
          await this.auditService.log({
            userId,
            action: 'page_project.migrate',
            resourceType: 'page_project',
            resourceId: id,
            details: { sourceNodeId: project.nodeId, targetNodeId: target.id, cleanupPending: true },
          });
          this.emit(id, 'migration.cleanup_pending');
          return this.get(id);
        }
      }
      await this.db
        .update(pageProjects)
        .set({
          migrationSourceNodeId: null,
          migrationTargetNodeId: null,
          migrationStatus: null,
          migrationError: null,
          updatedAt: new Date(),
        })
        .where(and(eq(pageProjects.id, id), eq(pageProjects.migrationGeneration, generation)));
      await this.auditService.log({
        userId,
        action: 'page_project.migrate',
        resourceType: 'page_project',
        resourceId: id,
        details: { sourceNodeId: project.nodeId, targetNodeId: target.id, cleanupPending: false },
      });
      this.emit(id, 'migration.completed');
      return this.get(id);
    });
  }

  async reconcileMigrations(): Promise<number> {
    if (!this.runtimeAdapter) return 0;
    const interrupted = await this.db
      .select({ id: pageProjects.id })
      .from(pageProjects)
      .where(eq(pageProjects.migrationStatus, 'staging'));
    for (const project of interrupted) {
      await this.db
        .update(pageProjects)
        .set({
          migrationStatus: 'failed',
          migrationError: 'Migration was interrupted before activation',
          updatedAt: new Date(),
        })
        .where(and(eq(pageProjects.id, project.id), eq(pageProjects.migrationStatus, 'staging')));
      this.emit(project.id, 'migration.failed');
    }
    const pending = await this.db
      .select({
        id: pageProjects.id,
        sourceNodeId: pageProjects.migrationSourceNodeId,
        generation: pageProjects.migrationGeneration,
      })
      .from(pageProjects)
      .where(eq(pageProjects.migrationStatus, 'cleanup_pending'));
    let cleaned = 0;
    for (const project of pending) {
      if (!project.sourceNodeId) continue;
      try {
        await this.runtimeAdapter.cleanupProjectNode(project.id, project.sourceNodeId);
        const [completed] = await this.db
          .update(pageProjects)
          .set({
            migrationSourceNodeId: null,
            migrationTargetNodeId: null,
            migrationStatus: null,
            migrationError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(pageProjects.id, project.id),
              eq(pageProjects.migrationGeneration, project.generation),
              eq(pageProjects.migrationStatus, 'cleanup_pending')
            )
          )
          .returning({ id: pageProjects.id });
        if (completed) {
          cleaned += 1;
          this.emit(project.id, 'migration.completed');
        }
      } catch (error) {
        await this.db
          .update(pageProjects)
          .set({
            migrationError: error instanceof Error ? error.message.slice(0, 1000) : 'Source cleanup failed',
            updatedAt: new Date(),
          })
          .where(and(eq(pageProjects.id, project.id), eq(pageProjects.migrationGeneration, project.generation)));
      }
    }
    return cleaned;
  }

  async update(id: string, input: UpdatePageProjectInput, userId: string) {
    const existing = await this.get(id);
    const [updated] = await this.db
      .update(pageProjects)
      .set({ ...input, updatedById: userId, updatedAt: new Date() })
      .where(eq(pageProjects.id, id))
      .returning();
    if (!updated) throw new AppError(404, 'PAGE_PROJECT_NOT_FOUND', 'Page Project not found');
    await this.auditService.log({
      userId,
      action: 'page_project.update',
      resourceType: 'page_project',
      resourceId: id,
      details: { name: updated.name, changes: Object.keys(input), previousName: existing.name },
    });
    this.emit(id, 'updated');
    if (input.maxDeployments !== undefined || input.storageQuotaBytes !== undefined) {
      await this.retentionService?.runProject(id);
    }
    return this.withCounts(updated);
  }

  async delete(id: string, userId: string): Promise<void> {
    const project = await this.get(id);
    if (project.deploymentCount > 0 || project.routeCount > 0) {
      throw new AppError(
        409,
        'PAGE_PROJECT_IN_USE',
        'Remove all Deployments and Pages Routes before deleting the Project',
        {
          deploymentCount: project.deploymentCount,
          routeCount: project.routeCount,
        }
      );
    }
    await this.db.transaction(async (tx) => {
      const activations = await tx
        .select({ id: pageTagActivations.id })
        .from(pageTagActivations)
        .innerJoin(pageTags, eq(pageTagActivations.tagId, pageTags.id))
        .where(eq(pageTags.projectId, id));
      if (activations.length > 0) {
        await tx.delete(pageTagActivations).where(
          inArray(
            pageTagActivations.id,
            activations.map((activation) => activation.id)
          )
        );
      }
      await tx.delete(dockerSourceBindings).where(eq(dockerSourceBindings.pageProjectId, id));
      await tx.delete(pageProjects).where(eq(pageProjects.id, id));
    });
    await this.auditService.log({
      userId,
      action: 'page_project.delete',
      resourceType: 'page_project',
      resourceId: id,
      details: { name: project.name, slug: project.slug },
    });
    this.emit(id, 'deleted');
  }

  private async assertFolderExists(folderId: string): Promise<void> {
    const [folder] = await this.db
      .select({ id: pageProjectFolders.id })
      .from(pageProjectFolders)
      .where(eq(pageProjectFolders.id, folderId))
      .limit(1);
    if (!folder) throw new AppError(404, 'PAGE_PROJECT_FOLDER_NOT_FOUND', 'Page Project folder not found');
  }

  private async withCounts(project: typeof pageProjects.$inferSelect) {
    const [[{ deploymentCount }], [{ tagCount }], [{ routeCount }]] = await Promise.all([
      this.db
        .select({ deploymentCount: count() })
        .from(pageDeployments)
        .where(and(eq(pageDeployments.projectId, project.id), ne(pageDeployments.status, 'deleted'))),
      this.db.select({ tagCount: count() }).from(pageTags).where(eq(pageTags.projectId, project.id)),
      this.db.select({ routeCount: count() }).from(pageRouteTargets).where(eq(pageRouteTargets.projectId, project.id)),
    ]);
    return { ...project, deploymentCount, tagCount, routeCount };
  }

  private async withMigrationLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.migrationLocks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.migrationLocks.set(projectId, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.migrationLocks.get(projectId) === tail) this.migrationLocks.delete(projectId);
    }
  }
}
