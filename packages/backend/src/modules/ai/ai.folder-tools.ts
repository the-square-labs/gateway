import { container } from '@/container.js';
import { type AccessDockerFolderType, type AccessFolderResourceType, accessAreaForBase } from '@/lib/access-summary.js';
import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import {
  getResourceScopedIds,
  hasScope,
  hasScopeBase,
  hasScopeForCreation,
  hasScopeForResource,
  scopeMatcher,
} from '@/lib/permissions.js';
import { FOLDER_SCOPABLE } from '@/lib/scopes.js';
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
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import { MoveHostsToFolderSchema, ReorderHostsSchema } from '@/modules/proxy/folder.schemas.js';
import { FolderService } from '@/modules/proxy/folder.service.js';
import { redactFolderTreeProxyHostsForScopes } from '@/modules/proxy/page-target-visibility.js';
import { stripFolderTreeRawProxyConfigForProgrammaticResponse } from '@/modules/proxy/raw-visibility.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import type { User } from '@/types.js';
import { folderLicenseFeature, type GenericFolderConfig, genericFolderConfig } from './ai.folder-tool-configs.js';
import {
  FOLDER_TOOL_RESOURCE_TYPES,
  type FolderToolResourceType,
  type GenericFolderResourceType,
} from './ai.folder-tool-types.js';

export const FOLDER_TOOL_NAMES = new Set(['list_resource_folders', 'manage_resource_folder']);

type ResourceType = FolderToolResourceType;

/** Per-resource scope the HTTP Docker folder routes require to move or reorder a resource. */
const DOCKER_MOVE_SCOPE_BY_RESOURCE_TYPE = {
  container: 'docker:containers:edit',
  image: 'docker:images:delete',
  volume: 'docker:volumes:delete',
  network: 'docker:networks:edit',
  compose: 'docker:compose:manage',
} as const;

const DOCKER_CREATE_SCOPE_BY_RESOURCE_TYPE = {
  container: 'docker:containers:create',
  compose: 'docker:compose:create',
  image: 'docker:images:pull',
  volume: 'docker:volumes:create',
  network: 'docker:networks:create',
} as const;

/** Without dockerResourceType, list the first Docker folder type the caller can use instead of refusing. */
function defaultDockerListType(scopes: string[]): keyof typeof DOCKER_CREATE_SCOPE_BY_RESOURCE_TYPE {
  const types = ['container', 'compose', 'image', 'volume', 'network'] as const;
  if (hasScope(scopes, 'docker:folders:manage')) return 'container';
  return (
    types.find(
      (type) =>
        hasScopeBase(scopes, `docker:${type === 'compose' ? 'compose' : `${type}s`}:view`) ||
        hasScopeBase(scopes, DOCKER_CREATE_SCOPE_BY_RESOURCE_TYPE[type])
    ) ?? 'container'
  );
}

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
  if ((FOLDER_TOOL_RESOURCE_TYPES as readonly unknown[]).includes(value)) return value as ResourceType;
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

/**
 * Every folder-scopable scope of one folder family. A folder grant of any of them (view, create, query,
 * deploy, console, ...) reveals the folder to a caller without broad access, even while it is empty.
 */
function folderFamilyBases(resourceType: AccessFolderResourceType, dockerType?: AccessDockerFolderType): string[] {
  return FOLDER_SCOPABLE.filter((base) => {
    const { area } = accessAreaForBase(base);
    return area.folderResourceType === resourceType && (!dockerType || area.dockerFolderType === dockerType);
  });
}

/**
 * Add the caller's actions in each listed folder (`access.actions`, `access.canCreate`), so an agent with
 * folder-limited access can pick a destination. Broad grants count in every folder; folder grants include
 * their subfolders.
 */
function annotateFolderAccess(
  tree: unknown,
  scopes: readonly string[],
  bases: readonly string[],
  createScope?: string
) {
  if (!Array.isArray(tree)) return tree;
  const holds = scopeMatcher(scopes);
  const visit = (node: unknown): unknown => {
    if (!node || typeof node !== 'object' || typeof (node as { id?: unknown }).id !== 'string') return node;
    const folder = node as { id: string; children?: unknown };
    const actions = [
      ...new Set(
        bases.filter((base) => holds(`${base}:folder/${folder.id}`)).map((base) => accessAreaForBase(base).action)
      ),
    ].sort();
    return {
      ...folder,
      access: { actions, canCreate: !!createScope && holds(`${createScope}:folder/${folder.id}`) },
      ...(Array.isArray(folder.children) ? { children: folder.children.map(visit) } : {}),
    };
  };
  return tree.map(visit);
}

/**
 * Mirrors each module's GET .../folders route: who may list, and which folders a scoped caller sees. A
 * folder grant of any of the family's scopes counts, so a folder-limited caller always sees its folders.
 */
function genericListOptions(user: User, config: GenericFolderConfig, resourceType: GenericFolderResourceType) {
  const scopes = user.scopes;
  const canManageFolders = hasScope(scopes, config.manageScope);
  const hasGlobalView = hasScope(scopes, config.viewScope);
  const hasGlobalCreate = !!config.createScope && hasScope(scopes, config.createScope);
  const listScopes = [
    config.viewScope,
    config.manageScope,
    ...(config.createScope ? [config.createScope] : []),
    ...(config.listScopes ?? []),
  ];
  const listsAll = (config.listScopes ?? []).some((scope) => hasScope(scopes, scope));
  const grantedFolderIds = getFolderScopedIds(scopes, folderFamilyBases(resourceType));
  if (!canManageFolders && grantedFolderIds.length === 0 && !listScopes.some((scope) => hasScopeBase(scopes, scope))) {
    throw new Error(`PERMISSION_DENIED: Missing one of required scopes: ${listScopes.join(', ')}`);
  }
  if (canManageFolders || hasGlobalView || hasGlobalCreate || listsAll) return { includeAllFolders: true };
  return {
    allowedResourceIds: config.visibleResourceIds?.(scopes) ?? getResourceScopedIds(scopes, config.viewScope),
    allowedFolderIds: grantedFolderIds,
  };
}

async function executeGenericFolderTool(
  user: User,
  resourceType: GenericFolderResourceType,
  args: Record<string, unknown>
) {
  const operation = operationArg(args.operation);
  const feature = folderLicenseFeature(resourceType);
  if (feature) {
    // LICENSE ENFORCEMENT: Same classes as the folder routes. Listing and deleting folders
    // keep working after the license grace period; creating or changing them does not.
    const policy = container.resolve(LicensePolicyService);
    if (operation === 'list' || operation === 'delete') await policy.requireFeatureForExistingRuntime(feature);
    else await policy.requireFeature(feature);
  }
  const config = genericFolderConfig(resourceType);
  if (operation === 'list') {
    return annotateFolderAccess(
      await config.service.getFolderTree(genericListOptions(user, config, resourceType)),
      user.scopes,
      folderFamilyBases(resourceType),
      config.createScope
    );
  }
  if (resourceType === 'pages') await container.resolve(PageProfileService).requireEnabled();

  ensureScope(user, config.manageScope);

  switch (operation) {
    case 'create':
      return config.service.createFolder(CreateResourceFolderSchema.parse(args), user.id);
    case 'update':
      return config.service.updateFolder(folderIdArg(args), UpdateResourceFolderSchema.parse(args), user.id);
    case 'move_folder':
      return config.service.moveFolder(folderIdArg(args), MoveResourceFolderSchema.parse(args), user.id, {
        scopes: user.scopes,
        editScope: config.moveEditScope,
      });
    case 'delete':
      await config.service.deleteFolder(folderIdArg(args), user.id);
      return { success: true };
    case 'reorder_folders':
      await config.service.reorderFolders(ReorderResourceFoldersSchema.parse(args));
      return { success: true };
    case 'move_resources': {
      const input = MoveResourcesToFolderSchema.parse({ ids: args.resourceIds, folderId: args.folderId });
      if (config.authorizePlacement) await config.authorizePlacement(user.scopes, input.ids);
      else ensureResourceMoveAccess(user, config.resourceMoveScope, input.ids, input.folderId);
      await config.service.moveResourcesToFolder(input, user.id);
      return { success: true };
    }
    case 'reorder_resources': {
      const input = ReorderResourcesSchema.parse(args);
      if (config.authorizePlacement) {
        await config.authorizePlacement(
          user.scopes,
          input.items.map((item) => item.id)
        );
      } else if (config.reorderItemScope) {
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
    // Same host redaction as GET /api/proxy-host-folders: advanced config and Page targets follow their own scopes.
    const present = (tree: unknown[]) =>
      redactFolderTreeProxyHostsForScopes(stripFolderTreeRawProxyConfigForProgrammaticResponse(tree), user.scopes);
    // Same access rule as the folder tree route: route viewers, route creators and folder managers. A caller
    // without broad access sees the folders holding its routes plus every folder it holds a route grant on,
    // including a granted folder that is still empty.
    const scopes = user.scopes;
    if (
      !hasScopeBase(scopes, 'proxy:view') &&
      !hasScopeBase(scopes, 'proxy:create') &&
      !hasScope(scopes, 'proxy:folders:manage')
    ) {
      throw new Error(
        'PERMISSION_DENIED: Missing one of required scopes: proxy:view, proxy:create, proxy:folders:manage'
      );
    }
    const includeAllFolders =
      hasScope(scopes, 'proxy:folders:manage') || hasScope(scopes, 'proxy:view') || hasScope(scopes, 'proxy:create');
    const routeFolderBases = folderFamilyBases('routes');
    const tree = await service.getFolderTree(
      includeAllFolders
        ? { includeAllFolders: true }
        : {
            allowedHostIds: getResourceScopedIds(scopes, 'proxy:view'),
            allowedFolderIds: getFolderScopedIds(scopes, routeFolderBases),
          }
    );
    return annotateFolderAccess(present(tree), scopes, routeFolderBases, 'proxy:create');
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
  const resourceType = DockerFolderResourceTypeSchema.parse(
    args.dockerResourceType ?? (operation === 'list' ? defaultDockerListType(user.scopes) : 'container')
  );

  if (operation === 'list') {
    // Same access rule and visibility as GET /docker/folders, including Compose projects, plus every folder the
    // caller holds any grant of this Docker type on.
    const bases = folderFamilyBases('docker', resourceType);
    const options = await dockerFolderTreeOptions(user.scopes, resourceType);
    const tree = await service.getFolderTree(
      'allowedFolderIds' in options && options.allowedFolderIds
        ? {
            ...options,
            allowedFolderIds: [...new Set([...options.allowedFolderIds, ...getFolderScopedIds(user.scopes, bases)])],
          }
        : options
    );
    return annotateFolderAccess(tree, user.scopes, bases, DOCKER_CREATE_SCOPE_BY_RESOURCE_TYPE[resourceType]);
  }

  ensureScope(user, 'docker:folders:manage');
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
