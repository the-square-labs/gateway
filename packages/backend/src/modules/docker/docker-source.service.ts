import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerBuildSecrets,
  dockerComposeProjects,
  dockerDeployments,
  dockerSourceBindings,
  integrationConnectors,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { type LicensePolicyService, requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { User } from '@/types.js';
import { prepareComposeGitBuild } from './compose/compose-policy.js';
import type {
  DockerBuildCreateInput,
  DockerSourceBindingUpsertInput,
  DockerSourceTarget,
} from './docker-build.schemas.js';
import type { DockerBuildService } from './docker-build.service.js';
import {
  dockerSourceTargetColumns,
  dockerSourceTargetWhere,
  type SourceBindingRow,
  type SupportedSourceProvider,
  toPublicDockerSource,
} from './docker-source-mappers.js';
import { type DockerSourceWebhookResult, DockerSourceWebhookService } from './docker-source-webhook.service.js';

export type { DockerSourceWebhookResult } from './docker-source-webhook.service.js';

const AUTOMATION_ACTOR: User = {
  id: '00000000-0000-4000-8000-000000000001',
  oidcSubject: null,
  email: 'docker-source-automation@gateway.internal',
  name: 'Docker source automation',
  avatarUrl: null,
  groupId: 'system',
  groupName: 'System',
  scopes: [
    'integrations:gitlab:projects:view',
    'integrations:gitlab:repo:read',
    'integrations:gitlab:system',
    'integrations:github:view',
    'integrations:github:system',
    'integrations:git:view',
    'integrations:git:system',
  ],
  isBlocked: false,
};

export class DockerSourceService {
  private buildService?: DockerBuildService;
  private licensePolicyService?: LicensePolicyService;
  private readonly webhooks: DockerSourceWebhookService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly integrations: IntegrationsService,
    private readonly cryptoService: CryptoService
  ) {
    this.webhooks = new DockerSourceWebhookService(
      db,
      integrations,
      cryptoService,
      () => this.buildService,
      (binding, commitSha) => this.prepareComposeCommit(binding, commitSha, AUTOMATION_ACTOR)
    );
  }

  setBuildService(buildService: DockerBuildService): void {
    this.buildService = buildService;
  }

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicyService = service;
  }

  async get(target: DockerSourceTarget) {
    const row = await this.findByTarget(target);
    return row ? toPublicDockerSource(row, await this.sourceProvider(row.connectorId)) : null;
  }

  async upsert(
    input: DockerSourceBindingUpsertInput,
    user: User,
    options: { allowMissingTarget?: boolean; initialConfig?: Record<string, unknown> | null } = {}
  ) {
    await this.requireGitPushToDeploy();
    if (!options.allowMissingTarget) await this.assertTargetExists(input.target);
    const resolved = await this.integrations.resolveDockerBuildSource(user, {
      connectorId: input.connectorId,
      projectId: input.projectId,
      branch: input.branch,
    });
    const existing = await this.findByTarget(input.target);
    const compose = await this.prepareComposeCommit(
      {
        ...(existing ?? {}),
        ...dockerSourceTargetColumns(input.target),
        connectorId: resolved.connectorId,
        projectId: resolved.projectId,
        repositoryCloneUrl: resolved.cloneUrl,
        composeFilePath: input.composeFilePath ?? existing?.composeFilePath ?? null,
        composeVariables: input.composeVariables,
        composeSecretKeys: input.composeSecretKeys,
      } as SourceBindingRow,
      resolved.commitSha,
      user
    );
    const now = new Date();
    const sourceChanged =
      !!existing && (existing.connectorId !== resolved.connectorId || existing.projectId !== resolved.projectId);
    if (sourceChanged && existing.webhookProviderId) {
      const removed = await this.integrations.removeDockerSourceWebhook({
        connectorId: existing.connectorId,
        projectId: existing.projectId,
        providerId: existing.webhookProviderId,
      });
      if (!removed) {
        throw new AppError(
          409,
          'SOURCE_WEBHOOK_CLEANUP_REQUIRED',
          'The previous repository webhook could not be removed; the source was not changed'
        );
      }
    }
    const values = {
      ...dockerSourceTargetColumns(input.target),
      connectorId: resolved.connectorId,
      projectId: resolved.projectId,
      repositoryRemoteId: resolved.remoteId,
      repositoryFullPath: resolved.fullPath,
      repositoryCloneUrl: resolved.cloneUrl,
      branch: resolved.branch,
      dockerfilePath: input.dockerfilePath,
      contextPath: input.contextPath,
      composeFilePath: input.target.kind === 'compose_project' ? input.composeFilePath : null,
      composeVariables: input.composeVariables,
      composeSecretKeys: input.composeSecretKeys,
      composeBuildPlan: compose.composeBuildPlan,
      autoBuild: input.autoBuild,
      autoDeploy: input.autoDeploy,
      initialConfig: options.initialConfig === undefined ? (existing?.initialConfig ?? null) : options.initialConfig,
      buildArgs: input.buildArgs,
      buildSecretNames: input.buildSecretNames,
      policy: input.policy,
      desiredCommitSha: resolved.commitSha,
      lastResolvedAt: now,
      lastWebhookError: null,
      ...(sourceChanged ? { webhookConfiguredAt: null, webhookProviderId: null, lastWebhookAt: null } : {}),
      updatedById: user.id,
      updatedAt: now,
    };
    const [row] = existing
      ? await this.db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-build-source:${existing.id}`}))`);
          return tx
            .update(dockerSourceBindings)
            .set(values)
            .where(eq(dockerSourceBindings.id, existing.id))
            .returning();
        })
      : await this.db
          .insert(dockerSourceBindings)
          .values({ ...values, createdById: user.id })
          .returning();

    await this.auditService.log({
      action: existing ? 'docker.source.updated' : 'docker.source.created',
      userId: user.id,
      resourceType:
        input.target.kind === 'container'
          ? 'docker-container'
          : input.target.kind === 'deployment'
            ? 'docker-deployment'
            : 'docker-compose-project',
      resourceId:
        input.target.kind === 'container'
          ? input.target.containerName
          : input.target.kind === 'deployment'
            ? input.target.deploymentId
            : input.target.composeProjectId,
      details: {
        target: input.target,
        connectorId: resolved.connectorId,
        projectId: resolved.projectId,
        repository: resolved.fullPath,
        branch: resolved.branch,
        commitSha: resolved.commitSha,
        autoBuild: input.autoBuild,
        autoDeploy: input.autoDeploy,
      },
    });
    await this.webhooks.reconcileWebhook(row).catch(async (error) => {
      await this.db
        .update(dockerSourceBindings)
        .set({ lastWebhookError: (error as Error).message.slice(0, 2048), updatedAt: new Date() })
        .where(eq(dockerSourceBindings.id, row.id));
    });
    const refreshed = await this.findByTarget(input.target);
    return toPublicDockerSource(refreshed ?? row, resolved.provider);
  }

  async remove(target: DockerSourceTarget, userId: string): Promise<boolean> {
    const existing = await this.findByTarget(target);
    if (!existing) return false;
    let webhookCleanup: 'not-configured' | 'removed' = 'not-configured';
    if (existing.webhookProviderId) {
      const removed = await this.integrations.removeDockerSourceWebhook({
        connectorId: existing.connectorId,
        projectId: existing.projectId,
        providerId: existing.webhookProviderId,
      });
      if (!removed) {
        throw new AppError(
          409,
          'SOURCE_WEBHOOK_CLEANUP_REQUIRED',
          'The repository webhook could not be removed; the source remains attached for automatic retry'
        );
      }
      webhookCleanup = 'removed';
    }
    await this.db.delete(dockerSourceBindings).where(eq(dockerSourceBindings.id, existing.id));
    await this.auditService.log({
      action: 'docker.source.deleted',
      userId,
      resourceType:
        target.kind === 'container'
          ? 'docker-container'
          : target.kind === 'deployment'
            ? 'docker-deployment'
            : 'docker-compose-project',
      resourceId:
        target.kind === 'container'
          ? target.containerName
          : target.kind === 'deployment'
            ? target.deploymentId
            : target.composeProjectId,
      details: {
        target,
        connectorId: existing.connectorId,
        projectId: existing.projectId,
        repository: existing.repositoryFullPath,
        branch: existing.branch,
        webhookCleanup,
      },
    });
    return true;
  }

  async resolveCurrent(target: DockerSourceTarget, user: User) {
    await this.requireGitPushToDeploy();
    const existing = await this.findByTarget(target);
    if (!existing) throw new AppError(404, 'SOURCE_BINDING_NOT_FOUND', 'Git source is not configured');
    const resolved = await this.integrations.resolveDockerBuildSource(user, {
      connectorId: existing.connectorId,
      projectId: existing.projectId,
      branch: existing.branch,
    });
    const compose = await this.prepareComposeCommit(existing, resolved.commitSha, user);
    const [updated] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-build-source:${existing.id}`}))`);
      return tx
        .update(dockerSourceBindings)
        .set({
          repositoryRemoteId: resolved.remoteId,
          repositoryFullPath: resolved.fullPath,
          repositoryCloneUrl: resolved.cloneUrl,
          desiredCommitSha: resolved.commitSha,
          composeBuildPlan: compose.composeBuildPlan,
          lastResolvedAt: new Date(),
          lastWebhookError: null,
          updatedAt: new Date(),
        })
        .where(eq(dockerSourceBindings.id, existing.id))
        .returning();
    });
    return toPublicDockerSource(updated, resolved.provider);
  }

  async pollDue(now = new Date(), limit = 50): Promise<{ checked: number; changed: number; failed: number }> {
    await this.requireGitPushToDeploy();
    const dueBefore = new Date(now.getTime() - 60_000);
    const rows = await this.db
      .select()
      .from(dockerSourceBindings)
      .where(
        and(
          eq(dockerSourceBindings.autoBuild, true),
          or(isNull(dockerSourceBindings.lastResolvedAt), lt(dockerSourceBindings.lastResolvedAt, dueBefore))
        )
      )
      .orderBy(asc(dockerSourceBindings.lastResolvedAt), asc(dockerSourceBindings.id))
      .limit(limit);
    let changed = 0;
    let failed = 0;
    for (const binding of rows) {
      try {
        const resolved = await this.integrations.resolveDockerBuildSource(AUTOMATION_ACTOR, {
          connectorId: binding.connectorId,
          projectId: binding.projectId,
          branch: binding.branch,
        });
        const compose = await this.prepareComposeCommit(binding, resolved.commitSha, AUTOMATION_ACTOR);
        const commitChanged = await this.db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-build-source:${binding.id}`}))`);
          const [current] = await tx
            .select({ desiredCommitSha: dockerSourceBindings.desiredCommitSha })
            .from(dockerSourceBindings)
            .where(eq(dockerSourceBindings.id, binding.id))
            .limit(1);
          if (!current) return false;
          const changed = resolved.commitSha.toLowerCase() !== current.desiredCommitSha?.toLowerCase();
          await tx
            .update(dockerSourceBindings)
            .set({
              repositoryRemoteId: resolved.remoteId,
              repositoryFullPath: resolved.fullPath,
              repositoryCloneUrl: resolved.cloneUrl,
              desiredCommitSha: resolved.commitSha,
              composeBuildPlan: compose.composeBuildPlan,
              lastResolvedAt: now,
              lastPollAt: now,
              lastPollError: null,
              updatedAt: now,
            })
            .where(eq(dockerSourceBindings.id, binding.id));
          return changed;
        });
        const shouldEnqueue =
          this.buildService &&
          (commitChanged || !(await this.buildService.hasBuildForCommit(binding.id, resolved.commitSha)));
        if (shouldEnqueue && this.buildService) {
          await this.buildService.enqueue({
            sourceBindingId: binding.id,
            commitSha: resolved.commitSha,
            trigger: 'poll',
          });
          if (commitChanged) changed += 1;
        }
      } catch (error) {
        failed += 1;
        await this.db
          .update(dockerSourceBindings)
          .set({ lastResolvedAt: now, lastPollAt: now, lastPollError: (error as Error).message.slice(0, 2048) })
          .where(eq(dockerSourceBindings.id, binding.id));
      }
    }
    return { checked: rows.length, changed, failed };
  }

  async createBuild(target: DockerSourceTarget, input: DockerBuildCreateInput, user: User) {
    await this.requireGitPushToDeploy();
    if (!this.buildService) throw new AppError(503, 'BUILD_SCHEDULER_UNAVAILABLE', 'Build scheduler is unavailable');
    const source = await this.resolveCurrent(target, user);
    if (input.commitSha && input.commitSha.toLowerCase() !== source.desiredCommitSha?.toLowerCase()) {
      throw new AppError(409, 'SOURCE_COMMIT_STALE', 'Requested commit is not the current configured branch head');
    }
    return this.buildService.enqueue({
      sourceBindingId: source.id,
      commitSha: source.desiredCommitSha!,
      trigger: 'manual',
      createdById: user.id,
      force: input.force,
    });
  }

  webhookSecret(sourceBindingId: string): string {
    return this.webhooks.webhookSecret(sourceBindingId);
  }

  async reconcileWebhooks(limit = 50): Promise<{ checked: number; configured: number; failed: number }> {
    await this.requireGitPushToDeploy();
    return this.webhooks.reconcileWebhooks(limit);
  }

  async handleWebhook(sourceBindingId: string, headers: Headers, rawBody: Buffer): Promise<DockerSourceWebhookResult> {
    await this.requireGitPushToDeploy();
    return this.webhooks.handleWebhook(sourceBindingId, headers, rawBody);
  }

  private async assertTargetExists(target: DockerSourceTarget): Promise<void> {
    if (target.kind === 'container') return;
    if (target.kind === 'deployment') {
      const [deployment] = await this.db
        .select({ id: dockerDeployments.id })
        .from(dockerDeployments)
        .where(eq(dockerDeployments.id, target.deploymentId))
        .limit(1);
      if (!deployment) throw new AppError(404, 'DEPLOYMENT_NOT_FOUND', 'Docker deployment not found');
      return;
    }
    const [project] = await this.db
      .select({ id: dockerComposeProjects.id })
      .from(dockerComposeProjects)
      .where(eq(dockerComposeProjects.id, target.composeProjectId))
      .limit(1);
    if (!project) throw new AppError(404, 'COMPOSE_PROJECT_NOT_FOUND', 'Compose project not found');
  }

  private async prepareComposeCommit(binding: SourceBindingRow, commitSha: string, user: User) {
    if (binding.targetKind !== 'compose_project') return { composeBuildPlan: binding.composeBuildPlan ?? null };
    if (!binding.composeProjectId || !binding.composeFilePath) {
      throw new AppError(400, 'COMPOSE_SOURCE_PATH_REQUIRED', 'Compose source requires a repository Compose file path');
    }
    const [project] = await this.db
      .select({ name: dockerComposeProjects.name })
      .from(dockerComposeProjects)
      .where(eq(dockerComposeProjects.id, binding.composeProjectId))
      .limit(1);
    if (!project) throw new AppError(404, 'COMPOSE_PROJECT_NOT_FOUND', 'Compose project not found');
    const file = await this.integrations.readDockerBuildSourceFile(user, {
      connectorId: binding.connectorId,
      projectId: binding.projectId,
      repositoryUrl: binding.repositoryCloneUrl,
      path: binding.composeFilePath,
      commitSha,
    });
    const prepared = prepareComposeGitBuild({
      projectName: project.name,
      yaml: file.content,
      variables: binding.composeVariables ?? {},
      secretKeys: binding.composeSecretKeys ?? [],
    });
    if (!prepared.valid) {
      throw new AppError(400, 'COMPOSE_SOURCE_INVALID', 'Repository Compose configuration is invalid', {
        diagnostics: prepared.diagnostics,
      });
    }
    return { composeBuildPlan: { sourceYaml: file.content, services: prepared.services } };
  }

  async listBuildSecrets(target: DockerSourceTarget) {
    const source = await this.findByTarget(target);
    if (!source) throw new AppError(404, 'SOURCE_BINDING_NOT_FOUND', 'Git source is not configured');
    const rows = await this.db
      .select({
        id: dockerBuildSecrets.id,
        name: dockerBuildSecrets.name,
        createdAt: dockerBuildSecrets.createdAt,
        updatedAt: dockerBuildSecrets.updatedAt,
      })
      .from(dockerBuildSecrets)
      .where(eq(dockerBuildSecrets.sourceBindingId, source.id))
      .orderBy(asc(dockerBuildSecrets.name));
    return rows;
  }

  async upsertBuildSecret(target: DockerSourceTarget, name: string, value: string, userId: string) {
    await this.requireGitPushToDeploy();
    const source = await this.findByTarget(target);
    if (!source) throw new AppError(404, 'SOURCE_BINDING_NOT_FOUND', 'Git source is not configured');
    const encryptedValue = JSON.stringify(this.cryptoService.encryptString(value));
    const now = new Date();
    const row = await this.db.transaction(async (tx) => {
      const [saved] = await tx
        .insert(dockerBuildSecrets)
        .values({ sourceBindingId: source.id, name, encryptedValue, createdById: userId, updatedById: userId })
        .onConflictDoUpdate({
          target: [dockerBuildSecrets.sourceBindingId, dockerBuildSecrets.name],
          set: { encryptedValue, updatedById: userId, updatedAt: now },
        })
        .returning({
          id: dockerBuildSecrets.id,
          name: dockerBuildSecrets.name,
          createdAt: dockerBuildSecrets.createdAt,
          updatedAt: dockerBuildSecrets.updatedAt,
        });
      const names = await tx
        .select({ name: dockerBuildSecrets.name })
        .from(dockerBuildSecrets)
        .where(eq(dockerBuildSecrets.sourceBindingId, source.id))
        .orderBy(asc(dockerBuildSecrets.name));
      await tx
        .update(dockerSourceBindings)
        .set({ buildSecretNames: names.map((item) => item.name), updatedAt: now, updatedById: userId })
        .where(eq(dockerSourceBindings.id, source.id));
      return saved;
    });
    await this.auditService.log({
      action: 'docker.build_secret.upsert',
      userId,
      resourceType: 'docker-source',
      resourceId: source.id,
      details: { name },
    });
    return row;
  }

  async deleteBuildSecret(target: DockerSourceTarget, name: string, userId: string): Promise<boolean> {
    const source = await this.findByTarget(target);
    if (!source) throw new AppError(404, 'SOURCE_BINDING_NOT_FOUND', 'Git source is not configured');
    const removed = await this.db.transaction(async (tx) => {
      const rows = await tx
        .delete(dockerBuildSecrets)
        .where(and(eq(dockerBuildSecrets.sourceBindingId, source.id), eq(dockerBuildSecrets.name, name)))
        .returning({ id: dockerBuildSecrets.id });
      if (rows.length === 0) return false;
      const names = await tx
        .select({ name: dockerBuildSecrets.name })
        .from(dockerBuildSecrets)
        .where(eq(dockerBuildSecrets.sourceBindingId, source.id))
        .orderBy(asc(dockerBuildSecrets.name));
      await tx
        .update(dockerSourceBindings)
        .set({ buildSecretNames: names.map((item) => item.name), updatedAt: new Date(), updatedById: userId })
        .where(eq(dockerSourceBindings.id, source.id));
      return true;
    });
    if (removed) {
      await this.auditService.log({
        action: 'docker.build_secret.delete',
        userId,
        resourceType: 'docker-source',
        resourceId: source.id,
        details: { name },
      });
    }
    return removed;
  }

  async getDecryptedBuildSecrets(sourceBindingId: string): Promise<Record<string, Buffer>> {
    const rows = await this.db
      .select({ name: dockerBuildSecrets.name, encryptedValue: dockerBuildSecrets.encryptedValue })
      .from(dockerBuildSecrets)
      .where(eq(dockerBuildSecrets.sourceBindingId, sourceBindingId));
    const values: Record<string, Buffer> = {};
    for (const row of rows) {
      const encrypted = JSON.parse(row.encryptedValue) as { encryptedKey: string; encryptedDek: string };
      values[row.name] = Buffer.from(this.cryptoService.decryptString(encrypted));
    }
    return values;
  }

  private async findByTarget(target: DockerSourceTarget): Promise<SourceBindingRow | null> {
    const [row] = await this.db.select().from(dockerSourceBindings).where(dockerSourceTargetWhere(target)).limit(1);
    return row ?? null;
  }

  private async sourceProvider(connectorId: string): Promise<SupportedSourceProvider> {
    const [connector] = await this.db
      .select({ provider: integrationConnectors.provider })
      .from(integrationConnectors)
      .where(eq(integrationConnectors.id, connectorId))
      .limit(1);
    if (!connector || !['gitlab', 'github', 'git'].includes(connector.provider)) {
      throw new AppError(409, 'SOURCE_CONNECTOR_UNAVAILABLE', 'Source connector is unavailable');
    }
    return connector.provider as SupportedSourceProvider;
  }

  private requireGitPushToDeploy(): Promise<void> {
    return requireConfiguredLicensePolicy(this.licensePolicyService).requireFeature('git-push-to-deploy');
  }
}
