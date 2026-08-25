import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import {
  type DockerBuildScanSummary,
  type DockerBuildStatus,
  type DockerBuildTrigger,
  dockerBuildBatches,
  dockerBuilds,
  dockerSourceBindings,
} from '@/db/schema/index.js';
import type { DockerBuildEvent } from '@/grpc/generated/types.js';
import { AppError } from '@/middleware/error-handler.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { DockerBuildArtifactStore } from './docker-build-artifact.js';
import {
  ACTIVE_BUILD_STATUSES,
  assertSupportedDockerBuildResourcePolicy,
  canTransitionDockerBuild,
  DEFAULT_BUILD_LEASE_MS,
  expiredDockerBuildDisposition,
  parseDockerBuildProgress,
  parseDockerBuildScanSummary,
  TERMINAL_BUILD_STATUSES,
} from './docker-build-policy.js';
import { type DockerBuildListInput, DockerBuildQuery } from './docker-build-query.js';

export {
  assertSupportedDockerBuildResourcePolicy,
  canTransitionDockerBuild,
  dockerBuildLimits,
  evaluateDockerArtifactPolicy,
  expiredDockerBuildDisposition,
  redactDockerBuildLog,
} from './docker-build-policy.js';

export interface DockerBuildEnqueueInput {
  sourceBindingId: string;
  commitSha: string;
  trigger: DockerBuildTrigger;
  triggerDeliveryId?: string | null;
  createdById?: string | null;
  force?: boolean;
}

export class DockerBuildService {
  private eventBus?: EventBusService;
  private admissionGuard?: () => Promise<void>;
  private licenseGuard?: () => Promise<void>;
  private artifactRollout?: (buildId: string) => Promise<'deployed' | 'superseded' | 'pending'>;
  private buildReleaseHandler?: (buildId: string) => Promise<void>;

  private readonly artifacts: DockerBuildArtifactStore;
  private readonly query: DockerBuildQuery;

  constructor(private readonly db: DrizzleClient) {
    this.query = new DockerBuildQuery(db);
    this.artifacts = new DockerBuildArtifactStore(db, (topic, payload) => this.publishBuildEvent(topic, payload));
  }

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  setAdmissionGuard(guard: () => Promise<void>): void {
    this.admissionGuard = guard;
  }

  setLicenseGuard(guard: () => Promise<void>): void {
    this.licenseGuard = guard;
  }

  setArtifactRollout(handler: (buildId: string) => Promise<'deployed' | 'superseded' | 'pending'>): void {
    this.artifactRollout = handler;
  }

  setBuildReleaseHandler(handler: (buildId: string) => Promise<void>): void {
    this.buildReleaseHandler = handler;
  }

  async admissionStatus(): Promise<{ ready: boolean; code: string | null; message: string | null }> {
    try {
      await this.admissionGuard?.();
      return { ready: true, code: null, message: null };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return { ready: false, code: error.code, message: error.message };
    }
  }

  async enqueue(input: DockerBuildEnqueueInput) {
    await this.licenseGuard?.();
    await this.admissionGuard?.();
    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-build-source:${input.sourceBindingId}`}))`);
      const [source] = await tx
        .select()
        .from(dockerSourceBindings)
        .where(eq(dockerSourceBindings.id, input.sourceBindingId))
        .limit(1);
      if (!source) throw new AppError(404, 'SOURCE_BINDING_NOT_FOUND', 'Git source is not configured');
      assertSupportedDockerBuildResourcePolicy(source.policy as Record<string, unknown>);
      if (source.desiredCommitSha && source.desiredCommitSha.toLowerCase() !== input.commitSha.toLowerCase()) {
        throw new AppError(409, 'SOURCE_COMMIT_STALE', 'Build commit is no longer the desired source commit');
      }

      const specs =
        source.targetKind === 'compose_project'
          ? (source.composeBuildPlan?.services ?? [])
          : [
              {
                serviceName: null,
                dockerfilePath: source.dockerfilePath,
                contextPath: source.contextPath,
                buildArgs: source.buildArgs,
              },
            ];
      if (specs.length === 0) {
        throw new AppError(409, 'COMPOSE_BUILD_PLAN_MISSING', 'Compose source has no resolved build services');
      }
      const commitSha = input.commitSha.toLowerCase();
      let batchId: string | null = null;
      if (source.targetKind === 'compose_project') {
        const batchDedupeKey = input.force ? `${source.id}:${commitSha}:${randomUUID()}` : `${source.id}:${commitSha}`;
        if (!input.force) {
          const [existingBatch] = await tx
            .select()
            .from(dockerBuildBatches)
            .where(eq(dockerBuildBatches.dedupeKey, batchDedupeKey))
            .limit(1);
          if (existingBatch) {
            const builds = await tx.select().from(dockerBuilds).where(eq(dockerBuilds.batchId, existingBatch.id));
            const build = builds[0];
            if (!build) throw new AppError(409, 'BUILD_BATCH_INCOMPLETE', 'Compose build batch has no child builds');
            return { build, builds, batch: existingBatch, created: false };
          }
        }
        const [batch] = await tx
          .insert(dockerBuildBatches)
          .values({
            sourceBindingId: source.id,
            dedupeKey: batchDedupeKey,
            commitSha,
            status: 'building',
            expectedServices: specs.map((spec) => spec.serviceName!).sort(),
            composeBuildPlan: source.composeBuildPlan!,
            composeVariables: source.composeVariables,
            composeSecretKeys: source.composeSecretKeys,
            createdById: input.createdById ?? null,
          })
          .returning();
        batchId = batch.id;
        await tx
          .update(dockerBuildBatches)
          .set({
            status: 'superseded',
            supersededByBatchId: batch.id,
            completedAt: now,
            updatedAt: now,
            errorCode: 'SUPERSEDED_BY_NEWER_COMMIT',
            errorMessage: 'A newer source commit was queued',
          })
          .where(
            and(
              eq(dockerBuildBatches.sourceBindingId, source.id),
              inArray(dockerBuildBatches.status, ['building', 'awaiting_approval', 'applying']),
              ne(dockerBuildBatches.id, batch.id)
            )
          );
      }
      const existing =
        source.targetKind === 'compose_project' || input.force
          ? []
          : await tx
              .select()
              .from(dockerBuilds)
              .where(and(eq(dockerBuilds.sourceBindingId, source.id), eq(dockerBuilds.commitSha, commitSha)));
      const existingByService = new Map(existing.map((build) => [build.serviceName ?? '', build]));
      const missing = specs.filter((spec) => !existingByService.has(spec.serviceName ?? ''));
      const inserted =
        missing.length === 0
          ? []
          : await tx
              .insert(dockerBuilds)
              .values(
                missing.map((spec) => ({
                  sourceBindingId: source.id,
                  batchId,
                  dedupeKey: batchId
                    ? `${batchId}:${spec.serviceName}`
                    : input.force
                      ? `${source.id}:${commitSha}:${spec.serviceName ?? 'default'}:${randomUUID()}`
                      : `${source.id}:${commitSha}:${spec.serviceName ?? 'default'}`,
                  trigger: input.trigger,
                  triggerDeliveryId: input.triggerDeliveryId ?? null,
                  repositoryRemoteId: source.repositoryRemoteId,
                  repositoryFullPath: source.repositoryFullPath,
                  ref: `refs/heads/${source.branch}`,
                  commitSha,
                  serviceName: spec.serviceName,
                  dockerfilePath: spec.dockerfilePath,
                  contextPath: spec.contextPath,
                  buildArgs: spec.buildArgs,
                  applicationRoot: source.applicationRoot,
                  packageManager: source.packageManager,
                  packageManagerVersion: source.packageManagerVersion,
                  nodeVersion: source.nodeVersion,
                  buildScript: source.buildScript,
                  artifactDirectory: source.artifactDirectory,
                  publishTag: source.publishTag,
                  status: 'queued' as const,
                  createdById: input.createdById ?? null,
                  queuedAt: now,
                  createdAt: now,
                  updatedAt: now,
                }))
              )
              .returning();
      const builds = specs
        .map(
          (spec) =>
            existingByService.get(spec.serviceName ?? '') ??
            inserted.find((row) => row.serviceName === spec.serviceName)
        )
        .filter((row): row is typeof dockerBuilds.$inferSelect => Boolean(row));
      const build = builds[0];
      if (!build) throw new AppError(500, 'BUILD_CREATE_FAILED', 'Docker build was not created');

      if (inserted.length > 0)
        await tx
          .update(dockerBuilds)
          .set({
            status: 'superseded',
            supersededByBuildId: build.id,
            completedAt: now,
            updatedAt: now,
            errorCode: 'SUPERSEDED_BY_NEWER_COMMIT',
            errorMessage: 'A newer source commit was queued',
          })
          .where(
            and(
              eq(dockerBuilds.sourceBindingId, source.id),
              eq(dockerBuilds.status, 'queued'),
              ne(dockerBuilds.commitSha, commitSha)
            )
          );
      if (inserted.length > 0)
        await tx
          .update(dockerBuilds)
          .set({
            cancellationRequestedAt: now,
            supersededByBuildId: build.id,
            updatedAt: now,
            errorCode: 'SUPERSEDED_BY_NEWER_COMMIT',
            errorMessage: 'Cancellation requested because a newer source commit was queued',
          })
          .where(
            and(
              eq(dockerBuilds.sourceBindingId, source.id),
              inArray(dockerBuilds.status, ACTIVE_BUILD_STATUSES),
              ne(dockerBuilds.commitSha, commitSha)
            )
          );
      const batch = batchId
        ? (await tx.select().from(dockerBuildBatches).where(eq(dockerBuildBatches.id, batchId)).limit(1))[0]
        : null;
      return { build, builds, batch, created: inserted.length > 0 };
    });
    for (const build of result.builds) this.emit(build);
    return result;
  }

  async hasBuildForCommit(sourceBindingId: string, commitSha: string): Promise<boolean> {
    const [source, builds] = await Promise.all([
      this.db.select().from(dockerSourceBindings).where(eq(dockerSourceBindings.id, sourceBindingId)).limit(1),
      this.db
        .select({ serviceName: dockerBuilds.serviceName })
        .from(dockerBuilds)
        .where(
          and(eq(dockerBuilds.sourceBindingId, sourceBindingId), eq(dockerBuilds.commitSha, commitSha.toLowerCase()))
        ),
    ]);
    const expected =
      source[0]?.targetKind === 'compose_project' ? (source[0].composeBuildPlan?.services ?? []) : [null];
    const present = new Set(builds.map((build) => build.serviceName));
    return (
      expected.length > 0 &&
      expected.every((spec) => present.has(spec && typeof spec === 'object' ? spec.serviceName : null))
    );
  }

  async claimNext(input: {
    builderNodeId: string;
    leaseOwner: string;
    platform: string;
    leaseMs?: number;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const leaseExpiresAt = new Date(now.getTime() + (input.leaseMs ?? DEFAULT_BUILD_LEASE_MS));
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('docker-build-claim'))`);
      const recovered = await this.recoverExpiredLeasesWith(tx, now);
      const [candidate] = await tx
        .select({ id: dockerBuilds.id })
        .from(dockerBuilds)
        .where(
          and(
            eq(dockerBuilds.status, 'queued'),
            sql`not exists (
              select 1 from docker_builds active
              where active.source_binding_id = ${dockerBuilds.sourceBindingId}
                and active.status in ('claimed', 'checking_out', 'building', 'scanning', 'pushing', 'deploying')
            )`
          )
        )
        .orderBy(asc(dockerBuilds.queuedAt), asc(dockerBuilds.id))
        .limit(1);
      if (!candidate) return { claimed: null, recovered };
      const [row] = await tx
        .update(dockerBuilds)
        .set({
          status: 'claimed',
          builderNodeId: input.builderNodeId,
          platform: input.platform,
          attempt: sql`${dockerBuilds.attempt} + 1`,
          leaseOwner: input.leaseOwner,
          leaseHeartbeatAt: now,
          leaseExpiresAt,
          startedAt: sql`coalesce(${dockerBuilds.startedAt}, ${now})`,
          updatedAt: now,
          errorCode: null,
          errorMessage: null,
        })
        .where(and(eq(dockerBuilds.id, candidate.id), eq(dockerBuilds.status, 'queued')))
        .returning();
      return { claimed: row ?? null, recovered };
    });
    for (const recovered of result.recovered) this.emit(recovered);
    await Promise.allSettled(result.recovered.map((recovered) => this.buildReleaseHandler?.(recovered.id)));
    if (result.claimed) this.emit(result.claimed);
    return result.claimed;
  }

  async heartbeat(buildId: string, leaseOwner: string, leaseMs = DEFAULT_BUILD_LEASE_MS, now = new Date()) {
    const [row] = await this.db
      .update(dockerBuilds)
      .set({ leaseHeartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now })
      .where(
        and(
          eq(dockerBuilds.id, buildId),
          eq(dockerBuilds.leaseOwner, leaseOwner),
          inArray(dockerBuilds.status, ACTIVE_BUILD_STATUSES)
        )
      )
      .returning();
    if (!row) throw new AppError(409, 'BUILD_LEASE_LOST', 'Build lease is no longer owned by this worker');
    this.emit(row);
    return row;
  }

  async transition(
    buildId: string,
    leaseOwner: string,
    nextStatus: DockerBuildStatus,
    input: { progress?: Record<string, unknown>; errorCode?: string | null; errorMessage?: string | null } = {}
  ) {
    const [current] = await this.db.select().from(dockerBuilds).where(eq(dockerBuilds.id, buildId)).limit(1);
    if (!current) throw new AppError(404, 'BUILD_NOT_FOUND', 'Docker build not found');
    if (current.leaseOwner !== leaseOwner)
      throw new AppError(409, 'BUILD_LEASE_LOST', 'Build lease owner does not match');
    if (!canTransitionDockerBuild(current.status, nextStatus)) {
      throw new AppError(409, 'BUILD_STATE_INVALID', `Cannot move build from ${current.status} to ${nextStatus}`);
    }
    const terminal = TERMINAL_BUILD_STATUSES.includes(nextStatus);
    const now = new Date();
    const [row] = await this.db
      .update(dockerBuilds)
      .set({
        status: nextStatus,
        progress: input.progress ?? current.progress,
        errorCode: input.errorCode ?? (nextStatus === 'failed' ? 'BUILD_FAILED' : null),
        errorMessage: input.errorMessage ?? null,
        leaseOwner: terminal ? null : current.leaseOwner,
        leaseHeartbeatAt: terminal ? null : current.leaseHeartbeatAt,
        leaseExpiresAt: terminal ? null : current.leaseExpiresAt,
        completedAt: terminal ? now : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(dockerBuilds.id, buildId),
          eq(dockerBuilds.status, current.status),
          eq(dockerBuilds.leaseOwner, leaseOwner)
        )
      )
      .returning();
    if (!row) throw new AppError(409, 'BUILD_STATE_CONFLICT', 'Build state changed concurrently');
    if (row.batchId && ['failed', 'cancelled', 'superseded'].includes(nextStatus)) {
      const batchStatus =
        nextStatus === 'superseded' ? 'superseded' : nextStatus === 'cancelled' ? 'cancelled' : 'failed';
      await this.db
        .update(dockerBuildBatches)
        .set({
          status: batchStatus,
          errorCode: row.errorCode,
          errorMessage: row.errorMessage,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(dockerBuildBatches.id, row.batchId),
            inArray(dockerBuildBatches.status, ['building', 'awaiting_approval', 'applying'])
          )
        );
    }
    this.emit(row);
    if (terminal) await this.buildReleaseHandler?.(row.id);
    return row;
  }

  async requestCancellation(buildId: string, userId: string) {
    const now = new Date();
    const [current] = await this.db.select().from(dockerBuilds).where(eq(dockerBuilds.id, buildId)).limit(1);
    if (!current) throw new AppError(404, 'BUILD_NOT_FOUND', 'Docker build not found');
    if (TERMINAL_BUILD_STATUSES.includes(current.status)) {
      throw new AppError(409, 'BUILD_NOT_ACTIVE', 'Completed builds cannot be cancelled');
    }
    const queued = current.status === 'queued';
    const [row] = await this.db
      .update(dockerBuilds)
      .set({
        status: queued ? 'cancelled' : current.status,
        cancellationRequestedAt: now,
        cancellationRequestedById: userId,
        completedAt: queued ? now : current.completedAt,
        errorCode: queued ? 'CANCELLED_BY_USER' : current.errorCode,
        errorMessage: queued ? 'Build cancelled before it was claimed' : current.errorMessage,
        updatedAt: now,
      })
      .where(and(eq(dockerBuilds.id, buildId), eq(dockerBuilds.status, current.status)))
      .returning();
    if (!row) throw new AppError(409, 'BUILD_STATE_CONFLICT', 'Build state changed concurrently');
    this.emit(row);
    return row;
  }

  async retry(buildId: string, userId: string) {
    const current = await this.get(buildId);
    if (!['failed', 'cancelled', 'superseded'].includes(current.status)) {
      throw new AppError(409, 'BUILD_NOT_RETRYABLE', 'Only failed, cancelled, or superseded builds can be retried');
    }
    return this.enqueue({
      sourceBindingId: current.sourceBindingId,
      commitSha: current.commitSha,
      trigger: 'retry',
      createdById: userId,
      force: true,
    });
  }

  async recoverExpiredLeases(now = new Date()) {
    const rows = await this.db.transaction((tx) => this.recoverExpiredLeasesWith(tx, now));
    for (const row of rows) this.emit(row);
    return rows;
  }

  async appendLog(
    buildId: string,
    sequence: number,
    content: string,
    options: { secretValues?: readonly string[]; secretNames?: readonly string[] } = {}
  ) {
    return this.artifacts.appendLog(buildId, sequence, content, options);
  }

  async handleDaemonEvent(builderNodeId: string, event: DockerBuildEvent) {
    const current = await this.get(event.buildId);
    if (current.builderNodeId !== builderNodeId || !current.leaseOwner) {
      throw new AppError(409, 'BUILD_EVENT_OWNER_MISMATCH', 'Build event does not belong to this builder lease');
    }
    const leaseOwner = current.leaseOwner;
    if (event.status === 'heartbeat') {
      return this.heartbeat(event.buildId, leaseOwner);
    }
    if (event.status === 'log') {
      const sequence = Number(event.sequence);
      if (!Number.isSafeInteger(sequence)) {
        throw new AppError(400, 'BUILD_LOG_SEQUENCE_INVALID', 'Build log sequence is invalid');
      }
      return this.appendLog(event.buildId, sequence, event.logChunk.toString('utf8'));
    }

    const status = event.status as DockerBuildStatus;
    if (status === 'checking_out' || status === 'building' || status === 'scanning' || status === 'pushing') {
      if (current.status === status) return current;
      return this.transition(event.buildId, leaseOwner, status, parseDockerBuildProgress(event.progressJson));
    }
    if (event.status === 'failed') {
      const cancelled = event.errorCode === 'BUILD_CANCELLED' || Boolean(current.cancellationRequestedAt);
      return this.transition(event.buildId, leaseOwner, cancelled ? 'cancelled' : 'failed', {
        errorCode: event.errorCode || (cancelled ? 'CANCELLED_BY_USER' : 'BUILD_FAILED'),
        errorMessage: event.errorMessage.slice(0, 4096) || null,
      });
    }
    if (event.status !== 'succeeded') {
      throw new AppError(400, 'BUILD_EVENT_STATUS_INVALID', 'Builder reported an unsupported build status');
    }

    let readyStatus: DockerBuildStatus = current.status;
    if (readyStatus === 'scanning') {
      await this.transition(event.buildId, leaseOwner, 'pushing');
      readyStatus = 'pushing';
    }
    if (readyStatus !== 'pushing') {
      throw new AppError(409, 'BUILD_EVENT_STATE_INVALID', 'Successful artifact arrived before the pushing state');
    }
    const artifact = await this.recordArtifact({
      buildId: event.buildId,
      registryRepository: event.artifactRepository,
      digest: event.artifactDigest,
      platform: event.platform,
      sizeBytes: Number(event.artifactSizeBytes),
      sbomDigest: event.sbomDigest || null,
      provenanceDigest: event.provenanceDigest || null,
      scanSummary: parseDockerBuildScanSummary(event.scanSummaryJson),
    });
    if (artifact.artifact.policyDecision !== 'approved') {
      return this.transition(event.buildId, leaseOwner, 'failed', {
        errorCode: 'BUILD_ARTIFACT_POLICY_REJECTED',
        errorMessage: artifact.artifact.policyReason || 'Built artifact did not satisfy source policy',
      });
    }
    if (current.sourceAutoDeploy === false && current.target.kind !== 'compose_project') {
      return this.transition(event.buildId, leaseOwner, 'succeeded');
    }
    if (!this.artifactRollout) {
      throw new AppError(503, 'BUILD_ROLLOUT_UNAVAILABLE', 'Artifact rollout service is unavailable');
    }
    await this.transition(event.buildId, leaseOwner, 'deploying');
    try {
      const disposition = await this.artifactRollout(event.buildId);
      return this.transition(event.buildId, leaseOwner, disposition === 'superseded' ? 'superseded' : 'succeeded');
    } catch (error) {
      return this.transition(event.buildId, leaseOwner, 'failed', {
        errorCode: 'BUILD_ROLLOUT_FAILED',
        errorMessage: (error as Error).message.slice(0, 4096),
      });
    }
  }

  async recordArtifact(input: {
    buildId: string;
    registryRepository: string;
    digest: string;
    platform: string;
    sizeBytes: number;
    sbomDigest?: string | null;
    provenanceDigest?: string | null;
    scanSummary?: DockerBuildScanSummary | null;
  }) {
    return this.artifacts.record(input);
  }

  async listLogs(buildId: string, afterSequence = -1, limit = 200) {
    return this.artifacts.listLogs(buildId, afterSequence, limit);
  }

  async listInternalRegistryRepositories(): Promise<string[]> {
    return this.query.listInternalRegistryRepositories();
  }

  async get(id: string) {
    return this.query.get(id);
  }

  async list(input: DockerBuildListInput = {}) {
    return this.query.list(input);
  }

  private async recoverExpiredLeasesWith(db: DrizzleExecutor, now: Date) {
    const expired = await db
      .select()
      .from(dockerBuilds)
      .where(and(inArray(dockerBuilds.status, ACTIVE_BUILD_STATUSES), lt(dockerBuilds.leaseExpiresAt, now)));
    const recovered = [];
    for (const build of expired) {
      const disposition = expiredDockerBuildDisposition(build);
      const retry = disposition === 'retry';
      const [row] = await db
        .update(dockerBuilds)
        .set({
          status: retry ? 'queued' : disposition,
          builderNodeId: retry ? null : build.builderNodeId,
          leaseOwner: null,
          leaseHeartbeatAt: null,
          leaseExpiresAt: null,
          queuedAt: retry ? now : build.queuedAt,
          completedAt: retry ? null : now,
          errorCode:
            disposition === 'retry'
              ? 'BUILD_LEASE_EXPIRED_RETRY'
              : disposition === 'cancelled'
                ? 'CANCELLED_BY_USER'
                : 'BUILD_LEASE_EXHAUSTED',
          errorMessage: retry
            ? 'Builder lease expired; build returned to the queue'
            : disposition === 'cancelled'
              ? 'Build cancellation completed after worker lease expired'
              : 'Builder lease expired and retry attempts were exhausted',
          updatedAt: now,
        })
        .where(
          and(
            eq(dockerBuilds.id, build.id),
            eq(dockerBuilds.status, build.status),
            eq(dockerBuilds.leaseExpiresAt, build.leaseExpiresAt!)
          )
        )
        .returning();
      if (row) recovered.push(row);
    }
    return recovered;
  }

  private emit(build: typeof dockerBuilds.$inferSelect): void {
    this.publishBuildEvent('docker.build.changed', {
      buildId: build.id,
      sourceBindingId: build.sourceBindingId,
      status: build.status,
      builderNodeId: build.builderNodeId,
      commitSha: build.commitSha,
      cancellationRequestedAt: build.cancellationRequestedAt,
      errorCode: build.errorCode,
      errorMessage: build.errorMessage,
      updatedAt: build.updatedAt,
    });
  }

  private publishBuildEvent(topic: string, payload: Record<string, unknown>): void {
    if (!this.eventBus) return;
    const buildId = typeof payload.buildId === 'string' ? payload.buildId : null;
    if (!buildId) return;
    void this.query
      .get(buildId)
      .then((build) => {
        const scopeResourceId =
          build.target.kind === 'container'
            ? build.target.containerName
            : build.target.kind === 'deployment'
              ? build.target.deploymentId
              : build.target.kind === 'compose_project'
                ? build.target.composeProjectId
                : build.target.pageProjectId;
        this.eventBus?.publish(topic, {
          ...payload,
          nodeId: build.target.nodeId,
          scopeResourceId,
          targetKind: build.target.kind,
          targetName: build.target.name,
        });
      })
      .catch(() => undefined);
  }
}
