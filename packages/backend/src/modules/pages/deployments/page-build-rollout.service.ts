import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerArtifactPins, dockerBuildArtifacts, dockerBuilds, dockerSourceBindings } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DockerRegistryTokenService } from '@/modules/docker/docker-registry-token.service.js';
import type { PagePublicationService } from '../tags/page-publication.service.js';
import {
  PAGE_UPLOAD_CHUNK_MAX_BYTES,
  type PageDeploymentService,
  type PageDeployPrincipal,
} from './page-deployment.service.js';

interface RegistryDescriptor {
  digest: string;
  size: number;
  mediaType?: string;
  platform?: { os?: string; architecture?: string };
}

interface RegistryManifest {
  mediaType?: string;
  manifests?: RegistryDescriptor[];
  layers?: RegistryDescriptor[];
}

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const GZIP_LAYER_TYPES = new Set([
  'application/vnd.oci.image.layer.v1.tar+gzip',
  'application/vnd.docker.image.rootfs.diff.tar.gzip',
]);

export class PageBuildRolloutService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly tokens: DockerRegistryTokenService,
    private readonly deployments: PageDeploymentService,
    private readonly publication: PagePublicationService,
    private readonly registryUrl = process.env.GATEWAY_INTERNAL_REGISTRY_URL || 'http://registry:5000'
  ) {}

  async rollout(buildId: string): Promise<'deployed' | 'superseded'> {
    const joined = await this.getBuild(buildId);
    if (joined.source.desiredCommitSha?.toLowerCase() !== joined.build.commitSha.toLowerCase()) {
      return 'superseded';
    }
    if (joined.source.configGeneration !== joined.build.sourceConfigGeneration) {
      return 'superseded';
    }
    if (!joined.source.pageProjectId || !joined.build.publishTag) {
      throw new AppError(409, 'PAGES_BUILD_SOURCE_INVALID', 'Pages build source configuration is incomplete');
    }
    const actorId = joined.build.createdById ?? joined.source.updatedById ?? joined.source.createdById;
    if (!actorId) throw new AppError(409, 'PAGES_BUILD_ACTOR_MISSING', 'Pages build has no owning user');

    const pinOwner = `pages-build:${buildId}`;
    await this.db
      .insert(dockerArtifactPins)
      .values({
        artifactId: joined.artifact.id,
        kind: 'build_in_progress',
        ownerKey: pinOwner,
        reason: 'Pages artifact import is in progress',
        expiresAt: new Date(Date.now() + 6 * 60 * 60_000),
      })
      .onConflictDoNothing();
    try {
      const layer = await this.resolveLayer(
        joined.artifact.registryRepository,
        joined.artifact.digest,
        joined.build.platform,
        buildId
      );
      const principal: PageDeployPrincipal = {
        kind: 'user',
        userId: actorId,
        scopes: [`pages:deploy:${joined.source.pageProjectId}`],
      };
      const created = await this.deployments.create(
        {
          projectId: joined.source.pageProjectId,
          declaredSizeBytes: layer.size,
          sha256: layer.digest.slice('sha256:'.length),
          idempotencyKey: `pages-build:${buildId}`,
          tag: joined.build.publishTag,
          source: {
            repository: joined.build.repositoryFullPath,
            commitSha: joined.build.commitSha,
            ref: joined.build.ref,
            actor: actorId,
          },
        },
        principal
      );

      const deploymentId = created.deployment.id;
      if (!['stored', 'staging', 'ready'].includes(created.deployment.status)) {
        if (!created.upload) {
          throw new AppError(409, 'PAGES_BUILD_UPLOAD_MISSING', 'Pages build upload session is unavailable');
        }
        try {
          await this.streamLayer(
            joined.artifact.registryRepository,
            layer.digest,
            buildId,
            created.upload.id,
            created.upload.offset,
            principal
          );
          await this.deployments.finalize(created.upload.id, principal);
        } catch (error) {
          await this.deployments.abortUpload(created.upload.id, principal).catch(() => undefined);
          throw error;
        }
      }

      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-build-source:${joined.source.id}`}))`);
        const [current] = await tx
          .select({
            desiredCommitSha: dockerSourceBindings.desiredCommitSha,
            configGeneration: dockerSourceBindings.configGeneration,
          })
          .from(dockerSourceBindings)
          .where(eq(dockerSourceBindings.id, joined.source.id))
          .limit(1);
        if (
          !current ||
          current.desiredCommitSha?.toLowerCase() !== joined.build.commitSha.toLowerCase() ||
          current.configGeneration !== joined.build.sourceConfigGeneration
        ) {
          return 'superseded';
        }
        await this.publication.markDeploymentReady(deploymentId);
        await tx
          .update(dockerSourceBindings)
          .set({ deployedCommitSha: joined.build.commitSha, updatedAt: new Date() })
          .where(
            and(
              eq(dockerSourceBindings.id, joined.source.id),
              eq(dockerSourceBindings.desiredCommitSha, joined.build.commitSha),
              eq(dockerSourceBindings.configGeneration, joined.build.sourceConfigGeneration)
            )
          );
        return 'deployed';
      });
    } finally {
      await this.db
        .delete(dockerArtifactPins)
        .where(and(eq(dockerArtifactPins.kind, 'build_in_progress'), eq(dockerArtifactPins.ownerKey, pinOwner)));
    }
  }

  private async getBuild(buildId: string) {
    const [joined] = await this.db
      .select({ build: dockerBuilds, source: dockerSourceBindings, artifact: dockerBuildArtifacts })
      .from(dockerBuilds)
      .innerJoin(dockerSourceBindings, eq(dockerSourceBindings.id, dockerBuilds.sourceBindingId))
      .innerJoin(dockerBuildArtifacts, eq(dockerBuildArtifacts.buildId, dockerBuilds.id))
      .where(eq(dockerBuilds.id, buildId))
      .limit(1);
    if (!joined || joined.source.targetKind !== 'pages_project') {
      throw new AppError(404, 'PAGES_BUILD_ARTIFACT_NOT_FOUND', 'Pages build artifact was not found');
    }
    if (joined.artifact.policyDecision !== 'approved' || joined.artifact.status !== 'ready') {
      throw new AppError(409, 'BUILD_ARTIFACT_NOT_APPROVED', 'Only approved immutable artifacts can be deployed');
    }
    return joined;
  }

  private async resolveLayer(repository: string, digest: string, platform: string | null, buildId: string) {
    let manifest = await this.fetchManifest(repository, digest, buildId);
    if (manifest.manifests?.length) {
      const architecture = platform?.split('/')[1];
      const selected =
        manifest.manifests.find(
          (candidate) => candidate.platform?.os === 'linux' && candidate.platform?.architecture === architecture
        ) ?? manifest.manifests[0];
      if (!selected?.digest) {
        throw new AppError(502, 'PAGES_BUILD_MANIFEST_INVALID', 'Pages build manifest has no platform image');
      }
      manifest = await this.fetchManifest(repository, selected.digest, buildId);
    }
    if (!manifest.layers || manifest.layers.length !== 1) {
      throw new AppError(
        502,
        'PAGES_BUILD_LAYER_INVALID',
        'Managed Pages build artifact must contain exactly one filesystem layer'
      );
    }
    const [layer] = manifest.layers;
    if (!layer || !/^sha256:[0-9a-f]{64}$/.test(layer.digest) || !Number.isSafeInteger(layer.size) || layer.size < 1) {
      throw new AppError(502, 'PAGES_BUILD_LAYER_INVALID', 'Pages build layer metadata is invalid');
    }
    if (!layer.mediaType || !GZIP_LAYER_TYPES.has(layer.mediaType)) {
      throw new AppError(502, 'PAGES_BUILD_LAYER_FORMAT_INVALID', 'Pages build layer must be a gzip-compressed tar');
    }
    return layer;
  }

  private async fetchManifest(repository: string, digest: string, buildId: string): Promise<RegistryManifest> {
    const response = await this.registryRequest(repository, `manifests/${encodeURIComponent(digest)}`, buildId, {
      accept: MANIFEST_ACCEPT,
    });
    if (!response.ok) {
      throw new AppError(502, 'PAGES_BUILD_MANIFEST_UNAVAILABLE', `Registry manifest returned ${response.status}`);
    }
    const body = await response.text();
    if (body.length > 2 * 1024 * 1024) {
      throw new AppError(502, 'PAGES_BUILD_MANIFEST_TOO_LARGE', 'Registry manifest exceeds 2 MiB');
    }
    try {
      return JSON.parse(body) as RegistryManifest;
    } catch {
      throw new AppError(502, 'PAGES_BUILD_MANIFEST_INVALID', 'Registry manifest is invalid JSON');
    }
  }

  private async streamLayer(
    repository: string,
    digest: string,
    buildId: string,
    uploadId: string,
    initialOffset: number,
    principal: PageDeployPrincipal
  ): Promise<void> {
    const headers: Record<string, string> = {};
    if (initialOffset > 0) headers.range = `bytes=${initialOffset}-`;
    const response = await this.registryRequest(repository, `blobs/${encodeURIComponent(digest)}`, buildId, headers);
    if (!response.ok || !response.body) {
      throw new AppError(502, 'PAGES_BUILD_LAYER_UNAVAILABLE', `Registry blob returned ${response.status}`);
    }
    let offset = initialOffset;
    let skip = initialOffset > 0 && response.status !== 206 ? initialOffset : 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let bytes = value;
      if (skip > 0) {
        const consumed = Math.min(skip, bytes.byteLength);
        skip -= consumed;
        bytes = bytes.subarray(consumed);
      }
      for (let start = 0; start < bytes.byteLength; start += PAGE_UPLOAD_CHUNK_MAX_BYTES) {
        const chunk = bytes.subarray(start, Math.min(start + PAGE_UPLOAD_CHUNK_MAX_BYTES, bytes.byteLength));
        if (chunk.byteLength === 0) continue;
        const appended = await this.deployments.appendChunk(uploadId, offset, chunk, principal);
        offset = appended.offset;
      }
    }
    if (skip > 0) {
      throw new AppError(
        502,
        'PAGES_BUILD_LAYER_TRUNCATED',
        'Registry blob is shorter than the persisted upload offset'
      );
    }
  }

  private registryRequest(repository: string, path: string, buildId: string, headers: Record<string, string>) {
    const grant = { repository, actions: ['pull' as const] };
    const issued = this.tokens.issueToken({
      subject: `gateway:pages-build:${buildId}`,
      requested: [grant],
      allowed: [grant],
      context: { buildId },
      ttlSeconds: 300,
    });
    const encodedRepository = repository.split('/').map(encodeURIComponent).join('/');
    return fetch(new URL(`/v2/${encodedRepository}/${path}`, this.registryUrl), {
      headers: { ...headers, authorization: `Bearer ${issued.token}` },
      signal: AbortSignal.timeout(30 * 60_000),
    });
  }
}
