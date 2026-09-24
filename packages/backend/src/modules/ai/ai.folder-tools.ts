import { container } from '@/container.js';
import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import {
  getResourceScopedIds,
  hasScope,
  hasScopeBase,
  hasScopeForCreation,
  hasScopeForResource,
} from '@/lib/permissions.js';
import { AdminUserFolderService } from '@/modules/admin/admin-user-folders.service.js';
import { DatabaseFolderService } from '@/modules/databases/database-folders.service.js';
import {
  DockerAccessResourceService,
  hasDockerResourceScope,
} from '@/modules/docker/docker-access-resource.service.js';
import { dockerFolderTreeOptions } from '@/modules/docker/docker-folder.routes.js';
import {
  CreateDockerFolderSchema,
  DockerFolderResourceTypeSchema,
  MoveDockerResourcesToFolderSchema,
  ReorderDockerFoldersSchema,
  ReorderDockerResourcesSchema,
} from '@/modules/docker/docker-folder.schemas.js';
import { DockerFolderService } from '@/modules/docker/docker-folder.service.js';
import { DockerNetworkAccessResourceService } from '@/modules/docker/docker-network-access-resource.service.js';
import { DomainFolderService } from '@/modules/domains/domain-folders.service.js';
import { PermissionGroupFolderService } from '@/modules/groups/permission-group-folders.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { LoggingEnvironmentFolderService } from '@/modules/logging/logging-environment-folders.service.js';
import { LoggingSchemaFolderService } from '@/modules/logging/logging-schema-folders.service.js';
import { NodeFolderService } from '@/modules/nodes/node-folders.service.js';
import { ObjectStorageFolderService } from '@/modules/object-storage/object-storage-folders.service.js';
import { visiblePageProjectIds } from '@/modules/pages/page-project-access.js';
import { PageProjectFolderService } from '@/modules/pages/page-project-folder.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import { MoveHostsToFolderSchema, ReorderHostsSchema } from '@/modules/proxy/folder.schemas.js';
import { FolderService } from '@/modules/proxy/folder.service.js';
import { stripFolderTreeRawProxyConfigForProgrammaticResponse } from '@/modules/proxy/raw-visibility.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import type { FolderedResourceService } from '@/modules/resource-folders/resource-folder.service.js';
import { SSLCertificateFolderService } from '@/modules/ssl/ssl-certificate-folders.service.js';
import type { User } from '@/types.js';
import { allowedResourceIdsForScopes } from './ai.service-helpers.js';

export const FOLDER_TOOL_NAMES = new Set(['list_resource_folders', 'manage_resource_folder']);

type ResourceType =
  | 'nodes'
  | 'databases'
  | 'storage'
  | 'domains'
  | 'ssl_certificates'
  | 'logging_environments'
  | 'logging_schemas'
  | 'admin_users'
  | 'permission_groups'
  | 'routes'
  | 'docker'
  | 'pages';

type GenericFolderConfig = {
  service: FolderedResourceService;
  viewScope: string;
  manageScope: string;
  /** Per-resource scope a whole-folder move must hold for every moved resource and the destination. */
  moveEditScope?: string;
  /** Scope the HTTP move-resources route requires on every moved resource and on the destination. */
  resourceMoveScope: string;
  /** Creation scope that also lets the HTTP folder list route show every folder. */
  createScope?: string;
  /** Folder-scoped grants of these scopes reveal their folders to resource-scoped callers. */
  folderGrantScopes?: readonly string[];
  /** Per-resource scope the HTTP reorder route requires on every reordered resource. */
  reorderItemScope?: string;
  /** Resource ids visible to a caller without broad view access; defaults to viewScope grants. */
  visibleResourceIds?: (scopes: string[]) => string[] | undefined;
};

/** Per-resource scope the HTTP Docker folder routes require to move or reorder a resource. */
const DOCKER_MOVE_SCOPE_BY_RESOURCE_TYPE = {
  container: 'docker:containers:edit',
  image: 'docker:images:delete',
  volume: 'docker:volumes:delete',
  network: 'docker:networks:edit',
  compose: 'docker:compose:manage',
} as const;

async function ensureDockerResourceMoveScopes(
  user: User,
  resourceType: keyof typeof DOCKER_MOVE_SCOPE_BY_RESOURCE_TYPE,
  items: ReadonlyArray<{ nodeId: string; resourceKey: string }>
) {
  const moveScope = DOCKER_MOVE_SCOPE_BY_RESOURCE_TYPE[resourceType];
  for (const item of items) {
    let resourceId: string | null = item.resourceKey;
    if (resourceType === 'container') {
      resourceId = await container
        .resolve(DockerAccessResourceService)
        .resolveResourceByName(item.nodeId, item.resourceKey);
    } else if (resourceType === 'network') {
      resourceId = await container
        .resolve(DockerNetworkAccessResourceService)
        .resolveNetwork(item.nodeId, item.resourceKey);
    }
    if (!resourceId || !hasDockerResourceScope(user.scopes, moveScope, item.nodeId, resourceId)) {
      throw new Error(`Missing required scope: ${moveScope}`);
    }
  }
}

function resourceTypeArg(value: unknown): ResourceType {
  if (
    value === 'nodes' ||
    value === 'databases' ||
    value === 'storage' ||
    value === 'domains' ||
    value === 'ssl_certificates' ||
    value === 'logging_environments' ||
    value === 'logging_schemas' ||
    value === 'admin_users' ||
    value === 'permission_groups' ||
    value === 'routes' ||
    value === 'docker' ||
    value === 'pages'
  ) {
    return value;
  }
  throw new Error(`Unsupported folder resourceType: ${String(value)}`);
}

function operationArg(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error('operation is required');
}

function folderIdArg(args: Record<string, unknown>): string {
  if (typeof args.folderId === 'string' && args.folderId) return args.folderId;
  throw new Error('folderId is required for this folder operation');
}

function ensureScope(user: User, scope: string) {
  if (!hasScope(user.scopes, scope)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${scope}`);
  }
}

function ensureScopeForResource(user: User, scope: string, resourceId: string) {
  if (!hasScopeForResource(user.scopes, scope, resourceId)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${scope}:${resourceId}`);
  }
}

/**
 * Moving resources into a folder mirrors the HTTP move routes: the caller must
 * be allowed to edit every moved resource and to place resources in the
 * destination, because folder-scoped grants on the destination then extend to them.
 */
function ensureResourceMoveAccess(
  user: User,
  editScope: string,
  resourceIds: readonly string[],
  folderId: string | null | undefined
) {
  for (const resourceId of resourceIds) ensureScopeForResource(user, editScope, resourceId);
  if (!hasScopeForCreation(user.scopes, editScope, folderId ?? null)) {
    throw new Error(`PERMISSION_DENIED: Missing ${editScope} for the move destination`);
  }
}

function genericConfig(resourceType: Exclude<ResourceType, 'routes' | 'docker'>): GenericFolderConfig {
  switch (resourceType) {
    case 'nodes':
      return {
        service: container.resolve(NodeFolderService),
        viewScope: 'nodes:details',
        manageScope: 'nodes:folders:manage',
        moveEditScope: 'nodes:rename',
        resourceMoveScope: 'nodes:rename',
        createScope: 'nodes:create',
        folderGrantScopes: ['nodes:details', 'nodes:rename', 'nodes:create'],
      };
    case 'databases':
      return {
        service: container.resolve(DatabaseFolderService),
        viewScope: 'databases:view',
        manageScope: 'databases:folders:manage',
        moveEditScope: 'databases:edit',
        resourceMoveScope: 'databases:edit',
        createScope: 'databases:create',
        folderGrantScopes: ['databases:view', 'databases:edit', 'databases:create'],
      };
    case 'storage':
      return {
        service: container.resolve(ObjectStorageFolderService),
        viewScope: 'storage:view',
        manageScope: 'storage:folders:manage',
        moveEditScope: 'storage:edit',
        resourceMoveScope: 'storage:edit',
      };
    case 'domains':
      return {
        service: container.resolve(DomainFolderService),
        viewScope: 'domains:view',
        manageScope: 'domains:folders:manage',
        moveEditScope: 'domains:edit',
        resourceMoveScope: 'domains:edit',
        createScope: 'domains:create',
        folderGrantScopes: ['domains:view', 'domains:edit', 'domains:create'],
      };
    case 'ssl_certificates':
      return {
        service: container.resolve(SSLCertificateFolderService),
        viewScope: 'ssl:cert:view',
        manageScope: 'ssl:cert:folders:manage',
        moveEditScope: 'ssl:cert:issue',
        resourceMoveScope: 'ssl:cert:issue',
        createScope: 'ssl:cert:issue',
        folderGrantScopes: ['ssl:cert:view', 'ssl:cert:issue', 'ssl:cert:delete'],
      };
    case 'logging_environments':
      return {
        service: container.resolve(LoggingEnvironmentFolderService),
        viewScope: 'logs:environments:view',
        manageScope: 'logs:environments:folders:manage',
        moveEditScope: 'logs:environments:edit',
        resourceMoveScope: 'logs:environments:edit',
        createScope: 'logs:environments:create',
        folderGrantScopes: [
          'logs:environments:view',
          'logs:environments:edit',
          'logs:environments:delete',
          'logs:environments:create',
        ],
      };
    case 'logging_schemas':
      return {
        service: container.resolve(LoggingSchemaFolderService),
        viewScope: 'logs:schemas:view',
        manageScope: 'logs:schemas:folders:manage',
        moveEditScope: 'logs:schemas:edit',
        resourceMoveScope: 'logs:schemas:edit',
        createScope: 'logs:schemas:create',
        folderGrantScopes: ['logs:schemas:view', 'logs:schemas:edit', 'logs:schemas:delete', 'logs:schemas:create'],
      };
    case 'admin_users':
      return {
        service: container.resolve(AdminUserFolderService),
        viewScope: 'admin:users',
        manageScope: 'admin:users:folders:manage',
        resourceMoveScope: 'admin:users',
        folderGrantScopes: ['admin:users'],
        reorderItemScope: 'admin:users',
      };
    case 'permission_groups':
      return {
        service: container.resolve(PermissionGroupFolderService),
        viewScope: 'admin:groups',
        manageScope: 'admin:groups:folders:manage',
        resourceMoveScope: 'admin:groups',
        folderGrantScopes: ['admin:groups'],
        reorderItemScope: 'admin:groups',
      };
    case 'pages':
      return {
        service: container.resolve(PageProjectFolderService),
        viewScope: 'pages:view',
        manageScope: 'pages:folders:manage',
        moveEditScope: 'pages:edit',
        resourceMoveScope: 'pages:edit',
        createScope: 'pages:create',
        folderGrantScopes: ['pages:view', 'pages:edit', 'pages:create'],
        reorderItemScope: 'pages:edit',
        visibleResourceIds: (scopes) => visiblePageProjectIds(scopes) ?? [],
      };
  }
}

/** Mirrors each module's GET .../folders route: who may list, and which folders a scoped caller sees. */
function genericListOptions(
  user: User,
  resourceType: Exclude<ResourceType, 'routes' | 'docker'>,
  config: GenericFolderConfig
) {
  const scopes = user.scopes;
  const logsManage =
    (resourceType === 'logging_environments' || resourceType === 'logging_schemas') && hasScope(scopes, 'logs:manage');
  const canManageFolders = hasScope(scopes, config.manageScope) || logsManage;
  const hasGlobalView = hasScope(scopes, config.viewScope) || logsManage;
  const hasGlobalCreate = !!config.createScope && hasScope(scopes, config.createScope);
  const listScopes = [config.viewScope, config.manageScope, ...(config.createScope ? [config.createScope] : [])];
  if (!canManageFolders && !listScopes.some((scope) => hasScopeBase(scopes, scope))) {
    throw new Error(`PERMISSION_DENIED: Missing one of required scopes: ${listScopes.join(', ')}`);
  }
  if (canManageFolders || hasGlobalView || hasGlobalCreate) return { includeAllFolders: true };
  return {
    allowedResourceIds: config.visibleResourceIds?.(scopes) ?? getResourceScopedIds(scopes, config.viewScope),
    ...(config.folderGrantScopes ? { allowedFolderIds: getFolderScopedIds(scopes, config.folderGrantScopes) } : {}),
  };
}

async function executeGenericFolderTool(
  user: User,
  resourceType: Exclude<ResourceType, 'routes' | 'docker'>,
  args: Record<string, unknown>
) {
  if (resourceType === 'logging_environments' || resourceType === 'logging_schemas') {
    // LICENSE ENFORCEMENT: Generic AI folder tools must not bypass the structured logging paywall.
    await container.resolve(LicensePolicyService).requireFeature('structured-logging');
  }
  // Same license gates as the database and storage folder routes.
  if (resourceType === 'databases') {
    await container.resolve(LicensePolicyService).requireFeature('external-database-connections');
  }
  if (resourceType === 'storage') {
    await container.resolve(LicensePolicyService).requireFeature('storage-connections');
  }
  if (resourceType === 'pages') {
    // Same gates as the Pages routes: the license feature, and an enabled Pages profile for mutations.
    await container.resolve(LicensePolicyService).requireFeature('pages');
  }
  const config = genericConfig(resourceType);
  const operation = operationArg(args.operation);
  if (operation === 'list') return config.service.getFolderTree(genericListOptions(user, resourceType, config));
  if (resourceType === 'pages') await container.resolve(PageProfileService).requireEnabled();

  if (config.manageScope.startsWith('logs:') && hasScope(user.scopes, 'logs:manage')) {
    // logs:manage is an intentional broad override for logging folder administration.
  } else {
    ensureScope(user, config.manageScope);
  }

  switch (operation) {
    case 'create':
      return config.service.createFolder(CreateResourceFolderSchema.parse(args), user.id);
    case 'update':
      return config.service.updateFolder(folderIdArg(args), UpdateResourceFolderSchema.parse(args), user.id);
    case 'move_folder':
      return config.service.moveFolder(
        folderIdArg(args),
        MoveResourceFolderSchema.parse(args),
        user.id,
        config.moveEditScope ? { scopes: user.scopes, editScope: config.moveEditScope } : undefined
      );
    case 'delete':
      await config.service.deleteFolder(folderIdArg(args), user.id);
      return { success: true };
    case 'reorder_folders':
      await config.service.reorderFolders(ReorderResourceFoldersSchema.parse(args));
      return { success: true };
    case 'move_resources': {
      const input = MoveResourcesToFolderSchema.parse({ ids: args.resourceIds, folderId: args.folderId });
      ensureResourceMoveAccess(user, config.resourceMoveScope, input.ids, input.folderId);
      await config.service.moveResourcesToFolder(input, user.id);
      return { success: true };
    }
    case 'reorder_resources': {
      const input = ReorderResourcesSchema.parse(args);
      if (config.reorderItemScope) {
        for (const item of input.items) ensureScopeForResource(user, config.reorderItemScope, item.id);
      }
      await config.service.reorderResources(input);
      return { success: true };
    }
    default:
      throw new Error(`Unsupported folder operation: ${operation}`);
  }
}

async function executeProxyFolderTool(user: User, args: Record<string, unknown>) {
  const service = container.resolve(FolderService);
  const operation = operationArg(args.operation);
  if (operation === 'list') {
    if (hasScope(user.scopes, 'proxy:folders:manage')) {
      return stripFolderTreeRawProxyConfigForProgrammaticResponse(
        await service.getFolderTree({ includeAllFolders: true })
      );
    }
    if (!hasScopeBase(user.scopes, 'proxy:view')) {
      throw new Error('PERMISSION_DENIED: Missing required scope proxy:view');
    }
    const tree = hasScope(user.scopes, 'proxy:view')
      ? await service.getFolderTree()
      : await service.getFolderTree({ allowedHostIds: allowedResourceIdsForScopes(user.scopes, 'proxy:view') });
    return stripFolderTreeRawProxyConfigForProgrammaticResponse(tree);
  }

  ensureScope(user, 'proxy:folders:manage');
  switch (operation) {
    case 'create':
      return service.createFolder(CreateResourceFolderSchema.parse(args), user.id);
    case 'update':
      return service.updateFolder(folderIdArg(args), UpdateResourceFolderSchema.parse(args), user.id);
    case 'move_folder':
      return service.moveFolder(folderIdArg(args), MoveResourceFolderSchema.parse(args), user.id, {
        scopes: user.scopes,
        editScope: 'proxy:edit',
      });
    case 'delete':
      await service.deleteFolder(folderIdArg(args), user.id);
      return { success: true };
    case 'reorder_folders':
      await service.reorderFolders(ReorderResourceFoldersSchema.parse(args));
      return { success: true };
    case 'move_resources': {
      const parsed = MoveHostsToFolderSchema.parse({ hostIds: args.resourceIds, folderId: args.folderId });
      ensureResourceMoveAccess(user, 'proxy:edit', parsed.hostIds, parsed.folderId);
      await service.moveHostsToFolder(parsed, user.id);
      return { success: true };
    }
    case 'reorder_resources': {
      const parsed = ReorderHostsSchema.parse(args);
      for (const item of parsed.items) ensureScopeForResource(user, 'proxy:edit', item.id);
      await service.reorderHosts(parsed);
      return { success: true };
    }
    default:
      throw new Error(`Unsupported proxy folder operation: ${operation}`);
  }
}

async function executeDockerFolderTool(user: User, args: Record<string, unknown>) {
  const service = container.resolve(DockerFolderService);
  const operation = operationArg(args.operation);
  const resourceType = DockerFolderResourceTypeSchema.parse(args.dockerResourceType ?? 'container');

  if (operation === 'list') {
    // Same access rule and visibility as GET /docker/folders, including Compose projects.
    return service.getFolderTree(await dockerFolderTreeOptions(user.scopes, resourceType));
  }

  ensureScope(user, 'docker:containers:folders:manage');
  const items = (Array.isArray(args.items) ? args.items : []).filter(
    (item): item is { nodeId: string; resourceKey: string } =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as { nodeId?: unknown }).nodeId === 'string' &&
      typeof (item as { resourceKey?: unknown }).resourceKey === 'string'
  );
  await ensureDockerResourceMoveScopes(user, resourceType, items);
  if (operation === 'move_resources') {
    // Same destination rule as the HTTP move route (docker-folder.routes.ts).
    const moveScope = DOCKER_MOVE_SCOPE_BY_RESOURCE_TYPE[resourceType];
    const folderId = typeof args.folderId === 'string' && args.folderId ? args.folderId : null;
    for (const item of items) {
      if (
        !hasScope(user.scopes, moveScope) &&
        !hasScope(user.scopes, `${moveScope}:${item.nodeId}`) &&
        !(folderId && hasScope(user.scopes, `${moveScope}:folder/${folderId}`))
      ) {
        throw new Error(`PERMISSION_DENIED: Missing required destination scope ${moveScope}`);
      }
    }
  }

  switch (operation) {
    case 'create':
      return service.createFolder(CreateDockerFolderSchema.parse({ ...args, resourceType }), user.id);
    case 'update':
      return service.updateFolder(folderIdArg(args), UpdateResourceFolderSchema.parse(args), user.id);
    case 'delete':
      await service.deleteFolder(folderIdArg(args), user.id);
      return { success: true };
    case 'reorder_folders':
      await service.reorderFolders(ReorderDockerFoldersSchema.parse({ ...args, resourceType }), user.id);
      return { success: true };
    case 'move_resources':
      await service.moveResourcesToFolder(
        MoveDockerResourcesToFolderSchema.parse({ resourceType, items: args.items, folderId: args.folderId }),
        user.id
      );
      return { success: true };
    case 'reorder_resources':
      await service.reorderResources(ReorderDockerResourcesSchema.parse({ ...args, resourceType }), user.id);
      return { success: true };
    case 'move_folder':
      throw new Error('Docker folders do not support move_folder; reorder or recreate the folder instead');
    default:
      throw new Error(`Unsupported docker folder operation: ${operation}`);
  }
}

export async function executeFolderTool(user: User, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const resourceType = resourceTypeArg(args.resourceType);
  if (toolName === 'list_resource_folders') {
    return resourceType === 'routes'
      ? executeProxyFolderTool(user, { ...args, operation: 'list' })
      : resourceType === 'docker'
        ? executeDockerFolderTool(user, { ...args, operation: 'list' })
        : executeGenericFolderTool(user, resourceType, { ...args, operation: 'list' });
  }
  if (toolName !== 'manage_resource_folder') throw new Error(`Unsupported folder tool: ${toolName}`);
  if (resourceType === 'routes') return executeProxyFolderTool(user, args);
  if (resourceType === 'docker') return executeDockerFolderTool(user, args);
  return executeGenericFolderTool(user, resourceType, args);
}
