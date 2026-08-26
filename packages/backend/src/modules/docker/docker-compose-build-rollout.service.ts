import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import {
  dockerArtifactPins,
  dockerBuildArtifacts,
  dockerBuildBatches,
  dockerBuilds,
  dockerComposeProjects,
  dockerSourceBindings,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { RelayRegistryService } from '@/services/relay-registry.service.js';
import type { DockerComposeService } from './compose/compose.service.js';
import { prepareComposeGitBuild } from './compose/compose-policy.js';

const BUILD_AUTOMATION_USER_ID = '00000000-0000-4000-8000-000000000001';
export const COMPOSE_GIT_ROLLOUT_ACTION = 'pull_apply' as const;

type ComposeRolloutClaim = {
  build: typeof dockerBuilds.$inferSelect;
  batch: typeof dockerBuildBatches.$inferSelect;
  source: typeof dockerSourceBindings.$inferSelect;
  project: typeof dockerComposeProjects.$inferSelect;
  approved: Map<string, typeof dockerBuildArtifacts.$inferSelect>;
};

export function composeGitRolloutIdempotencyKey(sourceBindingId: string, batchId: string): string {
  return `git:${sourceBindingId}:${batchId}`;
}

export function isComposeBuildBatchReady(
  expectedServices: readonly string[],
  rows: ReadonlyArray<{ serviceName: string | null; status: string | null; policyDecision: string | null }>
): boolean {
  const approved = new Set(
    rows
      .filter((row) => row.serviceName && row.status === 'ready' && row.policyDecision === 'approved')
      .map((row) => row.serviceName!)
  );
  return expectedServices.length > 0 && expectedServices.every((serviceName) => approved.has(serviceName));
}

export function isComposeRolloutCurrent(input: {
  batchStatus: string;
  desiredCommitSha: string | null;
  commitSha: string;
}): boolean {
  return input.batchStatus === 'applying' && input.desiredCommitSha?.toLowerCase() === input.commitSha.toLowerCase();
}

export class DockerComposeBuildRolloutService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly registry: RelayRegistryService,
    private readonly compose: DockerComposeService
  ) {}

  async recoverInterrupted(now = new Date()) {
    const batches = await this.db
      .select({ id: dockerBuildBatches.id })
      .from(dockerBuildBatches)
      .where(eq(dockerBuildBatches.status, 'applying'));
    let succeeded = 0;
    let failed = 0;

    for (const batch of batches) {
      const disposition = await this.db.transaction(async (tx) => {
        const [identity] = await tx
          .select({ sourceBindingId: dockerBuildBatches.sourceBindingId })
          .from(dockerBuildBatches)
          .where(eq(dockerBuildBatches.id, batch.id))
          .limit(1);
        if (!identity) return 'ignored' as const;
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`docker-build-source:${identity.sourceBindingId}`}))`
        );
        const [current] = await tx
          .select({ batch: dockerBuildBatches, source: dockerSourceBindings, project: dockerComposeProjects })
          .from(dockerBuildBatches)
          .innerJoin(dockerSourceBindings, eq(dockerSourceBindings.id, dockerBuildBatches.sourceBindingId))
          .innerJoin(dockerComposeProjects, eq(dockerComposeProjects.id, dockerSourceBindings.composeProjectId))
          .where(eq(dockerBuildBatches.id, batch.id))
          .limit(1);
        if (
          !current ||
          !isComposeRolloutCurrent({
            batchStatus: current.batch.status,
            desiredCommitSha: current.source.desiredCommitSha,
            commitSha: current.batch.commitSha,
          })
        ) {
          return 'ignored' as const;
        }

        if (
          current.batch.candidateRevisionId &&
          current.project.activeRevisionId === current.batch.candidateRevisionId
        ) {
          const rows = await tx
            .select({ build: dockerBuilds, artifact: dockerBuildArtifacts })
            .from(dockerBuilds)
            .innerJoin(dockerBuildArtifacts, eq(dockerBuildArtifacts.buildId, dockerBuilds.id))
            .where(eq(dockerBuilds.batchId, current.batch.id));
          const artifacts = new Map(
            rows
              .filter(
                (row) =>
                  row.build.serviceName && row.artifact.status === 'ready' && row.artifact.policyDecision === 'approved'
              )
              .map((row) => [row.build.serviceName!, row.artifact] as const)
          );
          if (
            isComposeBuildBatchReady(
              current.batch.expectedServices,
              rows.map((row) => ({
                serviceName: row.build.serviceName,
                status: row.artifact.status,
                policyDecision: row.artifact.policyDecision,
              }))
            )
          ) {
            for (const serviceName of current.batch.expectedServices) {
              await this.rotatePins(
                tx,
                current.source.id,
                artifacts.get(serviceName)!.id,
                `compose:${current.project.id}:${serviceName}`
              );
            }
            await tx
              .update(dockerSourceBindings)
              .set({ deployedCommitSha: current.batch.commitSha, deployingCommitSha: null, updatedAt: now })
              .where(eq(dockerSourceBindings.id, current.source.id));
            await tx
              .update(dockerBuildBatches)
              .set({ status: 'succeeded', completedAt: now, updatedAt: now })
              .where(eq(dockerBuildBatches.id, current.batch.id));
            return 'succeeded' as const;
          }
        }

        await tx
          .update(dockerSourceBindings)
          .set({ deployingCommitSha: null, updatedAt: now })
          .where(
            and(
              eq(dockerSourceBindings.id, current.source.id),
              eq(dockerSourceBindings.deployingCommitSha, current.batch.commitSha)
            )
          );
        await tx
          .update(dockerBuildBatches)
          .set({
            status: 'failed',
            errorCode: 'COMPOSE_ROLLOUT_INTERRUPTED',
            errorMessage: 'Gateway restarted before the Compose rollout was finalized',
            completedAt: now,
            updatedAt: now,
          })
          .where(and(eq(dockerBuildBatches.id, current.batch.id), eq(dockerBuildBatches.status, 'applying')));
        return 'failed' as const;
      });
      if (disposition === 'succeeded') succeeded += 1;
      if (disposition === 'failed') failed += 1;
    }

    return { succeeded, failed };
  }

  async rollout(buildId: string): Promise<'deployed' | 'superseded' | 'pending'> {
    const claim = await this.claim(buildId);
    if (claim.disposition !== 'claimed') return claim.disposition;

    try {
      const images: Record<string, string> = {};
      for (const service of claim.batch.composeBuildPlan.services) {
        const artifact = claim.approved.get(service.serviceName)!;
        images[service.serviceName] = `127.0.0.1:5443/${artifact.registryRepository}@${artifact.digest}`;
        await this.registry.ensureBinding({
          nodeId: claim.project.nodeId,
          role: 'runtime',
          repository: artifact.registryRepository,
          actions: ['pull'],
          contextKind: 'compose_project',
          contextId: claim.project.id,
        });
      }
      const prepared = prepareComposeGitBuild(
        {
          projectName: claim.project.name,
          yaml: claim.batch.composeBuildPlan.sourceYaml,
          variables: claim.batch.composeVariables,
          secretKeys: claim.batch.composeSecretKeys,
        },
        images
      );
      if (!prepared.valid || !prepared.runtimeYaml) {
        throw new AppError(409, 'COMPOSE_BUILD_RESOLUTION_FAILED', 'Built Compose images could not be resolved');
      }
      const actorId = claim.build.createdById ?? claim.source.createdById ?? BUILD_AUTOMATION_USER_ID;
      const revision = await this.compose.createGitRevision(
        claim.project.nodeId,
        claim.project.id,
        {
          yaml: prepared.runtimeYaml,
          variables: claim.batch.composeVariables,
          secretKeys: claim.batch.composeSecretKeys,
        },
        {
          yaml: claim.batch.composeBuildPlan.sourceYaml,
          bindingId: claim.source.id,
          batchId: claim.batch.id,
          commitSha: claim.build.commitSha,
        },
        actorId
      );
      await this.pinRevisionArtifacts(claim, revision.id);
      if (!claim.source.autoDeploy) return this.finalizeWithoutDeploy(claim, revision.id);

      const operation = await this.compose.startOperation(
        claim.project.nodeId,
        claim.project.id,
        COMPOSE_GIT_ROLLOUT_ACTION,
        {
          revisionId: revision.id,
          idempotencyKey: composeGitRolloutIdempotencyKey(claim.source.id, claim.batch.id),
          removeOrphans: true,
          volumeNames: [],
        },
        actorId
      );
      await this.compose.waitForOperation(operation.id);
      return this.finalizeApplied(claim, revision.id);
    } catch (error) {
      if (!(await this.markFailed(claim, error))) return 'superseded';
      throw error;
    }
  }

  private async claim(buildId: string) {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          build: dockerBuilds,
          batch: dockerBuildBatches,
          source: dockerSourceBindings,
          project: dockerComposeProjects,
        })
        .from(dockerBuilds)
        .innerJoin(dockerBuildBatches, eq(dockerBuildBatches.id, dockerBuilds.batchId))
        .innerJoin(dockerSourceBindings, eq(dockerSourceBindings.id, dockerBuilds.sourceBindingId))
        .innerJoin(dockerComposeProjects, eq(dockerComposeProjects.id, dockerSourceBindings.composeProjectId))
        .where(eq(dockerBuilds.id, buildId))
        .limit(1);
      if (!current) throw new AppError(404, 'BUILD_ARTIFACT_NOT_FOUND', 'Approved build artifact was not found');
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-build-source:${current.source.id}`}))`);
      if (current.batch.status === 'superseded') return { disposition: 'superseded' as const };
      if (current.batch.status === 'succeeded') return { disposition: 'deployed' as const };
      if (current.batch.status === 'failed' || current.batch.status === 'cancelled') {
        return { disposition: 'pending' as const };
      }
      if (current.source.desiredCommitSha?.toLowerCase() !== current.build.commitSha.toLowerCase()) {
        return { disposition: 'superseded' as const };
      }
      if (current.source.deployedCommitSha?.toLowerCase() === current.build.commitSha.toLowerCase()) {
        return { disposition: 'deployed' as const };
      }
      const expected = current.batch.composeBuildPlan.services;
      if (expected.length === 0) {
        throw new AppError(409, 'COMPOSE_BUILD_PLAN_MISSING', 'Compose source has no resolved build plan');
      }
      const rows = await tx
        .select({ build: dockerBuilds, artifact: dockerBuildArtifacts })
        .from(dockerBuilds)
        .leftJoin(dockerBuildArtifacts, eq(dockerBuildArtifacts.buildId, dockerBuilds.id))
        .where(and(eq(dockerBuilds.batchId, current.batch.id), eq(dockerBuilds.commitSha, current.build.commitSha)));
      const approved = new Map(
        rows
          .filter(
            (row) =>
              row.build.serviceName && row.artifact?.status === 'ready' && row.artifact.policyDecision === 'approved'
          )
          .map((row) => [row.build.serviceName!, row.artifact!] as const)
      );
      if (
        !isComposeBuildBatchReady(
          expected.map((service) => service.serviceName),
          rows.map((row) => ({
            serviceName: row.build.serviceName,
            status: row.artifact?.status ?? null,
            policyDecision: row.artifact?.policyDecision ?? null,
          }))
        )
      ) {
        await tx
          .update(dockerBuildBatches)
          .set({ status: 'awaiting_approval', updatedAt: new Date() })
          .where(eq(dockerBuildBatches.id, current.batch.id));
        return { disposition: 'pending' as const };
      }
      const [claimed] = await tx
        .update(dockerBuildBatches)
        .set({ status: 'applying', updatedAt: new Date() })
        .where(
          and(
            eq(dockerBuildBatches.id, current.batch.id),
            inArray(dockerBuildBatches.status, ['building', 'awaiting_approval'])
          )
        )
        .returning({ id: dockerBuildBatches.id });
      if (!claimed) return { disposition: 'pending' as const };
      await tx
        .update(dockerSourceBindings)
        .set({ deployingCommitSha: current.build.commitSha, updatedAt: new Date() })
        .where(eq(dockerSourceBindings.id, current.source.id));
      return { disposition: 'claimed' as const, ...current, approved };
    });
  }

  private async pinRevisionArtifacts(claim: ComposeRolloutClaim, revisionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const service of claim.batch.composeBuildPlan.services) {
        const artifact = claim.approved.get(service.serviceName)!;
        await tx
          .insert(dockerArtifactPins)
          .values({
            artifactId: artifact.id,
            composeRevisionId: revisionId,
            kind: 'manual',
            ownerKey: `compose-revision:${revisionId}:${service.serviceName}`,
            reason: 'Immutable Compose revision artifact',
          })
          .onConflictDoNothing();
      }
      await tx
        .update(dockerBuildBatches)
        .set({ candidateRevisionId: revisionId, updatedAt: new Date() })
        .where(and(eq(dockerBuildBatches.id, claim.batch.id), eq(dockerBuildBatches.status, 'applying')));
    });
  }

  private async finalizeWithoutDeploy(
    claim: ComposeRolloutClaim,
    revisionId: string
  ): Promise<'pending' | 'superseded'> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockCurrent(tx, claim);
      if (!current) return 'superseded';
      await tx
        .update(dockerComposeProjects)
        .set({ desiredState: 'stopped', status: 'stopped', updatedAt: new Date() })
        .where(eq(dockerComposeProjects.id, claim.project.id));
      await tx
        .update(dockerSourceBindings)
        .set({ deployingCommitSha: null, updatedAt: new Date() })
        .where(eq(dockerSourceBindings.id, claim.source.id));
      await tx
        .update(dockerBuildBatches)
        .set({
          status: 'succeeded',
          candidateRevisionId: revisionId,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(dockerBuildBatches.id, claim.batch.id), eq(dockerBuildBatches.status, 'applying')));
      return 'pending';
    });
  }

  private async finalizeApplied(claim: ComposeRolloutClaim, revisionId: string): Promise<'deployed' | 'superseded'> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockCurrent(tx, claim);
      if (!current || current.project.activeRevisionId !== revisionId) return 'superseded';
      for (const service of claim.batch.composeBuildPlan.services) {
        const artifact = claim.approved.get(service.serviceName)!;
        await this.rotatePins(tx, claim.source.id, artifact.id, `compose:${claim.project.id}:${service.serviceName}`);
      }
      await tx
        .update(dockerSourceBindings)
        .set({ deployedCommitSha: claim.build.commitSha, deployingCommitSha: null, updatedAt: new Date() })
        .where(eq(dockerSourceBindings.id, claim.source.id));
      const [finalized] = await tx
        .update(dockerBuildBatches)
        .set({
          status: 'succeeded',
          candidateRevisionId: revisionId,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(dockerBuildBatches.id, claim.batch.id), eq(dockerBuildBatches.status, 'applying')))
        .returning({ id: dockerBuildBatches.id });
      return finalized ? 'deployed' : 'superseded';
    });
  }

  private async lockCurrent(tx: DrizzleExecutor, claim: ComposeRolloutClaim) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-build-source:${claim.source.id}`}))`);
    const [current] = await tx
      .select({ batch: dockerBuildBatches, source: dockerSourceBindings, project: dockerComposeProjects })
      .from(dockerBuildBatches)
      .innerJoin(dockerSourceBindings, eq(dockerSourceBindings.id, dockerBuildBatches.sourceBindingId))
      .innerJoin(dockerComposeProjects, eq(dockerComposeProjects.id, dockerSourceBindings.composeProjectId))
      .where(eq(dockerBuildBatches.id, claim.batch.id))
      .limit(1);
    if (
      !current ||
      !isComposeRolloutCurrent({
        batchStatus: current.batch.status,
        desiredCommitSha: current.source.desiredCommitSha,
        commitSha: claim.build.commitSha,
      })
    ) {
      await tx
        .update(dockerSourceBindings)
        .set({ deployingCommitSha: null, updatedAt: new Date() })
        .where(
          and(
            eq(dockerSourceBindings.id, claim.source.id),
            eq(dockerSourceBindings.deployingCommitSha, claim.build.commitSha)
          )
        );
      return null;
    }
    return current;
  }

  private async markFailed(claim: ComposeRolloutClaim, error: unknown): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-build-source:${claim.source.id}`}))`);
      const [failed] = await tx
        .update(dockerBuildBatches)
        .set({
          status: 'failed',
          errorCode: 'COMPOSE_ROLLOUT_FAILED',
          errorMessage: (error as Error).message.slice(0, 4096),
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(dockerBuildBatches.id, claim.batch.id), eq(dockerBuildBatches.status, 'applying')))
        .returning({ id: dockerBuildBatches.id });
      await tx
        .update(dockerSourceBindings)
        .set({ deployingCommitSha: null, updatedAt: new Date() })
        .where(
          and(
            eq(dockerSourceBindings.id, claim.source.id),
            eq(dockerSourceBindings.deployingCommitSha, claim.build.commitSha)
          )
        );
      return Boolean(failed);
    });
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
