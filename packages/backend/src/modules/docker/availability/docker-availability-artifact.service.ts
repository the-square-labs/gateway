import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { parseDocument, stringify } from 'yaml';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerArtifactPins,
  dockerAvailabilityOperations,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  dockerBuildArtifacts,
  dockerBuilds,
  nodes,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import { registryRuntimeReferences } from '@/modules/docker/docker-registry-maintenance.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayRegistryService } from '@/services/relay-registry.service.js';
import type {
  DockerAvailabilityCandidateNode,
  DockerAvailabilityResolvedResource,
} from './docker-availability.types.js';

const INTERNAL_PREFIX = '127.0.0.1:5443/';
const _INTERNAL_DIGEST = /^127\.0\.0\.1:5443\/(.+)@(sha256:[0-9a-f]{64})$/i;

interface MirroredImageDetail {
  reference: string;
  repository: string;
  digest: string;
  platform: string;
  sizeBytes: number;
}

interface ResourceImage {
  key: string;
  source: string;
}

interface DeletedArtifactReference {
  ownerKind: 'build' | 'availability';
  registryRepository: string;
  digest: string;
}

export function availabilityArtifactIsReferenced(repository: string, references: unknown, digest?: string): boolean {
  const serialized = JSON.stringify(references) ?? '';
  // Tags cannot identify an immutable version, so retain them conservatively.
  // Git builds reuse a repository across digests: a reference to the new build
  // must not pin every previous build in that repository.
  return serialized.includes(`${repository}@${digest ?? ''}`) || serialized.includes(`${repository}:`);
}

export function deletedDockerArtifactReferences(
  image: Record<string, any>,
  artifacts: DeletedArtifactReference[],
  runtimeReferences: unknown
): string[] {
  const references: string[] = [
    ...(image.repoTags ?? image.RepoTags ?? []),
    ...(image.repoDigests ?? image.RepoDigests ?? []),
  ];
  return references.filter((reference) =>
    artifacts.some(
      (artifact) =>
        !availabilityArtifactIsReferenced(artifact.registryRepository, runtimeReferences, artifact.digest) &&
        (reference === `${INTERNAL_PREFIX}${artifact.registryRepository}@${artifact.digest}` ||
          (artifact.ownerKind === 'availability' &&
            reference === `${INTERNAL_PREFIX}${artifact.registryRepository}:image`))
    )
  );
}

export class DockerAvailabilityArtifactService {
  private collecting = false;
  constructor(
    private readonly db: DrizzleClient,
    private readonly registry: DockerInternalRegistryService,
    private readonly relayRegistry: RelayRegistryService,
    private readonly dispatch: NodeDispatchService
  ) {}

  // Called while the successful operation still owns its lease. Only images no
  // longer referenced by the logical spec or any surviving runtime lose pins.
  async releaseObsoletePins(policyId: string): Promise<void> {
    const [policies, placements, pinned] = await Promise.all([
      this.db.select().from(dockerAvailabilityPolicies).where(eq(dockerAvailabilityPolicies.id, policyId)),
      this.db.select().from(dockerAvailabilityPlacements).where(eq(dockerAvailabilityPlacements.policyId, policyId)),
      this.db
        .select({
          id: dockerArtifactPins.id,
          repository: dockerBuildArtifacts.registryRepository,
          digest: dockerBuildArtifacts.digest,
        })
        .from(dockerArtifactPins)
        .innerJoin(dockerBuildArtifacts, eq(dockerBuildArtifacts.id, dockerArtifactPins.artifactId))
        .where(
          and(
            eq(dockerArtifactPins.ownerKey, this.pinOwner(policyId)),
            inArray(dockerArtifactPins.kind, ['active', 'rollback'])
          )
        ),
    ]);
    const references = [policies, placements.filter((placement) => placement.actualState !== 'removed')];
    const obsolete = pinned.filter((pin) => !availabilityArtifactIsReferenced(pin.repository, references, pin.digest));
    if (obsolete.length)
      await this.db.delete(dockerArtifactPins).where(
        inArray(
          dockerArtifactPins.id,
          obsolete.map((pin) => pin.id)
        )
      );
  }

  async collectUnusedArtifacts(): Promise<void> {
    if (this.collecting) return;
    this.collecting = true;
    try {
      const active = await this.db
        .select({ id: dockerAvailabilityOperations.id })
        .from(dockerAvailabilityOperations)
        .where(inArray(dockerAvailabilityOperations.status, ['pending', 'running', 'waiting']))
        .limit(1);
      if (active.length) return;
      const builds = await this.db
        .select({ id: dockerBuilds.id })
        .from(dockerBuilds)
        .where(
          inArray(dockerBuilds.status, [
            'queued',
            'claimed',
            'checking_out',
            'building',
            'scanning',
            'pushing',
            'deploying',
          ])
        )
        .limit(1);
      if (builds.length) return;
      const policies = await this.db.select({ id: dockerAvailabilityPolicies.id }).from(dockerAvailabilityPolicies);
      for (const policy of policies) await this.releaseObsoletePins(policy.id);
      const artifacts = await this.db
        .select()
        .from(dockerBuildArtifacts)
        .where(
          and(
            eq(dockerBuildArtifacts.ownerKind, 'availability'),
            inArray(dockerBuildArtifacts.status, ['ready', 'deleted'])
          )
        );
      const pins = await this.db.select({ artifactId: dockerArtifactPins.artifactId }).from(dockerArtifactPins);
      const pinnedIds = new Set(pins.map((pin) => pin.artifactId));
      const references = await registryRuntimeReferences(this.db);
      const obsolete = artifacts.filter(
        (artifact) =>
          !pinnedIds.has(artifact.id) && !availabilityArtifactIsReferenced(artifact.registryRepository, references)
      );
      const registryState = await this.registry.getState();
      const lastCollectedAt = registryState.lastGcAt?.getTime() ?? 0;
      const pendingBlobCollection = artifacts.some(
        (artifact) => artifact.status === 'deleted' && artifact.updatedAt.getTime() > lastCollectedAt
      );
      if (obsolete.some((artifact) => artifact.status === 'ready') || pendingBlobCollection) {
        await this.registry.runGarbageCollection({ retentionCount: 1 });
      }
      // Retry node caches independently, including artifacts already removed
      // from the registry. Never force-remove an image used by a container.
      const deleted = await this.db
        .select({
          ownerKind: dockerBuildArtifacts.ownerKind,
          registryRepository: dockerBuildArtifacts.registryRepository,
          digest: dockerBuildArtifacts.digest,
        })
        .from(dockerBuildArtifacts)
        .where(eq(dockerBuildArtifacts.status, 'deleted'));
      if (!deleted.length) return;
      const dockerNodes = await this.db
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(eq(nodes.type, 'docker'), eq(nodes.status, 'online')));
      await Promise.all(
        dockerNodes.map(async (node) => {
          const inventory = await this.dispatch.sendDockerImageCommand(node.id, 'list');
          if (!inventory.success) return;
          const images: Array<Record<string, any>> = JSON.parse(inventory.detail ?? '[]');
          if (!Array.isArray(images)) return;
          for (const image of images) {
            for (const reference of deletedDockerArtifactReferences(image, deleted, references)) {
              const result = await this.dispatch.sendDockerImageCommand(node.id, 'remove', {
                imageRef: reference,
                force: false,
              });
              if (!result.success && !/in use|being used|conflict|not found|no such/i.test(result.error ?? '')) {
                throw new Error(result.error || 'Availability image cache cleanup failed');
              }
            }
          }
        })
      );
    } finally {
      this.collecting = false;
    }
  }

  async preflight(resource: DockerAvailabilityResolvedResource): Promise<void> {
    const images = this.resourceImages(resource);
    if (!images.length || images.some(({ source }) => !source.trim())) {
      throw new AppError(409, 'AVAILABILITY_IMAGE_REQUIRED', 'Every Availability workload must declare an image');
    }
    await this.registry.assertBuildAdmission();
  }

  async prepare(input: {
    policyId: string;
    generation: number;
    resource: DockerAvailabilityResolvedResource;
    candidateNodes: DockerAvailabilityCandidateNode[];
    reuseExistingArtifacts?: boolean;
  }): Promise<DockerAvailabilityResolvedResource> {
    await this.preflight(input.resource);
    const images = this.resourceImages(input.resource);
    const mirrored = new Map<string, string>();
    const artifactIds: string[] = [];

    for (const [index, image] of images.entries()) {
      const existingInternal = image.source.match(/^127\.0\.0\.1:5443\/(.+)@(sha256:[0-9a-f]{64})$/i);
      let detail: MirroredImageDetail;
      let artifactId: string | undefined;
      if (existingInternal) {
        const repository = existingInternal[1]!;
        const digest = existingInternal[2]!.toLowerCase();
        const [artifact] = await this.db
          .select()
          .from(dockerBuildArtifacts)
          .where(
            and(
              eq(dockerBuildArtifacts.registryRepository, repository),
              eq(dockerBuildArtifacts.digest, digest),
              eq(dockerBuildArtifacts.status, 'ready')
            )
          )
          .limit(1);
        if (!artifact) {
          throw new AppError(
            409,
            'AVAILABILITY_INTERNAL_ARTIFACT_NOT_FOUND',
            'The pinned internal image artifact is no longer available',
            { retryable: true }
          );
        }
        detail = {
          reference: image.source,
          repository,
          digest,
          platform: artifact.platform,
          sizeBytes: artifact.sizeBytes,
        };
        artifactId = artifact.id;
      } else if (input.reuseExistingArtifacts) {
        const reusable = await this.findReusableArtifact(input.policyId, image.source);
        if (reusable) {
          detail = reusable;
          artifactId = reusable.id;
        } else {
          detail = await this.mirrorImage(input, image, index);
        }
      } else {
        detail = await this.mirrorImage(input, image, index);
      }
      const immutableReference = `${INTERNAL_PREFIX}${detail.repository}@${detail.digest}`;
      mirrored.set(image.key, immutableReference);
      artifactId ??= await this.recordArtifact({
        policyId: input.policyId,
        sourceImageReference: image.source,
        ...detail,
      });
      artifactIds.push(artifactId);
      await this.ensurePin(input.policyId, artifactId);

      const prepullErrors: unknown[] = [];
      let preparedNodeCount = 0;
      await Promise.all(
        input.candidateNodes.map(async (node) => {
          try {
            await this.relayRegistry.ensureBinding({
              nodeId: node.id,
              role: node.id === input.resource.currentNodeId ? 'mirror' : 'runtime',
              repository: detail.repository,
              actions: node.id === input.resource.currentNodeId ? ['pull', 'push'] : ['pull'],
              contextKind: 'availability',
              contextId: input.policyId,
            });
            const ensured = await this.dispatch.sendDockerImageCommand(
              node.id,
              'ensure',
              { imageRef: immutableReference },
              15 * 60_000
            );
            if (!ensured.success) {
              throw new AppError(
                502,
                'AVAILABILITY_IMAGE_PREPULL_FAILED',
                ensured.error || `Failed to pre-pull image on ${node.hostname}`,
                { retryable: true, nodeId: node.id }
              );
            }
            preparedNodeCount += 1;
          } catch (error) {
            prepullErrors.push(error);
          }
        })
      );
      if (input.candidateNodes.length > 0 && preparedNodeCount === 0) throw prepullErrors[0];
    }

    await this.rotatePins(input.policyId, artifactIds);
    return this.rewriteResource(input.resource, mirrored);
  }

  private async findReusableArtifact(
    policyId: string,
    sourceImageReference: string
  ): Promise<(MirroredImageDetail & { id: string }) | null> {
    const [artifact] = await this.db
      .select()
      .from(dockerBuildArtifacts)
      .where(
        and(
          eq(dockerBuildArtifacts.ownerKind, 'availability'),
          eq(dockerBuildArtifacts.ownerKey, policyId),
          eq(dockerBuildArtifacts.sourceImageReference, sourceImageReference),
          eq(dockerBuildArtifacts.status, 'ready')
        )
      )
      .orderBy(desc(dockerBuildArtifacts.createdAt))
      .limit(1);
    if (!artifact) return null;
    return {
      id: artifact.id,
      reference: `${INTERNAL_PREFIX}${artifact.registryRepository}@${artifact.digest}`,
      repository: artifact.registryRepository,
      digest: artifact.digest,
      platform: artifact.platform,
      sizeBytes: artifact.sizeBytes,
    };
  }

  private async mirrorImage(
    input: {
      policyId: string;
      generation: number;
      resource: DockerAvailabilityResolvedResource;
    },
    image: ResourceImage,
    index: number
  ): Promise<MirroredImageDetail> {
    const repository = `gateway/availability/${input.policyId}/${index + 1}/${input.generation}`;
    await this.relayRegistry.ensureBinding({
      nodeId: input.resource.currentNodeId,
      role: 'mirror',
      repository,
      actions: ['pull', 'push'],
      contextKind: 'availability',
      contextId: input.policyId,
    });
    const targetImageRef = `${INTERNAL_PREFIX}${repository}:image`;
    const result = await this.dispatch.sendDockerImageCommand(
      input.resource.currentNodeId,
      'mirror',
      { imageRef: image.source, targetImageRef },
      15 * 60_000
    );
    if (!result.success) {
      throw new AppError(
        502,
        'AVAILABILITY_IMAGE_MIRROR_FAILED',
        result.error || `Failed to mirror image for ${image.key}`,
        { retryable: true }
      );
    }
    return this.parseMirrorDetail(result.detail);
  }

  async cleanup(policyId: string): Promise<void> {
    await this.db
      .delete(dockerArtifactPins)
      .where(
        and(
          eq(dockerArtifactPins.ownerKey, this.pinOwner(policyId)),
          inArray(dockerArtifactPins.kind, ['active', 'rollback'])
        )
      );
    await this.relayRegistry.revokeContextBinding({ contextKind: 'availability', contextId: policyId });
  }

  async resolveCanonicalSourceImage(
    nodeId: string,
    candidate: string,
    internalReference?: string | null
  ): Promise<string | null> {
    // Display metadata is best-effort: an offline origin must not make the
    // logical HA resource, inventory or monitoring dashboard unavailable.
    const listed = await this.dispatch.sendDockerImageCommand(nodeId, 'list').catch(() => null);
    if (!listed?.success || !listed.detail) return null;
    let images: Array<Record<string, unknown>>;
    try {
      const parsed = JSON.parse(listed.detail);
      if (!Array.isArray(parsed)) return null;
      images = parsed as Array<Record<string, unknown>>;
    } catch {
      return null;
    }
    const targets = new Set([candidate, String(internalReference ?? '')].filter(Boolean));
    const image = images.find((row) => {
      const ids = [row.Id, row.ID, row.id, row.ImageID, row.imageId].map((value) => String(value ?? ''));
      const references = [
        ...(Array.isArray(row.RepoTags) ? row.RepoTags : []),
        ...(Array.isArray(row.repoTags) ? row.repoTags : []),
        ...(Array.isArray(row.RepoDigests) ? row.RepoDigests : []),
        ...(Array.isArray(row.repoDigests) ? row.repoDigests : []),
      ].map(String);
      return [...ids, ...references].some((value) => targets.has(value));
    });
    if (!image) return null;
    return (
      [
        ...(Array.isArray(image.RepoTags) ? image.RepoTags : []),
        ...(Array.isArray(image.repoTags) ? image.repoTags : []),
      ]
        .map(String)
        .find((value) => value !== '<none>:<none>' && !/^127\.0\.0\.1:5443\//i.test(value)) ?? null
    );
  }

  private resourceImages(resource: DockerAvailabilityResolvedResource): ResourceImage[] {
    if (resource.kind !== 'compose') {
      return [{ key: 'workload', source: String(resource.imageReference ?? '') }];
    }
    const model = resource.portableSpec.normalizedModel as Record<string, any> | undefined;
    return Object.entries(model?.services ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([serviceName, service]) => ({
        key: serviceName,
        source: String((service as Record<string, unknown>).image ?? ''),
      }));
  }

  private rewriteResource(
    resource: DockerAvailabilityResolvedResource,
    mirrored: Map<string, string>
  ): DockerAvailabilityResolvedResource {
    const portableSpec = JSON.parse(JSON.stringify(resource.portableSpec)) as Record<string, any>;
    if (resource.kind === 'container') {
      portableSpec.image = mirrored.get('workload');
      return this.withFingerprint({ ...resource, portableSpec, imageReference: portableSpec.image });
    }
    if (resource.kind === 'deployment') {
      portableSpec.desiredConfig = { ...portableSpec.desiredConfig, image: mirrored.get('workload') };
      return this.withFingerprint({ ...resource, portableSpec, imageReference: portableSpec.desiredConfig.image });
    }

    const services = (portableSpec.normalizedModel?.services ?? {}) as Record<string, Record<string, unknown>>;
    for (const [serviceName, service] of Object.entries(services)) {
      service.image = mirrored.get(serviceName);
    }
    const document = parseDocument(String(portableSpec.yaml ?? ''), {
      schema: 'core',
      merge: false,
      uniqueKeys: true,
      strict: true,
      customTags: [],
      logLevel: 'silent',
    });
    if (document.errors.length) {
      throw new AppError(
        409,
        'AVAILABILITY_COMPOSE_REWRITE_FAILED',
        'Compose image references cannot be rewritten safely'
      );
    }
    const value = document.toJS({ maxAliasCount: 0, mapAsMap: false }) as Record<string, any>;
    for (const [serviceName, service] of Object.entries(
      (value.services ?? {}) as Record<string, Record<string, unknown>>
    )) {
      service.image = mirrored.get(serviceName);
      delete service.build;
    }
    portableSpec.yaml = stringify(value, { sortMapEntries: false });
    portableSpec.configDigest = createHash('sha256').update(portableSpec.yaml).digest('hex');
    return this.withFingerprint({ ...resource, portableSpec });
  }

  private withFingerprint(resource: DockerAvailabilityResolvedResource): DockerAvailabilityResolvedResource {
    return {
      ...resource,
      specFingerprint: createHash('sha256').update(JSON.stringify(resource.portableSpec)).digest('hex'),
    };
  }

  private parseMirrorDetail(detail: string | undefined): MirroredImageDetail {
    let parsed: Partial<MirroredImageDetail>;
    try {
      parsed = JSON.parse(detail ?? '{}') as Partial<MirroredImageDetail>;
    } catch {
      parsed = {};
    }
    if (
      typeof parsed.repository !== 'string' ||
      typeof parsed.digest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(parsed.digest) ||
      !/^linux\/(amd64|arm64)(\/v[1-4])?$/.test(String(parsed.platform ?? ''))
    ) {
      throw new AppError(
        502,
        'AVAILABILITY_IMAGE_METADATA_INVALID',
        'Docker daemon returned invalid mirrored image metadata'
      );
    }
    return {
      reference: String(parsed.reference ?? `${INTERNAL_PREFIX}${parsed.repository}@${parsed.digest}`),
      repository: parsed.repository,
      digest: parsed.digest,
      platform: String(parsed.platform),
      sizeBytes: Number.isSafeInteger(parsed.sizeBytes) && Number(parsed.sizeBytes) >= 0 ? Number(parsed.sizeBytes) : 0,
    };
  }

  private async recordArtifact(
    input: MirroredImageDetail & { policyId: string; sourceImageReference: string }
  ): Promise<string> {
    const [existing] = await this.db
      .select()
      .from(dockerBuildArtifacts)
      .where(
        and(
          eq(dockerBuildArtifacts.ownerKind, 'availability'),
          eq(dockerBuildArtifacts.ownerKey, input.policyId),
          eq(dockerBuildArtifacts.registryRepository, input.repository)
        )
      )
      .limit(1);
    if (existing) {
      if (existing.digest !== input.digest || existing.sourceImageReference !== input.sourceImageReference) {
        throw new AppError(
          409,
          'AVAILABILITY_ARTIFACT_IMMUTABLE',
          'Availability artifact metadata changed during retry'
        );
      }
      return existing.id;
    }
    const [artifact] = await this.db
      .insert(dockerBuildArtifacts)
      .values({
        ownerKind: 'availability',
        ownerKey: input.policyId,
        sourceImageReference: input.sourceImageReference,
        registryRepository: input.repository,
        digest: input.digest,
        platform: input.platform,
        sizeBytes: input.sizeBytes,
        status: 'ready',
        policyDecision: 'approved',
        policyReason: 'Mirrored for multi-node Availability',
        verifiedAt: new Date(),
      })
      .returning({ id: dockerBuildArtifacts.id });
    if (!artifact) throw new Error('Availability artifact was not persisted');
    return artifact.id;
  }

  private async ensurePin(policyId: string, artifactId: string): Promise<void> {
    const ownerKey = this.pinOwner(policyId);
    await this.db
      .insert(dockerArtifactPins)
      .values({
        artifactId,
        kind: 'active',
        ownerKey,
        reason: 'Required by multi-node Availability',
      })
      .onConflictDoNothing();
  }

  private async rotatePins(policyId: string, artifactIds: string[]): Promise<void> {
    const ownerKey = this.pinOwner(policyId);
    if (!artifactIds.length) return;
    await this.db.transaction(async (tx) => {
      const previous = await tx
        .select({ artifactId: dockerArtifactPins.artifactId })
        .from(dockerArtifactPins)
        .where(
          and(
            eq(dockerArtifactPins.ownerKey, ownerKey),
            eq(dockerArtifactPins.kind, 'active'),
            notInArray(dockerArtifactPins.artifactId, artifactIds)
          )
        );
      await tx
        .delete(dockerArtifactPins)
        .where(and(eq(dockerArtifactPins.ownerKey, ownerKey), eq(dockerArtifactPins.kind, 'rollback')));
      if (previous.length) {
        await tx
          .insert(dockerArtifactPins)
          .values(
            previous.map(({ artifactId }) => ({
              artifactId,
              kind: 'rollback' as const,
              ownerKey,
              reason: 'Previous successful multi-node Availability generation',
            }))
          )
          .onConflictDoNothing();
      }
      await tx
        .delete(dockerArtifactPins)
        .where(
          and(
            eq(dockerArtifactPins.ownerKey, ownerKey),
            eq(dockerArtifactPins.kind, 'active'),
            notInArray(dockerArtifactPins.artifactId, artifactIds)
          )
        );
    });
  }

  private pinOwner(policyId: string): string {
    return `availability:${policyId}`;
  }
}
