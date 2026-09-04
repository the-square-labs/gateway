import { and, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import {
  dockerArtifactPins,
  dockerBuildArtifacts,
  dockerBuilds,
  dockerDeployments,
  dockerSourceBindings,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { PageBuildRolloutService } from '@/modules/pages/deployments/page-build-rollout.service.js';
import type { RelayRegistryService } from '@/services/relay-registry.service.js';
import type { DockerComposeService } from './compose/compose.service.js';
import type { DockerManagementService } from './docker.service.js';
import { readDockerBuildRolloutProgress } from './docker-build-policy.js';
import { DockerComposeBuildRolloutService } from './docker-compose-build-rollout.service.js';
import type { DockerDeploymentService } from './docker-deployment.service.js';

export class DockerBuildRolloutService {
  private readonly composeRollout?: DockerComposeBuildRolloutService;
  private pagesRollout?: PageBuildRolloutService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly docker: DockerManagementService,
    private readonly deployments: DockerDeploymentService,
    private readonly registry: RelayRegistryService,
    compose?: DockerComposeService
  ) {
    if (compose) this.composeRollout = new DockerComposeBuildRolloutService(db, registry, compose);
  }

  setPagesRollout(service: PageBuildRolloutService): void {
    this.pagesRollout = service;
  }

  async rollout(
    buildId: string,
    leaseOwner: string,
    operationId: string
  ): Promise<'deployed' | 'superseded' | 'pending'> {
    const [target] = await this.db
      .select({
        targetKind: dockerSourceBindings.targetKind,
        status: dockerBuilds.status,
        leaseOwner: dockerBuilds.leaseOwner,
        progress: dockerBuilds.progress,
      })
      .from(dockerBuilds)
      .innerJoin(dockerSourceBindings, eq(dockerSourceBindings.id, dockerBuilds.sourceBindingId))
      .where(eq(dockerBuilds.id, buildId))
      .limit(1);
    this.assertRolloutLease(target, leaseOwner, operationId);
    if (target?.targetKind === 'compose_project') {
      if (!this.composeRollout) {
        throw new AppError(503, 'COMPOSE_ROLLOUT_UNAVAILABLE', 'Compose rollout is unavailable');
      }
      return this.composeRollout.rollout(buildId);
    }
    if (target?.targetKind === 'pages_project') {
      if (!this.pagesRollout) {
        throw new AppError(503, 'PAGES_BUILD_ROLLOUT_UNAVAILABLE', 'Pages build rollout is unavailable');
      }
      return this.pagesRollout.rollout(buildId);
    }
    return this.db.transaction(async (tx) => {
      const [identity] = await tx
        .select({ sourceBindingId: dockerBuilds.sourceBindingId })
        .from(dockerBuilds)
        .where(eq(dockerBuilds.id, buildId))
        .limit(1);
      if (!identity) throw new AppError(404, 'BUILD_ARTIFACT_NOT_FOUND', 'Approved build artifact was not found');
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`docker-build-source:${identity.sourceBindingId}`}))`
      );
      const [joined] = await tx
        .select({ build: dockerBuilds, source: dockerSourceBindings, artifact: dockerBuildArtifacts })
        .from(dockerBuilds)
        .innerJoin(dockerSourceBindings, eq(dockerSourceBindings.id, dockerBuilds.sourceBindingId))
        .innerJoin(dockerBuildArtifacts, eq(dockerBuildArtifacts.buildId, dockerBuilds.id))
        .where(eq(dockerBuilds.id, buildId))
        .limit(1);
      if (!joined) throw new AppError(404, 'BUILD_ARTIFACT_NOT_FOUND', 'Approved build artifact was not found');
      this.assertRolloutLease(joined.build, leaseOwner, operationId);
      if (joined.artifact.policyDecision !== 'approved' || joined.artifact.status !== 'ready') {
        throw new AppError(409, 'BUILD_ARTIFACT_NOT_APPROVED', 'Only approved immutable artifacts can be deployed');
      }
      if (joined.source.desiredCommitSha?.toLowerCase() !== joined.build.commitSha.toLowerCase()) {
        return 'superseded';
      }
      // A forced rebuild can produce another artifact from the same commit.
      // Only the artifact already active on this target is a duplicate rollout.
      // A cleared deployed SHA is an explicit redeploy signal after HA rollback.
      const targetOwnerKey =
        joined.source.targetKind === 'deployment'
          ? `deployment:${joined.source.deploymentId}`
          : `container:${joined.source.nodeId}:${joined.source.containerName}`;
      const [activePin] = await tx
        .select({ artifactId: dockerArtifactPins.artifactId })
        .from(dockerArtifactPins)
        .where(
          and(
            eq(dockerArtifactPins.ownerKey, targetOwnerKey),
            eq(dockerArtifactPins.kind, 'active'),
            eq(dockerArtifactPins.artifactId, joined.artifact.id)
          )
        )
        .limit(1);
      if (activePin && joined.source.deployedCommitSha?.toLowerCase() === joined.build.commitSha.toLowerCase()) {
        return 'deployed';
      }

      const image = `127.0.0.1:5443/${joined.artifact.registryRepository}@${joined.artifact.digest}`;
      const ownerKey = await this.deployTarget(
        joined.source,
        image,
        joined.build.createdById ?? joined.source.createdById
      );
      await this.rotatePins(tx, joined.source.id, joined.artifact.id, ownerKey);
      await tx
        .update(dockerSourceBindings)
        .set({ deployedCommitSha: joined.build.commitSha, updatedAt: new Date() })
        .where(eq(dockerSourceBindings.id, joined.source.id));
      return 'deployed';
    });
  }

  private assertRolloutLease(
    build: { status?: string; leaseOwner?: string | null; progress?: unknown } | null | undefined,
    leaseOwner: string,
    operationId: string
  ): void {
    const rollout = readDockerBuildRolloutProgress(build?.progress);
    if (
      build?.status !== 'deploying' ||
      build.leaseOwner !== leaseOwner ||
      rollout?.operationId !== operationId ||
      rollout.phase !== 'executing'
    ) {
      throw new AppError(409, 'BUILD_ROLLOUT_LEASE_LOST', 'Backend rollout lease is no longer current');
    }
  }

  async recoverInterruptedComposeRollouts(now = new Date()) {
    return this.composeRollout?.recoverInterrupted(now) ?? { succeeded: 0, failed: 0 };
  }

  private async deployTarget(
    source: typeof dockerSourceBindings.$inferSelect,
    image: string,
    actorId: string | null
  ): Promise<string> {
    const repository = image.slice('127.0.0.1:5443/'.length, image.indexOf('@'));
    if (source.targetKind === 'deployment') {
      const [deployment] = await this.db
        .select({ id: dockerDeployments.id, nodeId: dockerDeployments.nodeId, status: dockerDeployments.status })
        .from(dockerDeployments)
        .where(eq(dockerDeployments.id, source.deploymentId!))
        .limit(1);
      if (!deployment) throw new AppError(404, 'DEPLOYMENT_NOT_FOUND', 'Source deployment was not found');
      await this.registry.ensureBinding({
        nodeId: deployment.nodeId,
        role: 'runtime',
        repository,
        actions: ['pull'],
        contextKind: 'deployment',
        contextId: deployment.id,
      });
      if (deployment.status === 'creating') {
        await this.deployments.activatePending(deployment.nodeId, deployment.id, image, actorId);
      } else {
        await this.deployments.deploy(deployment.nodeId, deployment.id, { image }, actorId, 'git_push_to_deploy');
      }
      return `deployment:${deployment.id}`;
    }

    const managed = await this.docker.getManagedContainerConfiguration?.(source.nodeId!, source.containerName!);
    if (managed) {
      // HA owns artifact distribution, runtime selection and readiness. The
      // original node may be offline or no longer host the logical workload.
      await this.docker.recreateWithConfig(managed.nodeId, managed.containerName, { image }, actorId, {
        waitForAvailability: true,
      });
      return `container:${source.nodeId}:${source.containerName}`;
    }

    const containers = await this.docker.listAllContainers(source.nodeId!);
    const container = Array.isArray(containers)
      ? containers.find((candidate: any) => {
          const name = String(candidate.name ?? candidate.Name ?? '').replace(/^\//, '');
          return name === source.containerName;
        })
      : null;
    await this.registry.ensureBinding({
      nodeId: source.nodeId!,
      role: 'runtime',
      repository,
      actions: ['pull'],
      contextKind: 'container',
      contextId: `${source.nodeId}:${source.containerName}`,
    });
    const containerId = String(container?.id ?? container?.Id ?? '');
    if (!containerId) {
      if (!source.initialConfig || !actorId) {
        throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Source container was not found');
      }
      await this.docker.pullImageImmediate(source.nodeId!, image);
      const created = await this.docker.createContainer(
        source.nodeId!,
        { ...source.initialConfig, name: source.containerName!, image },
        actorId,
        []
      );
      const createdId = String(created?.id ?? created?.Id ?? '');
      if (!createdId) {
        throw new AppError(502, 'CONTAINER_ID_UNAVAILABLE', 'Created source container did not return an identity');
      }
      // Keep the created resource and its stable access identity if activation
      // fails. Users must still be able to inspect, edit Source and retry.
      await this.docker.startContainer(source.nodeId!, createdId, actorId);
      await this.waitForContainerReady(source.nodeId!, source.containerName!, image, 60_000);
      return `container:${source.nodeId}:${source.containerName}`;
    }
    const previousInspect = await this.docker.inspectContainer(source.nodeId!, containerId);
    const previousArtifact = await this.previousArtifactImage(source.id);
    const firstActivation = source.initialConfig && !source.deployedCommitSha && !previousArtifact;
    if (firstActivation && !actorId) {
      throw new AppError(403, 'BUILD_ACTOR_REQUIRED', 'First container activation requires a source owner');
    }
    const previousImage = previousArtifact || String(previousInspect?.Image ?? '').trim();
    if (!previousImage) {
      throw new AppError(
        409,
        'BUILD_ROLLOUT_ROLLBACK_UNAVAILABLE',
        'The currently running container has no immutable image reference for safe rollback'
      );
    }
    try {
      await this.docker.recreateWithConfig(source.nodeId!, containerId, { image }, actorId, {
        backgroundImagePull: false,
      });
      if (firstActivation && actorId) {
        // Recover the first activation without starting intentionally stopped
        // resources which already had a successful deployment.
        const currentId = await this.waitForReplacement(
          source.nodeId!,
          source.containerName!,
          containerId,
          image,
          60_000
        );
        await this.docker.startContainer(source.nodeId!, currentId, actorId);
      }
      await this.waitForContainerReady(source.nodeId!, source.containerName!, image, 60_000);
    } catch (error) {
      if (!previousImage) throw error;
      const current = await this.findContainer(source.nodeId!, source.containerName!);
      await this.docker.recreateWithConfig(
        source.nodeId!,
        String(current?.id ?? current?.Id ?? source.containerName),
        { image: previousImage },
        actorId,
        { backgroundImagePull: false, skipImagePull: previousImage.startsWith('sha256:') }
      );
      await this.waitForContainerReady(source.nodeId!, source.containerName!, previousImage, 60_000);
      throw new AppError(
        409,
        'BUILD_ROLLOUT_ROLLED_BACK',
        `New container revision failed readiness and the previous image was restored: ${(error as Error).message}`
      );
    }
    return `container:${source.nodeId}:${source.containerName}`;
  }

  private async previousArtifactImage(sourceBindingId: string): Promise<string | null> {
    const [artifact] = await this.db
      .select({ repository: dockerBuildArtifacts.registryRepository, digest: dockerBuildArtifacts.digest })
      .from(dockerArtifactPins)
      .innerJoin(dockerBuildArtifacts, eq(dockerBuildArtifacts.id, dockerArtifactPins.artifactId))
      .where(and(eq(dockerArtifactPins.kind, 'active'), eq(dockerBuildArtifacts.sourceBindingId, sourceBindingId)))
      .orderBy(desc(dockerArtifactPins.createdAt))
      .limit(1);
    return artifact ? `127.0.0.1:5443/${artifact.repository}@${artifact.digest}` : null;
  }

  private async findContainer(nodeId: string, name: string): Promise<any | null> {
    const containers = await this.docker.listAllContainers(nodeId);
    if (!Array.isArray(containers)) return null;
    return (
      containers.find((candidate: any) => String(candidate.name ?? candidate.Name ?? '').replace(/^\//, '') === name) ??
      null
    );
  }

  private async waitForReplacement(
    nodeId: string,
    name: string,
    previousId: string,
    expectedImage: string,
    timeoutMs: number
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Recreate acknowledges before the daemon task and its watcher finish.
      // Even a same-image retry must target the replacement, never the old ID.
      if (!this.docker.getContainerTransition(nodeId, name)) {
        const container = await this.findContainer(nodeId, name);
        const id = String(container?.id ?? container?.Id ?? '');
        if (id && id !== previousId) {
          const inspect = await this.docker.inspectContainer(nodeId, id);
          if (String(inspect?.Config?.Image ?? '').trim() === expectedImage) return id;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new AppError(409, 'CONTAINER_READINESS_FAILED', 'Container replacement did not finish before activation');
  }

  private async waitForContainerReady(
    nodeId: string,
    name: string,
    expectedImage: string,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastState = 'container not found';
    while (Date.now() < deadline) {
      if (this.docker.getContainerTransition(nodeId, name)) {
        lastState = 'waiting for container transition';
      } else {
        try {
          const container = await this.findContainer(nodeId, name);
          const id = String(container?.id ?? container?.Id ?? '');
          if (id) {
            const inspect = await this.docker.inspectContainer(nodeId, id);
            const image = String(inspect?.Config?.Image ?? '').trim();
            const running = inspect?.State?.Running === true;
            const health = String(inspect?.State?.Health?.Status ?? '').toLowerCase();
            lastState =
              image !== expectedImage
                ? `waiting for image ${expectedImage}`
                : health || (running ? 'running' : String(inspect?.State?.Status ?? 'not running'));
            if (image === expectedImage && running && (!health || health === 'healthy')) return;
            if (image === expectedImage && (health === 'unhealthy' || inspect?.State?.Dead === true)) break;
          }
        } catch (error) {
          // Inventory can briefly retain the removed ID while a replacement is
          // being observed. This is not a readiness failure or a rollback signal.
          if (
            !(error instanceof AppError && error.code === 'CONTAINER_NOT_FOUND') &&
            !(error instanceof Error && /no such container/i.test(error.message))
          )
            throw error;
          lastState = 'waiting for replacement container';
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new AppError(409, 'CONTAINER_READINESS_FAILED', `Container did not become ready (${lastState})`);
  }

  private async rotatePins(
    tx: DrizzleExecutor,
    sourceBindingId: string,
    artifactId: string,
    ownerKey: string
  ): Promise<void> {
    const [previous] = await tx
      .select({ artifactId: dockerArtifactPins.artifactId })
      .from(dockerArtifactPins)
      .innerJoin(dockerBuildArtifacts, eq(dockerBuildArtifacts.id, dockerArtifactPins.artifactId))
      .where(
        and(
          eq(dockerArtifactPins.kind, 'active'),
          eq(dockerArtifactPins.ownerKey, ownerKey),
          eq(dockerBuildArtifacts.sourceBindingId, sourceBindingId)
        )
      )
      .orderBy(desc(dockerArtifactPins.createdAt))
      .limit(1);
    await tx
      .delete(dockerArtifactPins)
      .where(and(eq(dockerArtifactPins.ownerKey, ownerKey), eq(dockerArtifactPins.kind, 'rollback')));
    await tx
      .delete(dockerArtifactPins)
      .where(and(eq(dockerArtifactPins.ownerKey, ownerKey), eq(dockerArtifactPins.kind, 'active')));
    if (previous && previous.artifactId !== artifactId) {
      await tx.insert(dockerArtifactPins).values({
        artifactId: previous.artifactId,
        kind: 'rollback',
        ownerKey,
        reason: 'Previous successful push-to-deploy artifact',
      });
    }
    await tx.insert(dockerArtifactPins).values({
      artifactId,
      kind: 'active',
      ownerKey,
      reason: 'Current push-to-deploy artifact',
    });
  }
}
