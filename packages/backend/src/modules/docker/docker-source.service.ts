import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerBuildSecrets,
  dockerComposeProjects,
  dockerDeployments,
  dockerSourceBindings,
  integrationConnectors,
  pageProjects,
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
  PagesBuildDiscoveryInput,
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
      (binding, commitSha) => this.prepareSourceCommit(binding, commitSha, AUTOMATION_ACTOR)
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
    await this.requireTargetFeatures(input.target);
    if (!options.allowMissingTarget) await this.assertTargetExists(input.target);
    const resolved = await this.integrations.resolveDockerBuildSource(user, {
      connectorId: input.connectorId,
      projectId: input.projectId,
      branch: input.branch,
    });
    const existing = await this.findByTarget(input.target);
    const prepared = await this.prepareSourceCommit(
      {
        ...(existing ?? {}),
        ...dockerSourceTargetColumns(input.target),
        connectorId: resolved.connectorId,
        projectId: resolved.projectId,
        repositoryCloneUrl: resolved.cloneUrl,
        composeFilePath: input.composeFilePath ?? existing?.composeFilePath ?? null,
        composeVariables: input.composeVariables,
        composeSecretKeys: input.composeSecretKeys,
        applicationRoot: input.applicationRoot ?? '.',
        packageManager: input.packageManager ?? null,
        packageManagerVersion: input.packageManagerVersion ?? null,
        nodeVersion: input.nodeVersion ?? null,
        buildScript: input.buildScript ?? null,
        artifactDirectory: input.artifactDirectory ?? null,
        publishTag: input.publishTag ?? null,
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
      composeBuildPlan: prepared.composeBuildPlan,
      autoBuild: input.autoBuild,
      autoDeploy: input.autoDeploy,
      initialConfig: options.initialConfig === undefined ? (existing?.initialConfig ?? null) : options.initialConfig,
      buildArgs: input.buildArgs,
      buildSecretNames: input.buildSecretNames,
      applicationRoot: input.target.kind === 'pages_project' ? (input.applicationRoot ?? '.') : '.',
      packageManager: input.target.kind === 'pages_project' ? input.packageManager : null,
      packageManagerVersion: input.target.kind === 'pages_project' ? (input.packageManagerVersion ?? null) : null,
      nodeVersion: input.target.kind === 'pages_project' ? input.nodeVersion : null,
      buildScript: input.target.kind === 'pages_project' ? input.buildScript : null,
      artifactDirectory: input.target.kind === 'pages_project' ? input.artifactDirectory : null,
      publishTag: input.target.kind === 'pages_project' ? input.publishTag : null,
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
      resourceType: this.targetResourceType(input.target),
      resourceId: this.targetResourceId(input.target),
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
      resourceType: this.targetResourceType(target),
      resourceId: this.targetResourceId(target),
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
    await this.requireTargetFeatures(target);
    const existing = await this.findByTarget(target);
    if (!existing) throw new AppError(404, 'SOURCE_BINDING_NOT_FOUND', 'Git source is not configured');
    const resolved = await this.integrations.resolveDockerBuildSource(user, {
      connectorId: existing.connectorId,
      projectId: existing.projectId,
      branch: existing.branch,
    });
    const prepared = await this.prepareSourceCommit(existing, resolved.commitSha, user);
    const [updated] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-build-source:${existing.id}`}))`);
      return tx
        .update(dockerSourceBindings)
        .set({
          repositoryRemoteId: resolved.remoteId,
          repositoryFullPath: resolved.fullPath,
          repositoryCloneUrl: resolved.cloneUrl,
          desiredCommitSha: resolved.commitSha,
          composeBuildPlan: prepared.composeBuildPlan,
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
        const prepared = await this.prepareSourceCommit(binding, resolved.commitSha, AUTOMATION_ACTOR);
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
              composeBuildPlan: prepared.composeBuildPlan,
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
    await this.requireTargetFeatures(target);
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
    if (target.kind === 'compose_project') {
      const [project] = await this.db
        .select({ id: dockerComposeProjects.id })
        .from(dockerComposeProjects)
        .where(eq(dockerComposeProjects.id, target.composeProjectId))
        .limit(1);
      if (!project) throw new AppError(404, 'COMPOSE_PROJECT_NOT_FOUND', 'Compose project not found');
      return;
    }
    const [project] = await this.db
      .select({ id: pageProjects.id })
      .from(pageProjects)
      .where(eq(pageProjects.id, target.pageProjectId))
      .limit(1);
    if (!project) throw new AppError(404, 'PAGE_PROJECT_NOT_FOUND', 'Page Project not found');
  }

  async discoverPagesBuild(input: PagesBuildDiscoveryInput, user: User) {
    await this.requireGitPushToDeploy();
    await requireConfiguredLicensePolicy(this.licensePolicyService).requireFeature('pages');
    const resolved = await this.integrations.resolveDockerBuildSource(user, {
      connectorId: input.connectorId,
      projectId: input.projectId,
      branch: input.branch,
    });
    const packagePath = input.applicationRoot === '.' ? 'package.json' : `${input.applicationRoot}/package.json`;
    const file = await this.integrations.readDockerBuildSourceFile(user, {
      connectorId: resolved.connectorId,
      projectId: resolved.projectId,
      repositoryUrl: resolved.cloneUrl,
      path: packagePath,
      commitSha: resolved.commitSha,
    });
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(file.content) as Record<string, unknown>;
    } catch {
      throw new AppError(400, 'PAGES_PACKAGE_JSON_INVALID', `${packagePath} is not valid JSON`);
    }
    const rawScripts = manifest.scripts;
    const scripts =
      rawScripts && typeof rawScripts === 'object' && !Array.isArray(rawScripts)
        ? Object.fromEntries(
            Object.entries(rawScripts)
              .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
              .sort(([left], [right]) => left.localeCompare(right))
          )
        : {};
    const managers = new Set<'npm' | 'pnpm' | 'yarn'>();
    let packageManagerVersion: string | null = null;
    const declaredManager = typeof manifest.packageManager === 'string' ? manifest.packageManager.trim() : '';
    const declared = /^(npm|pnpm|yarn)@([^\s]+)$/.exec(declaredManager);
    if (declared) {
      managers.add(declared[1] as 'npm' | 'pnpm' | 'yarn');
      packageManagerVersion = declared[2];
    }
    for (const [name, manager] of [
      ['package-lock.json', 'npm'],
      ['npm-shrinkwrap.json', 'npm'],
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
    ] as const) {
      const path = input.applicationRoot === '.' ? name : `${input.applicationRoot}/${name}`;
      try {
        await this.integrations.readDockerBuildSourceFile(user, {
          connectorId: resolved.connectorId,
          projectId: resolved.projectId,
          repositoryUrl: resolved.cloneUrl,
          path,
          commitSha: resolved.commitSha,
        });
        managers.add(manager);
      } catch (error) {
        if (error instanceof AppError && error.code === 'COMPOSE_FILE_TOO_LARGE') {
          managers.add(manager);
          continue;
        }
        if (!(error instanceof AppError) || error.statusCode !== 404) throw error;
      }
    }
    return {
      commitSha: resolved.commitSha,
      packagePath,
      scripts,
      packageManagers: [...managers],
      preferredPackageManager: declared?.[1] ?? (managers.size === 1 ? [...managers][0] : null),
      packageManagerVersion,
    };
  }

  private async prepareSourceCommit(binding: SourceBindingRow, commitSha: string, user: User) {
    if (binding.targetKind === 'pages_project') {
      if (!binding.buildScript) {
        throw new AppError(400, 'PAGES_BUILD_SCRIPT_REQUIRED', 'Pages source requires a package.json build script');
      }
      const packagePath = binding.applicationRoot === '.' ? 'package.json' : `${binding.applicationRoot}/package.json`;
      const file = await this.integrations.readDockerBuildSourceFile(user, {
        connectorId: binding.connectorId,
        projectId: binding.projectId,
        repositoryUrl: binding.repositoryCloneUrl,
        path: packagePath,
        commitSha,
      });
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(file.content) as Record<string, unknown>;
      } catch {
        throw new AppError(400, 'PAGES_PACKAGE_JSON_INVALID', `${packagePath} is not valid JSON`);
      }
      const scripts = manifest.scripts;
      if (
        !scripts ||
        typeof scripts !== 'object' ||
        Array.isArray(scripts) ||
        typeof (scripts as Record<string, unknown>)[binding.buildScript] !== 'string'
      ) {
        throw new AppError(
          400,
          'PAGES_BUILD_SCRIPT_NOT_FOUND',
          `Script ${binding.buildScript} is not present in ${packagePath}`
        );
      }
      return { composeBuildPlan: null };
    }
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
    if (source.targetKind === 'pages_project' && name.startsWith('VITE_')) {
      throw new AppError(
        400,
        'PAGES_PUBLIC_VARIABLE_CANNOT_BE_SECRET',
        'VITE_* values are public build variables and cannot be stored as secrets'
      );
    }
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

  private async requireTargetFeatures(target: DockerSourceTarget): Promise<void> {
    await this.requireGitPushToDeploy();
    if (target.kind === 'pages_project') {
      await requireConfiguredLicensePolicy(this.licensePolicyService).requireFeature('pages');
    }
  }

  private targetResourceType(target: DockerSourceTarget): string {
    return target.kind === 'container'
      ? 'docker-container'
      : target.kind === 'deployment'
        ? 'docker-deployment'
        : target.kind === 'compose_project'
          ? 'docker-compose-project'
          : 'page-project';
  }

  private targetResourceId(target: DockerSourceTarget): string {
    return target.kind === 'container'
      ? target.containerName
      : target.kind === 'deployment'
        ? target.deploymentId
        : target.kind === 'compose_project'
          ? target.composeProjectId
          : target.pageProjectId;
  }
}
