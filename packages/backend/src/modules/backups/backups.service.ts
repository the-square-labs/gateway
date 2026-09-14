import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import cron from 'node-cron';
import type { DrizzleClient } from '@/db/client.js';
import {
  type BackupEngine,
  type BackupManifest,
  backupPolicies,
  backupRunNodeLeases,
  backupRuns,
} from '@/db/schema/backups.js';
import { databaseConnections, managedDatabaseInstances } from '@/db/schema/databases.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { SchedulerService } from '@/services/scheduler.service.js';
import type {
  BackupDestination,
  BackupLimits,
  BackupPolicyInput,
  BackupRestoreInput,
  BackupRuntimeConnection,
  BackupRuntimePayload,
  BackupRunView,
  StorageBackupTargetConfig,
} from './backups.types.js';

const DEFAULT_LIMITS: BackupLimits = {
  workspaceBytes: 20 * 1024 ** 3,
  timeoutSeconds: 3600,
  cpuCores: 1,
  memoryMb: 1024,
};
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

export interface NodeBackupDispatch {
  sendDockerBackupCommand(
    nodeId: string,
    action: 'preflight' | 'start' | 'status' | 'cancel',
    runId: string,
    configJson: string,
    timeoutMs: number
  ): Promise<{ success: boolean; detail?: string; error?: string }>;
}
export interface BackupAuthorization {
  assertSource(userId: string, databaseId: string, purpose: 'backup' | 'restore'): Promise<void>;
  assertDestination(userId: string, destinationId: string, purpose: 'read' | 'write' | 'delete'): Promise<void>;
  assertExecutor(userId: string, nodeId: string): Promise<void>;
  assertRestoreTarget?(userId: string, connectionId: string): Promise<void>;
  assertScheduledActor(
    userId: string,
    databaseId: string,
    destinationId: string,
    executorNodeId: string
  ): Promise<void>;
}
export interface BackupTargetStore {
  getBackupTarget(id: string): Promise<StorageBackupTargetConfig>;
  deleteOwnedBackupArtifacts(
    target: StorageBackupTargetConfig,
    selection: { bucket: string; prefix: string },
    manifest: BackupManifest
  ): Promise<void>;
}
export interface ManagedDatabaseBackupExecutorPreparation {
  prepareConnectionForExecutor(
    runId: string,
    executorNodeId: string,
    connectionId: string,
    purpose: 'backup' | 'restore'
  ): Promise<BackupRuntimeConnection & { relayRouteId: string; managedDatabaseId: string }>;
}
export interface BackupRestoreTargetPreparation {
  prepareRestoreTargetForExecutor(
    runId: string,
    executorNodeId: string,
    userId: string,
    target: { newManagedDatabaseName?: string; restoreTargetConnectionId?: string }
  ): Promise<BackupRuntimeConnection & { newManagedDatabaseName?: string; newManagedDatabaseId?: string }>;
}
export interface StorageBackupRuntimeResolver {
  resolve(
    target: StorageBackupTargetConfig,
    executorNodeId: string,
    selection: {
      runId: string;
      bucket: string;
      prefix: string;
      ownerKind: 'storage_backup_target' | 'storage_backup_staging';
    }
  ): Promise<BackupDestination>;
}
export interface BackupRuntimeCleanup {
  cleanupRuntime(runId: string): Promise<void>;
}
export interface RedisStageReachability {
  /** A server-approved executor address that the selected external Redis can connect back to. */
  getExecutorReachableAddress(executorNodeId: string): Promise<string>;
}
export interface BackupToolImageCatalog {
  get(engine: BackupEngine): string | undefined;
  getRedisStage(): string | undefined;
}

export class BackupService {
  private readonly dispatching = new Set<string>();
  constructor(
    private readonly db: DrizzleClient,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly nodeDispatch: NodeBackupDispatch,
    private readonly targets: BackupTargetStore,
    private readonly authorization: BackupAuthorization,
    private readonly scheduler: SchedulerService,
    private readonly toolImages: BackupToolImageCatalog,
    private readonly runtimeCleanup: BackupRuntimeCleanup,
    private readonly managedSourcePreparation?: ManagedDatabaseBackupExecutorPreparation,
    private readonly restoreTargetPreparation?: BackupRestoreTargetPreparation,
    private readonly storageRuntimeResolver?: StorageBackupRuntimeResolver,
    private readonly redisStageReachability?: RedisStageReachability
  ) {}

  registerScheduler() {
    this.scheduler.registerInterval('database-backups-reconcile', 30_000, () => this.reconcileActiveRuns());
    this.scheduler.registerInterval('database-backups-schedule', 60_000, () => this.runDuePolicies());
  }

  async createPolicy(databaseId: string, input: BackupPolicyInput, userId: string) {
    this.validatePolicy(input);
    await this.authorize(
      userId,
      databaseId,
      input.destinationId,
      input.executorNodeId,
      input.stagingStorageConnectionId
    );
    const row = await this.db.transaction(async (tx) => {
      await this.lockBackupDestinations(tx, input.destinationId, input.stagingStorageConnectionId);
      const [created] = await tx
        .insert(backupPolicies)
        .values({
          databaseConnectionId: databaseId,
          destinationId: input.destinationId,
          bucket: input.bucket,
          prefix: input.prefix,
          stagingStorageConnectionId: input.stagingStorageConnectionId ?? null,
          stagingBucket: input.stagingBucket ?? null,
          executorNodeId: input.executorNodeId,
          schedule: input.schedule ?? null,
          timezone: input.timezone,
          retentionCount: input.retentionCount,
          limits: this.normalizedLimits(input.limits),
          enabled: input.enabled !== false,
          createdById: userId,
        })
        .returning();
      return created!;
    });
    await this.audit.log({
      userId,
      action: 'database.backup_policy.create',
      resourceType: 'database',
      resourceId: databaseId,
      details: { policyId: row.id },
    });
    return row;
  }

  async updatePolicy(databaseId: string, policyId: string, input: BackupPolicyInput, userId: string) {
    const policy = await this.policyForDatabase(policyId, databaseId);
    this.validatePolicy(input);
    await this.authorize(
      userId,
      databaseId,
      input.destinationId,
      input.executorNodeId,
      input.stagingStorageConnectionId
    );
    const updated = await this.db.transaction(async (tx) => {
      await this.lockBackupDestinations(tx, input.destinationId, input.stagingStorageConnectionId);
      const [next] = await tx
        .update(backupPolicies)
        .set({
          destinationId: input.destinationId,
          bucket: input.bucket,
          prefix: input.prefix,
          stagingStorageConnectionId: input.stagingStorageConnectionId ?? null,
          stagingBucket: input.stagingBucket ?? null,
          executorNodeId: input.executorNodeId,
          schedule: input.schedule ?? null,
          timezone: input.timezone,
          retentionCount: input.retentionCount,
          limits: this.normalizedLimits(input.limits),
          enabled: input.enabled !== false,
          updatedAt: new Date(),
        })
        .where(and(eq(backupPolicies.id, policy.id), eq(backupPolicies.databaseConnectionId, databaseId)))
        .returning();
      return next!;
    });
    await this.audit.log({
      userId,
      action: 'database.backup_policy.update',
      resourceType: 'database',
      resourceId: databaseId,
      details: { policyId },
    });
    return updated;
  }

  async deletePolicy(databaseId: string, policyId: string, userId: string) {
    const policy = await this.policyForDatabase(policyId, databaseId);
    await this.authorize(
      userId,
      databaseId,
      policy.destinationId,
      policy.executorNodeId,
      policy.stagingStorageConnectionId
    );
    await this.db
      .delete(backupPolicies)
      .where(and(eq(backupPolicies.id, policy.id), eq(backupPolicies.databaseConnectionId, databaseId)));
    await this.audit.log({
      userId,
      action: 'database.backup_policy.delete',
      resourceType: 'database',
      resourceId: databaseId,
      details: { policyId },
    });
  }

  async listRuns(databaseId: string): Promise<BackupRunView[]> {
    const rows = await this.db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.databaseConnectionId, databaseId))
      .orderBy(desc(backupRuns.createdAt));
    return rows.map((row) => this.toRunView(row));
  }

  async listPolicies(databaseId: string) {
    return this.db
      .select()
      .from(backupPolicies)
      .where(eq(backupPolicies.databaseConnectionId, databaseId))
      .orderBy(asc(backupPolicies.createdAt));
  }

  async startBackup(databaseId: string, policyId: string, userId: string) {
    const policy = await this.policyForDatabase(policyId, databaseId);
    await this.authorize(
      userId,
      databaseId,
      policy.destinationId,
      policy.executorNodeId,
      policy.stagingStorageConnectionId
    );
    return this.createAndDispatch(policy, userId, 'backup');
  }

  async startRestore(databaseId: string, sourceRunId: string, input: BackupRestoreInput, userId: string) {
    if (input.overwrite)
      throw new AppError(400, 'BACKUP_RESTORE_OVERWRITE_UNSUPPORTED', 'Restore must use a new target');
    if (!input.newManagedDatabaseName && !input.restoreTargetConnectionId)
      throw new AppError(400, 'BACKUP_RESTORE_TARGET_REQUIRED', 'Restore requires a new target');
    const [source] = await this.db
      .select()
      .from(backupRuns)
      .where(
        and(
          eq(backupRuns.id, sourceRunId),
          eq(backupRuns.databaseConnectionId, databaseId),
          eq(backupRuns.status, 'completed')
        )
      )
      .limit(1);
    if (!source?.manifest || source.artifactsDeletedAt || source.direction !== 'backup')
      throw new AppError(404, 'BACKUP_ARTIFACT_NOT_FOUND', 'Completed backup artifact not found');
    await this.authorize(
      userId,
      databaseId,
      source.destinationId,
      input.executorNodeId,
      source.stagingStorageConnectionId,
      'read',
      'restore'
    );
    const limits = this.normalizedLimits({ ...DEFAULT_LIMITS, ...input.limits });
    const run = await this.db.transaction(async (tx) => {
      const [currentArtifact] = await tx.select().from(backupRuns).where(eq(backupRuns.id, sourceRunId)).for('share');
      if (!currentArtifact?.manifest || currentArtifact.artifactsDeletedAt)
        throw new AppError(409, 'BACKUP_ARTIFACT_RETIRED', 'Backup artifact was retired before restore admission');
      await this.lockBackupDestinations(tx, source.destinationId, source.stagingStorageConnectionId);
      const [created] = await tx
        .insert(backupRuns)
        .values({
          databaseConnectionId: databaseId,
          destinationId: source.destinationId,
          destinationBucket: source.destinationBucket,
          destinationPrefix: source.destinationPrefix,
          stagingStorageConnectionId: source.stagingStorageConnectionId,
          stagingBucket: source.stagingBucket,
          timezone: source.timezone,
          executorNodeId: input.executorNodeId,
          direction: 'restore',
          engine: source.engine,
          status: 'queued',
          phase: 'queued',
          requestFingerprint: this.fingerprint({ sourceRunId, input }),
          restoreTarget: {
            sourceRunId,
            newManagedDatabaseName: input.newManagedDatabaseName,
            restoreTargetConnectionId: input.restoreTargetConnectionId,
            artifact: source.manifest,
          },
          createdById: userId,
        })
        .returning();
      return created!;
    });
    await this.dispatchRun(run, limits, source.manifest);
    return this.toRunView(run);
  }

  async deleteHistory(databaseId: string, runId: string, userId: string) {
    const run = await this.getRun(runId);
    if (run.databaseConnectionId !== databaseId)
      throw new AppError(404, 'BACKUP_RUN_NOT_FOUND', 'Backup run not found');
    if (
      ['queued', 'running'].includes(run.status) ||
      run.runtimeCleanupPending ||
      (run.manifest && !run.artifactsDeletedAt)
    )
      throw new AppError(
        409,
        'BACKUP_HISTORY_IN_USE',
        'Only completed cleanup with retired artifacts can be removed from history'
      );
    await this.db.delete(backupRuns).where(eq(backupRuns.id, run.id));
    await this.audit.log({
      userId,
      action: 'database.backup.history_delete',
      resourceType: 'database',
      resourceId: databaseId,
      details: { runId },
    });
    return { success: true };
  }

  async cancel(databaseId: string, runId: string, userId: string) {
    const run = await this.getRun(runId);
    if (run.databaseConnectionId !== databaseId)
      throw new AppError(404, 'BACKUP_RUN_NOT_FOUND', 'Backup run not found');
    await this.authorize(
      userId,
      run.databaseConnectionId,
      run.destinationId,
      run.executorNodeId,
      run.stagingStorageConnectionId,
      run.direction === 'restore' ? 'read' : 'write',
      run.direction === 'restore' ? 'restore' : 'backup'
    );
    if (!['queued', 'running'].includes(run.status)) return;
    await this.db
      .update(backupRuns)
      .set({ status: 'running', phase: 'cancelling', updatedAt: new Date() })
      .where(and(eq(backupRuns.id, run.id), inArray(backupRuns.status, ['queued', 'running'])));
    try {
      await this.requireDispatch(run.executorNodeId, 'cancel', run.id, '', 15_000);
    } catch {
      /* Cancellation intent is durable; reconciliation retries after reconnect. */
    }
  }

  async reconcileActiveRuns() {
    const active = await this.db
      .select()
      .from(backupRuns)
      .where(inArray(backupRuns.status, ['queued', 'running']));
    await Promise.all(
      active.map(async (run) => {
        if (this.dispatching.has(run.id)) return;
        this.dispatching.add(run.id);
        try {
          const response = await this.nodeDispatch.sendDockerBackupCommand(
            run.executorNodeId,
            'status',
            run.id,
            '',
            15_000
          );
          const unknown = !response.success && response.error === 'BACKUP_RUN_UNKNOWN';
          if (run.phase === 'cancelling') {
            if (unknown) await this.finish(run.id, 'cancelled', 'cancelled');
            else if (response.success && response.detail) {
              const detail = this.parseRunnerDetail(response.detail);
              if (['completed', 'failed', 'cancelled'].includes(detail.status))
                await this.applyRunnerDetail(run.id, detail);
              else await this.requireDispatch(run.executorNodeId, 'cancel', run.id, '', 15_000);
            }
            return;
          }
          const detail = response.success && response.detail ? this.parseRunnerDetail(response.detail) : undefined;
          if (unknown || detail?.phase === 'preflight_complete') {
            if (run.encryptedRuntimePayload) {
              const raw = this.crypto.decryptString(JSON.parse(run.encryptedRuntimePayload));
              const payload = JSON.parse(raw) as BackupRuntimePayload;
              await this.resumeDispatch(run, payload, unknown);
            } else if (unknown && run.updatedAt.getTime() < Date.now() - 30 * 60_000) {
              await this.finish(
                run.id,
                'failed',
                'preparation_interrupted',
                undefined,
                'Backup preparation was interrupted before dispatch'
              );
            }
            return;
          }
          if (detail) await this.applyRunnerDetail(run.id, detail);
        } catch {
          /* A transport failure never proves the owned process has stopped. */
        } finally {
          this.dispatching.delete(run.id);
        }
      })
    );
  }

  private async runDuePolicies() {
    await this.reconcilePendingCleanup();
    const policies = await this.db
      .select()
      .from(backupPolicies)
      .where(eq(backupPolicies.enabled, true))
      .orderBy(asc(backupPolicies.id));
    await Promise.all(policies.map((policy) => this.runPolicyIfDue(policy)));
  }

  private async runPolicyIfDue(policy: typeof backupPolicies.$inferSelect) {
    const now = new Date();
    if (!policy.schedule || !cron.validate(policy.schedule) || !cronMatches(policy.schedule, now, policy.timezone))
      return;
    const minute = new Date(now);
    minute.setSeconds(0, 0);
    const [claimed] = await this.db
      .update(backupPolicies)
      .set({ lastScheduledAt: minute, updatedAt: now })
      .where(
        and(
          eq(backupPolicies.id, policy.id),
          sql`(${backupPolicies.lastScheduledAt} is null or ${backupPolicies.lastScheduledAt} < ${minute})`
        )
      )
      .returning({ id: backupPolicies.id });
    if (!claimed || !policy.createdById) return;
    try {
      await this.authorization.assertScheduledActor(
        policy.createdById,
        policy.databaseConnectionId,
        policy.destinationId,
        policy.executorNodeId
      );
      await this.authorize(
        policy.createdById,
        policy.databaseConnectionId,
        policy.destinationId,
        policy.executorNodeId,
        policy.stagingStorageConnectionId
      );
      await this.createAndDispatch(policy, policy.createdById, 'backup');
    } catch {
      // An invalidated actor or a busy executor is not retried in this cron minute.
    }
  }

  private async createAndDispatch(policy: typeof backupPolicies.$inferSelect, userId: string, direction: 'backup') {
    const row = await this.databaseRow(policy.databaseConnectionId);
    const engine = row.type as BackupEngine;
    if (!['postgres', 'redis', 'clickhouse'].includes(engine))
      throw new AppError(400, 'BACKUP_ENGINE_UNSUPPORTED', 'Database engine is not supported for native backup');
    const run = await this.db.transaction(async (tx) => {
      await this.lockBackupDestinations(tx, policy.destinationId, policy.stagingStorageConnectionId);
      const [created] = await tx
        .insert(backupRuns)
        .values({
          policyId: policy.id,
          databaseConnectionId: policy.databaseConnectionId,
          destinationId: policy.destinationId,
          destinationBucket: policy.bucket,
          destinationPrefix: policy.prefix,
          stagingStorageConnectionId: policy.stagingStorageConnectionId,
          stagingBucket: policy.stagingBucket,
          timezone: policy.timezone,
          executorNodeId: policy.executorNodeId,
          direction,
          engine,
          status: 'queued',
          phase: 'queued',
          requestFingerprint: this.fingerprint({ policyId: policy.id, direction, createdAt: Date.now() }),
          createdById: userId,
        })
        .returning();
      return created!;
    });
    await this.dispatchRun(run, policy.limits);
    await this.audit.log({
      userId,
      action: 'database.backup.start',
      resourceType: 'database',
      resourceId: policy.databaseConnectionId,
      details: { runId: run.id, policyId: policy.id },
    });
    return this.toRunView(run);
  }

  private async dispatchRun(
    run: typeof backupRuns.$inferSelect,
    limits: BackupLimits,
    restoreArtifact?: BackupManifest
  ) {
    const claimed = await this.claim(run.id, run.executorNodeId, limits.timeoutSeconds);
    if (!claimed) {
      await this.db
        .update(backupRuns)
        .set({
          status: 'failed',
          phase: 'executor_busy',
          sanitizedError: 'A backup is already active on this Storage node',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(backupRuns.id, run.id));
      throw new AppError(409, 'BACKUP_EXECUTOR_BUSY', 'A backup is already active on this Storage node');
    }
    this.dispatching.add(run.id);
    let persisted = false;
    try {
      const payload = await this.runtimePayload(run, limits, restoreArtifact);
      await this.db
        .update(backupRuns)
        .set({
          encryptedRuntimePayload: JSON.stringify(this.crypto.encryptString(JSON.stringify(payload))),
          phase: 'dispatching',
          updatedAt: new Date(),
        })
        .where(eq(backupRuns.id, run.id));
      persisted = true;
      await this.resumeDispatch(run, payload, true);
    } catch (error) {
      if (!persisted) {
        await this.finish(
          run.id,
          'failed',
          'preparation',
          undefined,
          error instanceof Error ? error.message : 'Backup preparation failed'
        );
        throw error;
      }
      // The daemon may have accepted a timed-out request. Keep its lease and route
      // until a status response proves completion; replay uses the same encrypted snapshot.
      await this.db
        .update(backupRuns)
        .set({ phase: 'awaiting_runner', updatedAt: new Date() })
        .where(
          and(
            eq(backupRuns.id, run.id),
            inArray(backupRuns.status, ['queued', 'running']),
            sql`${backupRuns.phase} <> 'cancelling'`
          )
        );
    } finally {
      this.dispatching.delete(run.id);
    }
  }

  private async resumeDispatch(run: typeof backupRuns.$inferSelect, payload: BackupRuntimePayload, preflight: boolean) {
    if (!(await this.authorizeDispatch(run, payload))) return;
    const raw = JSON.stringify(payload);
    if (preflight) {
      const response = await this.nodeDispatch.sendDockerBackupCommand(
        run.executorNodeId,
        'preflight',
        run.id,
        raw,
        30_000
      );
      if (!response.success) {
        // Dispatch also reports transport errors as success:false. Only persisted
        // runner status can prove termination and release the executor lease.
        throw new AppError(502, 'BACKUP_RUNNER_UNCONFIRMED', 'Awaiting backup runner status');
      }
      if (response.detail) {
        const detail = this.parseRunnerDetail(response.detail);
        if (['completed', 'failed', 'cancelled'].includes(detail.status)) {
          await this.applyRunnerDetail(run.id, detail);
          return;
        }
      }
    }
    const current = await this.getRun(run.id);
    if (current.phase === 'cancelling' || !['queued', 'running'].includes(current.status)) return;
    if (!(await this.authorizeDispatch(current, payload))) return;
    const response = await this.requireDispatch(run.executorNodeId, 'start', run.id, raw, 30_000);
    if (response.detail) await this.applyRunnerDetail(run.id, this.parseRunnerDetail(response.detail));
  }

  private async authorizeDispatch(
    run: typeof backupRuns.$inferSelect,
    payload: BackupRuntimePayload
  ): Promise<boolean> {
    try {
      if (!run.createdById) throw new AppError(403, 'BACKUP_ACTOR_UNAVAILABLE', 'Backup owner is unavailable');
      await this.authorize(
        run.createdById,
        run.databaseConnectionId,
        run.destinationId,
        run.executorNodeId,
        run.stagingStorageConnectionId,
        run.direction === 'restore' ? 'read' : 'write',
        run.direction
      );
      if (run.direction === 'restore') {
        if (!payload.restoreTarget?.connectionId || !this.authorization.assertRestoreTarget) {
          throw new AppError(403, 'BACKUP_ACTOR_UNAVAILABLE', 'Restore target authorization is unavailable');
        }
        await this.authorization.assertRestoreTarget(run.createdById, payload.restoreTarget.connectionId);
      }
      return true;
    } catch (error) {
      // Transient policy/DB failures postpone dispatch. A revoked grant records
      // cancellation intent before contacting the daemon, because a prior ACK
      // may have been lost and the owned process may already exist.
      if (!(error instanceof AppError) || (error.statusCode !== 403 && error.statusCode !== 401)) throw error;
      await this.db
        .update(backupRuns)
        .set({ phase: 'cancelling', sanitizedError: 'Backup authorization was revoked', updatedAt: new Date() })
        .where(eq(backupRuns.id, run.id));
      const result = await this.nodeDispatch.sendDockerBackupCommand(run.executorNodeId, 'cancel', run.id, '', 15_000);
      if (!result.success && result.error === 'BACKUP_RUN_UNKNOWN')
        await this.finish(run.id, 'cancelled', 'authorization_revoked');
      else if (result.success && result.detail)
        await this.applyRunnerDetail(run.id, this.parseRunnerDetail(result.detail));
      return false;
    }
  }

  private async runtimePayload(
    run: typeof backupRuns.$inferSelect,
    limits: BackupLimits,
    restoreArtifact?: BackupManifest
  ): Promise<BackupRuntimePayload> {
    const source = run.direction === 'backup' ? await this.resolveSource(run) : undefined;
    const destination = await this.resolveDestination(run.destinationId, run.executorNodeId, {
      runId: run.id,
      bucket: run.destinationBucket,
      prefix: run.destinationPrefix,
      ownerKind: 'storage_backup_target',
    });
    if (destination.provider === 'sftp' && !destination.hostKeyFingerprint)
      throw new AppError(
        400,
        'BACKUP_SFTP_HOST_KEY_REQUIRED',
        'SFTP destination requires a pinned host key fingerprint'
      );
    const staging = run.stagingStorageConnectionId
      ? await this.resolveDestination(run.stagingStorageConnectionId, run.executorNodeId, {
          runId: run.id,
          bucket: run.stagingBucket!,
          prefix: `${run.destinationPrefix}/staging/${run.id}`,
          ownerKind: 'storage_backup_staging',
        })
      : undefined;
    const targetReference = run.restoreTarget as {
      newManagedDatabaseName?: string;
      restoreTargetConnectionId?: string;
    } | null;
    const restoreTarget =
      run.direction === 'restore'
        ? await this.resolveRestoreTarget(
            run.id,
            run.executorNodeId,
            run.createdById,
            run.databaseConnectionId,
            targetReference
          )
        : undefined;
    if (run.engine === 'clickhouse') {
      const nativeS3 = staging ?? destination;
      const database = source ?? restoreTarget;
      if (nativeS3.relayRouteId) {
        if (!database?.managedDatabaseId)
          throw new AppError(
            400,
            'BACKUP_CLICKHOUSE_STAGING_REQUIRED',
            'External ClickHouse requires a server-reachable S3 staging connection when the destination is private'
          );
        const [managed] = await this.db
          .select({ nodeId: managedDatabaseInstances.nodeId })
          .from(managedDatabaseInstances)
          .where(eq(managedDatabaseInstances.id, database.managedDatabaseId))
          .limit(1);
        if (managed?.nodeId !== run.executorNodeId)
          throw new AppError(
            400,
            'BACKUP_CLICKHOUSE_EXECUTOR_REQUIRED',
            'Select the ClickHouse node as executor or configure server-reachable S3 staging'
          );
      }
    }
    const redisStageAdvertiseHost =
      run.direction === 'restore' && run.engine === 'redis' && restoreTarget && !restoreTarget.managedDatabaseId
        ? await this.resolveRedisStageReachability(run.executorNodeId)
        : undefined;
    return {
      runId: run.id,
      version: 1,
      direction: run.direction,
      engine: run.engine,
      source,
      destination,
      staging,
      restoreTarget: restoreTarget ?? undefined,
      limits,
      toolImage: this.toolImageFor(run.engine),
      redisStageImage: run.direction === 'restore' && run.engine === 'redis' ? this.redisStageImage() : undefined,
      redisStageAdvertiseHost,
      restoreArtifact,
    };
  }

  private async resolveSource(run: typeof backupRuns.$inferSelect): Promise<BackupRuntimeConnection> {
    const row = await this.databaseRow(run.databaseConnectionId);
    // Always decrypt the canonical persisted record. DatabaseConnectionService.getDecryptedConfig
    // intentionally rewrites managed addresses to Gateway loopback and must never feed a Storage node.
    const config = JSON.parse(this.crypto.decryptString(JSON.parse(row.encryptedConfig))) as Record<string, unknown>;
    const [managedInstance] = await this.db
      .select({ id: managedDatabaseInstances.id })
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.databaseConnectionId, run.databaseConnectionId))
      .limit(1);
    if (managedInstance && this.managedSourcePreparation) {
      return this.managedSourcePreparation.prepareConnectionForExecutor(
        run.id,
        run.executorNodeId,
        run.databaseConnectionId,
        run.direction
      );
    }
    if (managedInstance)
      throw new AppError(409, 'BACKUP_MANAGED_RELAY_REQUIRED', 'Managed database backup requires relay integration');
    return {
      connectionId: row.id,
      host: String(config.host),
      port: Number(config.port),
      database: typeof config.database === 'string' ? config.database : undefined,
      username: typeof config.username === 'string' ? config.username : undefined,
      password: typeof config.password === 'string' ? config.password : undefined,
      tls: Boolean(config.sslEnabled ?? config.tlsEnabled),
      caPem: typeof config.caPem === 'string' ? config.caPem : undefined,
      serverName: typeof config.serverName === 'string' ? config.serverName : undefined,
    };
  }

  private async resolveRestoreTarget(
    runId: string,
    executorNodeId: string,
    userId: string | null,
    sourceConnectionId: string,
    target: { newManagedDatabaseName?: string; restoreTargetConnectionId?: string } | null
  ) {
    if (
      !target ||
      (!target.newManagedDatabaseName && !target.restoreTargetConnectionId) ||
      !this.restoreTargetPreparation ||
      !userId ||
      target.restoreTargetConnectionId === sourceConnectionId
    ) {
      throw new AppError(
        409,
        'BACKUP_RESTORE_TARGET_PREPARATION_REQUIRED',
        'Restore target requires server-side executor preparation'
      );
    }
    const prepared = await this.restoreTargetPreparation.prepareRestoreTargetForExecutor(
      runId,
      executorNodeId,
      userId,
      target
    );
    if (prepared.connectionId === sourceConnectionId)
      throw new AppError(409, 'BACKUP_RESTORE_TARGET_INVALID', 'Restore target must be a distinct empty database');
    return {
      connectionId: prepared.connectionId,
      host: prepared.host,
      port: prepared.port,
      database: prepared.database,
      username: prepared.username,
      password: prepared.password,
      tls: prepared.tls,
      caPem: prepared.caPem,
      serverName: prepared.serverName,
      relayRouteId: prepared.relayRouteId,
      managedDatabaseId: prepared.managedDatabaseId,
    };
  }

  private async resolveRedisStageReachability(executorNodeId: string) {
    if (!this.redisStageReachability)
      throw new AppError(
        409,
        'BACKUP_REDIS_STAGE_REACHABILITY_REQUIRED',
        'External Redis restore requires an executor-reachable staging address'
      );
    const host = (await this.redisStageReachability.getExecutorReachableAddress(executorNodeId)).trim();
    if (!host || host === 'localhost' || host === '::1' || host.startsWith('127.') || /[\\/\s]/.test(host))
      throw new AppError(
        409,
        'BACKUP_REDIS_STAGE_REACHABILITY_REQUIRED',
        'External Redis restore requires a non-loopback executor address'
      );
    return host;
  }

  private async claim(runId: string, nodeId: string, timeoutSeconds: number) {
    const now = new Date();
    const expiry = new Date(now.getTime() + timeoutSeconds * 1000);
    const [existingLease] = await this.db
      .select()
      .from(backupRunNodeLeases)
      .where(eq(backupRunNodeLeases.executorNodeId, nodeId))
      .limit(1);
    if (existingLease && existingLease.runId !== runId && existingLease.expiresAt <= now) {
      try {
        const response = await this.nodeDispatch.sendDockerBackupCommand(
          nodeId,
          'status',
          existingLease.runId,
          '',
          15_000
        );
        if (!response.success || !response.detail) return false;
        const detail = this.parseRunnerDetail(response.detail);
        if (detail.status === 'queued' || detail.status === 'running' || detail.cleanupPending) return false;
        await this.applyRunnerDetail(existingLease.runId, detail);
        await this.db
          .delete(backupRunNodeLeases)
          .where(
            and(eq(backupRunNodeLeases.executorNodeId, nodeId), eq(backupRunNodeLeases.runId, existingLease.runId))
          );
      } catch {
        // A status transport failure never proves that the old executor process is gone.
        return false;
      }
    }
    const claimed = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(backupRuns)
        .set({ status: 'running', phase: 'claimed', claimedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(backupRuns.id, runId), eq(backupRuns.status, 'queued')))
        .returning({ id: backupRuns.id });
      if (!updated) return false;
      const inserted = await tx.execute(
        sql`insert into backup_run_node_leases (executor_node_id, run_id, expires_at) values (${nodeId}, ${runId}, ${expiry})
          on conflict (executor_node_id) do nothing
          returning run_id`
      );
      if ((inserted as { rows?: unknown[] }).rows?.length) return true;
      await tx
        .update(backupRuns)
        .set({ status: 'queued', phase: 'queued', claimedAt: null })
        .where(eq(backupRuns.id, runId));
      return false;
    });
    return claimed;
  }

  private async applyRunnerDetail(
    runId: string,
    detail: {
      status: string;
      phase?: string;
      bytes?: number;
      manifest?: BackupManifest;
      error?: string;
      cleanupPending?: boolean;
    }
  ) {
    if (!['queued', 'running', 'completed', 'failed', 'cancelled'].includes(detail.status))
      throw new AppError(400, 'BACKUP_RUNNER_INVALID_STATUS', 'Runner returned invalid backup status');
    const run = await this.getRun(runId);
    if (!['queued', 'running'].includes(run.status)) return;
    if (detail.cleanupPending) {
      // The daemon retains its terminal result; continue ordinary polling and
      // keep the executor lease until its owned workspace is reclaimed.
      await this.db
        .update(backupRuns)
        .set({ status: 'running', phase: 'cleanup_pending', updatedAt: new Date() })
        .where(eq(backupRuns.id, runId));
      return;
    }
    if (detail.status === 'completed' && run.direction === 'backup') {
      const manifest = detail.manifest;
      const ownedPrefix = `${run.destinationPrefix}/${run.id}`;
      const valid =
        manifest &&
        manifest.version === 1 &&
        manifest.engine === run.engine &&
        manifest.sourceIdentity === run.databaseConnectionId &&
        manifest.ownedPrefix === ownedPrefix &&
        /^[a-f0-9]{64}$/.test(manifest.manifestSha256) &&
        Boolean(manifest.engineVersion) &&
        Array.isArray(manifest.artifactKeys) &&
        manifest.sizes &&
        manifest.fileChecksums &&
        manifest.artifactKeys.length > 0 &&
        new Set(manifest.artifactKeys).size === manifest.artifactKeys.length &&
        manifest.artifactKeys.every(
          (key) =>
            typeof key === 'string' &&
            key.startsWith(`${ownedPrefix}/`) &&
            key.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
            !key.includes('\\') &&
            !Array.from(key).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
            /^[a-f0-9]{64}$/.test(manifest.fileChecksums[key] ?? '') &&
            Number.isSafeInteger(manifest.sizes[key]) &&
            manifest.sizes[key]! >= 0
        );
      if (!valid) {
        await this.finish(
          runId,
          'failed',
          'manifest_invalid',
          undefined,
          'Runner returned an invalid or unowned backup manifest'
        );
        return;
      }
    }
    if (detail.status === 'completed' || detail.status === 'failed' || detail.status === 'cancelled')
      await this.finish(
        runId,
        detail.status,
        detail.phase ?? detail.status,
        detail.manifest,
        detail.error,
        detail.bytes
      );
    else
      await this.db
        .update(backupRuns)
        .set({
          status: detail.status as 'queued' | 'running',
          phase: run.phase === 'cancelling' ? 'cancelling' : (detail.phase ?? detail.status),
          bytes: String(detail.bytes ?? 0),
          updatedAt: new Date(),
        })
        .where(eq(backupRuns.id, runId));
  }

  private async finish(
    runId: string,
    status: 'completed' | 'failed' | 'cancelled',
    phase: string,
    manifest?: BackupManifest,
    error?: string,
    bytes = 0
  ) {
    const run = await this.getRun(runId);
    await this.db.transaction(async (tx) => {
      await tx
        .update(backupRuns)
        .set({
          status,
          phase,
          manifest: manifest ?? null,
          bytes: String(bytes),
          sanitizedError: error ? this.redact(error) : null,
          completedAt: new Date(),
          updatedAt: new Date(),
          runtimeCleanupPending: true,
          encryptedRuntimePayload: null,
        })
        .where(eq(backupRuns.id, runId));
      await tx.delete(backupRunNodeLeases).where(eq(backupRunNodeLeases.runId, runId));
    });
    await this.cleanupRuntime(runId);
    if (status === 'completed' && run.direction === 'backup' && run.policyId) await this.enforceRetention(run.policyId);
  }

  private async enforceRetention(policyId: string) {
    const [policy] = await this.db.select().from(backupPolicies).where(eq(backupPolicies.id, policyId)).limit(1);
    if (!policy) return;
    const completed = await this.db
      .select()
      .from(backupRuns)
      .where(
        and(
          eq(backupRuns.policyId, policyId),
          eq(backupRuns.direction, 'backup'),
          eq(backupRuns.status, 'completed'),
          sql`${backupRuns.artifactsDeletedAt} is null`
        )
      )
      .orderBy(desc(backupRuns.completedAt));
    for (const run of completed.slice(policy.retentionCount)) {
      if (!run.manifest?.ownedPrefix || !run.createdById) continue;
      await this.authorization.assertDestination(run.createdById, run.destinationId, 'delete');
      await this.db.transaction(async (tx) => {
        const [current] = await tx.select().from(backupRuns).where(eq(backupRuns.id, run.id)).for('update');
        if (!current || current.artifactsDeletedAt) return;
        const [restoring] = await tx
          .select({ id: backupRuns.id })
          .from(backupRuns)
          .where(
            and(
              inArray(backupRuns.status, ['queued', 'running']),
              sql`${backupRuns.restoreTarget}->>'sourceRunId' = ${run.id}`
            )
          )
          .limit(1);
        if (restoring) return;
        const target = await this.targets.getBackupTarget(run.destinationId);
        await this.targets.deleteOwnedBackupArtifacts(
          target,
          { bucket: run.destinationBucket, prefix: run.destinationPrefix },
          run.manifest!
        );
        await tx
          .update(backupRuns)
          .set({ artifactsDeletedAt: new Date(), updatedAt: new Date() })
          .where(eq(backupRuns.id, run.id));
      });
    }
  }

  private validatePolicy(input: BackupPolicyInput) {
    if (
      input.schedule &&
      (!cron.validate(input.schedule) || !/^[0-9*/,-]+(?: +[0-9*/,-]+){4}$/.test(input.schedule.trim()))
    )
      throw new AppError(400, 'BACKUP_SCHEDULE_INVALID', 'Schedule must be a numeric five-field cron expression');
    if (!Number.isInteger(input.retentionCount) || input.retentionCount < 1 || input.retentionCount > 365)
      throw new AppError(400, 'BACKUP_RETENTION_INVALID', 'Retention must be between 1 and 365');
    if (!isBucketName(input.bucket) || !isSafePrefix(input.prefix))
      throw new AppError(400, 'BACKUP_DESTINATION_INVALID', 'Backup bucket or prefix is invalid');
    if (
      (input.stagingStorageConnectionId && !input.stagingBucket) ||
      (!input.stagingStorageConnectionId && input.stagingBucket)
    )
      throw new AppError(400, 'BACKUP_STAGING_INVALID', 'Staging storage and bucket must be configured together');
    if (input.stagingBucket && !isBucketName(input.stagingBucket))
      throw new AppError(400, 'BACKUP_STAGING_INVALID', 'Staging bucket is invalid');
    if (!isValidTimezone(input.timezone))
      throw new AppError(400, 'BACKUP_TIMEZONE_INVALID', 'Backup timezone is invalid');
    this.normalizedLimits(input.limits);
  }
  private normalizedLimits(limits: BackupLimits): BackupLimits {
    const value = { ...DEFAULT_LIMITS, ...limits };
    if (
      !Number.isInteger(value.workspaceBytes) ||
      value.workspaceBytes < 1024 ** 3 ||
      value.workspaceBytes > 1024 ** 4 ||
      !Number.isInteger(value.timeoutSeconds) ||
      value.timeoutSeconds < 60 ||
      value.timeoutSeconds > MAX_TIMEOUT_SECONDS ||
      !Number.isInteger(value.cpuCores) ||
      value.cpuCores < 1 ||
      value.cpuCores > 32 ||
      !Number.isInteger(value.memoryMb) ||
      value.memoryMb < 128 ||
      value.memoryMb > 262144
    )
      throw new AppError(400, 'BACKUP_LIMITS_INVALID', 'Backup limits are outside allowed bounds');
    return value;
  }
  private async lockBackupDestinations(
    tx: Pick<DrizzleClient, 'execute'>,
    destinationId: string,
    stagingStorageConnectionId?: string | null
  ) {
    const ids = [
      ...new Set([destinationId, stagingStorageConnectionId].filter((value): value is string => Boolean(value))),
    ];
    const result = await tx.execute(sql`
      select connection.id, cluster.status as managed_status
      from object_storage_connections connection
      left join managed_storage_clusters cluster on cluster.object_storage_connection_id = connection.id
      where connection.id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `
      )})
      for share of connection
    `);
    const rows = result.rows.map((row) => ({
      id: String(row.id),
      managed_status: typeof row.managed_status === 'string' ? row.managed_status : null,
    }));
    if (rows.length !== ids.length)
      throw new AppError(
        409,
        'BACKUP_DESTINATION_UNAVAILABLE',
        'Backup destination was deleted during request processing'
      );
    if (rows.some((row) => row.managed_status && row.managed_status !== 'ready'))
      throw new AppError(409, 'BACKUP_DESTINATION_UNAVAILABLE', 'Managed backup destination is not ready');
  }
  private async authorize(
    userId: string,
    databaseId: string,
    destinationId: string,
    executorNodeId: string,
    stagingStorageConnectionId?: string | null,
    destinationPurpose: 'read' | 'write' | 'delete' = 'write',
    sourcePurpose: 'backup' | 'restore' = 'backup'
  ) {
    await Promise.all([
      this.authorization.assertSource(userId, databaseId, sourcePurpose),
      this.authorization.assertDestination(userId, destinationId, destinationPurpose),
      this.authorization.assertExecutor(userId, executorNodeId),
      ...(stagingStorageConnectionId
        ? [this.authorization.assertDestination(userId, stagingStorageConnectionId, 'write')]
        : []),
    ]);
  }
  private async policyForDatabase(id: string, databaseId: string) {
    const [policy] = await this.db
      .select()
      .from(backupPolicies)
      .where(and(eq(backupPolicies.id, id), eq(backupPolicies.databaseConnectionId, databaseId)))
      .limit(1);
    if (!policy) throw new AppError(404, 'BACKUP_POLICY_NOT_FOUND', 'Backup policy not found');
    return policy;
  }
  private async databaseRow(id: string) {
    const [row] = await this.db.select().from(databaseConnections).where(eq(databaseConnections.id, id)).limit(1);
    if (!row) throw new AppError(404, 'DATABASE_NOT_FOUND', 'Database connection not found');
    return row;
  }
  private async getRun(id: string) {
    const [run] = await this.db.select().from(backupRuns).where(eq(backupRuns.id, id)).limit(1);
    if (!run) throw new AppError(404, 'BACKUP_RUN_NOT_FOUND', 'Backup run not found');
    return run;
  }
  private toolImageFor(engine: BackupEngine) {
    const image = this.toolImages.get(engine);
    if (!image?.includes('@sha256:'))
      throw new AppError(
        503,
        'BACKUP_TOOL_IMAGE_UNAVAILABLE',
        'Server-approved immutable backup tool image is not configured'
      );
    return image;
  }
  private redisStageImage() {
    const image = this.toolImages.getRedisStage();
    if (!image?.includes('@sha256:'))
      throw new AppError(
        503,
        'BACKUP_REDIS_STAGE_IMAGE_UNAVAILABLE',
        'Immutable Redis staging image is not configured'
      );
    return image;
  }
  private normalizeDestination(target: StorageBackupTargetConfig): BackupDestination {
    const provider =
      target.provider === 'ftp' || target.provider === 'ftps' || target.provider === 'sftp' ? target.provider : 's3';
    if (
      (target.managedClusterId || target.managedNodeId) &&
      (!this.storageRuntimeResolver || target.endpoint?.includes('127.0.0.1') || target.endpoint?.includes('localhost'))
    ) {
      throw new AppError(
        409,
        'BACKUP_STORAGE_RELAY_REQUIRED',
        'Managed private storage requires executor relay integration'
      );
    }
    return {
      ...target,
      provider,
      connectionId: target.connectionId,
      host: target.host ?? '',
      port: target.port ?? (provider === 's3' ? 443 : provider === 'sftp' ? 22 : 21),
      tls: provider === 'ftps' || provider === 's3',
    };
  }
  private async resolveDestination(
    targetId: string,
    executorNodeId: string,
    selection: {
      runId: string;
      bucket: string;
      prefix: string;
      ownerKind: 'storage_backup_target' | 'storage_backup_staging';
    }
  ) {
    const target = await this.targets.getBackupTarget(targetId);
    const destination = this.storageRuntimeResolver
      ? await this.storageRuntimeResolver.resolve(target, executorNodeId, selection)
      : { ...this.normalizeDestination(target), bucket: selection.bucket, prefix: selection.prefix };
    if (
      destination.provider === 's3' &&
      (destination.bucket !== selection.bucket || destination.prefix !== selection.prefix)
    )
      throw new AppError(
        409,
        'BACKUP_DESTINATION_SNAPSHOT_INVALID',
        'Storage resolver did not preserve the immutable backup location'
      );
    return destination;
  }
  private async requireDispatch(
    nodeId: string,
    action: 'preflight' | 'start' | 'status' | 'cancel',
    runId: string,
    configJson: string,
    timeoutMs: number
  ) {
    const response = await this.nodeDispatch.sendDockerBackupCommand(nodeId, action, runId, configJson, timeoutMs);
    if (!response.success)
      throw new AppError(
        502,
        'BACKUP_RUNNER_REJECTED',
        this.redact(response.error ?? 'Backup runner rejected request')
      );
    return response;
  }
  private async cleanupRuntime(runId: string) {
    try {
      await this.runtimeCleanup.cleanupRuntime(runId);
      await this.db
        .update(backupRuns)
        .set({ runtimeCleanupPending: false, updatedAt: new Date() })
        .where(eq(backupRuns.id, runId));
    } catch {
      await this.db
        .update(backupRuns)
        .set({ runtimeCleanupPending: true, updatedAt: new Date() })
        .where(eq(backupRuns.id, runId));
    }
  }
  private async reconcilePendingCleanup() {
    const rows = await this.db
      .select({ id: backupRuns.id })
      .from(backupRuns)
      .where(eq(backupRuns.runtimeCleanupPending, true));
    await Promise.all(rows.map((row) => this.cleanupRuntime(row.id)));
  }
  private fingerprint(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  private parseRunnerDetail(detail: string) {
    return JSON.parse(detail) as {
      status: string;
      cleanupPending?: boolean;
      phase?: string;
      bytes?: number;
      manifest?: BackupManifest;
      error?: string;
    };
  }
  private redact(value: string) {
    return value.replace(/(password|secret|token|private.?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]').slice(0, 2048);
  }
  private toRunView(row: typeof backupRuns.$inferSelect): BackupRunView {
    return {
      id: row.id,
      policyId: row.policyId,
      databaseConnectionId: row.databaseConnectionId,
      destinationId: row.destinationId,
      destinationBucket: row.destinationBucket,
      destinationPrefix: row.destinationPrefix,
      stagingStorageConnectionId: row.stagingStorageConnectionId,
      stagingBucket: row.stagingBucket,
      timezone: row.timezone,
      executorNodeId: row.executorNodeId,
      direction: row.direction,
      engine: row.engine,
      status: row.status,
      phase: row.phase,
      bytes: row.bytes,
      manifest: row.manifest,
      error: row.sanitizedError,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      artifactsDeletedAt: row.artifactsDeletedAt,
      createdAt: row.createdAt,
    };
  }
}

export function shouldRunScheduledPolicy(expression: string, now: Date, timezone: string) {
  return cronMatches(expression, now, timezone);
}

function cronMatches(expression: string, now: Date, timezone: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    minute: 'numeric',
    hour: 'numeric',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (name: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === name)?.value);
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const dayByName: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const values = [value('minute'), value('hour'), value('day'), value('month'), dayByName[weekday ?? '']];
  const matches = fields.map((field, index) => cronFieldMatches(field, values[index]!, [0, 0, 1, 1, 0][index]!));
  if (values[4] === 0 && cronFieldMatches(fields[4]!, 7, 0)) matches[4] = true;
  const days = fields[2] !== '*' && fields[4] !== '*' ? matches[2] || matches[4] : matches[2] && matches[4];
  return Boolean(matches[0] && matches[1] && matches[3] && days);
}

function isBucketName(value: string) {
  return /^[a-z0-9][a-z0-9.-]{1,253}[a-z0-9]$/.test(value) && !value.includes('..');
}
function isSafePrefix(value: string) {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes('\\') &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    !value.startsWith('/') &&
    !value.split('/').some((segment) => !segment || segment === '..' || segment === '.')
  );
}
function isValidTimezone(value: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function cronFieldMatches(field: string, value: number, min: number) {
  return field.split(',').some((part) => {
    const [range, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    const [startText, endText] = range === '*' ? [String(min), String(Number.MAX_SAFE_INTEGER)] : range!.split('-');
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    return (
      Number.isInteger(start) && Number.isInteger(end) && value >= start && value <= end && (value - start) % step === 0
    );
  });
}
