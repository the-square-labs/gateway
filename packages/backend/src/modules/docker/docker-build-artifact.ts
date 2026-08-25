import { and, asc, eq, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type DockerBuildScanSummary,
  dockerBuildArtifacts,
  dockerBuildLogChunks,
  dockerBuilds,
  dockerSourceBindings,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  BUILD_LOG_CHUNK_MAX_BYTES,
  BUILD_LOG_TOTAL_MAX_BYTES,
  evaluateDockerArtifactPolicy,
  redactDockerBuildLog,
} from './docker-build-policy.js';

type PublishEvent = (topic: string, payload: Record<string, unknown>) => void;

export class DockerBuildArtifactStore {
  constructor(
    private readonly db: DrizzleClient,
    private readonly publish: PublishEvent
  ) {}

  async appendLog(
    buildId: string,
    sequence: number,
    content: string,
    options: { secretValues?: readonly string[]; secretNames?: readonly string[] } = {}
  ) {
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new AppError(400, 'BUILD_LOG_SEQUENCE_INVALID', 'Build log sequence must be a non-negative integer');
    }
    const redacted = redactDockerBuildLog(content, options);
    const byteLength = Buffer.byteLength(redacted, 'utf8');
    if (byteLength > BUILD_LOG_CHUNK_MAX_BYTES) {
      throw new AppError(413, 'BUILD_LOG_CHUNK_TOO_LARGE', 'Build log chunk exceeds 256 KiB');
    }
    const [total] = await this.db
      .select({ bytes: sql<number>`coalesce(sum(${dockerBuildLogChunks.byteLength}), 0)` })
      .from(dockerBuildLogChunks)
      .where(eq(dockerBuildLogChunks.buildId, buildId));
    if (Number(total?.bytes ?? 0) + byteLength > BUILD_LOG_TOTAL_MAX_BYTES) {
      throw new AppError(413, 'BUILD_LOG_LIMIT_EXCEEDED', 'Build log exceeds the 10 MiB persisted limit');
    }
    const [row] = await this.db
      .insert(dockerBuildLogChunks)
      .values({ buildId, sequence, content: redacted, byteLength })
      .onConflictDoNothing({ target: [dockerBuildLogChunks.buildId, dockerBuildLogChunks.sequence] })
      .returning();
    if (row) this.publish('docker.build.log', { buildId, sequence, byteLength });
    return row ?? null;
  }

  async record(input: {
    buildId: string;
    registryRepository: string;
    digest: string;
    platform: string;
    sizeBytes: number;
    sbomDigest?: string | null;
    provenanceDigest?: string | null;
    scanSummary?: DockerBuildScanSummary | null;
  }) {
    if (!/^sha256:[0-9a-f]{64}$/.test(input.digest)) {
      throw new AppError(400, 'BUILD_ARTIFACT_DIGEST_INVALID', 'Artifact digest must be an immutable sha256 digest');
    }
    if (!/^linux\/(amd64|arm64)(\/v[1-4])?$/.test(input.platform)) {
      throw new AppError(400, 'BUILD_ARTIFACT_PLATFORM_INVALID', 'Artifact platform is not supported');
    }
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new AppError(400, 'BUILD_ARTIFACT_SIZE_INVALID', 'Artifact size must be a non-negative integer');
    }
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-build-artifact:${input.buildId}`}))`);
      const [joined] = await tx
        .select({ build: dockerBuilds, source: dockerSourceBindings })
        .from(dockerBuilds)
        .innerJoin(dockerSourceBindings, eq(dockerSourceBindings.id, dockerBuilds.sourceBindingId))
        .where(eq(dockerBuilds.id, input.buildId))
        .limit(1);
      if (!joined) throw new AppError(404, 'BUILD_NOT_FOUND', 'Docker build not found');
      if (!['pushing', 'deploying', 'succeeded'].includes(joined.build.status)) {
        throw new AppError(409, 'BUILD_ARTIFACT_STATE_INVALID', 'Build is not ready to record an artifact');
      }
      const [existing] = await tx
        .select()
        .from(dockerBuildArtifacts)
        .where(eq(dockerBuildArtifacts.buildId, input.buildId))
        .limit(1);
      if (existing) {
        if (
          existing.digest !== input.digest ||
          existing.registryRepository !== input.registryRepository ||
          existing.platform !== input.platform
        ) {
          throw new AppError(
            409,
            'BUILD_ARTIFACT_IMMUTABLE',
            'A different artifact is already recorded for this build'
          );
        }
        return { artifact: existing, created: false };
      }
      const policy = evaluateDockerArtifactPolicy(joined.source.policy, input);
      const now = new Date();
      const [artifact] = await tx
        .insert(dockerBuildArtifacts)
        .values({
          buildId: joined.build.id,
          sourceBindingId: joined.source.id,
          registryRepository: input.registryRepository,
          digest: input.digest,
          platform: input.platform,
          sizeBytes: input.sizeBytes,
          status: policy.decision === 'approved' ? 'ready' : 'rejected',
          sbomDigest: input.sbomDigest ?? null,
          provenanceDigest: input.provenanceDigest ?? null,
          scanSummary: input.scanSummary ?? null,
          policyDecision: policy.decision,
          policyReason: policy.reason,
          verifiedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return { artifact, created: true };
    });
    this.publish('docker.build.artifact.changed', {
      buildId: input.buildId,
      sourceBindingId: result.artifact.sourceBindingId,
      artifactId: result.artifact.id,
      digest: result.artifact.digest,
      status: result.artifact.status,
      policyDecision: result.artifact.policyDecision,
    });
    return result;
  }

  async listLogs(buildId: string, afterSequence = -1, limit = 200) {
    return this.db
      .select()
      .from(dockerBuildLogChunks)
      .where(and(eq(dockerBuildLogChunks.buildId, buildId), sql`${dockerBuildLogChunks.sequence} > ${afterSequence}`))
      .orderBy(asc(dockerBuildLogChunks.sequence))
      .limit(Math.min(Math.max(limit, 1), 500));
  }
}
