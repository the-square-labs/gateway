import { container } from '@/container.js';
import { hasScope, hasScopeBase, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  CreateManagedDatabaseBindingSchema,
  CreateManagedDatabaseSchema,
  DeleteManagedDatabaseBindingSchema,
  ManagedDatabaseListQuerySchema,
  UpdateManagedDatabaseSchema,
} from '@/modules/databases/databases.schemas.js';
import { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import {
  DockerBuildCreateSchema,
  DockerBuildSecretNameSchema,
  DockerBuildSecretValueSchema,
  DockerSourceBindingUpsertSchema,
  PagesBuildDiscoverySchema,
} from '@/modules/docker/docker-build.schemas.js';
import {
  DockerMigrationCreateInputSchema,
  DockerMigrationPreflightInputSchema,
} from '@/modules/docker/docker-migration.schemas.js';
import { DockerMigrationService } from '@/modules/docker/docker-migration.service.js';
import { DockerSourceService } from '@/modules/docker/docker-source.service.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { LoggingRuntimeService } from '@/modules/logging/logging-runtime.service.js';
import { LoggingSettingsService } from '@/modules/logging/logging-settings.service.js';
import {
  CreatePageDeploymentSchema,
  PageDeploymentListQuerySchema,
} from '@/modules/pages/deployments/page-deployment.schemas.js';
import {
  PageDeploymentService,
  type PageDeployPrincipal,
} from '@/modules/pages/deployments/page-deployment.service.js';
import {
  CreatePageProjectSchema,
  MigratePageProjectSchema,
  PageProjectListQuerySchema,
  UpdatePageProjectSchema,
} from '@/modules/pages/page-project.schemas.js';
import { PageProjectService } from '@/modules/pages/page-project.service.js';
import { visiblePageProjectIds } from '@/modules/pages/page-project-access.js';
import { UpdatePageProfileSchema } from '@/modules/pages/profile/page-profile.schemas.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import { PageRetentionService } from '@/modules/pages/retention/page-retention.service.js';
import {
  ResetPageRuntimeConfigSchema,
  SavePageRuntimeConfigSchema,
} from '@/modules/pages/runtime-config/page-runtime-config.schemas.js';
import { PageRuntimeConfigService } from '@/modules/pages/runtime-config/page-runtime-config.service.js';
import { PagePublicationService } from '@/modules/pages/tags/page-publication.service.js';
import { MovePageTagSchema, PageTagParamSchema } from '@/modules/pages/tags/page-tag.schemas.js';
import { PageTagService } from '@/modules/pages/tags/page-tag.service.js';
import { CreatePageDeployTokenSchema } from '@/modules/pages/tokens/page-deploy-token.schemas.js';
import { PageDeployTokenService } from '@/modules/pages/tokens/page-deploy-token.service.js';
import { AdditionalRouteService } from '@/modules/proxy/additional-route.service.js';
import {
  CreateAdditionalRouteSchema,
  UpdateAdditionalRouteSchema,
} from '@/modules/proxy/additional-route.validation.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { User } from '@/types.js';

export const RESOURCE_SETUP_TOOL_NAMES = new Set([
  'upload_pages_artifact',
  'manage_pages',
  'manage_additional_route',
  'manage_additional_secure_link',
  'manage_managed_database',
  'manage_docker_migration',
  'manage_logging_backend',
]);

export async function executeResourceSetupTool(user: User, toolName: string, args: Record<string, unknown>) {
  if (toolName === 'upload_pages_artifact') return uploadPagesArtifact(user, args);
  if (toolName === 'manage_pages') return managePages(user, args);
  if (toolName === 'manage_additional_route') return manageAdditionalRoute(user, args);
  if (toolName === 'manage_additional_secure_link') return manageAdditionalSecureLink(user, args);
  if (toolName === 'manage_managed_database') return manageManagedDatabase(user, args);
  if (toolName === 'manage_docker_migration') return manageDockerMigration(user, args);
  if (toolName === 'manage_logging_backend') return manageLoggingBackend(user, args);
  throw new Error(`Unsupported resource setup tool: ${toolName}`);
}

const MCP_PAGE_UPLOAD_CHUNK_MAX_BYTES = 1024 * 1024;

async function uploadPagesArtifact(user: User, args: Record<string, unknown>) {
  const operation = requiredEnum(args.operation, ['begin', 'chunk', 'finalize'] as const);
  await container.resolve(LicensePolicyService).requireFeature('pages');
  await container.resolve(PageProfileService).requireEnabled();

  const deployments = container.resolve(PageDeploymentService);
  const principal: PageDeployPrincipal = { kind: 'user', userId: user.id, scopes: user.scopes };
  if (operation === 'begin') {
    const input = CreatePageDeploymentSchema.parse(args);
    ensureResourceScope(user, 'pages:deploy', input.projectId);
    return deployments.create(input, principal);
  }

  const uploadId = requiredString(args.uploadId);
  if (operation === 'chunk') {
    const offset = requiredNumber(args.offset);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', 'Upload offset must be a non-negative integer');
    }
    return deployments.appendChunk(
      uploadId,
      offset,
      decodeMcpPageUploadChunk(requiredString(args.contentBase64)),
      principal
    );
  }

  const stored = await deployments.finalize(uploadId, principal);
  await container.resolve(PagePublicationService).markDeploymentReady(stored.deployment.id);
  return { deployment: await deployments.get(stored.deployment.id) };
}

function decodeMcpPageUploadChunk(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new AppError(400, 'PAGES_UPLOAD_CHUNK_INVALID', 'Upload chunk must use canonical base64 encoding');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength === 0) {
    throw new AppError(400, 'PAGES_UPLOAD_CHUNK_EMPTY', 'Upload chunk cannot be empty');
  }
  if (bytes.byteLength > MCP_PAGE_UPLOAD_CHUNK_MAX_BYTES) {
    throw new AppError(413, 'PAGES_UPLOAD_CHUNK_TOO_LARGE', 'MCP upload chunks cannot exceed 1 MiB');
  }
  if (bytes.toString('base64') !== value) {
    throw new AppError(400, 'PAGES_UPLOAD_CHUNK_INVALID', 'Upload chunk must use canonical base64 encoding');
  }
  return bytes;
}

async function managePages(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  await container.resolve(LicensePolicyService).requireFeature('pages');

  const profile = container.resolve(PageProfileService);
  if (operation === 'profile_get') {
    ensureScope(user, 'pages:settings:view');
    return profile.get();
  }
  if (operation === 'profile_options') {
    ensureScope(user, 'pages:settings:view');
    return profile.getOptions();
  }
  if (operation === 'profile_configure') {
    ensureScope(user, 'pages:settings:edit');
    const input = UpdatePageProfileSchema.parse(args);
    return input.enabled ? profile.configure(input, user.id) : profile.disable(user.id);
  }
  if (operation === 'profile_disable') {
    ensureScope(user, 'pages:settings:edit');
    return profile.disable(user.id);
  }

  const readOperations = new Set([
    'project_list',
    'project_get',
    'deployment_list',
    'deployment_get',
    'tag_list',
    'token_list',
    'config_list',
    'source_get',
    'source_secret_list',
  ]);
  if (!readOperations.has(operation)) await profile.requireEnabled();

  const projects = container.resolve(PageProjectService);
  if (operation === 'project_list') {
    ensureAnyScopeBase(user, ['pages:view', 'pages:create']);
    return projects.list(PageProjectListQuerySchema.parse(args), { allowedIds: visiblePageProjectIds(user.scopes) });
  }
  if (operation === 'project_create') {
    ensureScope(user, 'pages:create');
    if (args.folderId) ensureScope(user, 'pages:folders:manage');
    return projects.create(CreatePageProjectSchema.parse(args), user.id);
  }

  const projectId = requiredString(args.projectId);
  if (operation === 'project_get') {
    ensureResourceScope(user, 'pages:view', projectId);
    return projects.get(projectId);
  }
  if (operation === 'project_update') {
    ensureResourceScope(user, 'pages:edit', projectId);
    return projects.update(projectId, UpdatePageProjectSchema.parse(args), user.id);
  }
  if (operation === 'project_migrate') {
    ensureResourceScope(user, 'pages:edit', projectId);
    return projects.migrate(projectId, MigratePageProjectSchema.parse(args), user.id);
  }
  if (operation === 'project_delete') {
    ensureResourceScope(user, 'pages:delete', projectId);
    await projects.delete(projectId, user.id);
    return { success: true };
  }

  const sourceTarget = { kind: 'pages_project' as const, pageProjectId: projectId };
  const sources = () => container.resolve(DockerSourceService);
  if (operation === 'source_get') {
    ensureResourceScope(user, 'pages:view', projectId);
    return sources().get(sourceTarget);
  }
  if (operation === 'source_repositories') {
    ensureResourceScope(user, 'pages:edit', projectId);
    return container
      .resolve(IntegrationsService)
      .listDockerBuildSourceRepositories(user, requiredString(args.sourceConnectorId));
  }
  if (operation === 'source_discover') {
    ensureResourceScope(user, 'pages:edit', projectId);
    return sources().discoverPagesBuild(
      PagesBuildDiscoverySchema.parse({
        connectorId: args.sourceConnectorId,
        projectId: args.repositoryProjectId,
        branch: args.branch,
        applicationRoot: args.applicationRoot ?? '.',
      }),
      user
    );
  }
  if (operation === 'source_upsert') {
    ensureResourceScope(user, 'pages:edit', projectId);
    return sources().upsert(
      DockerSourceBindingUpsertSchema.parse({
        target: sourceTarget,
        connectorId: args.sourceConnectorId,
        projectId: args.repositoryProjectId,
        branch: args.branch,
        applicationRoot: args.applicationRoot ?? '.',
        packageManager: args.packageManager,
        packageManagerVersion: args.packageManagerVersion,
        nodeVersion: args.nodeVersion,
        buildScript: args.buildScript,
        artifactDirectory: args.artifactDirectory,
        publishTag: args.publishTag,
        autoBuild: args.autoBuild ?? true,
        autoDeploy: args.autoDeploy ?? true,
        buildArgs: args.buildArgs ?? {},
        buildSecretNames: args.buildSecretNames ?? [],
        policy: args.policy ?? {},
      }),
      user
    );
  }
  if (operation === 'source_remove') {
    ensureResourceScope(user, 'pages:edit', projectId);
    return { success: true, removed: await sources().remove(sourceTarget, user.id) };
  }
  if (operation === 'source_build') {
    ensureResourceScope(user, 'pages:deploy', projectId);
    return sources().createBuild(
      sourceTarget,
      DockerBuildCreateSchema.parse({ commitSha: args.commitSha, force: args.force ?? false }),
      user
    );
  }
  if (operation === 'source_secret_list') {
    ensureResourceScope(user, 'pages:view', projectId);
    return sources().listBuildSecrets(sourceTarget);
  }
  if (operation === 'source_secret_upsert') {
    ensureResourceScope(user, 'pages:edit', projectId);
    const name = DockerBuildSecretNameSchema.parse(args.secretName);
    const { value } = DockerBuildSecretValueSchema.parse({ value: args.secretValue });
    return sources().upsertBuildSecret(sourceTarget, name, value, user.id);
  }
  if (operation === 'source_secret_delete') {
    ensureResourceScope(user, 'pages:edit', projectId);
    const name = DockerBuildSecretNameSchema.parse(args.secretName);
    return { success: true, removed: await sources().deleteBuildSecret(sourceTarget, name, user.id) };
  }

  if (operation === 'deployment_list') {
    ensureResourceScope(user, 'pages:view', projectId);
    return container.resolve(PageDeploymentService).list(projectId, PageDeploymentListQuerySchema.parse(args));
  }
  const deploymentId = optionalString(args.deploymentId);
  if (operation === 'deployment_get') {
    ensureResourceScope(user, 'pages:view', projectId);
    return container.resolve(PageDeploymentService).getForProject(projectId, requiredValue(deploymentId));
  }
  if (operation === 'deployment_pin') {
    ensureResourceScope(user, 'pages:deployments:manage', projectId);
    return container
      .resolve(PageRetentionService)
      .setPinned(projectId, requiredValue(deploymentId), requiredBoolean(args.pinned), user.id);
  }
  if (operation === 'deployment_delete') {
    ensureResourceScope(user, 'pages:deployments:manage', projectId);
    await container.resolve(PageRetentionService).deleteDeployment(projectId, requiredValue(deploymentId), user.id);
    return { success: true };
  }

  if (operation === 'tag_list') {
    ensureResourceScope(user, 'pages:view', projectId);
    return container.resolve(PageTagService).list(projectId);
  }
  const tag = optionalString(args.tag);
  if (operation === 'tag_move') {
    ensureResourceScope(user, 'pages:tags:manage', projectId);
    const parsed = PageTagParamSchema.parse({ projectId, tag: requiredValue(tag) });
    const move = MovePageTagSchema.parse(args);
    return container.resolve(PagePublicationService).moveUserTag(projectId, parsed.tag, move.deploymentId, user.id);
  }
  if (operation === 'tag_delete') {
    ensureResourceScope(user, 'pages:tags:manage', projectId);
    const parsed = PageTagParamSchema.parse({ projectId, tag: requiredValue(tag) });
    await container.resolve(PageTagService).delete(projectId, parsed.tag, user.id);
    return { success: true };
  }

  const tokens = container.resolve(PageDeployTokenService);
  if (operation === 'token_list') {
    ensureResourceScope(user, 'pages:tokens:manage', projectId);
    return tokens.list(projectId);
  }
  if (operation === 'token_create') {
    ensureResourceScope(user, 'pages:tokens:manage', projectId);
    return tokens.create(projectId, CreatePageDeployTokenSchema.parse(args), user.id);
  }
  if (operation === 'token_revoke') {
    ensureResourceScope(user, 'pages:tokens:manage', projectId);
    await tokens.revoke(projectId, requiredString(args.tokenId), user.id);
    return { success: true };
  }

  const configs = container.resolve(PageRuntimeConfigService);
  if (operation === 'config_list') {
    ensureResourceScope(user, 'pages:view', projectId);
    return configs.list(projectId);
  }
  if (operation === 'config_save_default') {
    ensureResourceScope(user, 'pages:edit', projectId);
    return configs.saveDefault(projectId, SavePageRuntimeConfigSchema.parse(args), user.id);
  }
  const tagId = requiredString(args.tagId);
  if (operation === 'config_save_tag') {
    ensureResourceScope(user, 'pages:edit', projectId);
    return configs.saveTag(projectId, tagId, SavePageRuntimeConfigSchema.parse(args), user.id);
  }
  if (operation === 'config_reset_tag') {
    ensureResourceScope(user, 'pages:edit', projectId);
    const input = ResetPageRuntimeConfigSchema.parse(args);
    return configs.resetTag(projectId, tagId, input.expectedGeneration, user.id);
  }
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported Pages operation: ${operation}`);
}

async function manageAdditionalRoute(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  const routeId = requiredString(args.routeId);
  const service = container.resolve(AdditionalRouteService);
  if (operation === 'list') {
    ensureResourceScope(user, 'proxy:view', routeId);
    return { data: await service.list(routeId) };
  }
  const additionalRouteId = operation === 'create' ? undefined : requiredString(args.additionalRouteId);
  if (operation === 'get') {
    ensureResourceScope(user, 'proxy:view', routeId);
    return service.present(await service.get(routeId, requiredValue(additionalRouteId)));
  }
  ensureResourceScope(user, 'proxy:edit', routeId);
  if (operation === 'create') {
    const input = CreateAdditionalRouteSchema.parse(args);
    if (input.advancedConfig !== undefined && input.advancedConfig !== null) {
      ensureResourceScope(user, 'proxy:advanced', routeId);
    }
    await requirePagesForAdditionalTarget(input);
    return service.present(await service.create(routeId, input, user.id, user.scopes));
  }
  if (operation === 'update') {
    const input = UpdateAdditionalRouteSchema.parse(args);
    if (input.advancedConfig !== undefined) ensureResourceScope(user, 'proxy:advanced', routeId);
    await requirePagesForAdditionalTarget(input);
    return service.present(
      await service.update(routeId, requiredValue(additionalRouteId), input, user.id, user.scopes)
    );
  }
  if (operation === 'retry') {
    const existing = await service.get(routeId, requiredValue(additionalRouteId));
    if (existing.targetKind === 'pages') await container.resolve(LicensePolicyService).requireFeature('pages');
    return service.present(await service.retry(routeId, existing.id, user.id, user.scopes));
  }
  if (operation === 'delete') {
    await service.remove(routeId, requiredValue(additionalRouteId), user.id);
    return { success: true };
  }
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported Additional Route operation: ${operation}`);
}

async function manageAdditionalSecureLink(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  const routeId = requiredString(args.routeId);
  const service = container.resolve(ProxyService);
  if (operation === 'list') {
    ensureResourceScope(user, 'proxy:view', routeId);
    return { data: await service.listAdditionalSecureLinks(routeId) };
  }
  ensureResourceScope(user, 'proxy:edit', routeId);
  if (operation === 'create') {
    return service.createAdditionalSecureLink(
      routeId,
      {
        name: requiredString(args.name),
        upstreamKind: requiredEnum(args.upstreamKind, ['docker_container', 'docker_deployment']),
        forwardScheme: requiredEnum(args.forwardScheme, ['http', 'https']),
        dockerNodeId: optionalString(args.dockerNodeId),
        dockerContainerName: optionalString(args.dockerContainerName),
        dockerComposeProjectId: optionalString(args.dockerComposeProjectId),
        dockerComposeServiceName: optionalString(args.dockerComposeServiceName),
        dockerDeploymentId: optionalString(args.dockerDeploymentId),
        dockerContainerPort: requiredNumber(args.dockerContainerPort),
      },
      user.id
    );
  }
  const bindingId = requiredString(args.bindingId);
  if (operation === 'retry') return service.retryAdditionalSecureLink(routeId, bindingId, user.id);
  if (operation === 'delete') {
    await service.deleteAdditionalSecureLink(routeId, bindingId, user.id);
    return { success: true };
  }
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported Additional Secure Link operation: ${operation}`);
}

async function requirePagesForAdditionalTarget(input: {
  targetKind?: string;
  pageProjectId?: string | null;
  pageTagId?: string | null;
}): Promise<void> {
  if (input.targetKind === 'pages' || input.pageProjectId != null || input.pageTagId != null) {
    await container.resolve(LicensePolicyService).requireFeature('pages');
    await container.resolve(PageProfileService).requireEnabled();
  }
}

async function manageManagedDatabase(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  const service = container.resolve(ManagedDatabaseService);
  const bindings = container.resolve(ManagedDatabaseBindingService);

  if (operation === 'catalog') {
    ensureScope(user, 'databases:view');
    return service.listCatalog();
  }
  if (operation === 'list') {
    ensureScope(user, 'databases:view');
    return service.list(ManagedDatabaseListQuerySchema.parse({ nodeId: args.nodeId, type: args.type }));
  }
  if (operation === 'create') {
    ensureScope(user, 'databases:create');
    return service.create(CreateManagedDatabaseSchema.parse(args), user.id);
  }

  const databaseId = requiredString(args.databaseId);
  if (operation === 'get') {
    ensureResourceScope(user, 'databases:view', databaseId);
    return service.get(databaseId);
  }
  if (operation === 'update') {
    ensureResourceScope(user, 'databases:edit', databaseId);
    return service.update(databaseId, UpdateManagedDatabaseSchema.parse(args), user.id);
  }
  if (operation === 'retry') {
    ensureResourceScope(user, 'databases:edit', databaseId);
    return service.retryProvisioning(databaseId, user.id);
  }
  if (operation === 'restart') {
    ensureResourceScope(user, 'databases:edit', databaseId);
    return service.restart(databaseId, user.id);
  }
  if (operation === 'pause') {
    ensureResourceScope(user, 'databases:edit', databaseId);
    return service.pause(databaseId, user.id);
  }
  if (operation === 'unpause') {
    ensureResourceScope(user, 'databases:edit', databaseId);
    return service.unpause(databaseId, user.id);
  }
  if (operation === 'rotate_certificate') {
    ensureResourceScope(user, 'databases:edit', databaseId);
    return service.rotateCertificate(databaseId, user.id);
  }
  if (operation === 'delete') {
    ensureResourceScope(user, 'databases:delete', databaseId);
    return service.delete(databaseId, user.id);
  }
  if (operation === 'list_bindings') {
    ensureResourceScope(user, 'databases:view', databaseId);
    return bindings.list(databaseId);
  }
  if (operation === 'create_binding') {
    ensureResourceScope(user, 'databases:edit', databaseId);
    const input = CreateManagedDatabaseBindingSchema.parse(args);
    ensureBindingTargetScopes(user, input);
    return bindings.create(databaseId, input, user.id);
  }
  if (operation === 'delete_binding') {
    ensureResourceScope(user, 'databases:delete', databaseId);
    const bindingId = requiredString(args.bindingId);
    ensureBindingTargetScopes(user, await bindings.getTarget(databaseId, bindingId));
    return bindings.delete(databaseId, bindingId, user.id, DeleteManagedDatabaseBindingSchema.parse(args));
  }
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported managed database operation: ${operation}`);
}

async function manageDockerMigration(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  const service = container.resolve(DockerMigrationService);
  if (operation === 'preflight') {
    ensureScope(user, 'docker:containers:migrate');
    return service.preflightMigration(DockerMigrationPreflightInputSchema.parse(args), user.scopes);
  }
  if (operation === 'start') {
    ensureScope(user, 'docker:containers:migrate');
    return service.create(DockerMigrationCreateInputSchema.parse(args), user.id, user.scopes);
  }
  const migrationId = requiredString(args.migrationId);
  if (operation === 'get') {
    ensureScope(user, 'docker:tasks');
    return service.get(migrationId, user.scopes);
  }
  if (operation === 'cancel') {
    ensureScope(user, 'docker:tasks:manage');
    return service.cancel(migrationId, user.id, user.scopes);
  }
  if (operation === 'retry_cleanup') {
    ensureScope(user, 'docker:tasks:manage');
    return service.retryCleanup(migrationId, user.id, user.scopes);
  }
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported Docker migration operation: ${operation}`);
}

async function manageLoggingBackend(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  if (operation === 'get') {
    ensureScope(user, 'settings:gateway:view');
    return container.resolve(LoggingSettingsService).getPublicConfig();
  }
  ensureScope(user, 'settings:gateway:edit');
  const runtime = container.resolve(LoggingRuntimeService);
  if (operation === 'enable_local') return runtime.update({ mode: 'local' });
  if (operation === 'configure_external') {
    return runtime.update({
      mode: 'external',
      url: requiredString(args.url),
      username: requiredString(args.username),
      password: requiredString(args.password),
      database: optionalString(args.database),
      table: optionalString(args.table),
      requestTimeoutMs: optionalNumber(args.requestTimeoutMs),
    });
  }
  if (operation === 'disable') return runtime.update({ mode: 'disabled' });
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported logging backend operation: ${operation}`);
}

function ensureBindingTargetScopes(
  user: User,
  target: {
    targetType: 'container' | 'deployment' | 'compose_service';
    targetNodeId: string;
    targetResourceId: string;
  }
) {
  const scopes =
    target.targetType === 'compose_service'
      ? ['docker:compose:manage']
      : target.targetType === 'deployment'
        ? ['docker:containers:edit', 'docker:containers:manage', 'docker:containers:secrets']
        : ['docker:containers:environment', 'docker:containers:secrets'];
  const targetResourceId =
    target.targetType === 'compose_service'
      ? target.targetResourceId.split(':', 1)[0] || target.targetResourceId
      : target.targetResourceId;
  for (const scope of scopes) {
    if (!hasDockerResourceScope(user.scopes, scope, target.targetNodeId, targetResourceId)) {
      throw new AppError(
        403,
        'FORBIDDEN',
        `Missing required scope: ${scope}:${target.targetNodeId}/${targetResourceId}`
      );
    }
  }
}

function ensureScope(user: User, scope: string) {
  if (!hasScope(user.scopes, scope)) throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}`);
}

function ensureResourceScope(user: User, scope: string, resourceId: string) {
  if (!hasScopeForResource(user.scopes, scope, resourceId)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}:${resourceId}`);
  }
}

function ensureAnyScopeBase(user: User, scopes: string[]) {
  if (!scopes.some((scope) => hasScopeBase(user.scopes, scope))) {
    throw new AppError(403, 'FORBIDDEN', `Missing one of required scopes: ${scopes.join(', ')}`);
  }
}

function requiredString(value: unknown): string {
  const text = optionalString(value);
  if (!text) throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', 'Required value is missing');
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requiredNumber(value: unknown): number {
  const number = optionalNumber(value);
  if (number === undefined) throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', 'Required number is missing');
  return number;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', 'Required boolean is missing');
  return value;
}

function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', 'Required value is missing');
  return value;
}

function requiredEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', `Expected one of: ${values.join(', ')}`);
  }
  return value as T[number];
}
