import { isDeepStrictEqual } from 'node:util';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type DockerComposeOperationAction,
  dockerComposeOperations,
  dockerComposeProjects,
  dockerComposeRevisions,
  dockerContainerFolderAssignments,
  dockerSecrets,
  managedDatabaseBindings,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { DockerSecretService } from '../docker-secret.service.js';
import type { DockerSnapshotService } from '../docker-snapshot.service.js';
import type { DockerSnapshotReconciler } from '../docker-snapshot-reconciler.service.js';
import type { DockerTaskService } from '../docker-task.service.js';
import type {
  ComposeCreateInput,
  ComposeOperationInput,
  ComposeOperationListQuery,
  ComposeRevisionCreateInput,
  ComposeYamlInput,
} from './compose.schemas.js';
import type { DockerComposeDispatcher, DockerComposeDispatchResult } from './compose-dispatcher.js';
import {
  addManagedDatabaseBindingToYaml,
  assertManagedDatabaseBindingInYaml,
  composeBindingSecretKey,
  decodeComposeServiceTarget,
  encodeComposeServiceTarget,
  removeManagedDatabaseBindingFromYaml,
} from './compose-managed-bindings.js';
import { prepareComposeGitBuild, validateComposeYaml } from './compose-policy.js';

const ACTIVE_OPERATION_STATUSES = ['pending', 'running', 'cancelling'] as const;
const INTERRUPTED_OPERATION_ERROR = 'Compose operation tracking interrupted by backend restart';

function encodeOperationCursor(operation: OperationRow) {
  return Buffer.from(JSON.stringify([operation.createdAt.toISOString(), operation.id]), 'utf8').toString('base64url');
}

function decodeOperationCursor(cursor: string) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string'
    ) {
      throw new Error('invalid cursor shape');
    }
    const createdAt = new Date(parsed[0]);
    if (
      !Number.isFinite(createdAt.getTime()) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed[1])
    ) {
      throw new Error('invalid cursor value');
    }
    return { createdAt, id: parsed[1] };
  } catch {
    throw new AppError(400, 'COMPOSE_OPERATION_CURSOR_INVALID', 'Compose activity cursor is invalid');
  }
}

type ProjectRow = typeof dockerComposeProjects.$inferSelect;
type RevisionRow = typeof dockerComposeRevisions.$inferSelect;
type OperationRow = typeof dockerComposeOperations.$inferSelect;

function composeSecretOwner(projectId: string) {
  return `compose:${projectId}`;
}

function isManagedDatabaseSecret(key: string) {
  return key.startsWith('GATEWAY_DB_');
}

function databaseErrorDetails(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof record.code === 'string') {
      return {
        code: record.code,
        constraint: typeof record.constraint === 'string' ? record.constraint : '',
      };
    }
    current = record.cause;
  }
  return null;
}

export class DockerComposeService {
  private dispatcher?: DockerComposeDispatcher;
  private eventBus?: EventBusService;
  private snapshotReconciler?: Pick<DockerSnapshotReconciler, 'refreshNow'>;
  private availabilityCoordinator?: {
    isManaged(projectId: string): Promise<boolean>;
    removeManaged(projectId: string, userId: string | null): Promise<boolean>;
    applyRevision(projectId: string, revisionId: string, userId: string | null): Promise<boolean>;
    setRunning(projectId: string, running: boolean, userId: string | null, restart?: boolean): Promise<boolean>;
  };

  constructor(
    private readonly db: DrizzleClient,
    private readonly audit: AuditService,
    private readonly tasks: DockerTaskService,
    private readonly secrets: DockerSecretService,
    private readonly snapshots?: DockerSnapshotService
  ) {}

  setDispatcher(dispatcher: DockerComposeDispatcher) {
    this.dispatcher = dispatcher;
  }

  setEventBus(eventBus: EventBusService) {
    this.eventBus = eventBus;
  }

  setSnapshotReconciler(reconciler: Pick<DockerSnapshotReconciler, 'refreshNow'>) {
    this.snapshotReconciler = reconciler;
  }

  setAvailabilityCoordinator(coordinator: NonNullable<DockerComposeService['availabilityCoordinator']>): void {
    this.availabilityCoordinator = coordinator;
  }

  validate(input: ComposeYamlInput) {
    return validateComposeYaml(input);
  }

  async list(nodeId?: string) {
    const rows = await this.db
      .select({
        project: dockerComposeProjects,
        folderId: dockerContainerFolderAssignments.folderId,
        folderSortOrder: dockerContainerFolderAssignments.sortOrder,
      })
      .from(dockerComposeProjects)
      .leftJoin(
        dockerContainerFolderAssignments,
        and(
          eq(dockerContainerFolderAssignments.nodeId, dockerComposeProjects.nodeId),
          eq(dockerContainerFolderAssignments.resourceType, 'compose'),
          sql`${dockerContainerFolderAssignments.resourceKey} = ${dockerComposeProjects.id}::text`
        )
      )
      .where(nodeId ? eq(dockerComposeProjects.nodeId, nodeId) : undefined)
      .orderBy(dockerComposeProjects.name);

    const runtimeByNode = new Map<string, Promise<Awaited<ReturnType<DockerComposeService['loadNodeRuntime']>>>>();
    const runtimeForNode = (id: string) => {
      const existing = runtimeByNode.get(id);
      if (existing) return existing;
      const created = this.loadNodeRuntime(id);
      runtimeByNode.set(id, created);
      return created;
    };
    return Promise.all(
      rows.map(async ({ project, folderId, folderSortOrder }) => {
        const [activeRevision, operations] = await Promise.all([
          project.activeRevisionId ? this.getRevision(project.id, project.activeRevisionId) : null,
          this.queryOperations(project.id, { limit: 1 }),
        ]);
        const runtime = this.projectRuntime(
          await runtimeForNode(project.nodeId),
          project.name,
          project,
          activeRevision
        );
        return {
          ...project,
          scopeResourceId: project.id,
          folderId,
          folderSortOrder,
          lastOperation: operations.data[0] ?? null,
          ...runtime,
        };
      })
    );
  }

  async get(nodeId: string, projectId: string) {
    const project = await this.getProject(nodeId, projectId);
    const [activeRevision, revisions] = await Promise.all([
      project.activeRevisionId ? this.getRevision(project.id, project.activeRevisionId) : null,
      this.listRevisions(project.id),
    ]);
    const runtime = this.projectRuntime(await this.loadNodeRuntime(nodeId), project.name, project, activeRevision);
    return {
      ...project,
      scopeResourceId: project.id,
      activeRevision,
      revisions,
      ...runtime,
    };
  }

  async findByName(nodeId: string, name: string) {
    const [project] = await this.db
      .select()
      .from(dockerComposeProjects)
      .where(and(eq(dockerComposeProjects.nodeId, nodeId), eq(dockerComposeProjects.name, name)))
      .limit(1);
    return project ?? null;
  }

  async create(nodeId: string, input: ComposeCreateInput, userId: string) {
    const validation = validateComposeYaml(input);
    this.assertValid(validation);

    const result = await this.db.transaction(async (tx) => {
      const [project] = await tx
        .insert(dockerComposeProjects)
        .values({
          nodeId,
          name: input.projectName,
          managementState: 'managed',
          desiredState: 'stopped',
          status: 'stopped',
          availability: 'available',
          createdById: userId,
          updatedById: userId,
        })
        .returning();
      const [revision] = await tx
        .insert(dockerComposeRevisions)
        .values({
          projectId: project.id,
          revisionNumber: 1,
          sourceYaml: input.yaml,
          originalYaml: input.yaml,
          normalizedModel: validation.normalizedModel!,
          configDigest: validation.configDigest!,
          variables: input.variables,
          secretKeys: [...new Set(input.secretKeys)].sort(),
          createdById: userId,
        })
        .returning();
      const [updated] = await tx
        .update(dockerComposeProjects)
        .set({ activeRevisionId: revision.id, updatedAt: new Date() })
        .where(eq(dockerComposeProjects.id, project.id))
        .returning();
      return { project: updated, revision };
    });

    await this.audit.log({
      userId,
      action: 'docker.compose.create',
      resourceType: 'docker-compose-project',
      resourceId: result.project.id,
      details: { nodeId, name: result.project.name, revisionId: result.revision.id },
    });
    this.emit('created', result.project);
    return result;
  }

  async createPendingGitProject(nodeId: string, projectName: string, userId: string) {
    const [project] = await this.db
      .insert(dockerComposeProjects)
      .values({
        nodeId,
        name: projectName,
        managementState: 'managed',
        desiredState: 'running',
        status: 'validating',
        availability: 'available',
        createdById: userId,
        updatedById: userId,
      })
      .returning();
    await this.audit.log({
      userId,
      action: 'docker.compose.source.create',
      resourceType: 'docker-compose-project',
      resourceId: project.id,
      details: { nodeId, name: project.name },
    });
    this.emit('created', project, { source: 'repository' });
    return project;
  }

  async discardPendingGitProject(projectId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(dockerComposeProjects)
      .where(and(eq(dockerComposeProjects.id, projectId), sql`${dockerComposeProjects.activeRevisionId} IS NULL`))
      .returning({ id: dockerComposeProjects.id });
    return deleted.length > 0;
  }

  async adopt(nodeId: string, projectId: string, input: ComposeRevisionCreateInput, userId: string) {
    const project = await this.getProject(nodeId, projectId);
    const validation = validateComposeYaml({ ...input, projectName: project.name });
    this.assertValid(validation);
    let revision = await this.getRevisionByDigest(project.id, validation.configDigest!);
    if (project.managementState !== 'external') {
      if (revision && project.activeRevisionId === revision.id) {
        return { project, revision, validation };
      }
      throw new AppError(409, 'COMPOSE_ALREADY_MANAGED', 'Only external Compose projects can be adopted');
    }
    if (!revision) {
      try {
        revision = await this.insertRevision(
          project,
          input,
          validation.normalizedModel!,
          validation.configDigest!,
          userId
        );
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'COMPOSE_REVISION_EXISTS') throw error;
        revision = await this.getRevisionByDigest(project.id, validation.configDigest!);
        if (!revision) throw error;
      }
    }
    const adoptedProject = await this.completeAdoption(project, revision.id, userId);
    await this.audit.log({
      userId,
      action: 'docker.compose.adopt',
      resourceType: 'docker-compose-project',
      resourceId: project.id,
      details: { nodeId, revisionId: revision.id },
    });
    this.emit('adopted', adoptedProject, { revisionId: revision.id });
    return { project: adoptedProject, revision, validation };
  }

  async createRevision(nodeId: string, projectId: string, input: ComposeRevisionCreateInput, userId: string) {
    const project = await this.getProject(nodeId, projectId);
    if (project.managementState !== 'managed') {
      throw new AppError(409, 'COMPOSE_EXTERNAL_READ_ONLY', 'External Compose projects must be adopted first');
    }
    const sourceValidation = validateComposeYaml({ ...input, projectName: project.name });
    this.assertValid(sourceValidation);
    const effectiveInput = await this.addCurrentManagedDatabaseBindings(project, input);
    const effectiveValidation = validateComposeYaml({ ...effectiveInput, projectName: project.name });
    this.assertValid(effectiveValidation);
    let revision: RevisionRow;
    try {
      revision = await this.insertRevision(
        project,
        effectiveInput,
        sourceValidation.normalizedModel!,
        effectiveValidation.configDigest!,
        userId,
        input.yaml
      );
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'COMPOSE_REVISION_EXISTS') throw error;
      // Secret values live outside immutable revision identity. Reapplying the
      // same YAML/keys after a secret update must still reach Pull & Apply.
      const existing = await this.getRevisionByDigest(project.id, effectiveValidation.configDigest!);
      if (!existing) throw error;
      return existing;
    }
    await this.audit.log({
      userId,
      action: 'docker.compose.revision.create',
      resourceType: 'docker-compose-project',
      resourceId: project.id,
      details: { nodeId, revisionId: revision.id, revisionNumber: revision.revisionNumber },
    });
    this.emit('revision_created', project, { revisionId: revision.id });
    return revision;
  }

  async createGitRevision(
    nodeId: string,
    projectId: string,
    input: ComposeRevisionCreateInput,
    source: { yaml: string; bindingId: string; batchId: string; commitSha: string },
    userId: string
  ) {
    const project = await this.getProject(nodeId, projectId);
    if (project.managementState !== 'managed') {
      throw new AppError(409, 'COMPOSE_EXTERNAL_READ_ONLY', 'External Compose projects must be adopted first');
    }
    const authored = prepareComposeGitBuild({ ...input, yaml: source.yaml, projectName: project.name });
    if (!authored.valid) {
      throw new AppError(400, 'COMPOSE_SOURCE_INVALID', 'Repository Compose configuration is invalid', {
        diagnostics: authored.diagnostics,
      });
    }
    const effectiveInput = await this.addCurrentManagedDatabaseBindings(project, input);
    const effectiveValidation = validateComposeYaml({ ...effectiveInput, projectName: project.name });
    this.assertValid(effectiveValidation);
    const revision = await this.insertRevision(
      project,
      effectiveInput,
      effectiveValidation.normalizedModel!,
      effectiveValidation.configDigest!,
      userId,
      source.yaml,
      { sourceBindingId: source.bindingId, buildBatchId: source.batchId, sourceCommitSha: source.commitSha }
    );
    this.emit('revision_created', project, { revisionId: revision.id, sourceCommitSha: source.commitSha });
    return revision;
  }

  async listRevisions(projectId: string) {
    return this.db
      .select()
      .from(dockerComposeRevisions)
      .where(eq(dockerComposeRevisions.projectId, projectId))
      .orderBy(desc(dockerComposeRevisions.revisionNumber));
  }

  async listOperations(nodeId: string, projectId: string, query: ComposeOperationListQuery) {
    await this.getProject(nodeId, projectId);
    return this.queryOperations(projectId, query);
  }

  private async queryOperations(projectId: string, query: ComposeOperationListQuery) {
    const cursor = query.cursor ? decodeOperationCursor(query.cursor) : null;
    const rows = await this.db
      .select()
      .from(dockerComposeOperations)
      .where(
        and(
          eq(dockerComposeOperations.projectId, projectId),
          cursor
            ? or(
                lt(dockerComposeOperations.createdAt, cursor.createdAt),
                and(eq(dockerComposeOperations.createdAt, cursor.createdAt), lt(dockerComposeOperations.id, cursor.id))
              )
            : undefined
        )
      )
      .orderBy(desc(dockerComposeOperations.createdAt), desc(dockerComposeOperations.id))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const data = rows.slice(0, query.limit);
    return {
      data,
      nextCursor: hasMore && data.length > 0 ? encodeOperationCursor(data[data.length - 1]!) : null,
    };
  }

  async getRevisionForApi(projectId: string, revisionId: string) {
    return this.getRevision(projectId, revisionId);
  }

  async deleteRevision(nodeId: string, projectId: string, revisionId: string, userId: string) {
    const project = await this.getProject(nodeId, projectId);
    const revision = await this.getRevision(projectId, revisionId);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-compose:${project.id}`}))`);
      const [currentProject] = await tx
        .select({
          activeRevisionId: dockerComposeProjects.activeRevisionId,
          status: dockerComposeProjects.status,
        })
        .from(dockerComposeProjects)
        .where(and(eq(dockerComposeProjects.id, project.id), eq(dockerComposeProjects.nodeId, nodeId)))
        .limit(1);
      if (!currentProject) throw new AppError(404, 'COMPOSE_PROJECT_NOT_FOUND', 'Compose project not found');
      if (currentProject.status === 'deleting') {
        throw new AppError(409, 'COMPOSE_DELETE_IN_PROGRESS', 'Compose project deletion is running');
      }
      if (currentProject.activeRevisionId === revision.id) {
        throw new AppError(409, 'COMPOSE_ACTIVE_REVISION', 'The active Compose revision cannot be deleted');
      }
      const [activeOperation] = await tx
        .select({ id: dockerComposeOperations.id })
        .from(dockerComposeOperations)
        .where(
          and(
            eq(dockerComposeOperations.projectId, project.id),
            eq(dockerComposeOperations.revisionId, revision.id),
            inArray(dockerComposeOperations.status, [...ACTIVE_OPERATION_STATUSES])
          )
        )
        .limit(1);
      if (activeOperation) {
        throw new AppError(
          409,
          'COMPOSE_REVISION_IN_USE',
          'The Compose revision is currently used by an active lifecycle operation'
        );
      }
      const deleted = await tx
        .delete(dockerComposeRevisions)
        .where(and(eq(dockerComposeRevisions.id, revision.id), eq(dockerComposeRevisions.projectId, project.id)))
        .returning({ id: dockerComposeRevisions.id });
      if (!deleted[0]) throw new AppError(404, 'COMPOSE_REVISION_NOT_FOUND', 'Compose revision not found');
    });
    await this.audit.log({
      userId,
      action: 'docker.compose.revision.delete',
      resourceType: 'docker-compose-project',
      resourceId: project.id,
      details: { nodeId, revisionId: revision.id, revisionNumber: revision.revisionNumber },
    });
    this.emit('revision_deleted', project, { revisionId: revision.id });
  }

  async deleteProject(nodeId: string, projectId: string, userId: string) {
    const project = await this.getProject(nodeId, projectId);
    const previousStatus = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-compose:${project.id}`}))`);
      const [current] = await tx
        .select({ managementState: dockerComposeProjects.managementState, status: dockerComposeProjects.status })
        .from(dockerComposeProjects)
        .where(and(eq(dockerComposeProjects.id, project.id), eq(dockerComposeProjects.nodeId, nodeId)))
        .limit(1);
      if (!current) throw new AppError(404, 'COMPOSE_PROJECT_NOT_FOUND', 'Compose project not found');
      if (current.managementState !== 'managed') {
        throw new AppError(409, 'COMPOSE_EXTERNAL_READ_ONLY', 'External Compose projects cannot be deleted');
      }
      if (current.status === 'deleting') {
        throw new AppError(409, 'COMPOSE_DELETE_IN_PROGRESS', 'Compose project deletion is already running');
      }
      const [active] = await tx
        .select({ id: dockerComposeOperations.id })
        .from(dockerComposeOperations)
        .where(
          and(
            eq(dockerComposeOperations.projectId, project.id),
            inArray(dockerComposeOperations.status, [...ACTIVE_OPERATION_STATUSES])
          )
        )
        .limit(1);
      if (active) throw new AppError(409, 'COMPOSE_OPERATION_IN_PROGRESS', 'Another Compose operation is running');
      const bindings = await tx
        .select({ targetResourceId: managedDatabaseBindings.targetResourceId })
        .from(managedDatabaseBindings)
        .where(
          and(
            eq(managedDatabaseBindings.targetNodeId, nodeId),
            eq(managedDatabaseBindings.targetType, 'compose_service')
          )
        );
      if (bindings.some((binding) => decodeComposeServiceTarget(binding.targetResourceId).projectId === project.id)) {
        throw new AppError(
          409,
          'COMPOSE_DATABASE_BINDINGS_EXIST',
          'Delete managed database links before deleting the Compose project'
        );
      }
      await tx
        .update(dockerComposeProjects)
        .set({ status: 'deleting', updatedAt: new Date() })
        .where(eq(dockerComposeProjects.id, project.id));
      return current.status;
    });

    try {
      const cleanup = await this.cleanupProjectRuntime(project, userId);

      await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-compose:${project.id}`}))`);
        const [current] = await tx
          .select({ managementState: dockerComposeProjects.managementState, status: dockerComposeProjects.status })
          .from(dockerComposeProjects)
          .where(and(eq(dockerComposeProjects.id, project.id), eq(dockerComposeProjects.nodeId, nodeId)))
          .limit(1);
        if (!current) throw new AppError(404, 'COMPOSE_PROJECT_NOT_FOUND', 'Compose project not found');
        if (current.managementState !== 'managed') {
          throw new AppError(409, 'COMPOSE_EXTERNAL_READ_ONLY', 'External Compose projects cannot be deleted');
        }
        if (current.status !== 'deleting') {
          throw new AppError(409, 'COMPOSE_DELETE_INTERRUPTED', 'Compose project deletion lost its runtime fence');
        }
        const [active] = await tx
          .select({ id: dockerComposeOperations.id })
          .from(dockerComposeOperations)
          .where(
            and(
              eq(dockerComposeOperations.projectId, project.id),
              inArray(dockerComposeOperations.status, [...ACTIVE_OPERATION_STATUSES])
            )
          )
          .limit(1);
        if (active) throw new AppError(409, 'COMPOSE_OPERATION_IN_PROGRESS', 'Another Compose operation is running');
        const bindings = await tx
          .select({ targetResourceId: managedDatabaseBindings.targetResourceId })
          .from(managedDatabaseBindings)
          .where(
            and(
              eq(managedDatabaseBindings.targetNodeId, nodeId),
              eq(managedDatabaseBindings.targetType, 'compose_service')
            )
          );
        if (bindings.some((binding) => decodeComposeServiceTarget(binding.targetResourceId).projectId === project.id)) {
          throw new AppError(
            409,
            'COMPOSE_DATABASE_BINDINGS_EXIST',
            'Delete managed database links before deleting the Compose project'
          );
        }
        await tx
          .delete(dockerContainerFolderAssignments)
          .where(
            and(
              eq(dockerContainerFolderAssignments.nodeId, nodeId),
              eq(dockerContainerFolderAssignments.resourceType, 'compose'),
              eq(dockerContainerFolderAssignments.resourceKey, project.id)
            )
          );
        await tx
          .delete(dockerSecrets)
          .where(
            and(eq(dockerSecrets.nodeId, nodeId), eq(dockerSecrets.containerName, composeSecretOwner(project.id)))
          );
        await tx.delete(dockerComposeProjects).where(eq(dockerComposeProjects.id, project.id));
      });

      await this.audit.log({
        userId,
        action: 'docker.compose.delete',
        resourceType: 'docker-compose-project',
        resourceId: project.id,
        details: { nodeId, name: project.name, removedVolumes: cleanup.removedVolumes },
      });
      this.emit('deleted', project);
    } catch (error) {
      await this.db
        .update(dockerComposeProjects)
        .set({ status: previousStatus, updatedAt: new Date() })
        .where(and(eq(dockerComposeProjects.id, project.id), eq(dockerComposeProjects.status, 'deleting')));
      throw error;
    }
  }

  private async cleanupProjectRuntime(project: ProjectRow, userId: string) {
    await this.availabilityCoordinator?.removeManaged(project.id, userId);
    const runtime = await this.refreshProjectRuntime(project);
    if (runtime.serviceCount > 0 || runtime.networkNames.length > 0) {
      const down = await this.startOperation(
        project.nodeId,
        project.id,
        'down',
        {
          idempotencyKey: `project-delete:${project.id}:down:${crypto.randomUUID()}`,
          removeOrphans: true,
          volumeNames: [],
        },
        userId,
        true
      );
      await this.waitForOperation(down.id);
    }
    if (runtime.volumeNames.length > 0) {
      const volumes = await this.startOperation(
        project.nodeId,
        project.id,
        'delete_volumes',
        {
          idempotencyKey: `project-delete:${project.id}:volumes:${crypto.randomUUID()}`,
          removeOrphans: false,
          volumeNames: runtime.volumeNames,
        },
        userId,
        true
      );
      await this.waitForOperation(volumes.id);
    }
    const remaining = await this.refreshProjectRuntime(project);
    if (remaining.serviceCount > 0 || remaining.networkNames.length > 0 || remaining.volumeNames.length > 0) {
      throw new AppError(
        409,
        'COMPOSE_DELETE_CLEANUP_INCOMPLETE',
        'Compose runtime cleanup did not remove every project-owned container, network, and volume'
      );
    }
    return { removedVolumes: runtime.volumeNames };
  }

  private async refreshProjectRuntime(project: ProjectRow) {
    if (!this.snapshotReconciler) {
      throw new AppError(503, 'COMPOSE_RUNTIME_REFRESH_UNAVAILABLE', 'Compose runtime cleanup is unavailable');
    }
    await this.snapshotReconciler.refreshNow(project.nodeId, 'containers');
    await this.snapshotReconciler.refreshNow(project.nodeId, 'volumes');
    await this.snapshotReconciler.refreshNow(project.nodeId, 'networks');
    const activeRevision = project.activeRevisionId
      ? await this.getRevision(project.id, project.activeRevisionId).catch(() => null)
      : null;
    return this.projectRuntime(await this.loadNodeRuntime(project.nodeId), project.name, project, activeRevision);
  }

  async startOperation(
    nodeId: string,
    projectId: string,
    action: DockerComposeOperationAction,
    input: ComposeOperationInput,
    userId: string,
    allowProjectDeleting = false
  ): Promise<OperationRow> {
    const project = await this.getProject(nodeId, projectId);
    const effectiveAction: DockerComposeOperationAction = action === 'apply' ? 'pull_apply' : action;
    const availabilityManaged = (await this.availabilityCoordinator?.isManaged(project.id)) ?? false;
    if (!this.dispatcher && !availabilityManaged) {
      throw new AppError(
        409,
        'COMPOSE_CAPABILITY_UNAVAILABLE',
        'This Docker node does not support managed Compose lifecycle operations'
      );
    }
    if (project.managementState === 'external' && effectiveAction !== 'pull_apply') {
      throw new AppError(409, 'COMPOSE_EXTERNAL_READ_ONLY', 'External Compose projects are read-only until adopted');
    }

    if (effectiveAction === 'cancel') {
      return this.cancelActiveOperation(project, input.idempotencyKey, userId);
    }

    const revision = await this.resolveOperationRevision(project, effectiveAction, input.revisionId);
    if (project.managementState === 'external' && !revision) {
      throw new AppError(409, 'COMPOSE_ADOPTION_REVISION_REQUIRED', 'Adoption requires a validated revision');
    }
    if (revision && effectiveAction === 'pull_apply') {
      await this.assertManagedDatabaseBindingsPreserved(project, revision.originalYaml);
    }
    const options = { removeOrphans: input.removeOrphans, volumeNames: input.volumeNames };
    const reserved = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-compose:${project.id}`}))`);
      const [currentProject] = await tx
        .select({ status: dockerComposeProjects.status })
        .from(dockerComposeProjects)
        .where(eq(dockerComposeProjects.id, project.id))
        .limit(1);
      if (!currentProject) throw new AppError(404, 'COMPOSE_PROJECT_NOT_FOUND', 'Compose project not found');
      if (!allowProjectDeleting && currentProject.status === 'deleting') {
        throw new AppError(409, 'COMPOSE_DELETE_IN_PROGRESS', 'Compose project deletion is running');
      }
      const [existing] = await tx
        .select()
        .from(dockerComposeOperations)
        .where(
          and(
            eq(dockerComposeOperations.projectId, project.id),
            eq(dockerComposeOperations.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1);
      if (existing) {
        this.assertIdempotentOperation(existing, effectiveAction, revision?.id ?? null, options);
        return { operation: existing, created: false } as const;
      }
      if (revision) {
        const [currentRevision] = await tx
          .select({ id: dockerComposeRevisions.id })
          .from(dockerComposeRevisions)
          .where(and(eq(dockerComposeRevisions.id, revision.id), eq(dockerComposeRevisions.projectId, project.id)))
          .limit(1);
        if (!currentRevision) throw new AppError(404, 'COMPOSE_REVISION_NOT_FOUND', 'Compose revision not found');
      }
      const [active] = await tx
        .select({ id: dockerComposeOperations.id })
        .from(dockerComposeOperations)
        .where(
          and(
            eq(dockerComposeOperations.projectId, project.id),
            inArray(dockerComposeOperations.status, [...ACTIVE_OPERATION_STATUSES])
          )
        )
        .limit(1);
      if (active) throw new AppError(409, 'COMPOSE_OPERATION_IN_PROGRESS', 'Another Compose operation is running');
      const [operation] = await tx
        .insert(dockerComposeOperations)
        .values({
          projectId: project.id,
          revisionId: revision?.id ?? null,
          idempotencyKey: input.idempotencyKey,
          action: effectiveAction,
          options,
          createdById: userId,
        })
        .returning();
      if (!operation) throw new AppError(500, 'COMPOSE_OPERATION_CREATE_FAILED', 'Compose operation was not created');
      return { operation, created: true } as const;
    });
    if (!reserved.created) return reserved.operation;

    let task: Awaited<ReturnType<DockerTaskService['create']>>;
    try {
      task = await this.tasks.create({
        nodeId,
        containerId: project.id,
        containerName: project.name,
        type: `compose_${effectiveAction}`,
      });
      await this.db
        .update(dockerComposeOperations)
        .set({ taskId: task.id })
        .where(eq(dockerComposeOperations.id, reserved.operation.id));
    } catch (error) {
      await this.db
        .update(dockerComposeOperations)
        .set({ status: 'failed', error: this.sanitizeOperationError(error, {}), completedAt: new Date() })
        .where(eq(dockerComposeOperations.id, reserved.operation.id));
      throw error;
    }

    if (availabilityManaged) {
      void this.executeAvailabilityOperation(
        project,
        revision,
        reserved.operation.id,
        task.id,
        effectiveAction,
        userId
      ).catch(() => {});
    } else {
      void this.executeOperation(
        project,
        revision,
        reserved.operation.id,
        task.id,
        effectiveAction,
        allowProjectDeleting
      ).catch(() => {});
    }
    this.emit('operation_started', project, { operationId: reserved.operation.id, action: effectiveAction });
    return { ...reserved.operation, taskId: task.id };
  }

  private async executeAvailabilityOperation(
    project: ProjectRow,
    revision: RevisionRow | null,
    operationId: string,
    taskId: string,
    action: DockerComposeOperationAction,
    userId: string
  ): Promise<void> {
    const startedAt = new Date();
    await Promise.all([
      this.db
        .update(dockerComposeOperations)
        .set({ status: 'running', startedAt, progress: `Running ${action} through Availability` })
        .where(eq(dockerComposeOperations.id, operationId)),
      this.tasks.update(taskId, { status: 'running', progress: `Running Compose ${action} through Availability` }),
    ]);
    try {
      if (action === 'pull_apply') {
        if (!revision) throw new AppError(409, 'COMPOSE_REVISION_REQUIRED', 'A Compose revision is required');
        await this.availabilityCoordinator?.applyRevision(project.id, revision.id, userId);
      } else if (action === 'start') {
        await this.availabilityCoordinator?.setRunning(project.id, true, userId);
      } else if (action === 'restart') {
        await this.availabilityCoordinator?.setRunning(project.id, true, userId, true);
      } else if (action === 'stop' || action === 'down') {
        await this.availabilityCoordinator?.setRunning(project.id, false, userId);
      } else if (action === 'delete_volumes') {
        throw new AppError(
          409,
          'AVAILABILITY_MOUNTS_UNSUPPORTED',
          'Compose projects with Availability cannot use volumes or mounts'
        );
      }
      const completedAt = new Date();
      const stopped = action === 'stop' || action === 'down';
      await Promise.all([
        this.db
          .update(dockerComposeOperations)
          .set({ status: 'succeeded', progress: `Compose ${action} queued in Availability`, completedAt })
          .where(eq(dockerComposeOperations.id, operationId)),
        this.tasks.update(taskId, {
          status: 'succeeded',
          progress: `Compose ${action} queued in Availability`,
          completedAt,
        }),
        this.db
          .update(dockerComposeProjects)
          .set({
            ...(revision && action === 'pull_apply' ? { activeRevisionId: revision.id } : {}),
            desiredState: stopped ? 'stopped' : 'running',
            status: stopped ? 'stopped' : 'running',
            updatedAt: completedAt,
          })
          .where(eq(dockerComposeProjects.id, project.id)),
      ]);
      this.emit('operation_succeeded', project, { operationId, action });
    } catch (error) {
      const message = this.sanitizeOperationError(error, {});
      const completedAt = new Date();
      await Promise.all([
        this.db
          .update(dockerComposeOperations)
          .set({ status: 'failed', error: message, completedAt })
          .where(eq(dockerComposeOperations.id, operationId)),
        this.tasks.update(taskId, { status: 'failed', error: message, completedAt }),
      ]);
      this.emit('operation_failed', project, { operationId, action });
      throw error;
    }
  }

  async recoverInterruptedOperations(now = new Date()) {
    const interrupted = await this.db
      .update(dockerComposeOperations)
      .set({ status: 'failed', error: INTERRUPTED_OPERATION_ERROR, completedAt: now })
      .where(inArray(dockerComposeOperations.status, [...ACTIVE_OPERATION_STATUSES]))
      .returning();
    await this.db
      .update(dockerComposeProjects)
      .set({ status: 'failed', updatedAt: now })
      .where(eq(dockerComposeProjects.status, 'deleting'));
    if (interrupted.length === 0) return 0;

    const projectIds = [...new Set(interrupted.map((operation) => operation.projectId))];
    for (const projectId of projectIds) {
      const [project] = await this.db
        .select()
        .from(dockerComposeProjects)
        .where(eq(dockerComposeProjects.id, projectId))
        .limit(1);
      if (!project) continue;
      const status = await this.observedProjectStatus(project);
      await this.db
        .update(dockerComposeProjects)
        .set({ status, updatedAt: now })
        .where(eq(dockerComposeProjects.id, project.id));
      this.emit('operation_recovered', project, {
        operationIds: interrupted
          .filter((operation) => operation.projectId === project.id)
          .map((operation) => operation.id),
      });
    }
    return interrupted.length;
  }

  async listSecrets(nodeId: string, projectId: string, reveal: boolean) {
    await this.getProject(nodeId, projectId);
    return (await this.secrets.list(nodeId, composeSecretOwner(projectId), reveal, true)).map((secret) => ({
      ...secret,
      system: isManagedDatabaseSecret(secret.key),
    }));
  }

  async createSecret(nodeId: string, projectId: string, key: string, value: string, userId: string) {
    await this.getProject(nodeId, projectId);
    if (isManagedDatabaseSecret(key)) {
      throw new AppError(409, 'COMPOSE_SECRET_RESERVED', 'This secret name is reserved for managed database links');
    }
    return this.secrets.create(nodeId, composeSecretOwner(projectId), key, value, userId, { managed: true });
  }

  async updateSecret(nodeId: string, projectId: string, secretId: string, value: string, userId: string) {
    await this.getProject(nodeId, projectId);
    await this.assertUserManagedSecret(nodeId, projectId, secretId);
    return this.secrets.update(secretId, nodeId, value, userId, composeSecretOwner(projectId));
  }

  async deleteSecret(nodeId: string, projectId: string, secretId: string, userId: string) {
    await this.getProject(nodeId, projectId);
    await this.assertUserManagedSecret(nodeId, projectId, secretId);
    return this.secrets.delete(secretId, nodeId, userId, composeSecretOwner(projectId));
  }

  async resolveServiceTarget(nodeId: string, targetResourceId: string, requireRunning = false) {
    const target = decodeComposeServiceTarget(targetResourceId);
    const project = await this.getProject(nodeId, target.projectId);
    if (project.managementState !== 'managed') {
      throw new AppError(409, 'COMPOSE_EXTERNAL_READ_ONLY', 'External Compose projects must be adopted first');
    }
    if (requireRunning && project.status !== 'running' && project.status !== 'degraded') {
      throw new AppError(409, 'COMPOSE_PROJECT_NOT_RUNNING', 'Start the Compose project before creating a link');
    }
    if (!project.activeRevisionId) {
      throw new AppError(409, 'COMPOSE_ACTIVE_REVISION_REQUIRED', 'Compose project has no active revision');
    }
    const revision = await this.getRevision(project.id, project.activeRevisionId);
    const service = revision.normalizedModel.services[target.serviceName];
    if (!service) throw new AppError(404, 'COMPOSE_SERVICE_NOT_FOUND', 'Compose service not found');
    return {
      project,
      revision,
      serviceName: target.serviceName,
      service,
      targetResourceId: encodeComposeServiceTarget(target),
    };
  }

  async getServiceEnvironmentNames(nodeId: string, targetResourceId: string) {
    const target = await this.resolveServiceTarget(nodeId, targetResourceId);
    return new Set(Object.keys(target.service.environment ?? {}));
  }

  async applyManagedDatabaseBinding(
    nodeId: string,
    targetResourceId: string,
    bindingId: string,
    networkName: string,
    hostAlias: string,
    hostAddress: string | undefined,
    environment: Record<string, string>,
    userId: string
  ) {
    const target = await this.resolveServiceTarget(nodeId, targetResourceId);
    const patch = { bindingId, networkName, hostAlias, hostAddress, environment };
    const updated = addManagedDatabaseBindingToYaml(target.revision.originalYaml, target.serviceName, patch);
    const createdSecretKeys: string[] = [];
    try {
      for (const [name, value] of Object.entries(environment)) {
        const key = composeBindingSecretKey(bindingId, name);
        await this.secrets.create(nodeId, composeSecretOwner(target.project.id), key, value, userId, { managed: true });
        createdSecretKeys.push(key);
      }
      const revision = await this.findOrCreateManagedRevision(
        target.project,
        {
          yaml: updated.yaml,
          variables: target.revision.variables,
          secretKeys: [...new Set([...target.revision.secretKeys, ...updated.secretKeys])],
        },
        userId,
        target.revision.sourceYaml
      );
      if (target.project.status === 'running' || target.project.status === 'degraded') {
        const operation = await this.startOperation(
          nodeId,
          target.project.id,
          'pull_apply',
          {
            revisionId: revision.id,
            idempotencyKey: `database-binding:${bindingId}:apply:${crypto.randomUUID()}`,
            removeOrphans: false,
            volumeNames: [],
          },
          userId
        );
        await this.waitForOperation(operation.id);
      } else {
        await this.db
          .update(dockerComposeProjects)
          .set({ activeRevisionId: revision.id, updatedById: userId, updatedAt: new Date() })
          .where(eq(dockerComposeProjects.id, target.project.id));
        this.emit('revision_activated', target.project, { revisionId: revision.id });
      }
      return revision;
    } catch (error) {
      await this.deleteManagedSecrets(nodeId, target.project.id, createdSecretKeys, userId).catch(() => undefined);
      throw error;
    }
  }

  async removeManagedDatabaseBinding(
    nodeId: string,
    targetResourceId: string,
    bindingId: string,
    networkName: string,
    hostAlias: string,
    hostAddress: string | undefined,
    environment: Record<string, string>,
    userId: string
  ) {
    const target = await this.resolveServiceTarget(nodeId, targetResourceId);
    const patch = { bindingId, networkName, hostAlias, hostAddress, environment };
    const updated = removeManagedDatabaseBindingFromYaml(target.revision.originalYaml, target.serviceName, patch);
    const revision = await this.findOrCreateManagedRevision(
      target.project,
      {
        yaml: updated.yaml,
        variables: target.revision.variables,
        secretKeys: target.revision.secretKeys.filter((key) => !updated.secretKeys.includes(key)),
      },
      userId,
      target.revision.sourceYaml
    );
    if (target.project.status === 'running' || target.project.status === 'degraded') {
      const operation = await this.startOperation(
        nodeId,
        target.project.id,
        'pull_apply',
        {
          revisionId: revision.id,
          idempotencyKey: `database-binding:${bindingId}:remove:${crypto.randomUUID()}`,
          removeOrphans: false,
          volumeNames: [],
        },
        userId
      );
      await this.waitForOperation(operation.id);
    } else {
      await this.db
        .update(dockerComposeProjects)
        .set({ activeRevisionId: revision.id, updatedById: userId, updatedAt: new Date() })
        .where(eq(dockerComposeProjects.id, target.project.id));
      this.emit('revision_activated', target.project, { revisionId: revision.id });
    }
    await this.deleteManagedSecrets(nodeId, target.project.id, updated.secretKeys, userId);
    return revision;
  }

  async waitForOperation(operationId: string, timeoutMs = 300_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const operation = await this.getOperation(operationId);
      if (operation.status === 'succeeded') return operation;
      if (operation.status === 'failed' || operation.status === 'cancelled') {
        throw new AppError(409, 'COMPOSE_OPERATION_FAILED', operation.error ?? 'Compose operation failed');
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new AppError(504, 'COMPOSE_OPERATION_TIMEOUT', 'Timed out waiting for the Compose operation');
  }

  private async executeOperation(
    project: ProjectRow,
    revision: RevisionRow | null,
    operationId: string,
    taskId: string,
    action: DockerComposeOperationAction,
    preserveProjectStatus = false
  ) {
    const startedAt = new Date();
    const startUpdates: Promise<unknown>[] = [
      this.db
        .update(dockerComposeOperations)
        .set({ status: 'running', startedAt, progress: `Running ${action}` })
        .where(eq(dockerComposeOperations.id, operationId)),
      this.tasks.update(taskId, { status: 'running', progress: `Running Compose ${action}` }),
    ];
    if (!preserveProjectStatus) {
      startUpdates.push(
        this.db
          .update(dockerComposeProjects)
          .set({
            status: action === 'apply' || action === 'pull_apply' ? 'applying' : project.status,
            updatedAt: startedAt,
          })
          .where(eq(dockerComposeProjects.id, project.id))
      );
    }
    await Promise.all(startUpdates);

    let resolvedSecrets: Record<string, string> = {};
    try {
      resolvedSecrets = revision
        ? await this.secrets.getDecryptedMap(project.nodeId, composeSecretOwner(project.id))
        : {};
      const result = await this.dispatcher!.execute(project.nodeId, {
        operationId,
        projectId: project.id,
        projectName: project.name,
        revisionId: revision?.id ?? null,
        configDigest: revision?.configDigest ?? null,
        yaml: revision?.originalYaml ?? null,
        normalizedModel: revision?.normalizedModel ?? null,
        variables: revision?.variables ?? {},
        secrets: resolvedSecrets,
        action,
        options: (await this.getOperation(operationId)).options,
      });
      if (!result.success) throw new Error(result.message || result.detail || `Compose ${action} failed`);

      const completedAt = new Date();
      const nextStatus =
        action === 'stop' || action === 'down' ? 'stopped' : action === 'delete_volumes' ? project.status : 'running';
      const completedUpdates: Promise<unknown>[] = [
        this.db
          .update(dockerComposeOperations)
          .set({ status: 'succeeded', progress: result.message ?? `Compose ${action} completed`, completedAt })
          .where(eq(dockerComposeOperations.id, operationId)),
        this.tasks.update(taskId, {
          status: 'succeeded',
          progress: result.message ?? `Compose ${action} completed`,
          completedAt,
        }),
      ];
      if (!preserveProjectStatus) {
        completedUpdates.push(
          this.db
            .update(dockerComposeProjects)
            .set({
              ...(project.managementState === 'external' && (action === 'apply' || action === 'pull_apply')
                ? { managementState: 'managed' as const }
                : {}),
              ...(revision && (action === 'apply' || action === 'pull_apply') ? { activeRevisionId: revision.id } : {}),
              desiredState: nextStatus === 'stopped' ? 'stopped' : 'running',
              status: nextStatus,
              updatedAt: completedAt,
            })
            .where(eq(dockerComposeProjects.id, project.id))
        );
      }
      await Promise.all(completedUpdates);
      this.emit('operation_succeeded', project, { operationId, action });
    } catch (error) {
      const message = this.sanitizeOperationError(error, resolvedSecrets);
      const completedAt = new Date();
      const [failedOperation] = await this.db
        .update(dockerComposeOperations)
        .set({ status: 'failed', error: message, completedAt })
        .where(
          and(
            eq(dockerComposeOperations.id, operationId),
            inArray(dockerComposeOperations.status, ['pending', 'running'])
          )
        )
        .returning({ id: dockerComposeOperations.id });
      if (failedOperation) {
        const failedUpdates: Promise<unknown>[] = [
          this.tasks.update(taskId, { status: 'failed', error: message, completedAt }),
        ];
        if (!preserveProjectStatus) {
          failedUpdates.push(
            this.db
              .update(dockerComposeProjects)
              .set({ status: 'failed', updatedAt: completedAt })
              .where(eq(dockerComposeProjects.id, project.id))
          );
        }
        await Promise.all(failedUpdates);
        this.emit('operation_failed', project, { operationId, action, error: message });
      }
      throw error;
    }
  }

  private async cancelActiveOperation(
    project: ProjectRow,
    idempotencyKey: string,
    userId: string
  ): Promise<OperationRow> {
    const reserved = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-compose:${project.id}`}))`);
      const [currentProject] = await tx
        .select({ status: dockerComposeProjects.status })
        .from(dockerComposeProjects)
        .where(eq(dockerComposeProjects.id, project.id))
        .limit(1);
      if (!currentProject) throw new AppError(404, 'COMPOSE_PROJECT_NOT_FOUND', 'Compose project not found');
      if (currentProject.status === 'deleting') {
        throw new AppError(409, 'COMPOSE_DELETE_IN_PROGRESS', 'Compose project deletion is running');
      }
      const [existing] = await tx
        .select()
        .from(dockerComposeOperations)
        .where(
          and(
            eq(dockerComposeOperations.projectId, project.id),
            eq(dockerComposeOperations.idempotencyKey, idempotencyKey)
          )
        )
        .limit(1);
      if (existing) {
        this.assertIdempotentOperation(existing, 'cancel', existing.revisionId, {});
        return { existing } as const;
      }
      const activeRows = await tx
        .select()
        .from(dockerComposeOperations)
        .where(
          and(
            eq(dockerComposeOperations.projectId, project.id),
            inArray(dockerComposeOperations.status, [...ACTIVE_OPERATION_STATUSES])
          )
        )
        .orderBy(desc(dockerComposeOperations.createdAt));
      if (activeRows.some((operation) => operation.action === 'cancel')) {
        throw new AppError(409, 'COMPOSE_CANCEL_IN_PROGRESS', 'Compose cancellation is already running');
      }
      const active = activeRows.find((operation) => operation.action !== 'cancel');
      if (!active) throw new AppError(409, 'COMPOSE_OPERATION_NOT_RUNNING', 'No Compose operation is running');
      await tx
        .update(dockerComposeOperations)
        .set({ status: 'cancelling', progress: 'Cancellation requested' })
        .where(eq(dockerComposeOperations.id, active.id));
      const [cancelOperation] = await tx
        .insert(dockerComposeOperations)
        .values({
          projectId: project.id,
          revisionId: active.revisionId,
          idempotencyKey,
          action: 'cancel',
          status: 'running',
          progress: 'Cancelling active Compose operation',
          createdById: userId,
          startedAt: new Date(),
        })
        .returning();
      if (!cancelOperation) {
        throw new AppError(500, 'COMPOSE_OPERATION_CREATE_FAILED', 'Compose cancellation was not created');
      }
      return { active, cancelOperation } as const;
    });
    if ('existing' in reserved) {
      if (!reserved.existing) {
        throw new AppError(500, 'COMPOSE_OPERATION_STATE_INVALID', 'Compose operation state is invalid');
      }
      return reserved.existing;
    }
    const { active, cancelOperation } = reserved;

    const revision = active.revisionId ? await this.getRevision(project.id, active.revisionId) : null;
    let result: DockerComposeDispatchResult;
    try {
      result = await this.dispatcher!.execute(project.nodeId, {
        operationId: active.id,
        projectId: project.id,
        projectName: project.name,
        revisionId: revision?.id ?? null,
        configDigest: revision?.configDigest ?? null,
        yaml: null,
        normalizedModel: null,
        variables: {},
        secrets: {},
        action: 'cancel',
        options: { removeOrphans: false, volumeNames: [] },
      });
      if (!result.success) {
        throw new AppError(409, 'COMPOSE_CANCEL_FAILED', result.message ?? 'Compose cancellation failed');
      }
    } catch (error) {
      await Promise.all([
        this.db
          .update(dockerComposeOperations)
          .set({ status: 'failed', error: this.sanitizeOperationError(error, {}), completedAt: new Date() })
          .where(eq(dockerComposeOperations.id, cancelOperation.id)),
        this.db
          .update(dockerComposeOperations)
          .set({ status: 'running', progress: 'Running after cancellation failed' })
          .where(and(eq(dockerComposeOperations.id, active.id), eq(dockerComposeOperations.status, 'cancelling'))),
      ]);
      throw error;
    }

    const completedAt = new Date();
    const status = await this.observedProjectStatus(project);
    const [, [operation]] = await Promise.all([
      this.db
        .update(dockerComposeOperations)
        .set({ status: 'cancelled', progress: result.message ?? 'Cancelled by user', completedAt })
        .where(eq(dockerComposeOperations.id, active.id)),
      this.db
        .update(dockerComposeOperations)
        .set({ status: 'succeeded', progress: result.message ?? 'Cancellation requested', completedAt })
        .where(eq(dockerComposeOperations.id, cancelOperation.id))
        .returning(),
      this.db
        .update(dockerComposeProjects)
        .set({ status, updatedAt: completedAt })
        .where(eq(dockerComposeProjects.id, project.id)),
    ]);
    if (active.taskId) {
      await this.tasks.update(active.taskId, {
        status: 'failed',
        error: 'Cancelled by user',
        completedAt,
      });
    }
    await this.audit.log({
      userId,
      action: 'docker.compose.operation.cancel',
      resourceType: 'docker-compose-project',
      resourceId: project.id,
      details: { nodeId: project.nodeId, operationId: active.id },
    });
    this.emit('operation_cancelled', project, { operationId: active.id });
    if (!operation) {
      throw new AppError(500, 'COMPOSE_CANCEL_STATE_FAILED', 'Compose cancellation state was not persisted');
    }
    return operation;
  }

  private async insertRevision(
    project: ProjectRow,
    input: ComposeRevisionCreateInput,
    normalizedModel: RevisionRow['normalizedModel'],
    configDigest: string,
    userId: string,
    sourceYaml = input.yaml,
    source: { sourceBindingId: string; buildBatchId: string; sourceCommitSha: string } | null = null
  ) {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-compose:${project.id}`}))`);
        const [latest] = await tx
          .select({ revisionNumber: dockerComposeRevisions.revisionNumber })
          .from(dockerComposeRevisions)
          .where(eq(dockerComposeRevisions.projectId, project.id))
          .orderBy(desc(dockerComposeRevisions.revisionNumber))
          .limit(1);
        const [revision] = await tx
          .insert(dockerComposeRevisions)
          .values({
            projectId: project.id,
            revisionNumber: (latest?.revisionNumber ?? 0) + 1,
            sourceYaml,
            originalYaml: input.yaml,
            normalizedModel,
            configDigest,
            variables: input.variables,
            secretKeys: [...new Set(input.secretKeys)].sort(),
            sourceBindingId: source?.sourceBindingId ?? null,
            buildBatchId: source?.buildBatchId ?? null,
            sourceCommitSha: source?.sourceCommitSha ?? null,
            createdById: userId,
          })
          .returning();
        return revision;
      });
    } catch (error) {
      const databaseError = databaseErrorDetails(error);
      if (
        (databaseError?.code === '23505' && /project_digest_unique/i.test(databaseError.constraint)) ||
        (error instanceof Error && /project_digest_unique/i.test(error.message))
      ) {
        throw new AppError(409, 'COMPOSE_REVISION_EXISTS', 'This Compose configuration already has a revision');
      }
      if (
        (databaseError?.code === '23505' && /project_revision_unique/i.test(databaseError.constraint)) ||
        (error instanceof Error && /project_revision_unique/i.test(error.message))
      ) {
        throw new AppError(409, 'COMPOSE_REVISION_CONFLICT', 'Another Compose revision was created concurrently');
      }
      throw error;
    }
  }

  private async findOrCreateManagedRevision(
    project: ProjectRow,
    input: ComposeRevisionCreateInput,
    userId: string,
    sourceYaml: string
  ): Promise<RevisionRow> {
    const sourceValidation = validateComposeYaml({ ...input, yaml: sourceYaml, projectName: project.name });
    this.assertValid(sourceValidation);
    const validation = validateComposeYaml({ ...input, projectName: project.name });
    this.assertValid(validation);
    await this.assertManagedDatabaseBindingsPreserved(project, input.yaml);
    const [existing] = await this.db
      .select()
      .from(dockerComposeRevisions)
      .where(
        and(
          eq(dockerComposeRevisions.projectId, project.id),
          eq(dockerComposeRevisions.configDigest, validation.configDigest!)
        )
      )
      .limit(1);
    if (existing) return existing;
    const revision = await this.insertRevision(
      project,
      input,
      sourceValidation.normalizedModel!,
      validation.configDigest!,
      userId,
      sourceYaml
    );
    await this.audit.log({
      userId,
      action: 'docker.compose.revision.create',
      resourceType: 'docker-compose-project',
      resourceId: project.id,
      details: {
        nodeId: project.nodeId,
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        managed: true,
      },
    });
    this.emit('revision_created', project, { revisionId: revision.id });
    return revision;
  }

  private async addCurrentManagedDatabaseBindings(project: ProjectRow, input: ComposeRevisionCreateInput) {
    const rows = await this.db
      .select()
      .from(managedDatabaseBindings)
      .where(
        and(
          eq(managedDatabaseBindings.targetNodeId, project.nodeId),
          eq(managedDatabaseBindings.targetType, 'compose_service'),
          eq(managedDatabaseBindings.desiredState, 'active'),
          inArray(managedDatabaseBindings.status, ['creating', 'ready', 'error'])
        )
      );
    let yaml = input.yaml;
    const secretKeys = new Set(input.secretKeys);
    let activeYaml: string | null | undefined;
    for (const binding of rows) {
      const target = decodeComposeServiceTarget(binding.targetResourceId);
      if (target.projectId !== project.id) continue;
      const environment = Object.fromEntries(
        Object.values(binding.environment)
          .filter((name): name is string => Boolean(name))
          .map((name) => [name, ''])
      );
      const patch = {
        bindingId: binding.id,
        networkName: binding.networkName,
        environment,
      };
      if (binding.status === 'error') {
        if (activeYaml === undefined) {
          activeYaml = project.activeRevisionId
            ? (await this.getRevision(project.id, project.activeRevisionId)).originalYaml
            : null;
        }
        if (!activeYaml) continue;
        try {
          assertManagedDatabaseBindingInYaml(activeYaml, target.serviceName, patch);
        } catch {
          continue;
        }
      }
      const updated = addManagedDatabaseBindingToYaml(yaml, target.serviceName, patch);
      yaml = updated.yaml;
      for (const key of updated.secretKeys) secretKeys.add(key);
    }
    return { yaml, variables: input.variables, secretKeys: [...secretKeys].sort() };
  }

  private async assertManagedDatabaseBindingsPreserved(project: ProjectRow, yaml: string) {
    const rows = await this.db
      .select()
      .from(managedDatabaseBindings)
      .where(
        and(
          eq(managedDatabaseBindings.targetNodeId, project.nodeId),
          eq(managedDatabaseBindings.targetType, 'compose_service'),
          eq(managedDatabaseBindings.desiredState, 'active'),
          inArray(managedDatabaseBindings.status, ['creating', 'ready', 'error'])
        )
      );
    let activeYaml: string | null | undefined;
    for (const binding of rows) {
      const target = decodeComposeServiceTarget(binding.targetResourceId);
      if (target.projectId !== project.id) continue;
      const patch = {
        bindingId: binding.id,
        networkName: binding.networkName,
        environment: Object.fromEntries(
          Object.values(binding.environment)
            .filter((name): name is string => Boolean(name))
            .map((name) => [name, ''])
        ),
      };
      if (binding.status === 'error') {
        if (activeYaml === undefined) {
          activeYaml = project.activeRevisionId
            ? (await this.getRevision(project.id, project.activeRevisionId)).originalYaml
            : null;
        }
        if (!activeYaml) continue;
        try {
          assertManagedDatabaseBindingInYaml(activeYaml, target.serviceName, patch);
        } catch {
          // A failed create is compensated and has no active managed YAML to
          // preserve. Failed removals retain the active marker and stay locked.
          continue;
        }
      }
      assertManagedDatabaseBindingInYaml(yaml, target.serviceName, patch);
    }
  }

  private async deleteManagedSecrets(nodeId: string, projectId: string, keys: string[], userId: string) {
    if (keys.length === 0) return;
    const rows = await this.secrets.list(nodeId, composeSecretOwner(projectId), false, true);
    for (const row of rows) {
      if (keys.includes(row.key)) {
        await this.secrets.delete(row.id, nodeId, userId, composeSecretOwner(projectId));
      }
    }
  }

  private async assertUserManagedSecret(nodeId: string, projectId: string, secretId: string) {
    const secret = (await this.secrets.list(nodeId, composeSecretOwner(projectId), false, true)).find(
      (row) => row.id === secretId
    );
    if (secret && isManagedDatabaseSecret(secret.key)) {
      throw new AppError(409, 'COMPOSE_SECRET_RESERVED', 'Managed database link secrets cannot be changed directly');
    }
  }

  private async resolveOperationRevision(
    project: ProjectRow,
    action: DockerComposeOperationAction,
    revisionId?: string
  ) {
    if (action === 'cancel' || action === 'delete_volumes') return null;
    const selected = revisionId ?? project.activeRevisionId;
    if (selected) return this.getRevision(project.id, selected);
    if (action === 'apply' || action === 'pull_apply' || action === 'down') {
      const latest = await this.listRevisions(project.id);
      return latest[0] ?? null;
    }
    throw new AppError(409, 'COMPOSE_ACTIVE_REVISION_REQUIRED', 'Compose lifecycle requires an active revision');
  }

  private assertIdempotentOperation(
    existing: typeof dockerComposeOperations.$inferSelect,
    action: DockerComposeOperationAction,
    revisionId: string | null,
    options: Record<string, unknown>
  ) {
    const existingAction = existing.action === 'apply' ? 'pull_apply' : existing.action;
    const requestedAction = action === 'apply' ? 'pull_apply' : action;
    if (
      existingAction !== requestedAction ||
      existing.revisionId !== revisionId ||
      !isDeepStrictEqual(existing.options ?? {}, options)
    ) {
      throw new AppError(
        409,
        'COMPOSE_IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used for a different Compose operation'
      );
    }
  }

  private async observedProjectStatus(project: ProjectRow): Promise<ProjectRow['status']> {
    const activeRevision = project.activeRevisionId
      ? await this.getRevision(project.id, project.activeRevisionId).catch(() => null)
      : null;
    const runtime = this.projectRuntime(
      await this.loadNodeRuntime(project.nodeId),
      project.name,
      project,
      activeRevision
    );
    if (runtime.serviceCount === 0) return project.desiredState === 'stopped' ? 'stopped' : 'missing';
    if (runtime.runningServiceCount === 0) return 'stopped';
    const expected = activeRevision
      ? Object.keys(activeRevision.normalizedModel.services).length
      : runtime.serviceCount;
    return runtime.runningServiceCount >= expected ? 'running' : 'degraded';
  }

  private async getRevision(projectId: string, revisionId: string) {
    const [revision] = await this.db
      .select()
      .from(dockerComposeRevisions)
      .where(and(eq(dockerComposeRevisions.id, revisionId), eq(dockerComposeRevisions.projectId, projectId)))
      .limit(1);
    if (!revision) throw new AppError(404, 'COMPOSE_REVISION_NOT_FOUND', 'Compose revision not found');
    return revision;
  }

  private async getRevisionByDigest(projectId: string, configDigest: string) {
    const [revision] = await this.db
      .select()
      .from(dockerComposeRevisions)
      .where(
        and(eq(dockerComposeRevisions.projectId, projectId), eq(dockerComposeRevisions.configDigest, configDigest))
      )
      .limit(1);
    return revision ?? null;
  }

  private async completeAdoption(project: ProjectRow, revisionId: string, userId: string) {
    const [updated] = await this.db
      .update(dockerComposeProjects)
      .set({
        managementState: 'managed',
        activeRevisionId: revisionId,
        desiredState: 'stopped',
        status: 'stopped',
        updatedById: userId,
        updatedAt: new Date(),
      })
      .where(and(eq(dockerComposeProjects.id, project.id), eq(dockerComposeProjects.managementState, 'external')))
      .returning();
    if (!updated) throw new AppError(409, 'COMPOSE_ADOPTION_CONFLICT', 'Compose project adoption state changed');
    return updated;
  }

  private async getOperation(operationId: string) {
    const [operation] = await this.db
      .select()
      .from(dockerComposeOperations)
      .where(eq(dockerComposeOperations.id, operationId))
      .limit(1);
    if (!operation) throw new AppError(404, 'COMPOSE_OPERATION_NOT_FOUND', 'Compose operation not found');
    return operation;
  }

  private async getProject(nodeId: string, projectId: string) {
    const [project] = await this.db
      .select()
      .from(dockerComposeProjects)
      .where(and(eq(dockerComposeProjects.id, projectId), eq(dockerComposeProjects.nodeId, nodeId)))
      .limit(1);
    if (!project) throw new AppError(404, 'COMPOSE_PROJECT_NOT_FOUND', 'Compose project not found');
    return project;
  }

  private assertValid(validation: ReturnType<typeof validateComposeYaml>) {
    if (!validation.valid || !validation.normalizedModel || !validation.configDigest) {
      throw new AppError(400, 'COMPOSE_VALIDATION_FAILED', 'Compose configuration is not supported', {
        diagnostics: validation.diagnostics,
        requiredVariables: validation.requiredVariables,
      });
    }
  }

  private sanitizeOperationError(error: unknown, secrets: Record<string, string>) {
    let message = error instanceof Error ? error.message : String(error);
    for (const value of Object.values(secrets)) {
      if (value) message = message.split(value).join('***');
    }
    return message.slice(0, 4000);
  }

  private async loadNodeRuntime(nodeId: string) {
    if (!this.snapshots) return { containers: [], volumes: [], networks: [] };
    const [containers, volumes, networks] = await Promise.all([
      this.snapshots.getList<Record<string, unknown>[]>(nodeId, 'containers'),
      this.snapshots.getList<Record<string, unknown>[]>(nodeId, 'volumes'),
      this.snapshots.getList<Record<string, unknown>[]>(nodeId, 'networks'),
    ]);
    return {
      containers: Array.isArray(containers.data) ? containers.data : [],
      volumes: Array.isArray(volumes.data) ? volumes.data : [],
      networks: Array.isArray(networks.data) ? networks.data : [],
    };
  }

  private projectRuntime(
    runtime: Awaited<ReturnType<DockerComposeService['loadNodeRuntime']>>,
    projectName: string,
    project: ProjectRow,
    activeRevision: RevisionRow | null
  ) {
    const labelsFor = (item: Record<string, unknown>) => {
      const labels = item.labels ?? item.Labels;
      return labels && typeof labels === 'object' && !Array.isArray(labels) ? (labels as Record<string, string>) : {};
    };
    const nameFor = (item: Record<string, unknown>) =>
      String(item.name ?? item.Name ?? item.id ?? item.Id ?? '').replace(/^\/+/, '');
    const containers = runtime.containers.filter(
      (item) => labelsFor(item)['com.docker.compose.project'] === projectName
    );
    const serviceMap = new Map<
      string,
      { name: string; image: string; state: string; health: string; containerIds: string[] }
    >();
    for (const item of containers) {
      const labels = labelsFor(item);
      const serviceName = labels['com.docker.compose.service'] || nameFor(item);
      const current = serviceMap.get(serviceName) ?? {
        name: serviceName,
        image: String(item.image ?? item.Image ?? ''),
        state: 'unknown',
        health: 'unknown',
        containerIds: [],
      };
      const state = String(item.state ?? item.State ?? 'unknown').toLowerCase();
      const health = String(item.health ?? item.Health ?? item.healthStatus ?? 'unknown').toLowerCase();
      current.containerIds.push(String(item.id ?? item.Id ?? ''));
      if (state === 'running') current.state = 'running';
      else if (current.state !== 'running') current.state = state;
      if (health === 'healthy' || health === 'online') current.health = 'healthy';
      else if (current.health !== 'healthy') current.health = health;
      serviceMap.set(serviceName, current);
    }
    const services = [...serviceMap.values()].sort((left, right) => left.name.localeCompare(right.name));
    const volumeNames = runtime.volumes
      .filter((item) => {
        const labels = labelsFor(item);
        return labels['com.docker.compose.project'] === projectName && !!labels['com.docker.compose.volume'];
      })
      .map(nameFor)
      .sort();
    const networkNames = runtime.networks
      .filter((item) => {
        const labels = labelsFor(item);
        return labels['com.docker.compose.project'] === projectName && !!labels['com.docker.compose.network'];
      })
      .map(nameFor)
      .sort();
    const expectsRunning = project.desiredState === 'running';
    const drifted =
      project.managementState === 'managed' &&
      !!activeRevision &&
      expectsRunning &&
      (containers.length === 0 ||
        containers.some((item) => labelsFor(item)['wiolett.gateway.compose.revision'] !== activeRevision.configDigest));
    return {
      services,
      volumeNames,
      networkNames,
      serviceCount: services.length,
      runningServiceCount: services.filter((service) => service.state === 'running').length,
      healthyServiceCount: services.filter((service) => service.health === 'healthy').length,
      drifted,
    };
  }

  private emit(action: string, project: ProjectRow, extra: Record<string, unknown> = {}) {
    const { action: operationAction, ...details } = extra;
    this.eventBus?.publish('docker.compose.changed', {
      action,
      projectId: project.id,
      projectName: project.name,
      nodeId: project.nodeId,
      ...details,
      ...(operationAction ? { operationAction } : {}),
    });
  }
}
