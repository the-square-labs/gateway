import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerMigrationArtifacts, dockerMigrations } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { DockerManagementService } from './docker.service.js';
import type { DockerDeploymentService } from './docker-deployment.service.js';
import type { DockerEnvironmentService } from './docker-environment.service.js';
import { assertMigrationAvailabilityAllowed } from './docker-migration-availability.js';
import { sourceDeploymentSlotEnvironments } from './docker-migration-deployment-runtime.js';
import type { DockerMigrationDispatchAdapter, MigrationArtifactMetadata } from './docker-migration-dispatch.js';
import { mergeMigrationEnvironment, migrationEnvironmentOverlays } from './docker-migration-environment.js';
import {
  assertMigrationDeletionGate,
  assertMigrationManifest,
  equalMigrationEnv,
  type MigrationRow,
  migrationDeploymentContainerNames,
  migrationDeploymentSnapshot,
  migrationEnvList,
  migrationEnvMap,
  openMigrationPlan,
  type StoredMigrationPlan,
  sealMigrationPlan,
  waitForMigratedContainer,
} from './docker-migration-runtime.js';
import { migrationSourceMayNeedRestore, restoreMigrationSource } from './docker-migration-source-restore.js';
import type { DockerSecretService } from './docker-secret.service.js';

type ArtifactRow = typeof dockerMigrationArtifacts.$inferSelect;

export class DockerMigrationExecutor {
  constructor(
    private db: DrizzleClient,
    private dispatch: DockerMigrationDispatchAdapter,
    private docker: DockerManagementService,
    private deployments: DockerDeploymentService,
    private environment: DockerEnvironmentService,
    private secrets: DockerSecretService,
    private crypto: CryptoService
  ) {}

  async execute(row: MigrationRow): Promise<{
    progress?: Record<string, unknown>;
    verification?: Record<string, unknown>;
  }> {
    await assertMigrationAvailabilityAllowed(this.db, row);
    switch (row.phase) {
      case 'preparing':
        return this.prepare(row, 'image');
      case 'stopping_source':
        await this.stopSource(row);
        return {};
      case 'preparing_volumes':
        return this.prepare(row, 'volume');
      case 'transferring':
        return this.transfer(row);
      case 'creating_target':
        return this.createTarget(row);
      case 'verifying_target':
        return this.verifyTarget(row);
      case 'starting_target':
        return this.startTarget(row);
      case 'cleanup_source':
        await this.cleanupSource(row);
        return {};
      case 'finalizing':
        await Promise.all([
          this.dispatch.finalize(row.sourceNodeId, row.id),
          this.dispatch.finalize(row.targetNodeId, row.id),
        ]);
        return {};
      default:
        return {};
    }
  }

  async rollback(row: MigrationRow): Promise<void> {
    await assertMigrationAvailabilityAllowed(this.db, row);
    const plan = openMigrationPlan(row, this.crypto);
    const failures: unknown[] = [];
    await this.removeTarget(row, plan).catch((error) => failures.push(error));
    await Promise.all(
      [row.sourceNodeId, row.targetNodeId].map((nodeId) =>
        this.dispatch.abort(nodeId, row.id).catch((error) => failures.push(error))
      )
    );
    if (migrationSourceMayNeedRestore(row)) {
      await restoreMigrationSource(this.dispatch, row, plan).catch((error) => failures.push(error));
    }
    if (failures.length) throw new AggregateError(failures, 'Docker migration rollback was incomplete');
  }

  private async prepare(row: MigrationRow, kind: 'image' | 'volume') {
    const artifacts = await this.artifacts(row.id);
    const currentPlan = openMigrationPlan(row, this.crypto);
    const nextPlan: StoredMigrationPlan = { ...currentPlan };
    if (kind === 'image' && row.resourceType === 'container') {
      const manifest = await this.dispatch.captureManifest(row.sourceNodeId, row.resourceName);
      const blockers = Array.isArray(manifest.blockers) ? manifest.blockers : [];
      if (blockers.length > 0) {
        throw new AppError(409, 'MIGRATION_MANIFEST_BLOCKED', String(blockers[0]));
      }
      nextPlan.manifest = manifest;
      await this.docker.getContainerEnv(row.sourceNodeId, row.resourceName);
    } else if (kind === 'image') {
      nextPlan.deployment = migrationDeploymentSnapshot(
        await this.deployments.get(row.sourceNodeId, row.deploymentId!)
      );
      nextPlan.deploymentActiveSlot = String(nextPlan.deployment.activeSlot ?? '');
      nextPlan.deploymentManifests = {};
      const deployment = this.deploymentPayload(nextPlan);
      for (const [role, name] of Object.entries({ router: deployment.routerName, ...deployment.slots })) {
        if (typeof name !== 'string' || !name) continue;
        const manifest = await this.dispatch.captureManifest(row.sourceNodeId, name);
        const blockers = Array.isArray(manifest.blockers) ? manifest.blockers : [];
        if (blockers.length > 0) {
          throw new AppError(409, 'MIGRATION_MANIFEST_BLOCKED', String(blockers[0]));
        }
        nextPlan.deploymentManifests[role] = manifest;
      }
    }
    for (const artifact of artifacts) {
      if (artifact.kind !== kind) continue;
      if (artifact.state === 'prepared' || artifact.state === 'verified') continue;
      const metadata = await this.dispatch.prepareArtifact({
        nodeId: row.sourceNodeId,
        migrationId: row.id,
        artifactId: artifact.id,
        kind: artifact.kind,
        sourceIdentity: artifact.sourceIdentity,
      });
      await this.storeSourceArtifact(artifact, metadata);
    }
    await this.db
      .update(dockerMigrations)
      .set({ plan: sealMigrationPlan(nextPlan, this.crypto), updatedAt: new Date() })
      .where(eq(dockerMigrations.id, row.id));
    const totalBytes = (await this.artifacts(row.id)).reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
    return { progress: { totalBytes, transferredBytes: 0, message: `${kind} artifacts prepared` } };
  }

  private async stopSource(row: MigrationRow): Promise<void> {
    const plan = openMigrationPlan(await this.reload(row.id), this.crypto);
    if (row.resourceType === 'container') {
      await this.dispatch.containerAction(row.sourceNodeId, 'live_update', row.resourceName, {
        configJson: JSON.stringify({ restartPolicy: 'no' }),
      });
      if (row.sourceState === 'running') {
        await this.dispatch.containerAction(row.sourceNodeId, 'stop', row.resourceName, {
          configJson: JSON.stringify({ timeoutProvided: true }),
          timeoutSeconds: 10,
        });
        await waitForMigratedContainer(
          () => this.dispatch.containerAction(row.sourceNodeId, 'inspect', row.resourceName),
          false,
          30_000
        );
      }
      return;
    }
    const payload = this.deploymentPayload(plan);
    for (const name of migrationDeploymentContainerNames(payload)) {
      await this.dispatch.containerAction(row.sourceNodeId, 'live_update', name, {
        configJson: JSON.stringify({ restartPolicy: 'no' }),
      });
    }
    if (row.sourceState === 'ready') {
      await this.dispatch.deploymentAction(row.sourceNodeId, 'stop', row.deploymentId!, {
        configJson: JSON.stringify({ deployment: payload.deployment }),
      });
    }
  }

  private async transfer(row: MigrationRow) {
    const artifacts = await this.artifacts(row.id);
    const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
    let completedBytes = artifacts
      .filter((artifact) => artifact.state === 'verified')
      .reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
    for (const artifact of artifacts) {
      if (artifact.state === 'verified') continue;
      const source = await this.dispatch.queryArtifact(row.sourceNodeId, row.id, artifact.id);
      let offset = 0;
      try {
        offset = (await this.dispatch.queryArtifact(row.targetNodeId, row.id, artifact.id)).sizeBytes;
      } catch {
        offset = 0;
      }
      await this.dispatch.transferArtifact({
        sourceNodeId: row.sourceNodeId,
        targetNodeId: row.targetNodeId,
        migrationId: row.id,
        artifactId: artifact.id,
        offset,
        onProgress: async (nextOffset) => {
          await this.db
            .update(dockerMigrationArtifacts)
            .set({ transferredBytes: nextOffset, state: 'transferring', updatedAt: new Date() })
            .where(eq(dockerMigrationArtifacts.id, artifact.id));
          await this.db
            .update(dockerMigrations)
            .set({
              progress: {
                ...row.progress,
                currentArtifactId: artifact.id,
                transferredBytes: completedBytes + nextOffset,
                totalBytes,
                message: `Transferring ${artifact.kind}`,
              },
              updatedAt: new Date(),
            })
            .where(eq(dockerMigrations.id, row.id));
        },
      });
      const imported = await this.dispatch.importArtifact({
        nodeId: row.targetNodeId,
        migrationId: row.id,
        artifactId: artifact.id,
        kind: artifact.kind,
        config: await this.importConfig(row, artifact, source),
      });
      this.assertArtifact(source, imported, artifact.kind);
      await this.storeTargetArtifact(artifact, imported);
      completedBytes += artifact.sizeBytes;
    }
    return {
      progress: { transferredBytes: totalBytes, totalBytes, message: 'Artifacts transferred and verified' },
      verification: { imageDigestVerified: true, volumeTreeVerified: true, fsyncVerified: true },
    };
  }

  private async createTarget(row: MigrationRow) {
    const fresh = await this.reload(row.id);
    const plan = openMigrationPlan(fresh, this.crypto);
    const overlays = await migrationEnvironmentOverlays(this.environment, this.secrets, row);
    const effectiveEnv = mergeMigrationEnvironment(plan.deployment?.desiredConfig?.env, overlays);
    let target: Record<string, string>;
    if (row.resourceType === 'container') {
      const created = await this.dispatch.createContainerStopped(row.targetNodeId, row.id, {
        migrationId: row.id,
        manifest: plan.manifest,
        env: migrationEnvList(effectiveEnv),
      });
      target = { containerId: created.containerId };
    } else {
      const payload = this.deploymentPayload(plan);
      const sourceSlotEnv = await sourceDeploymentSlotEnvironments(this.dispatch, row.sourceNodeId, payload);
      const slotConfigs = Object.fromEntries(
        Object.entries(payload.slotConfigs ?? {}).map(([slot, config]) => [
          slot,
          {
            ...(config as Record<string, unknown>),
            env: sourceSlotEnv[slot] ?? {},
          },
        ])
      );
      target = await this.dispatch.createDeploymentStopped(row.targetNodeId, row.id, {
        ...payload,
        desiredConfig: {
          ...payload.desiredConfig,
          env: sourceSlotEnv[payload.activeSlot] ?? effectiveEnv,
        },
        slotConfigs,
      });
    }
    await this.db
      .update(dockerMigrations)
      .set({ plan: sealMigrationPlan({ ...plan, target }, this.crypto), updatedAt: new Date() })
      .where(eq(dockerMigrations.id, row.id));
    return { progress: { message: 'Target resource created stopped' } };
  }

  private async verifyTarget(row: MigrationRow) {
    const plan = openMigrationPlan(await this.reload(row.id), this.crypto);
    if (row.resourceType === 'container') {
      const targetId = plan.target?.containerId;
      if (!targetId) throw new AppError(502, 'MIGRATION_TARGET_MISSING', 'Target container identity is missing');
      const inspect = await this.dispatch.containerAction(row.targetNodeId, 'inspect', targetId);
      if (
        !equalMigrationEnv(
          migrationEnvMap((inspect.Config as Record<string, unknown> | undefined)?.Env),
          await this.effectiveEnvironment(row)
        )
      ) {
        throw new AppError(502, 'MIGRATION_ENV_MISMATCH', 'Target environment and secrets do not match the source');
      }
      const targetManifest = await this.dispatch.captureManifest(row.targetNodeId, targetId);
      assertMigrationManifest(plan.manifest ?? {}, targetManifest);
    } else {
      await this.verifyDeploymentTarget(row, plan);
    }
    return {
      verification: {
        manifestVerified: true,
        environmentVerified: true,
        secretsVerified: true,
      },
      progress: { message: 'Target configuration verified' },
    };
  }

  private async verifyDeploymentTarget(row: MigrationRow, plan: StoredMigrationPlan): Promise<void> {
    const payload = this.deploymentPayload(plan);
    const sourceSlotEnv = await sourceDeploymentSlotEnvironments(this.dispatch, row.sourceNodeId, payload);
    const targets = {
      router: plan.target?.routerId,
      blue: plan.target?.blueContainerId,
      green: plan.target?.greenContainerId,
    };
    for (const [role, targetId] of Object.entries(targets)) {
      if (!targetId) throw new AppError(502, 'MIGRATION_TARGET_MISSING', `Target ${role} identity is missing`);
      const targetManifest = await this.dispatch.captureManifest(row.targetNodeId, targetId);
      assertMigrationManifest(plan.deploymentManifests?.[role] ?? {}, targetManifest);
      if (role === 'router') continue;
      const inspect = await this.dispatch.containerAction(row.targetNodeId, 'inspect', targetId);
      const expected = sourceSlotEnv[role] ?? {};
      if (!equalMigrationEnv(migrationEnvMap((inspect.Config as Record<string, any> | undefined)?.Env), expected)) {
        throw new AppError(502, 'MIGRATION_ENV_MISMATCH', `Target ${role} environment and secrets do not match`);
      }
    }
  }

  private async startTarget(row: MigrationRow) {
    if (!['running', 'ready'].includes(row.sourceState)) {
      return { verification: { healthVerified: false }, progress: { message: 'Target remains stopped' } };
    }
    const plan = openMigrationPlan(await this.reload(row.id), this.crypto);
    if (row.resourceType === 'container') {
      const targetId = plan.target?.containerId;
      if (!targetId) throw new AppError(502, 'MIGRATION_TARGET_MISSING', 'Target container identity is missing');
      await this.dispatch.containerAction(row.targetNodeId, 'start', targetId);
      await waitForMigratedContainer(
        () => this.dispatch.containerAction(row.targetNodeId, 'inspect', targetId),
        true,
        120_000
      );
    } else {
      const payload = this.deploymentPayload(plan);
      await this.dispatch.deploymentAction(row.targetNodeId, 'start', row.deploymentId!, {
        configJson: JSON.stringify({ deployment: payload.deployment }),
      });
    }
    return { verification: { healthVerified: true }, progress: { message: 'Target health gate passed' } };
  }

  private async cleanupSource(row: MigrationRow): Promise<void> {
    if (row.keepSource) return;
    const fresh = await this.reload(row.id);
    assertMigrationDeletionGate(fresh, await this.artifacts(row.id));
    const plan = openMigrationPlan(fresh, this.crypto);
    if (row.resourceType === 'container') {
      await this.dispatch.containerAction(row.sourceNodeId, 'remove', row.resourceName, { force: false });
    } else {
      const payload = this.deploymentPayload(plan);
      await this.dispatch.deploymentAction(row.sourceNodeId, 'remove', row.deploymentId!, {
        configJson: JSON.stringify({ deployment: payload.deployment }),
      });
    }
    for (const artifact of await this.artifacts(row.id)) {
      if (artifact.kind !== 'volume' || artifact.state !== 'verified') continue;
      const volumes = (await this.docker.listVolumes(row.sourceNodeId)) as Array<Record<string, any>>;
      const volume = volumes.find((item) => (item.Name ?? item.name) === artifact.sourceIdentity);
      const consumers = volume?.UsedBy ?? volume?.usedBy ?? [];
      if (Array.isArray(consumers) && consumers.length > 0) {
        throw new AppError(409, 'MIGRATION_VOLUME_IN_USE', `Source volume ${artifact.sourceIdentity} is still in use`);
      }
      await this.dispatch.volumeAction(row.sourceNodeId, 'remove', artifact.sourceIdentity);
    }
  }

  private async removeTarget(row: MigrationRow, plan: StoredMigrationPlan): Promise<void> {
    const failures: unknown[] = [];
    try {
      if (row.resourceType === 'container' && plan.target?.containerId) {
        await this.dispatch.containerAction(row.targetNodeId, 'remove', plan.target.containerId, { force: true });
      } else if (row.resourceType === 'deployment' && plan.deployment) {
        const payload = this.deploymentPayload(plan);
        await this.dispatch.deploymentAction(row.targetNodeId, 'remove', row.deploymentId!, {
          configJson: JSON.stringify({ deployment: payload.deployment }),
        });
      }
    } catch (error) {
      failures.push(error);
    }
    for (const artifact of await this.artifacts(row.id)) {
      if (artifact.kind !== 'volume') continue;
      await this.dispatch
        .volumeAction(row.targetNodeId, 'remove', artifact.targetIdentity, { force: true })
        .catch((error) => failures.push(error));
    }
    if (failures.length) throw new AggregateError(failures, 'Target migration cleanup was incomplete');
  }

  private async effectiveEnvironment(row: MigrationRow): Promise<Record<string, string>> {
    const overlays = await migrationEnvironmentOverlays(this.environment, this.secrets, row);
    const deployment =
      row.resourceType === 'deployment' ? await this.deployments.get(row.sourceNodeId, row.deploymentId!) : null;
    return mergeMigrationEnvironment(deployment?.desiredConfig?.env, overlays);
  }

  private deploymentPayload(plan: StoredMigrationPlan): Record<string, any> {
    if (!plan.deployment) throw new AppError(500, 'MIGRATION_PLAN_INVALID', 'Deployment snapshot is missing');
    return plan.deployment;
  }

  private async importConfig(row: MigrationRow, artifact: ArtifactRow, source: MigrationArtifactMetadata) {
    if (artifact.kind === 'image') {
      return {
        expectedImageId: source.imageId,
        expectedArtifactDigest: source.artifactDigest,
        sourceTags: source.imageTags ?? [],
      };
    }
    const volumes = (await this.docker.listVolumes(row.sourceNodeId)) as Array<Record<string, any>>;
    const volume = volumes.find((item) => (item.Name ?? item.name) === artifact.sourceIdentity);
    return {
      volumeName: artifact.targetIdentity,
      labels: volume?.Labels ?? volume?.labels ?? {},
      expectedArtifactDigest: source.artifactDigest,
      expectedLogicalDigest: source.logicalDigest,
      expectedEntryCount: source.entryCount,
      expectedContentBytes: source.contentBytes,
    };
  }

  private assertArtifact(source: MigrationArtifactMetadata, target: MigrationArtifactMetadata, kind: string): void {
    if (source.artifactDigest !== target.artifactDigest || source.sizeBytes !== target.sizeBytes) {
      throw new AppError(502, 'MIGRATION_ARTIFACT_MISMATCH', `${kind} artifact digest does not match`);
    }
    if (
      kind === 'volume' &&
      (source.logicalDigest !== target.logicalDigest ||
        source.entryCount !== target.entryCount ||
        source.contentBytes !== target.contentBytes)
    ) {
      throw new AppError(502, 'MIGRATION_VOLUME_MISMATCH', 'Target volume contents or metadata do not match');
    }
    if (kind === 'image' && source.imageId !== target.imageId) {
      throw new AppError(502, 'MIGRATION_IMAGE_MISMATCH', 'Target image digest does not match');
    }
  }

  private async artifacts(id: string): Promise<ArtifactRow[]> {
    return this.db.select().from(dockerMigrationArtifacts).where(eq(dockerMigrationArtifacts.migrationId, id));
  }

  private async reload(id: string): Promise<MigrationRow> {
    const [row] = await this.db.select().from(dockerMigrations).where(eq(dockerMigrations.id, id)).limit(1);
    if (!row) throw new AppError(404, 'MIGRATION_NOT_FOUND', 'Docker migration not found');
    return row;
  }

  private storeSourceArtifact(artifact: ArtifactRow, metadata: MigrationArtifactMetadata): Promise<unknown> {
    return this.db
      .update(dockerMigrationArtifacts)
      .set({
        sizeBytes: metadata.sizeBytes,
        artifactDigest: metadata.artifactDigest,
        sourceManifestRoot: metadata.logicalDigest,
        entryCount: metadata.entryCount,
        logicalBytes: metadata.contentBytes,
        state: 'prepared',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dockerMigrationArtifacts.id, artifact.id),
          eq(dockerMigrationArtifacts.migrationId, artifact.migrationId)
        )
      );
  }

  private storeTargetArtifact(artifact: ArtifactRow, metadata: MigrationArtifactMetadata): Promise<unknown> {
    return this.db
      .update(dockerMigrationArtifacts)
      .set({
        transferredBytes: metadata.sizeBytes,
        targetManifestRoot: metadata.logicalDigest,
        state: 'verified',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dockerMigrationArtifacts.id, artifact.id),
          eq(dockerMigrationArtifacts.migrationId, artifact.migrationId)
        )
      );
  }
}
