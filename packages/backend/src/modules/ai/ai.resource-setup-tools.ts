import { container } from '@/container.js';
import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import {
  getResourceScopedIds,
  hasScope,
  hasScopeBase,
  hasScopeForCreation,
  hasScopeForResource,
} from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { UpdateAuthProvisioningSettingsSchema } from '@/modules/admin/admin.schemas.js';
import { updateGatewaySettings } from '@/modules/admin/gateway-settings.js';
import { DatabaseFolderService } from '@/modules/databases/database-folders.service.js';
import {
  CreateManagedDatabaseBindingSchema,
  CreateManagedDatabaseSchema,
  DeleteManagedDatabaseBindingSchema,
  ManagedDatabaseListQuerySchema,
  UpdateManagedDatabaseSchema,
} from '@/modules/databases/databases.schemas.js';
import { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import {
  DockerBuildCreateSchema,
  DockerBuildSecretNameSchema,
  DockerBuildSecretValueSchema,
  DockerSourceBindingUpsertSchema,
  PagesBuildDiscoverySchema,
} from '@/modules/docker/docker-build.schemas.js';
import {
  DockerMigrationCreateInputSchema,
  DockerMigrationListQuerySchema,
  DockerMigrationPreflightInputSchema,
  DockerMigrationResolveInputSchema,
} from '@/modules/docker/docker-migration.schemas.js';
import { DockerMigrationService } from '@/modules/docker/docker-migration.service.js';
import { DockerSourceService } from '@/modules/docker/docker-source.service.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
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
import { canAccessPageProject, visiblePageProjectIds } from '@/modules/pages/page-project-access.js';
import { PageProjectFolderService } from '@/modules/pages/page-project-folder.service.js';
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
import { redactAdditionalRouteForScopes } from '@/modules/proxy/page-target-visibility.js';
import { CreateAdditionalSecureLinkSchema } from '@/modules/proxy/proxy.schemas.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { User } from '@/types.js';
import { assertWorkloadBindingTargetAccess } from './ai.binding-target-access.js';
import {
  ensureManagedDatabaseScopes,
  MANAGED_DATABASE_ACCESS_OPERATIONS,
  manageManagedDatabaseAccess,
} from './ai.database-tools.js';

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
    'project_get_by_slug',
    'project_placement_options',
    'source_repositories',
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
    const input = CreatePageProjectSchema.parse(args);
    if (!hasScopeForCreation(user.scopes, 'pages:create', input.folderId, input.nodeId)) {
      throw new AppError(403, 'FORBIDDEN', 'Missing pages:create permission for the selected destination');
    }
    await container.resolve(PageProjectFolderService).assertFolderExists(input.folderId);
    return projects.create(input, user.id);
  }
  if (operation === 'project_placement_options') {
    // GET /projects/placement-options: nodes a Project can be created on or moved to.
    ensureAnyScopeBase(user, ['pages:create', 'pages:edit']);
    const canUseAnyPlacement =
      hasScope(user.scopes, 'pages:create') ||
      hasScope(user.scopes, 'pages:edit') ||
      getFolderScopedIds(user.scopes, ['pages:create']).length > 0;
    return canUseAnyPlacement
      ? projects.placementOptions()
      : projects.placementOptions({ allowedNodeIds: getResourceScopedIds(user.scopes, 'pages:create') });
  }
  if (operation === 'project_get_by_slug') {
    const project = await projects.getBySlug(requiredString(args.slug));
    if (!canAccessPageProject(user.scopes, 'pages:view', project.id)) {
      throw new AppError(403, 'PAGE_PROJECT_FORBIDDEN', 'Missing pages:view for this Project');
    }
    return project;
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
    const input = MigratePageProjectSchema.parse(args);
    // Like POST /projects/:id/migrate: moving a Project onto a node needs pages:create for that node.
    const project = await projects.get(projectId);
    if (!hasScopeForCreation(user.scopes, 'pages:create', project.folderId, input.targetNodeId)) {
      throw new AppError(403, 'PAGE_PROJECT_FORBIDDEN', 'Missing pages:create permission for the target node');
    }
    return projects.migrate(projectId, input, user.id);
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
    ensureResourceScope(user, 'pages:deploy', projectId);
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
  // Same view the Additional Route endpoints return: advanced config and Pages fields follow the caller scopes.
  const visible = (row: unknown) => redactAdditionalRouteForScopes(row as Record<string, unknown>, user.scopes);
  if (operation === 'list') {
    ensureResourceScope(user, 'proxy:view', routeId);
    return { data: (await service.list(routeId)).map(visible) };
  }
  const additionalRouteId = operation === 'create' ? undefined : requiredString(args.additionalRouteId);
  if (operation === 'get') {
    ensureResourceScope(user, 'proxy:view', routeId);
    return visible(await service.present(await service.get(routeId, requiredValue(additionalRouteId))));
  }
  ensureResourceScope(user, 'proxy:edit', routeId);
  if (operation === 'create') {
    const input = CreateAdditionalRouteSchema.parse(args);
    if (input.advancedConfig !== undefined) ensureResourceScope(user, 'proxy:advanced', routeId);
    await requirePagesForAdditionalTarget(input);
    return visible(await service.present(await service.create(routeId, input, user.id, user.scopes)));
  }
  if (operation === 'update') {
    const input = UpdateAdditionalRouteSchema.parse(args);
    await requirePagesForAdditionalTarget(input);
    if (input.advancedConfig !== undefined) ensureResourceScope(user, 'proxy:advanced', routeId);
    return visible(
      await service.present(
        await service.update(routeId, requiredValue(additionalRouteId), input, user.id, user.scopes)
      )
    );
  }
  if (operation === 'retry') {
    const existing = await service.get(routeId, requiredValue(additionalRouteId));
    if (existing.targetKind === 'pages') await container.resolve(LicensePolicyService).requireFeature('pages');
    return visible(await service.present(await service.retry(routeId, existing.id, user.id, user.scopes)));
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
      CreateAdditionalSecureLinkSchema.parse({
        name: args.name,
        upstreamKind: args.upstreamKind,
        managedStorageId: args.managedStorageId,
        forwardScheme: args.forwardScheme,
        dockerNodeId: args.dockerNodeId,
        dockerContainerName: args.dockerContainerName,
        dockerComposeProjectId: args.dockerComposeProjectId,
        dockerComposeServiceName: args.dockerComposeServiceName,
        dockerDeploymentId: args.dockerDeploymentId,
        dockerContainerPort: args.dockerContainerPort,
      }),
      user.id,
      user.scopes
    );
  }
  const bindingId = requiredString(args.bindingId);
  if (operation === 'retry') return service.retryAdditionalSecureLink(routeId, bindingId, user.id, user.scopes);
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
  // LICENSE ENFORCEMENT: same gate as every /api/databases route.
  await container.resolve(LicensePolicyService).requireFeature('external-database-connections');
  if (MANAGED_DATABASE_ACCESS_OPERATIONS.has(operation)) return manageManagedDatabaseAccess(user, operation, args);
  const service = container.resolve(ManagedDatabaseService);
  const bindings = container.resolve(ManagedDatabaseBindingService);

  if (operation === 'catalog') {
    ensureAnyScopeBase(user, ['databases:view']);
    return service.listCatalog();
  }
  if (operation === 'list') {
    // Same visibility as GET /databases/managed: scoped grants name the canonical connection.
    ensureAnyScopeBase(user, ['databases:view']);
    const rows = await service.list(ManagedDatabaseListQuerySchema.parse({ nodeId: args.nodeId, type: args.type }));
    if (hasScope(user.scopes, 'databases:view')) return rows;
    const allowedIds = new Set(getResourceScopedIds(user.scopes, 'databases:view'));
    return rows.filter((row) => allowedIds.has(row.databaseConnectionId ?? ''));
  }
  if (operation === 'create') {
    const input = CreateManagedDatabaseSchema.parse(args);
    if (!hasScopeForCreation(user.scopes, 'databases:create', input.folderId, input.nodeId)) {
      throw new AppError(403, 'FORBIDDEN', 'Missing databases:create permission for the selected destination');
    }
    await container.resolve(DatabaseFolderService).assertFolderExists(input.folderId);
    return service.create(input, user.id);
  }

  const databaseId = requiredString(args.databaseId);
  if (operation === 'get') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:view');
    return service.get(databaseId);
  }
  if (operation === 'update') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    return service.update(databaseId, UpdateManagedDatabaseSchema.parse(args), user.id);
  }
  if (operation === 'retry') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    return service.retryProvisioning(databaseId, user.id);
  }
  if (operation === 'restart') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    return service.restart(databaseId, user.id);
  }
  if (operation === 'pause') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    return service.pause(databaseId, user.id);
  }
  if (operation === 'unpause') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    return service.unpause(databaseId, user.id);
  }
  if (operation === 'rotate_certificate') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    return service.rotateCertificate(databaseId, user.id);
  }
  if (operation === 'delete') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:delete');
    return service.delete(databaseId, user.id);
  }
  if (operation === 'list_bindings') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:view');
    return bindings.list(databaseId);
  }
  if (operation === 'create_binding') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    const input = CreateManagedDatabaseBindingSchema.parse(args);
    await assertWorkloadBindingTargetAccess(user.scopes, input);
    return bindings.create(databaseId, input, user.id);
  }
  if (operation === 'delete_binding') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:delete');
    const bindingId = requiredString(args.bindingId);
    await assertWorkloadBindingTargetAccess(user.scopes, await bindings.getTarget(databaseId, bindingId));
    return bindings.delete(databaseId, bindingId, user.id, DeleteManagedDatabaseBindingSchema.parse(args));
  }
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported managed database operation: ${operation}`);
}

/**
 * Mirrors the Docker migration routes: preflight and start are authorized by the
 * service against source, target and dependencies (docker:containers:migrate);
 * list and get need docker:tasks, cancel, retry_cleanup and resolve need
 * docker:tasks:manage, and the service narrows every one to the migration nodes.
 */
async function manageDockerMigration(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  const service = container.resolve(DockerMigrationService);
  if (operation === 'preflight') {
    ensureAnyScopeBase(user, ['docker:containers:migrate']);
    return service.preflightMigration(DockerMigrationPreflightInputSchema.parse(args), user.scopes);
  }
  if (operation === 'start') {
    ensureAnyScopeBase(user, ['docker:containers:migrate']);
    return service.create(DockerMigrationCreateInputSchema.parse(args), user.id, user.scopes);
  }
  if (operation === 'list') {
    ensureAnyScopeBase(user, ['docker:tasks']);
    return service.list(
      user.scopes,
      DockerMigrationListQuerySchema.parse({ status: args.status, nodeId: args.nodeId, limit: args.limit })
    );
  }
  const migrationId = requiredString(args.migrationId);
  if (operation === 'get') {
    ensureAnyScopeBase(user, ['docker:tasks']);
    return service.get(migrationId, user.scopes);
  }
  if (operation === 'cancel') {
    ensureAnyScopeBase(user, ['docker:tasks:manage']);
    return service.cancel(migrationId, user.id, user.scopes);
  }
  if (operation === 'retry_cleanup') {
    ensureAnyScopeBase(user, ['docker:tasks:manage']);
    return service.retryCleanup(migrationId, user.id, user.scopes);
  }
  if (operation === 'resolve') {
    ensureAnyScopeBase(user, ['docker:tasks:manage']);
    return service.resolve(
      migrationId,
      DockerMigrationResolveInputSchema.parse({ authoritativeSide: args.authoritativeSide }),
      user.id,
      user.scopes
    );
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
  const logging =
    operation === 'enable_local'
      ? { mode: 'local' }
      : operation === 'disable'
        ? { mode: 'disabled' }
        : operation === 'configure_external'
          ? {
              mode: 'external',
              url: requiredString(args.url),
              username: requiredString(args.username),
              password: requiredString(args.password),
              database: optionalString(args.database),
              table: optionalString(args.table),
              requestTimeoutMs: optionalNumber(args.requestTimeoutMs),
            }
          : null;
  if (!logging) {
    throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported logging backend operation: ${operation}`);
  }
  // Same path as PUT /admin/auth-settings { logging }: schema, audit record, and settings change event.
  const input = UpdateAuthProvisioningSettingsSchema.parse({ logging });
  return (await updateGatewaySettings({ user, scopes: user.scopes }, input)).logging;
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
