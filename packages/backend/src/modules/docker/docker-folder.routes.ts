import type { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { getResourceScopedIds, hasScope, hasScopeBase } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import {
  createDockerFolderRoute,
  deleteDockerFolderRoute,
  getDockerFolderPlacementsRoute,
  listDockerFoldersRoute,
  moveDockerContainersRoute,
  moveDockerResourcesRoute,
  reorderDockerContainersRoute,
  reorderDockerFoldersRoute,
  reorderDockerResourcesRoute,
  updateDockerFolderRoute,
} from './docker.docs.js';
import {
  DockerAccessResourceService,
  dockerScopedNodeIds,
  hasDockerResourceScope,
} from './docker-access-resource.service.js';
import {
  CreateDockerFolderSchema,
  DockerFolderPlacementsSchema,
  DockerFolderResourceTypeSchema,
  MoveDockerContainersToFolderSchema,
  MoveDockerResourcesToFolderSchema,
  ReorderDockerContainersSchema,
  ReorderDockerFoldersSchema,
  ReorderDockerResourcesSchema,
  UpdateDockerFolderSchema,
} from './docker-folder.schemas.js';
import { DockerFolderService } from './docker-folder.service.js';

const VIEW_SCOPE_BY_RESOURCE_TYPE = {
  container: 'docker:containers:view',
  image: 'docker:images:view',
  network: 'docker:networks:view',
  volume: 'docker:volumes:view',
} as const;

function hasAnyDockerScope(scopes: string[], prefix: string): boolean {
  return scopes.some((scope) => scope === prefix || scope.startsWith(`${prefix}:`));
}

function requireAnyDockerScope(scopes: string[], prefix: string, message: string) {
  if (!hasAnyDockerScope(scopes, prefix)) {
    throw new AppError(403, 'FORBIDDEN', message);
  }
}

async function assertContainerScopes(
  scopes: string[],
  baseScope: string,
  items: Array<{ nodeId: string; containerName: string }>
): Promise<void> {
  const resources = container.resolve(DockerAccessResourceService);
  for (const item of items) {
    const resourceId = await resources.resolveResourceByName(item.nodeId, item.containerName);
    if (!resourceId || !hasDockerResourceScope(scopes, baseScope, item.nodeId, resourceId)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${baseScope}`);
    }
  }
}

export function registerDockerFolderRoutes(router: OpenAPIHono<AppEnv>) {
  router.openapi(listDockerFoldersRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    const resourceType = DockerFolderResourceTypeSchema.default('container').parse(c.req.query('resourceType'));
    const viewScope = VIEW_SCOPE_BY_RESOURCE_TYPE[resourceType];
    if (!hasScopeBase(scopes, viewScope) && !hasScope(scopes, 'docker:containers:folders:manage')) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'Docker folders require resource view access or docker:containers:folders:manage'
      );
    }
    const service = container.resolve(DockerFolderService);
    const canManageFolders = hasScope(scopes, 'docker:containers:folders:manage');
    const data = await service.getFolderTree(
      canManageFolders || hasScope(scopes, viewScope)
        ? { resourceType, includeAllFolders: canManageFolders }
        : {
            resourceType,
            allowedNodeIds:
              resourceType === 'container'
                ? dockerScopedNodeIds(scopes, [viewScope])
                : getResourceScopedIds(scopes, viewScope),
          }
    );
    return c.json({ data });
  });

  router.openapi(createDockerFolderRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(
      scopes,
      'docker:containers:folders:manage',
      'Creating Docker folders requires docker:containers:folders:manage'
    );
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = CreateDockerFolderSchema.parse(body);
    const service = container.resolve(DockerFolderService);
    const data = await service.createFolder(input, user.id);
    return c.json({ data }, 201);
  });

  router.openapi(reorderDockerFoldersRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(
      scopes,
      'docker:containers:folders:manage',
      'Reordering Docker folders requires docker:containers:folders:manage'
    );
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = ReorderDockerFoldersSchema.parse(body);
    const service = container.resolve(DockerFolderService);
    await service.reorderFolders(input, user.id);
    return c.json({ success: true });
  });

  router.openapi(reorderDockerResourcesRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(
      scopes,
      'docker:containers:folders:manage',
      'Reordering Docker resources requires docker:containers:folders:manage'
    );
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = ReorderDockerResourcesSchema.parse(body);
    if (input.resourceType === 'container') {
      await assertContainerScopes(
        scopes,
        'docker:containers:edit',
        input.items.map((item) => ({ nodeId: item.nodeId, containerName: item.resourceKey }))
      );
    }
    const service = container.resolve(DockerFolderService);
    await service.reorderResources(input, user.id);
    return c.json({ success: true });
  });

  router.openapi(reorderDockerContainersRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(
      scopes,
      'docker:containers:folders:manage',
      'Reordering Docker containers requires docker:containers:folders:manage'
    );
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = ReorderDockerContainersSchema.parse(body);
    await assertContainerScopes(scopes, 'docker:containers:edit', input.items);
    const service = container.resolve(DockerFolderService);
    await service.reorderContainers(input, user.id);
    return c.json({ success: true });
  });

  router.openapi(updateDockerFolderRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(
      scopes,
      'docker:containers:folders:manage',
      'Updating Docker folders requires docker:containers:folders:manage'
    );
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = UpdateDockerFolderSchema.parse(body);
    const service = container.resolve(DockerFolderService);
    const data = await service.updateFolder(c.req.param('id')!, input, user.id);
    return c.json({ data });
  });

  router.openapi(deleteDockerFolderRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(
      scopes,
      'docker:containers:folders:manage',
      'Deleting Docker folders requires docker:containers:folders:manage'
    );
    const user = c.get('user')!;
    const service = container.resolve(DockerFolderService);
    await service.deleteFolder(c.req.param('id')!, user.id);
    return c.body(null, 204);
  });

  router.openapi(moveDockerContainersRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(
      scopes,
      'docker:containers:folders:manage',
      'Moving containers between Docker folders requires docker:containers:folders:manage'
    );
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = MoveDockerContainersToFolderSchema.parse(body);
    await assertContainerScopes(scopes, 'docker:containers:edit', input.items);
    const service = container.resolve(DockerFolderService);
    await service.moveContainersToFolder(input, user.id);
    return c.json({ success: true });
  });

  router.openapi(moveDockerResourcesRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(
      scopes,
      'docker:containers:folders:manage',
      'Moving Docker resources between folders requires docker:containers:folders:manage'
    );
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = MoveDockerResourcesToFolderSchema.parse(body);
    if (input.resourceType === 'container') {
      await assertContainerScopes(
        scopes,
        'docker:containers:edit',
        input.items.map((item) => ({ nodeId: item.nodeId, containerName: item.resourceKey }))
      );
    }
    const service = container.resolve(DockerFolderService);
    await service.moveResourcesToFolder(input, user.id);
    return c.json({ success: true });
  });

  router.openapi(getDockerFolderPlacementsRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    const body = await c.req.json();
    const input = DockerFolderPlacementsSchema.parse(body);
    const viewScope = VIEW_SCOPE_BY_RESOURCE_TYPE[input.resourceType];
    if (!hasScopeBase(scopes, viewScope) && !hasScope(scopes, 'docker:containers:folders:manage')) {
      throw new AppError(403, 'FORBIDDEN', 'Docker folder placements require resource view access');
    }
    if (input.resourceType === 'container') {
      await assertContainerScopes(
        scopes,
        viewScope,
        input.items.map((item) => ({ nodeId: item.nodeId, containerName: item.resourceKey }))
      );
    }
    const service = container.resolve(DockerFolderService);
    const data = await service.getResourcePlacementsForRefs(input.resourceType, input.items);
    return c.json({ data });
  });
}
