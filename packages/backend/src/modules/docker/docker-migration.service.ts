import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import type { DockerMigrationPhase, DockerMigrationStatus } from '@/db/schema/docker-migrations.js';
import { dockerMigrationArtifacts, dockerMigrationNodeLocks, dockerMigrations } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { DockerManagementService } from './docker.service.js';
import type { DockerMigrationCreateInput, DockerMigrationPreflightInput } from './docker-migration.schemas.js';
import type { DockerMigrationCoordinator } from './docker-migration-coordinator.js';
import type { DockerMigrationExecutor } from './docker-migration-executor.js';
import { DOCKER_MIGRATION_LEASE_HEARTBEAT_MS, DockerMigrationLease } from './docker-migration-lease.js';
import {
  assertDockerMigrationCleanupAccess,
  assertDockerMigrationManageAccess,
  assertDockerMigrationReadAccess,
} from './docker-migration-permissions.js';
import type { DockerMigrationPreflightService } from './docker-migration-preflight.js';
import { sanitizeDockerMigration } from './docker-migration-records.js';

const logger = createChildLogger('DockerMigrationService');

export { DOCKER_MIGRATION_LEASE_EXPIRY_MS, DOCKER_MIGRATION_LEASE_HEARTBEAT_MS } from './docker-migration-lease.js';

const ACTIVE_STATUSES: DockerMigrationStatus[] = ['pending', 'running', 'waiting', 'cancelling'];
const MIGRATING_STATUSES: DockerMigrationStatus[] = [...ACTIVE_STATUSES, 'cleanup_pending', 'needs_attention'];
const TERMINAL_STATUSES: DockerMigrationStatus[] = ['cancelled', 'completed', 'failed', 'needs_attention'];
const PHASES: DockerMigrationPhase[] = [
  'locking',
  'preparing',
  'maintenance',
  'stopping_source',
  'preparing_volumes',
  'transferring',
  'creating_target',
  'verifying_target',
  'starting_target',
  'cutover',
  'proxy_cutover',
  'cleanup_source',
  'finalizing',
  'done',
];

export class DockerMigrationService {
  private readonly lease: DockerMigrationLease;
  private readonly queued = new Set<string>();
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private recoveryPromise: Promise<void> | null = null;
  private stopping = false;
  private readonly stopWaiters = new Set<() => void>();

  constructor(
    private db: DrizzleClient,
    private preflight: DockerMigrationPreflightService,
    private executor: DockerMigrationExecutor,
    private coordinator: DockerMigrationCoordinator,
    private audit: AuditService,
    private events: EventBusService,
    private docker: DockerManagementService
  ) {
    this.lease = new DockerMigrationLease(db);
  }

  start(): void {
    if (this.recoveryTimer) return;
    this.stopping = false;
    this.runRecovery();
    this.recoveryTimer = setInterval(() => this.runRecovery(), DOCKER_MIGRATION_LEASE_HEARTBEAT_MS);
    this.recoveryTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await this.recoveryPromise;
    if (this.queued.size === 0) return;
    await new Promise<void>((resolve) => this.stopWaiters.add(resolve));
  }

  async preflightMigration(input: DockerMigrationPreflightInput, scopes: string[]) {
    return this.preflight.run(input, scopes);
  }

  async create(input: DockerMigrationCreateInput, userId: string, scopes: string[]) {
    const report = await this.preflight.run(input, scopes);
    if (report.fingerprint !== input.preflightFingerprint) {
      throw new AppError(409, 'MIGRATION_PREFLIGHT_STALE', 'Migration preflight is stale', { preflight: report });
    }
    if (report.blockers.length > 0) {
      throw new AppError(409, 'MIGRATION_PREFLIGHT_BLOCKED', 'Migration preflight has blockers', {
        preflight: report,
      });
    }
    const [row] = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(dockerMigrations)
        .values({
          resourceType: report.resourceType,
          resourceName: report.resourceName,
          deploymentId: input.resource.type === 'deployment' ? input.resource.deploymentId : null,
          sourceNodeId: input.sourceNodeId,
          targetNodeId: input.targetNodeId,
          keepSource: input.keepSource,
          sourceState: report.sourceState,
          sourceFingerprint: report.fingerprint,
          preflight: report,
          plan: {
            plannedChanges: report.plannedChanges,
            verificationPlan: report.verificationPlan,
            environmentKeyCount: report.environmentKeyCount,
            secretKeyCount: report.secretKeyCount,
          },
          proxySnapshot: {
            hosts: report.proxyHosts,
            migrationEnteredMaintenance: [],
          },
          createdById: userId,
        })
        .returning();
      if (report.artifacts.length > 0) {
        await tx.insert(dockerMigrationArtifacts).values(
          report.artifacts.map((artifact) => ({
            migrationId: inserted[0]!.id,
            kind: artifact.kind,
            sourceIdentity: artifact.sourceIdentity,
            targetIdentity: artifact.targetIdentity,
            sizeBytes: artifact.sizeBytes ?? 0,
          }))
        );
      }
      return inserted;
    });
    await this.log(row, 'docker_migration.requested', userId);
    this.markMigrating(row);
    this.emit(row);
    this.queue(row.id);
    return sanitizeDockerMigration(row);
  }

  async list(scopes: string[], filters: { status?: string; nodeId?: string; limit: number }) {
    const conditions = [];
    if (filters.status) conditions.push(eq(dockerMigrations.status, filters.status as DockerMigrationStatus));
    if (filters.nodeId) {
      conditions.push(
        or(eq(dockerMigrations.sourceNodeId, filters.nodeId), eq(dockerMigrations.targetNodeId, filters.nodeId))!
      );
    }
    const rows = await this.db
      .select()
      .from(dockerMigrations)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(dockerMigrations.createdAt))
      .limit(Math.min(filters.limit * 4, 400));
    return rows
      .filter((row) => {
        try {
          assertDockerMigrationReadAccess(scopes, row.sourceNodeId, row.targetNodeId, this.scopeResourceId(row));
          return true;
        } catch {
          return false;
        }
      })
      .slice(0, filters.limit)
      .map(sanitizeDockerMigration);
  }

  async get(id: string, scopes: string[]) {
    const row = await this.getRow(id);
    assertDockerMigrationReadAccess(scopes, row.sourceNodeId, row.targetNodeId, this.scopeResourceId(row));
    const artifacts = await this.db
      .select()
      .from(dockerMigrationArtifacts)
      .where(eq(dockerMigrationArtifacts.migrationId, id));
    return { ...sanitizeDockerMigration(row), preflight: row.preflight, artifacts };
  }

  async cancel(id: string, userId: string, scopes: string[]) {
    const row = await this.getRow(id);
    assertDockerMigrationManageAccess(scopes, row.sourceNodeId, row.targetNodeId, this.scopeResourceId(row));
    if (row.cutoverAt || !ACTIVE_STATUSES.includes(row.status)) {
      throw new AppError(409, 'MIGRATION_CANNOT_CANCEL', 'Migration cannot be cancelled after cutover or completion');
    }
    const [updated] = await this.db
      .update(dockerMigrations)
      .set({
        status: 'cancelling',
        cancellationRequestedAt: new Date(),
        cancellationRequestedById: userId,
        updatedAt: new Date(),
      })
      .where(eq(dockerMigrations.id, id))
      .returning();
    await this.log(updated, 'docker_migration.cancel_requested', userId);
    this.emit(updated);
    this.queue(id);
    return sanitizeDockerMigration(updated);
  }

  async retryCleanup(id: string, userId: string, scopes: string[]) {
    const row = await this.getRow(id);
    assertDockerMigrationManageAccess(scopes, row.sourceNodeId, row.targetNodeId, this.scopeResourceId(row));
    if (row.status !== 'cleanup_pending') {
      throw new AppError(409, 'MIGRATION_CLEANUP_NOT_RETRYABLE', 'Migration does not have retryable cleanup');
    }
    const artifacts = await this.db
      .select({ kind: dockerMigrationArtifacts.kind })
      .from(dockerMigrationArtifacts)
      .where(eq(dockerMigrationArtifacts.migrationId, row.id));
    const proxySnapshot = row.proxySnapshot as { hosts?: unknown[] };
    assertDockerMigrationCleanupAccess(
      scopes,
      row.sourceNodeId,
      row.targetNodeId,
      this.scopeResourceId(row),
      artifacts.some((artifact) => artifact.kind === 'volume'),
      (proxySnapshot.hosts?.length ?? 0) > 0
    );
    const [updated] = await this.db
      .update(dockerMigrations)
      .set({
        status: 'pending',
        phase: row.phase,
        errorCode: null,
        errorMessage: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(dockerMigrations.id, id))
      .returning();
    await this.log(updated, 'docker_migration.cleanup_retry', userId);
    this.markMigrating(updated);
    this.emit(updated);
    this.queue(id);
    return sanitizeDockerMigration(updated);
  }

  async recoverOnStartup(now = new Date()): Promise<number> {
    await this.db.delete(dockerMigrationNodeLocks).where(lt(dockerMigrationNodeLocks.leaseExpiresAt, now));
    const migrating = await this.db
      .select()
      .from(dockerMigrations)
      .where(inArray(dockerMigrations.status, MIGRATING_STATUSES));
    for (const row of migrating) this.markMigrating(row);
    const recoverable = await this.db
      .select()
      .from(dockerMigrations)
      .where(
        and(
          inArray(dockerMigrations.status, ACTIVE_STATUSES),
          or(isNull(dockerMigrations.leaseExpiresAt), lt(dockerMigrations.leaseExpiresAt, now))
        )
      );
    for (const row of recoverable) {
      this.markMigrating(row);
      this.queue(row.id);
    }
    return recoverable.length;
  }

  private runRecovery(): void {
    if (this.stopping || this.recoveryPromise) return;
    const active = this.recoverOnStartup()
      .then(() => undefined)
      .catch((error) => {
        logger.warn('Docker migration recovery failed', { error });
      })
      .finally(() => {
        if (this.recoveryPromise === active) this.recoveryPromise = null;
      });
    this.recoveryPromise = active;
  }

  private queue(id: string): void {
    if (this.stopping) return;
    if (this.queued.has(id)) return;
    this.queued.add(id);
    setImmediate(() => {
      void this.run(id)
        .catch((error) => logger.error('Docker migration runner failed', { migrationId: id, error }))
        .finally(() => {
          this.queued.delete(id);
          if (this.stopping && this.queued.size === 0) {
            for (const resolve of this.stopWaiters) resolve();
            this.stopWaiters.clear();
          }
        });
    });
  }

  private async run(id: string): Promise<void> {
    if (this.stopping) return;
    let row = await this.getRow(id);
    if (TERMINAL_STATUSES.includes(row.status)) return;
    if (!(await this.lease.claim(id))) return;
    const heartbeatTimer = setInterval(() => {
      void this.lease.heartbeat(id).catch(() => undefined);
    }, DOCKER_MIGRATION_LEASE_HEARTBEAT_MS);
    heartbeatTimer.unref?.();
    try {
      await this.lease.acquireNodeLocks(row);
      row = await this.update(id, {
        status: row.status === 'cancelling' ? 'cancelling' : 'running',
        phase: row.phase === 'queued' ? 'locking' : row.phase,
        startedAt: row.startedAt ?? new Date(),
      });
      await this.log(row, 'docker_migration.started', row.createdById);
      while (!TERMINAL_STATUSES.includes(row.status)) {
        if (this.stopping) {
          await this.lease.release(row.id);
          logger.info('Paused Docker migration at phase boundary for Gateway shutdown', {
            migrationId: row.id,
            phase: row.phase,
          });
          return;
        }
        await this.lease.heartbeat(row.id);
        if (row.cancellationRequestedAt && !row.cutoverAt) {
          await this.rollback(row, true);
          return;
        }
        if (row.phase === 'done') {
          await this.complete(row);
          return;
        }
        await this.executePhase(row);
        row = await this.getRow(id);
      }
    } catch (error) {
      await this.handleFailure(row, error);
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private async executePhase(row: typeof dockerMigrations.$inferSelect): Promise<void> {
    await this.lease.assertOwnership(row.id);
    if (row.phase === 'locking') {
      await this.recheckPreflight(row);
    } else if (row.phase === 'maintenance') {
      await this.coordinator.enterMaintenance(row);
      await this.log(row, 'docker_migration.maintenance_entered', row.createdById);
    } else if (row.phase === 'cutover') {
      await this.coordinator.cutoverMetadata(row);
      await this.log(row, 'docker_migration.cutover', row.createdById);
    } else if (row.phase === 'proxy_cutover') {
      await this.coordinator.exitEnteredMaintenance(row);
    } else if (!['queued', 'done'].includes(row.phase)) {
      const result = await this.executor.execute(row);
      if (row.phase === 'cleanup_source') await this.coordinator.refreshSourceSnapshots(row);
      if (result.verification || result.progress) {
        await this.db
          .update(dockerMigrations)
          .set({
            ...(result.verification ? { verification: { ...row.verification, ...result.verification } } : {}),
            ...(result.progress ? { progress: { ...row.progress, ...result.progress } } : {}),
            updatedAt: new Date(),
          })
          .where(eq(dockerMigrations.id, row.id));
      }
    }
    await this.lease.assertOwnership(row.id);
    const next = PHASES[Math.min(PHASES.indexOf(row.phase) + 1, PHASES.length - 1)]!;
    const completed = [...new Set([...(row.progress?.completedPhases ?? []), row.phase])];
    await this.update(row.id, { phase: next, progress: { ...row.progress, completedPhases: completed } });
    if (row.phase === 'cutover') await this.coordinator.refreshSourceSnapshots(row);
  }

  private async recheckPreflight(row: typeof dockerMigrations.$inferSelect) {
    const resource =
      row.resourceType === 'container'
        ? ({ type: 'container', containerName: row.resourceName } as const)
        : ({ type: 'deployment', deploymentId: row.deploymentId! } as const);
    const current = await this.preflight.run(
      {
        resource,
        sourceNodeId: row.sourceNodeId,
        targetNodeId: row.targetNodeId,
        keepSource: row.keepSource,
      },
      [],
      false
    );
    if (current.fingerprint !== row.sourceFingerprint || current.blockers.length > 0) {
      throw new AppError(409, 'MIGRATION_PREFLIGHT_STALE', 'Migration preflight changed after locks were acquired');
    }
  }

  private async rollback(row: typeof dockerMigrations.$inferSelect, cancelled: boolean) {
    await this.update(row.id, { phase: 'rollback', status: 'cancelling' });
    await this.executor.rollback(row);
    await this.coordinator.exitEnteredMaintenance(row);
    const updated = await this.update(row.id, {
      status: cancelled ? 'cancelled' : 'failed',
      completedAt: new Date(),
      phase: 'done',
      errorCode: cancelled ? null : row.errorCode,
      errorMessage: cancelled ? null : row.errorMessage,
    });
    await this.lease.release(row.id);
    this.clearMigrating(updated);
    await this.log(updated, cancelled ? 'docker_migration.cancelled' : 'docker_migration.rolled_back', row.createdById);
  }

  private async complete(row: typeof dockerMigrations.$inferSelect) {
    const updated = await this.update(row.id, { status: 'completed', phase: 'done', completedAt: new Date() });
    await this.lease.release(row.id);
    this.clearMigrating(updated);
    await this.log(updated, 'docker_migration.completed', row.createdById);
  }

  private async handleFailure(row: typeof dockerMigrations.$inferSelect, error: unknown) {
    const code = error instanceof AppError ? error.code : 'MIGRATION_FAILED';
    const message = error instanceof AppError ? error.message : 'Migration phase failed';
    if (code === 'MIGRATION_NODE_UNAVAILABLE' || code === 'MIGRATION_NODE_BUSY') {
      const updated = await this.update(row.id, {
        status: 'waiting',
        errorCode: code,
        errorMessage:
          code === 'MIGRATION_NODE_BUSY'
            ? 'Waiting for another migration to release a node lock'
            : 'Waiting for a migration node to reconnect',
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      this.emit(updated);
      return;
    }
    const fresh = await this.getRow(row.id);
    if (!fresh.cutoverAt) {
      await this.update(row.id, { errorCode: code, errorMessage: message });
      await this.rollback(await this.getRow(row.id), false).catch(async () => {
        await this.update(row.id, {
          status: 'needs_attention',
          errorCode: 'MIGRATION_ROLLBACK_FAILED',
          errorMessage: 'Migration rollback requires operator attention',
          completedAt: new Date(),
        });
        await this.lease.release(row.id);
      });
      return;
    }
    const updated = await this.update(row.id, {
      status: 'cleanup_pending',
      errorCode: code,
      errorMessage: message,
      completedAt: new Date(),
    });
    await this.lease.release(row.id);
    await this.log(updated, 'docker_migration.failed', row.createdById);
  }

  private async getRow(id: string) {
    const [row] = await this.db.select().from(dockerMigrations).where(eq(dockerMigrations.id, id)).limit(1);
    if (!row) throw new AppError(404, 'MIGRATION_NOT_FOUND', 'Docker migration not found');
    return row;
  }

  private async update(id: string, values: Partial<typeof dockerMigrations.$inferInsert>) {
    const [row] = await this.db
      .update(dockerMigrations)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(dockerMigrations.id, id), eq(dockerMigrations.leaseOwner, this.lease.owner)))
      .returning();
    if (!row) throw new AppError(409, 'MIGRATION_LEASE_LOST', 'Docker migration lease was lost');
    this.emit(row);
    return row;
  }

  private emit(row: typeof dockerMigrations.$inferSelect) {
    const migration = sanitizeDockerMigration(row);
    this.events.publish('docker.migration.changed', {
      id: row.id,
      resourceType: row.resourceType,
      resourceName: row.resourceName,
      deploymentId: row.deploymentId,
      sourceNodeId: row.sourceNodeId,
      targetNodeId: row.targetNodeId,
      targetNodeSlug: migration.targetNodeSlug,
      targetResourceId: migration.targetResourceId,
      scopeResourceId: this.scopeResourceId(row),
      status: row.status,
      phase: row.phase,
      cutoverAt: row.cutoverAt,
      progress: row.progress,
      errorCode: row.errorCode,
    });
  }

  private markMigrating(row: typeof dockerMigrations.$inferSelect): void {
    if (row.resourceType !== 'container') return;
    const sourceResourceId = String(
      (row.preflight as { sourceResourceId?: unknown } | null)?.sourceResourceId ?? row.resourceName
    );
    if (this.docker.setTransition(row.sourceNodeId, row.resourceName, 'migrating')) {
      this.docker.emitTransition(row.sourceNodeId, row.resourceName, sourceResourceId, 'migrating');
    }
    if (this.docker.setTransition(row.targetNodeId, row.resourceName, 'migrating')) {
      this.docker.emitTransition(row.targetNodeId, row.resourceName, '', 'migrating');
    }
  }

  private scopeResourceId(row: typeof dockerMigrations.$inferSelect): string {
    return String(
      (row.preflight as { scopeResourceId?: unknown } | null)?.scopeResourceId ??
        row.deploymentId ??
        (row.preflight as { sourceResourceId?: unknown } | null)?.sourceResourceId ??
        row.resourceName
    );
  }

  private clearMigrating(row: typeof dockerMigrations.$inferSelect): void {
    if (row.resourceType !== 'container') return;
    const migration = sanitizeDockerMigration(row);
    this.docker.clearTransition(row.sourceNodeId, row.resourceName);
    this.docker.clearTransition(row.targetNodeId, row.resourceName);
    this.docker.emitTransition(row.sourceNodeId, row.resourceName, '', null);
    this.docker.emitTransition(row.targetNodeId, row.resourceName, migration.targetResourceId ?? '', null);
  }

  private log(row: typeof dockerMigrations.$inferSelect, action: string, userId: string | null) {
    return this.audit.log({
      userId,
      action,
      resourceType: 'docker_migration',
      resourceId: row.id,
      details: {
        resourceType: row.resourceType,
        sourceNodeId: row.sourceNodeId,
        targetNodeId: row.targetNodeId,
        keepSource: row.keepSource,
        status: row.status,
        phase: row.phase,
      },
    });
  }
}
