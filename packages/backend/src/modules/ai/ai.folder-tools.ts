import { container } from '@/container.js';
import { hasScope, hasScopeBase, hasScopeForResource } from '@/lib/permissions.js';
import { AdminUserFolderService } from '@/modules/admin/admin-user-folders.service.js';
import { DatabaseFolderService } from '@/modules/databases/database-folders.service.js';
import {
  DockerAccessResourceService,
  hasDockerResourceScope,
} from '@/modules/docker/docker-access-resource.service.js';
import {
  CreateDockerFolderSchema,
  DockerFolderResourceTypeSchema,
  MoveDockerResourcesToFolderSchema,
  ReorderDockerFoldersSchema,
  ReorderDockerResourcesSchema,
} from '@/modules/docker/docker-folder.schemas.js';
import { DockerFolderService } from '@/modules/docker/docker-folder.service.js';
import { DomainFolderService } from '@/modules/domains/domain-folders.service.js';
import { PermissionGroupFolderService } from '@/modules/groups/permission-group-folders.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { LoggingEnvironmentFolderService } from '@/modules/logging/logging-environment-folders.service.js';
import { LoggingSchemaFolderService } from '@/modules/logging/logging-schema-folders.service.js';
import { NodeFolderService } from '@/modules/nodes/node-folders.service.js';
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
  | 'domains'
  | 'ssl_certificates'
  | 'logging_environments'
  | 'logging_schemas'
  | 'admin_users'
  | 'permission_groups'
  | 'routes'
  | 'docker';

type GenericFolderConfig = {
  service: FolderedResourceService;
  viewScope: string;
  manageScope: string;
};

const DOCKER_VIEW_SCOPE_BY_RESOURCE_TYPE = {
  container: 'docker:containers:view',
  image: 'docker:images:view',
  network: 'docker:networks:view',
  volume: 'docker:volumes:view',
  compose: 'docker:compose:view',
} as const;

function composeFolderVisibility(scopes: string[], viewScope: string) {
  const targets =
    allowedResourceIdsForScopes(scopes, viewScope)?.filter((target) => !target.startsWith('folder/')) ?? [];
  return {
    allowedNodeIds: targets.filter((target) => !target.includes('/')),
    allowedResourceRefs: targets.flatMap((target) => {
      const [nodeId, resourceKey, ...rest] = target.split('/');
      return nodeId && resourceKey && rest.length === 0 ? [{ nodeId, resourceKey }] : [];
    }),
  };
}

function resourceTypeArg(value: unknown): ResourceType {
  if (
    value === 'nodes' ||
    value === 'databases' ||
    value === 'domains' ||
    value === 'ssl_certificates' ||
    value === 'logging_environments' ||
    value === 'logging_schemas' ||
    value === 'admin_users' ||
    value === 'permission_groups' ||
    value === 'routes' ||
    value === 'docker'
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

function ensureAnyScope(user: User, scopes: readonly string[]) {
  if (!scopes.some((scope) => hasScopeBase(user.scopes, scope))) {
    throw new Error(`PERMISSION_DENIED: Missing one of required scopes: ${scopes.join(', ')}`);
  }
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

function genericConfig(resourceType: Exclude<ResourceType, 'routes' | 'docker'>): GenericFolderConfig {
  switch (resourceType) {
    case 'nodes':
      return {
        service: container.resolve(NodeFolderService),
        viewScope: 'nodes:details',
        manageScope: 'nodes:folders:manage',
      };
    case 'databases':
      return {
        service: container.resolve(DatabaseFolderService),
        viewScope: 'databases:view',
        manageScope: 'databases:folders:manage',
      };
    case 'domains':
      return {
        service: container.resolve(DomainFolderService),
        viewScope: 'domains:view',
        manageScope: 'domains:folders:manage',
      };
    case 'ssl_certificates':
      return {
        service: container.resolve(SSLCertificateFolderService),
        viewScope: 'ssl:cert:view',
        manageScope: 'ssl:cert:folders:manage',
      };
    case 'logging_environments':
      return {
        service: container.resolve(LoggingEnvironmentFolderService),
        viewScope: 'logs:environments:view',
        manageScope: 'logs:environments:folders:manage',
      };
    case 'logging_schemas':
      return {
        service: container.resolve(LoggingSchemaFolderService),
        viewScope: 'logs:schemas:view',
        manageScope: 'logs:schemas:folders:manage',
      };
    case 'admin_users':
      return {
        service: container.resolve(AdminUserFolderService),
        viewScope: 'admin:users',
        manageScope: 'admin:users:folders:manage',
      };
    case 'permission_groups':
      return {
        service: container.resolve(PermissionGroupFolderService),
        viewScope: 'admin:groups',
        manageScope: 'admin:groups:folders:manage',
      };
  }
}

function genericListOptions(
  user: User,
  resourceType: Exclude<ResourceType, 'routes' | 'docker'>,
  config: GenericFolderConfig
) {
  const isLoggingResource = resourceType === 'logging_environments' || resourceType === 'logging_schemas';
  if (resourceType === 'domains' || resourceType === 'ssl_certificates') {
    if (!hasScopeBase(user.scopes, config.viewScope)) {
      throw new Error(`PERMISSION_DENIED: Missing required scope ${config.viewScope}`);
    }
    return hasScope(user.scopes, config.viewScope)
      ? { includeAllFolders: hasScope(user.scopes, config.manageScope) }
      : { allowedResourceIds: allowedResourceIdsForScopes(user.scopes, config.viewScope) };
  }
  if (hasScope(user.scopes, config.manageScope) || (isLoggingResource && hasScope(user.scopes, 'logs:manage'))) {
    return { includeAllFolders: true };
  }
  if (!hasScopeBase(user.scopes, config.viewScope)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${config.viewScope}`);
  }
  if (hasScope(user.scopes, config.viewScope)) return {};
  return { allowedResourceIds: allowedResourceIdsForScopes(user.scopes, config.viewScope) };
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
  const config = genericConfig(resourceType);
  const operation = operationArg(args.operation);
  if (operation === 'list') return config.service.getFolderTree(genericListOptions(user, resourceType, config));

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
      return config.service.moveFolder(folderIdArg(args), MoveResourceFolderSchema.parse(args), user.id);
    case 'delete':
      await config.service.deleteFolder(folderIdArg(args), user.id);
      return { success: true };
    case 'reorder_folders':
      await config.service.reorderFolders(ReorderResourceFoldersSchema.parse(args));
      return { success: true };
    case 'move_resources':
      await config.service.moveResourcesToFolder(
        MoveResourcesToFolderSchema.parse({ ids: args.resourceIds, folderId: args.folderId }),
        user.id
      );
      return { success: true };
    case 'reorder_resources':
      await config.service.reorderResources(ReorderResourcesSchema.parse(args));
      return { success: true };
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
      return service.moveFolder(folderIdArg(args), MoveResourceFolderSchema.parse(args), user.id);
    case 'delete':
      await service.deleteFolder(folderIdArg(args), user.id);
      return { success: true };
    case 'reorder_folders':
      await service.reorderFolders(ReorderResourceFoldersSchema.parse(args));
      return { success: true };
    case 'move_resources': {
      const parsed = MoveHostsToFolderSchema.parse({ hostIds: args.resourceIds, folderId: args.folderId });
      for (const hostId of parsed.hostIds) ensureScopeForResource(user, 'proxy:edit', hostId);
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
    if (hasScope(user.scopes, 'docker:containers:folders:manage')) {
      return service.getFolderTree({ resourceType, includeAllFolders: true });
    }
    const viewScope = DOCKER_VIEW_SCOPE_BY_RESOURCE_TYPE[resourceType];
    ensureAnyScope(user, [viewScope]);
    if (hasScope(user.scopes, viewScope)) return service.getFolderTree({ resourceType });
    return service.getFolderTree(
      resourceType === 'compose'
        ? { resourceType, ...composeFolderVisibility(user.scopes, viewScope) }
        : { resourceType, allowedNodeIds: allowedResourceIdsForScopes(user.scopes, viewScope) }
    );
  }

  ensureScope(user, 'docker:containers:folders:manage');
  if (resourceType === 'container') {
    const items = Array.isArray(args.items) ? args.items : [];
    const resources = container.resolve(DockerAccessResourceService);
    for (const item of items) {
      if (!item || typeof item !== 'object' || !('nodeId' in item) || typeof item.nodeId !== 'string') continue;
      if (!('resourceKey' in item) || typeof item.resourceKey !== 'string') continue;
      const resourceId = await resources.resolveResourceByName(item.nodeId, item.resourceKey);
      if (!resourceId || !hasDockerResourceScope(user.scopes, 'docker:containers:edit', item.nodeId, resourceId)) {
        throw new Error('Missing required scope: docker:containers:edit');
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
