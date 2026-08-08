import type { SandboxJob } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import type { AISandboxArtifactService } from './ai.sandbox-artifact.service.js';
import type { AISandboxJobsService } from './ai.sandbox-jobs.service.js';
import type { SandboxResourceTier } from './ai.sandbox-policy.js';
import {
  hasSandboxManageAccess,
  normalizeSandboxRuntime,
  resolveSandboxPolicy,
  sandboxScopesSatisfied,
} from './ai.sandbox-policy.js';
import type { AISandboxRunnerService } from './ai.sandbox-runner.service.js';

const logger = createChildLogger('AISandboxService');
const SANDBOX_RECONCILE_INTERVAL_MS = 60_000;
const SANDBOX_ARTIFACT_CHUNK_BYTES = 256 * 1024;
const SANDBOX_CREATION_GRACE_MS = 2 * 60_000;

export interface SandboxExecuteScriptInput {
  runtime?: unknown;
  script: string;
  resourceTier?: SandboxResourceTier;
  ttlSeconds?: number;
  conversationId?: string | null;
}

export interface SandboxRunProcessInput {
  runtime?: unknown;
  command: string[];
  resourceTier?: SandboxResourceTier;
  ttlSeconds?: number;
  conversationId?: string | null;
}

export interface SandboxFetchInput {
  url: string;
}

export interface SandboxDownloadArtifactInput {
  processId: string;
  url: string;
  path?: string;
}

export interface SandboxUploadArtifactInput {
  processId: string;
  path: string;
  contentBase64: string;
}

export interface SandboxUploadArtifactStreamInput {
  processId: string;
  path: string;
  chunks: AsyncIterable<Uint8Array>;
  maxBytes: number;
}

export interface SandboxReadArtifactInput {
  processId: string;
  path: string;
  offset?: number;
  length?: number;
  encoding?: 'utf8' | 'base64';
}

export interface SandboxListArtifactFilesInput {
  processId: string;
  path?: string;
  maxDepth?: number;
  limit?: number;
  includeFiles?: boolean;
  includeDirectories?: boolean;
}

export interface SandboxSendArtifactInput {
  processId: string;
  path: string;
  filename?: string;
  mediaType?: string;
  conversationId?: string | null;
}

export class AISandboxService {
  private reconcileInterval: ReturnType<typeof setInterval> | null = null;
  private readonly creatingJobIds = new Set<string>();
  private readonly monitoredJobIds = new Set<string>();

  constructor(
    private readonly jobs: AISandboxJobsService,
    private readonly runner: AISandboxRunnerService,
    private readonly artifacts: AISandboxArtifactService
  ) {}

  status() {
    return this.runner.status;
  }

  async health() {
    return this.runner.health();
  }

  async executeScript(user: User, input: SandboxExecuteScriptInput) {
    if (!input.script.trim()) throw new AppError(400, 'INVALID_SANDBOX_SCRIPT', 'script is required');
    const runtime = normalizeSandboxRuntime(input.runtime);
    const policy = resolveSandboxPolicy(user.scopes, input.resourceTier, input.ttlSeconds);
    const job = await this.jobs.create({
      userId: user.id,
      conversationId: input.conversationId,
      kind: 'script',
      runtime,
      resourceTier: policy.tier,
      requestedTtlSeconds: policy.requestedTtlSeconds,
      effectiveTtlSeconds: policy.effectiveTtlSeconds,
      requiredScopes: policy.requiredScopes,
      workspaceReservationBytes: policy.tierPolicy.workspaceBytes,
    });

    this.creatingJobIds.add(job.id);
    try {
      const result = await this.runner.executeScript({
        policy: {
          jobId: job.id,
          userId: user.id,
          conversationId: input.conversationId,
          kind: 'script',
          runtime,
          tier: policy.tier,
          ttlSeconds: policy.effectiveTtlSeconds,
          requiredScopes: policy.requiredScopes,
          cpuQuota: policy.tierPolicy.cpuQuota,
          memoryBytes: policy.tierPolicy.memoryBytes,
          workspaceBytes: policy.tierPolicy.workspaceBytes,
          pidsLimit: policy.tierPolicy.pidsLimit,
        },
        script: input.script,
      });
      await this.jobs.update(job.id, {
        containerId: result.containerId,
        outputBytes: result.outputBytes,
        workspaceUsageBytes: result.workspaceUsageBytes,
      });
      await this.jobs.markFinished(job.id, result.timedOut ? 'timeout' : 'exited', {
        exitCode: result.exitCode,
        outputBytes: result.outputBytes,
        workspaceUsageBytes: result.workspaceUsageBytes,
      });
      return {
        jobId: job.id,
        runtime,
        resourceTier: policy.tier,
        requestedTtlSeconds: policy.requestedTtlSeconds,
        effectiveTtlSeconds: policy.effectiveTtlSeconds,
        exitCode: result.exitCode,
        output: result.output,
        timedOut: result.timedOut,
      };
    } catch (error) {
      const normalized = this.toSandboxAppError(error);
      await this.jobs.markFinished(job.id, 'failed', { error: normalized.message });
      throw normalized;
    } finally {
      this.creatingJobIds.delete(job.id);
    }
  }

  async runProcess(user: User, input: SandboxRunProcessInput) {
    if (!Array.isArray(input.command) || input.command.length === 0) {
      throw new AppError(400, 'INVALID_SANDBOX_COMMAND', 'command is required');
    }
    const runtime = normalizeSandboxRuntime(input.runtime);
    const policy = resolveSandboxPolicy(user.scopes, input.resourceTier, input.ttlSeconds);
    const job = await this.jobs.create({
      userId: user.id,
      conversationId: input.conversationId,
      kind: 'process',
      runtime,
      resourceTier: policy.tier,
      requestedTtlSeconds: policy.requestedTtlSeconds,
      effectiveTtlSeconds: policy.effectiveTtlSeconds,
      requiredScopes: policy.requiredScopes,
      workspaceReservationBytes: policy.tierPolicy.workspaceBytes,
    });

    this.creatingJobIds.add(job.id);
    try {
      const result = await this.runner.runProcess({
        policy: {
          jobId: job.id,
          userId: user.id,
          conversationId: input.conversationId,
          kind: 'process',
          runtime,
          tier: policy.tier,
          ttlSeconds: policy.effectiveTtlSeconds,
          requiredScopes: policy.requiredScopes,
          cpuQuota: policy.tierPolicy.cpuQuota,
          memoryBytes: policy.tierPolicy.memoryBytes,
          workspaceBytes: policy.tierPolicy.workspaceBytes,
          pidsLimit: policy.tierPolicy.pidsLimit,
        },
        command: input.command,
      });
      await this.jobs.markRunning(job.id, result.containerId);
      this.monitorProcessJob(job.id, result.containerId, result.expiresAt);
      return {
        jobId: job.id,
        processId: result.processId,
        containerId: result.containerId,
        runtime,
        resourceTier: policy.tier,
        requestedTtlSeconds: policy.requestedTtlSeconds,
        effectiveTtlSeconds: policy.effectiveTtlSeconds,
        expiresAt: result.expiresAt,
      };
    } catch (error) {
      const normalized = this.toSandboxAppError(error);
      await this.jobs.markFinished(job.id, 'failed', { error: normalized.message });
      throw normalized;
    } finally {
      this.creatingJobIds.delete(job.id);
    }
  }

  async readProcessOutput(user: User, processId: string, tail?: number) {
    const job = await this.resolveOwnedJob(user, processId);
    const containerId = job.containerId ?? processId;
    return this.runner.readProcessOutput({ processId: containerId, tail });
  }

  async fetch(_user: User, input: SandboxFetchInput) {
    if (!input.url.trim()) throw new AppError(400, 'INVALID_SANDBOX_FETCH_URL', 'url is required');
    return this.runner.fetch({ url: input.url });
  }

  async downloadArtifact(user: User, input: SandboxDownloadArtifactInput) {
    const job = await this.resolveOwnedJob(user, input.processId);
    const containerId = job.containerId ?? input.processId;
    return this.runnerOperation(() =>
      this.runner.downloadArtifact({ processId: containerId, url: input.url, path: input.path })
    );
  }

  async uploadArtifact(user: User, input: SandboxUploadArtifactInput) {
    const job = await this.resolveOwnedJob(user, input.processId);
    const containerId = job.containerId ?? input.processId;
    return this.runnerOperation(() =>
      this.runner.uploadArtifact({
        processId: containerId,
        path: input.path,
        contentBase64: input.contentBase64,
      })
    );
  }

  async uploadArtifactStream(user: User, input: SandboxUploadArtifactStreamInput) {
    const job = await this.resolveOwnedJob(user, input.processId);
    const containerId = job.containerId ?? input.processId;
    const maxBytes = Math.max(1, Math.floor(input.maxBytes));
    let offset = 0;

    for await (const rawChunk of input.chunks) {
      const chunk = Buffer.from(rawChunk);
      for (let start = 0; start < chunk.byteLength; start += SANDBOX_ARTIFACT_CHUNK_BYTES) {
        const part = chunk.subarray(start, start + SANDBOX_ARTIFACT_CHUNK_BYTES);
        if (offset + part.byteLength > maxBytes) {
          throw new AppError(413, 'GITLAB_ARCHIVE_TOO_LARGE', 'Repository archive exceeds connector clone size limit');
        }
        const result = await this.runnerOperation(() =>
          this.runner.uploadArtifactChunk({
            processId: containerId,
            path: input.path,
            offset,
            contentBase64: part.toString('base64'),
          })
        );
        offset = result.sizeBytes;
      }
    }

    if (offset === 0) {
      throw new AppError(502, 'GITLAB_ARCHIVE_EMPTY', 'GitLab returned an empty repository archive');
    }

    return { processId: containerId, path: input.path, sizeBytes: offset };
  }

  async listArtifactFiles(user: User, input: SandboxListArtifactFilesInput) {
    const job = await this.resolveOwnedJob(user, input.processId);
    const containerId = job.containerId ?? input.processId;
    return this.runnerOperation(() =>
      this.runner.listArtifactFiles({
        processId: containerId,
        path: input.path,
        maxDepth: input.maxDepth,
        limit: input.limit,
        includeFiles: input.includeFiles,
        includeDirectories: input.includeDirectories,
      })
    );
  }

  async readArtifact(user: User, input: SandboxReadArtifactInput) {
    const job = await this.resolveOwnedJob(user, input.processId);
    const containerId = job.containerId ?? input.processId;
    return this.runnerOperation(() =>
      this.runner.readArtifact({
        processId: containerId,
        path: input.path,
        offset: input.offset,
        length: input.length,
        encoding: input.encoding,
      })
    );
  }

  async sendArtifact(user: User, input: SandboxSendArtifactInput) {
    const job = await this.resolveOwnedJob(user, input.processId);
    const containerId = job.containerId ?? input.processId;
    const result = await this.runnerOperation(() =>
      this.runner.sendArtifact({
        processId: containerId,
        path: input.path,
        filename: input.filename,
        mediaType: input.mediaType,
      })
    );
    const artifact = await this.artifacts.saveFromTempFile({
      userId: user.id,
      conversationId: input.conversationId ?? job.conversationId,
      sourceProcessId: containerId,
      sourcePath: result.path,
      filename: result.filename,
      mediaType: result.mediaType,
      sizeBytes: result.sizeBytes,
      tempFilePath: result.tempFilePath,
    });
    return {
      artifactId: artifact.id,
      filename: artifact.filename,
      mediaType: artifact.mediaType,
      sizeBytes: artifact.sizeBytes,
      sourcePath: artifact.sourcePath,
      downloadUrl: artifact.downloadUrl,
    };
  }

  async writeProcessStdin(user: User, processId: string, data: string, close?: boolean) {
    const job = await this.resolveOwnedJob(user, processId);
    const containerId = job.containerId ?? processId;
    return this.runner.writeProcessStdin({ processId: containerId, data, close });
  }

  async killProcess(user: User, processId: string) {
    const job = await this.resolveOwnedJob(user, processId);
    if (!job.containerId) {
      await this.jobs.markFinished(job.id, 'killed');
      return { processId: job.id, killed: true };
    }
    const result = await this.runner.killProcess({ processId: job.containerId });
    await this.jobs.markFinished(job.id, 'killed');
    return result;
  }

  private monitorProcessJob(jobId: string, containerId: string, expiresAt: string) {
    if (this.monitoredJobIds.has(jobId)) return;
    this.monitoredJobIds.add(jobId);
    void (async () => {
      try {
        const expiresAtMs = Date.parse(expiresAt);
        const timeoutMs = Number.isFinite(expiresAtMs) ? Math.max(1_000, expiresAtMs - Date.now() + 10_000) : undefined;
        const result = await this.runner.waitProcess({ processId: containerId, timeoutMs });
        const status = Number.isFinite(expiresAtMs) && Date.now() >= expiresAtMs ? 'timeout' : 'exited';
        await this.runner.killProcess({ processId: containerId });
        await this.jobs.markFinishedIfActive(jobId, status, {
          exitCode: result.exitCode,
          outputBytes: result.outputBytes,
          workspaceUsageBytes: result.workspaceUsageBytes,
        });
      } catch (error) {
        logger.warn('Failed to monitor sandbox process completion', { jobId, containerId, error });
      } finally {
        this.monitoredJobIds.delete(jobId);
      }
    })();
  }

  async killConversationJobs(userId: string, conversationId: string) {
    const jobs = await this.jobs.listActiveForConversation(userId, conversationId);
    let killed = 0;

    for (const job of jobs) {
      if (job.containerId) {
        await this.runner.killProcess({ processId: job.containerId }).catch((error) => {
          logger.warn('Failed to kill sandbox job for deleted conversation', {
            jobId: job.id,
            conversationId,
            containerId: job.containerId,
            error,
          });
        });
      }
      await this.jobs.markFinished(job.id, 'killed').catch((error) => {
        logger.warn('Failed to mark sandbox job killed for deleted conversation', {
          jobId: job.id,
          conversationId,
          error,
        });
      });
      killed += 1;
    }

    return { killed };
  }

  async listJobs(user: User, input: { activeOnly?: boolean; status?: string; limit?: number } = {}) {
    const canManageAll = hasSandboxManageAccess(user.scopes);
    await this.expireDueJobs({ userId: user.id, canManageAll });
    return this.jobs.list({
      userId: user.id,
      canManageAll,
      activeOnly: input.activeOnly,
      status: input.status as never,
      limit: input.limit,
    });
  }

  async revokeUserAccess(userId: string, currentScopes: string[], reason: string) {
    const jobs = await this.jobs.listActiveForUser(userId);
    const unauthorized = jobs.filter((job) => !sandboxScopesSatisfied(currentScopes, job.requiredScopes));
    if (unauthorized.length === 0) return { revoked: 0 };

    const result = await this.runner.revokeUserSandboxAccess({ userId, currentScopes, reason });
    for (const job of unauthorized) {
      await this.jobs.markFinished(job.id, 'revoked', { revocationReason: reason }).catch(() => {});
    }
    return result;
  }

  startPolicyReconciliation() {
    if (this.reconcileInterval) return;
    void this.reconcileActiveJobs().catch((error) => {
      logger.warn('Initial sandbox policy reconciliation failed', { error });
    });
    this.reconcileInterval = setInterval(() => {
      this.reconcileActiveJobs().catch((error) => {
        logger.warn('Sandbox policy reconciliation failed', { error });
      });
    }, SANDBOX_RECONCILE_INTERVAL_MS);
    this.reconcileInterval.unref();
  }

  stopPolicyReconciliation() {
    if (!this.reconcileInterval) return;
    clearInterval(this.reconcileInterval);
    this.reconcileInterval = null;
  }

  async reconcileActiveJobs() {
    const rows = await this.jobs.listActiveWithEffectiveScopes();
    const now = Date.now();
    let expired = 0;
    let revoked = 0;
    const unauthorizedByUser = new Map<string, { currentScopes: string[]; jobIds: string[] }>();

    for (const row of rows) {
      const expiresAt = row.job.expiresAt?.getTime();
      if (expiresAt !== undefined && expiresAt <= now) {
        await this.expireJob(row.job);
        expired += 1;
        continue;
      }

      const discovered = await this.runner.findJobContainer({ jobId: row.job.id }).catch((error) => {
        logger.warn('Failed to recover sandbox container from job label', { jobId: row.job.id, error });
        return undefined;
      });
      let containerId = row.job.containerId;
      let recoveredExpiresAt: string | null = null;
      if (discovered && !discovered.containerId && containerId) {
        await this.jobs.markFinishedIfActive(row.job.id, 'failed', {
          error: 'Sandbox container is no longer available',
        });
        continue;
      }
      if (!containerId && discovered?.containerId) {
        containerId = discovered.containerId;
        recoveredExpiresAt = discovered.expiresAt;
        await this.jobs.markRunning(row.job.id, containerId).catch((error) => {
          logger.warn('Failed to restore sandbox job container reference', {
            jobId: row.job.id,
            containerId,
            error,
          });
        });
      }
      if (!containerId && discovered && !this.creatingJobIds.has(row.job.id)) {
        const createdAtMs = row.job.createdAt?.getTime();
        if (createdAtMs !== undefined && now - createdAtMs >= SANDBOX_CREATION_GRACE_MS) {
          await this.jobs.markFinishedIfActive(row.job.id, 'failed', {
            error: 'Sandbox container was not created',
          });
          continue;
        }
      }

      let terminatedForQuota = false;
      if (containerId) {
        await this.runner
          .getWorkspaceUsage({ processId: containerId })
          .then(async ({ workspaceUsageBytes, overReservation }) => {
            if (overReservation) {
              logger.warn('Sandbox workspace exceeds its soft reservation; stopping the sandbox', {
                jobId: row.job.id,
                containerId,
                workspaceUsageBytes,
                workspaceReservationBytes: row.job.workspaceReservationBytes,
              });
              try {
                await this.runner.killProcess({ processId: containerId });
              } catch (error) {
                logger.warn('Failed to stop sandbox that exceeded its workspace reservation', {
                  jobId: row.job.id,
                  containerId,
                  error,
                });
                return this.jobs.update(row.job.id, { workspaceUsageBytes });
              }
              terminatedForQuota = true;
              return this.jobs.markFinishedIfActive(row.job.id, 'failed', {
                error: 'Sandbox workspace exceeded its reserved capacity',
                workspaceUsageBytes,
              });
            }
            return this.jobs.update(row.job.id, { workspaceUsageBytes });
          })
          .catch((error) => {
            logger.warn('Failed to reconcile sandbox workspace usage', {
              jobId: row.job.id,
              containerId,
              error,
            });
          });
      }

      if (terminatedForQuota) continue;

      if (containerId) {
        const expiresAt = recoveredExpiresAt ?? row.job.expiresAt?.toISOString();
        if (expiresAt) this.monitorProcessJob(row.job.id, containerId, expiresAt);
      }

      if (sandboxScopesSatisfied(row.currentScopes, row.job.requiredScopes)) continue;
      const group = unauthorizedByUser.get(row.userId) ?? { currentScopes: row.currentScopes, jobIds: [] };
      group.jobIds.push(row.job.id);
      unauthorizedByUser.set(row.userId, group);
    }

    for (const [userId, group] of unauthorizedByUser) {
      const result = await this.runner
        .revokeUserSandboxAccess({ userId, currentScopes: group.currentScopes, reason: 'policy_reconciliation' })
        .catch((error) => {
          logger.warn('Sandbox runner revocation failed during reconciliation', { userId, error });
          return { revoked: 0 };
        });
      revoked += result.revoked;
      for (const jobId of group.jobIds) {
        await this.jobs.markFinished(jobId, 'revoked', { revocationReason: 'policy_reconciliation' }).catch(() => {});
      }
    }

    return { checked: rows.length, expired, revoked };
  }

  private async expireDueJobs(input: { userId?: string; canManageAll?: boolean } = {}) {
    const jobs = await this.jobs.listExpiredActive(input);
    if (jobs.length === 0) return { expired: 0 };

    let expired = 0;
    for (const job of jobs) {
      await this.expireJob(job);
      expired += 1;
    }
    return { expired };
  }

  private async expireJob(job: SandboxJob) {
    if (job.containerId) {
      try {
        await this.runner.killProcess({ processId: job.containerId });
      } catch (error) {
        logger.warn('Failed to kill expired sandbox job', { jobId: job.id, containerId: job.containerId, error });
        return;
      }
    }
    await this.jobs.markFinished(job.id, 'expired').catch((error) => {
      logger.warn('Failed to mark sandbox job expired', { jobId: job.id, error });
    });
  }

  private async resolveOwnedJob(user: User, processId: string) {
    const byId = await this.jobs.get(processId).catch(() => null);
    const job = byId ?? (await this.jobs.findByContainerId(processId));
    if (!job) throw new AppError(404, 'SANDBOX_JOB_NOT_FOUND', 'Sandbox job not found');
    if (job.userId !== user.id && !hasSandboxManageAccess(user.scopes)) {
      throw new AppError(403, 'SANDBOX_JOB_FORBIDDEN', 'You cannot access this sandbox job');
    }
    return job;
  }

  private async runnerOperation<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw this.toSandboxAppError(error);
    }
  }

  private toSandboxAppError(error: unknown): Error {
    if (error instanceof AppError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('sandbox workspace admission denied:')) {
      return new AppError(507, 'SANDBOX_DISK_ADMISSION_DENIED', message);
    }
    if (message.startsWith('sandbox workspace soft quota exceeded:')) {
      return new AppError(413, 'SANDBOX_WORKSPACE_QUOTA_EXCEEDED', message);
    }
    return error instanceof Error ? error : new Error(message);
  }
}
