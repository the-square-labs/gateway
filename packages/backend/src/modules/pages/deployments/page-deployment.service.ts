import { randomBytes, randomUUID } from 'node:crypto';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { pageDeployments, pageProjects, pageUploadSessions } from '@/db/schema/index.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { validatePageArchive } from '../artifacts/page-archive-validator.js';
import type { PageArtifactStore } from '../artifacts/page-artifact-store.js';
import { PAGE_EVENT_CHANNELS, pageProjectEvent } from '../page-events.js';
import type { PageRetentionService } from '../retention/page-retention.service.js';
import { assertPageDeployTokenTagAllowed, type ValidatedPageDeployToken } from '../tokens/page-deploy-token.service.js';
import type { CreatePageDeploymentInput, PageDeploymentListQuery } from './page-deployment.schemas.js';

const PAGE_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const PAGE_UPLOAD_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
const PAGE_ARCHIVE_MAX_FILES = 20_000;
const PAGE_ARCHIVE_MAX_PATH_BYTES = 1024;
const PAGE_ARCHIVE_MAX_EXPANDED_BYTES = 5 * 1024 * 1024 * 1024;

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export type PageDeployPrincipal =
  | { kind: 'user'; userId: string; scopes: string[]; tokenPrefix?: string }
  | { kind: 'deploy-token'; token: ValidatedPageDeployToken };

function publicSlug(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return output;
}

function publicFailure(error: unknown): { code: string; message: string } {
  if (error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500) {
    return { code: error.code, message: error.message.slice(0, 500) };
  }
  return { code: 'PAGES_DEPLOYMENT_FINALIZE_FAILED', message: 'Deployment validation failed' };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export class PageDeploymentService {
  private eventBus?: EventBusService;
  private retentionService?: PageRetentionService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly settingsService: GeneralSettingsService,
    private readonly store: PageArtifactStore
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  setRetentionService(retentionService: PageRetentionService): void {
    this.retentionService = retentionService;
  }

  async create(input: CreatePageDeploymentInput, principal: PageDeployPrincipal) {
    if (input.idempotencyKey) {
      const existing = await this.findIdempotent(input, principal);
      if (existing) return existing;
    }
    await this.retentionService?.assertCanAcceptDeployment(input.projectId);
    const settings = await this.settingsService.getConfig();
    if (input.declaredSizeBytes > settings.fileUploadMaxBytes) {
      throw new AppError(413, 'PAGES_ARTIFACT_TOO_LARGE', 'Artifact exceeds the Gateway file-upload limit');
    }

    const deploymentId = randomUUID();
    const uploadId = randomUUID();
    const tempKey = this.store.uploadKey(uploadId);
    const uploadExpiresAt = new Date(Date.now() + PAGE_UPLOAD_TTL_MS);
    let created: { deployment: typeof pageDeployments.$inferSelect };
    try {
      created = await this.db.transaction(async (tx) => {
        const [project] = await tx
          .update(pageProjects)
          .set({ nextDeploymentSequence: sql`${pageProjects.nextDeploymentSequence} + 1`, updatedAt: new Date() })
          .where(eq(pageProjects.id, input.projectId))
          .returning({
            id: pageProjects.id,
            storageQuotaBytes: pageProjects.storageQuotaBytes,
            storageUsedBytes: pageProjects.storageUsedBytes,
            nextDeploymentSequence: pageProjects.nextDeploymentSequence,
          });
        if (!project) throw new AppError(404, 'PAGE_PROJECT_NOT_FOUND', 'Page Project not found');

        const [{ reservedBytes }] = await tx
          .select({
            reservedBytes: sql<number>`coalesce(sum(${pageUploadSessions.declaredSizeBytes}), 0)`,
          })
          .from(pageUploadSessions)
          .innerJoin(pageDeployments, eq(pageUploadSessions.deploymentId, pageDeployments.id))
          .where(
            and(
              eq(pageDeployments.projectId, input.projectId),
              inArray(pageUploadSessions.status, ['open', 'finalizing'])
            )
          );
        if (
          project.storageUsedBytes + Number(reservedBytes ?? 0) + input.declaredSizeBytes >
          project.storageQuotaBytes
        ) {
          throw new AppError(
            409,
            'PAGES_STORAGE_QUOTA_EXCEEDED',
            'Project storage quota does not have enough free space',
            {
              projectId: project.id,
              quotaUsedBytes: project.storageUsedBytes + Number(reservedBytes ?? 0),
              quotaLimitBytes: project.storageQuotaBytes,
            }
          );
        }

        const [deployment] = await tx
          .insert(pageDeployments)
          .values({
            id: deploymentId,
            projectId: input.projectId,
            sequence: project.nextDeploymentSequence - 1,
            publicSlug: publicSlug(),
            status: 'uploading',
            sourceMetadata: input.source,
            idempotencyKey: input.idempotencyKey ?? null,
            requestedTag: input.tag ?? null,
            createdById: principal.kind === 'user' ? principal.userId : null,
            deployTokenId: principal.kind === 'deploy-token' ? principal.token.tokenId : null,
          })
          .returning();
        if (!deployment) throw new Error('Deployment insert did not return a row');
        await tx.insert(pageUploadSessions).values({
          id: uploadId,
          deploymentId,
          declaredSizeBytes: input.declaredSizeBytes,
          declaredSha256: input.sha256,
          tempKey,
          expiresAt: uploadExpiresAt,
        });
        return { deployment };
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'PAGES_STORAGE_QUOTA_EXCEEDED') {
        const details = error.details as { quotaUsedBytes?: number; quotaLimitBytes?: number } | undefined;
        this.eventBus?.publish(
          PAGE_EVENT_CHANNELS.project,
          pageProjectEvent(input.projectId, 'quota.blocked', {
            id: input.projectId,
            quotaUsedBytes: details?.quotaUsedBytes,
            quotaLimitBytes: details?.quotaLimitBytes,
            failureCode: error.code,
          })
        );
      }
      if (input.idempotencyKey && isUniqueViolation(error)) {
        const existing = await this.findIdempotent(input, principal);
        if (existing) return existing;
      }
      throw error;
    }

    await this.auditService.log({
      userId: principal.kind === 'user' ? principal.userId : null,
      action: 'page_deployment.create',
      resourceType: 'page_deployment',
      resourceId: created.deployment.id,
      details: {
        projectId: input.projectId,
        publicSlug: created.deployment.publicSlug,
        sequence: created.deployment.sequence,
        declaredSizeBytes: input.declaredSizeBytes,
        requestedTag: input.tag ?? null,
        credentialType: principal.kind,
        credentialPrefix:
          principal.kind === 'deploy-token' ? principal.token.tokenPrefix : (principal.tokenPrefix ?? null),
      },
    });
    this.emit(created.deployment, 'created');
    return {
      deployment: this.serialize(created.deployment),
      upload: { id: uploadId, offset: 0, expiresAt: uploadExpiresAt.toISOString() },
    };
  }

  async appendChunk(uploadId: string, offset: number, bytes: Uint8Array, principal: PageDeployPrincipal) {
    if (bytes.byteLength > PAGE_UPLOAD_CHUNK_MAX_BYTES) {
      throw new AppError(413, 'PAGES_UPLOAD_CHUNK_TOO_LARGE', 'Upload chunk exceeds 8 MiB');
    }
    const row = await this.getUpload(uploadId);
    this.assertPrincipal(row.deployment, principal);
    if (row.session.status !== 'open') throw new AppError(409, 'PAGES_UPLOAD_NOT_OPEN', 'Upload is not open');
    if (row.session.expiresAt.getTime() <= Date.now()) {
      throw new AppError(410, 'PAGES_UPLOAD_EXPIRED', 'Upload session has expired');
    }
    if (offset !== row.session.receivedBytes) {
      throw new AppError(409, 'PAGES_UPLOAD_OFFSET_MISMATCH', 'Upload offset does not match received bytes', {
        expectedOffset: row.session.receivedBytes,
      });
    }
    if (offset + bytes.byteLength > row.session.declaredSizeBytes) {
      throw new AppError(400, 'PAGES_UPLOAD_SIZE_EXCEEDED', 'Upload exceeds its declared size');
    }
    const nextOffset = await this.store.appendChunk(row.session.tempKey, offset, bytes);
    let updated: Array<{ id: string }>;
    try {
      updated = await this.db
        .update(pageUploadSessions)
        .set({ receivedBytes: nextOffset, updatedAt: new Date() })
        .where(
          and(
            eq(pageUploadSessions.id, uploadId),
            eq(pageUploadSessions.status, 'open'),
            eq(pageUploadSessions.receivedBytes, offset)
          )
        )
        .returning({ id: pageUploadSessions.id });
    } catch (error) {
      await this.store.rollbackChunk(row.session.tempKey, offset, nextOffset);
      throw error;
    }
    if (updated.length === 0) {
      await this.store.rollbackChunk(row.session.tempKey, offset, nextOffset);
      throw new AppError(409, 'PAGES_UPLOAD_CONCURRENT_WRITE', 'Upload changed during chunk write');
    }
    return { id: uploadId, offset: nextOffset, complete: nextOffset === row.session.declaredSizeBytes };
  }

  async finalize(uploadId: string, principal: PageDeployPrincipal) {
    const row = await this.getUpload(uploadId);
    this.assertPrincipal(row.deployment, principal);
    if (row.session.status === 'complete') return { deployment: this.serialize(row.deployment) };
    if (row.session.status !== 'open') throw new AppError(409, 'PAGES_UPLOAD_NOT_OPEN', 'Upload is not open');
    if (row.session.expiresAt.getTime() <= Date.now()) {
      throw new AppError(410, 'PAGES_UPLOAD_EXPIRED', 'Upload session has expired');
    }
    if (row.session.receivedBytes !== row.session.declaredSizeBytes) {
      throw new AppError(409, 'PAGES_UPLOAD_INCOMPLETE', 'Upload has not received all declared bytes');
    }
    const claimed = await this.db
      .update(pageUploadSessions)
      .set({ status: 'finalizing', updatedAt: new Date() })
      .where(and(eq(pageUploadSessions.id, uploadId), eq(pageUploadSessions.status, 'open')))
      .returning({ id: pageUploadSessions.id });
    if (claimed.length === 0) throw new AppError(409, 'PAGES_UPLOAD_FINALIZING', 'Upload is already finalizing');
    await this.db
      .update(pageDeployments)
      .set({ status: 'validating', updatedAt: new Date() })
      .where(eq(pageDeployments.id, row.deployment.id));

    let committedArtifactKey: string | null = null;
    let stored:
      | {
          deployment: typeof pageDeployments.$inferSelect;
          compressedSizeBytes: number;
          expandedSizeBytes: number;
          fileCount: number;
        }
      | undefined;
    try {
      const actualSize = await this.store.size(row.session.tempKey);
      if (actualSize !== row.session.declaredSizeBytes) {
        throw new AppError(400, 'PAGES_UPLOAD_SIZE_MISMATCH', 'Stored upload size does not match its declaration');
      }
      const actualSha256 = await this.store.sha256(row.session.tempKey);
      if (actualSha256 !== row.session.declaredSha256) {
        throw new AppError(400, 'PAGES_UPLOAD_CHECKSUM_MISMATCH', 'Artifact SHA-256 does not match its declaration');
      }
      const settings = await this.settingsService.getConfig();
      const maxExpandedBytes = Math.min(
        row.project.storageQuotaBytes,
        Math.min(PAGE_ARCHIVE_MAX_EXPANDED_BYTES, Math.max(1024 * 1024 * 1024, settings.fileUploadMaxBytes * 10))
      );
      const validation = await validatePageArchive(this.store.resolveKey(row.session.tempKey), {
        maxFiles: PAGE_ARCHIVE_MAX_FILES,
        maxFileBytes: Math.min(settings.fileUploadMaxBytes, maxExpandedBytes),
        maxExpandedBytes,
        maxPathBytes: PAGE_ARCHIVE_MAX_PATH_BYTES,
      });
      const artifactKey = this.store.artifactKey(row.deployment.projectId, row.deployment.id);
      await this.store.commitUpload(row.session.tempKey, artifactKey);
      committedArtifactKey = artifactKey;
      const [deployment] = await this.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(pageDeployments)
          .set({
            status: 'stored',
            artifactKey,
            artifactSha256: actualSha256,
            compressedSizeBytes: actualSize,
            expandedSizeBytes: validation.expandedSizeBytes,
            fileCount: validation.fileCount,
            failureCode: null,
            failureMessage: null,
            updatedAt: new Date(),
          })
          .where(eq(pageDeployments.id, row.deployment.id))
          .returning();
        await tx
          .update(pageUploadSessions)
          .set({ status: 'complete', updatedAt: new Date() })
          .where(eq(pageUploadSessions.id, uploadId));
        await tx
          .update(pageProjects)
          .set({
            storageUsedBytes: sql`${pageProjects.storageUsedBytes} + ${actualSize}`,
            updatedAt: new Date(),
          })
          .where(eq(pageProjects.id, row.deployment.projectId));
        return [updated];
      });
      if (!deployment) throw new Error('Deployment disappeared during finalization');
      stored = {
        deployment,
        compressedSizeBytes: actualSize,
        expandedSizeBytes: validation.expandedSizeBytes,
        fileCount: validation.fileCount,
      };
      committedArtifactKey = null;
    } catch (error) {
      const failure = publicFailure(error);
      await Promise.allSettled([
        this.db
          .update(pageUploadSessions)
          .set({ status: 'failed', failureCode: failure.code, updatedAt: new Date() })
          .where(eq(pageUploadSessions.id, uploadId)),
        this.db
          .update(pageDeployments)
          .set({ status: 'failed', failureCode: failure.code, failureMessage: failure.message, updatedAt: new Date() })
          .where(eq(pageDeployments.id, row.deployment.id)),
        this.store.remove(row.session.tempKey),
        ...(committedArtifactKey ? [this.store.remove(committedArtifactKey)] : []),
      ]);
      this.eventBus?.publish(
        PAGE_EVENT_CHANNELS.deployment,
        pageProjectEvent(row.deployment.projectId, 'failed', {
          id: row.deployment.id,
          publicSlug: row.deployment.publicSlug,
          status: 'failed',
          failureCode: failure.code,
        })
      );
      throw error instanceof AppError ? error : new AppError(500, failure.code, failure.message);
    }

    if (!stored) throw new AppError(500, 'PAGES_DEPLOYMENT_FINALIZE_FAILED', 'Deployment validation failed');
    await this.auditService.log({
      userId: principal.kind === 'user' ? principal.userId : null,
      action: 'page_deployment.store',
      resourceType: 'page_deployment',
      resourceId: stored.deployment.id,
      details: {
        projectId: stored.deployment.projectId,
        publicSlug: stored.deployment.publicSlug,
        compressedSizeBytes: stored.compressedSizeBytes,
        expandedSizeBytes: stored.expandedSizeBytes,
        fileCount: stored.fileCount,
      },
    });
    this.emit(stored.deployment, 'stored');
    return { deployment: this.serialize(stored.deployment) };
  }

  async abortUpload(
    uploadId: string,
    principal: PageDeployPrincipal,
    failureCode = 'PAGES_BUILD_IMPORT_FAILED'
  ): Promise<void> {
    const row = await this.getUpload(uploadId);
    this.assertPrincipal(row.deployment, principal);
    if (row.session.status === 'complete' || row.deployment.status === 'ready') return;
    const code = failureCode.slice(0, 128);
    await Promise.allSettled([
      this.db
        .update(pageUploadSessions)
        .set({ status: 'failed', failureCode: code, updatedAt: new Date() })
        .where(eq(pageUploadSessions.id, uploadId)),
      this.db
        .update(pageDeployments)
        .set({
          status: 'failed',
          failureCode: code,
          failureMessage: 'Build artifact import failed',
          updatedAt: new Date(),
        })
        .where(eq(pageDeployments.id, row.deployment.id)),
      this.store.remove(row.session.tempKey),
    ]);
    this.emit({ ...row.deployment, status: 'failed', failureCode: code }, 'failed');
  }

  async list(projectId: string, query: PageDeploymentListQuery) {
    const where = eq(pageDeployments.projectId, projectId);
    const [data, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(pageDeployments)
        .where(where)
        .orderBy(desc(pageDeployments.sequence))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
      this.db.select({ total: count() }).from(pageDeployments).where(where),
    ]);
    return {
      data: data.map((deployment) => this.serialize(deployment)),
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  async get(deploymentId: string) {
    const [deployment] = await this.db
      .select()
      .from(pageDeployments)
      .where(eq(pageDeployments.id, deploymentId))
      .limit(1);
    if (!deployment) throw new AppError(404, 'PAGE_DEPLOYMENT_NOT_FOUND', 'Page Deployment not found');
    return this.serialize(deployment);
  }

  async getForProject(projectId: string, deploymentId: string) {
    const [deployment] = await this.db
      .select()
      .from(pageDeployments)
      .where(and(eq(pageDeployments.id, deploymentId), eq(pageDeployments.projectId, projectId)))
      .limit(1);
    if (!deployment) throw new AppError(404, 'PAGE_DEPLOYMENT_NOT_FOUND', 'Page Deployment not found');
    return this.serialize(deployment);
  }

  private async findIdempotent(input: CreatePageDeploymentInput, principal: PageDeployPrincipal) {
    const [row] = await this.db
      .select({ deployment: pageDeployments, session: pageUploadSessions })
      .from(pageDeployments)
      .leftJoin(pageUploadSessions, eq(pageUploadSessions.deploymentId, pageDeployments.id))
      .where(
        and(eq(pageDeployments.projectId, input.projectId), eq(pageDeployments.idempotencyKey, input.idempotencyKey!))
      )
      .limit(1);
    if (!row) return null;
    this.assertPrincipal(row.deployment, principal);
    if (
      row.deployment.requestedTag !== (input.tag ?? null) ||
      row.session?.declaredSizeBytes !== input.declaredSizeBytes ||
      row.session?.declaredSha256 !== input.sha256
    ) {
      throw new AppError(
        409,
        'PAGES_IDEMPOTENCY_CONFLICT',
        'Idempotency key was already used with different Deployment parameters'
      );
    }
    return {
      deployment: this.serialize(row.deployment),
      upload: row.session
        ? { id: row.session.id, offset: row.session.receivedBytes, expiresAt: row.session.expiresAt.toISOString() }
        : null,
    };
  }

  private async getUpload(uploadId: string) {
    const [row] = await this.db
      .select({ session: pageUploadSessions, deployment: pageDeployments, project: pageProjects })
      .from(pageUploadSessions)
      .innerJoin(pageDeployments, eq(pageUploadSessions.deploymentId, pageDeployments.id))
      .innerJoin(pageProjects, eq(pageDeployments.projectId, pageProjects.id))
      .where(eq(pageUploadSessions.id, uploadId))
      .limit(1);
    if (!row) throw new AppError(404, 'PAGES_UPLOAD_NOT_FOUND', 'Upload session not found');
    return row;
  }

  private assertPrincipal(deployment: typeof pageDeployments.$inferSelect, principal: PageDeployPrincipal): void {
    if (principal.kind === 'user') {
      if (!hasScopeForResource(principal.scopes, 'pages:deploy', deployment.projectId)) {
        throw new AppError(403, 'PAGE_DEPLOY_FORBIDDEN', 'Missing pages:deploy for this Project');
      }
      if (deployment.createdById !== principal.userId || deployment.deployTokenId) {
        throw new AppError(403, 'PAGES_UPLOAD_PRINCIPAL_MISMATCH', 'Upload belongs to another principal');
      }
      return;
    }
    if (principal.token.projectId !== deployment.projectId) {
      throw new AppError(403, 'PAGE_DEPLOY_TOKEN_PROJECT_MISMATCH', 'Deploy token belongs to another Project');
    }
    if (deployment.deployTokenId !== principal.token.tokenId) {
      throw new AppError(403, 'PAGES_UPLOAD_PRINCIPAL_MISMATCH', 'Upload belongs to another deploy token');
    }
    assertPageDeployTokenTagAllowed(principal.token, deployment.requestedTag);
  }

  private emit(deployment: typeof pageDeployments.$inferSelect, action: string): void {
    this.eventBus?.publish(
      PAGE_EVENT_CHANNELS.deployment,
      pageProjectEvent(deployment.projectId, action, {
        id: deployment.id,
        publicSlug: deployment.publicSlug,
        status: deployment.status,
      })
    );
  }

  private serialize(deployment: typeof pageDeployments.$inferSelect) {
    const {
      artifactKey: _artifactKey,
      deployTokenId,
      idempotencyKey: _idempotencyKey,
      failureMessage,
      ...safe
    } = deployment;
    return {
      ...safe,
      credentialType: deployTokenId ? 'deploy-token' : deployment.createdById ? 'user' : null,
      sourceMetadata: deployment.sourceMetadata,
      createdAt: deployment.createdAt.toISOString(),
      updatedAt: deployment.updatedAt.toISOString(),
      readyAt: deployment.readyAt?.toISOString() ?? null,
      deletedAt: deployment.deletedAt?.toISOString() ?? null,
      failureMessage: deployment.failureCode ? failureMessage : null,
    };
  }
}
