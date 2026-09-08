import type { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { dockerAccessResources, dockerDeployments } from '@/db/schema/index.js';
import { getFolderScopedIds } from '@/lib/folder-scopes.js';
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
import { DockerAccessResourceService, hasDockerResourceScope } from './docker-access-resource.service.js';
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
import { DockerNetworkAccessResourceService } from './docker-network-access-resource.service.js';

const VIEW_SCOPE_BY_RESOURCE_TYPE = {
  container: 'docker:containers:view',
  image: 'docker:images:view',
  network: 'docker:networks:view',
  volume: 'docker:volumes:view',
  compose: 'docker:compose:view',
} as const;

const MOVE_SCOPE_BY_RESOURCE_TYPE = {
  container: 'docker:containers:edit',
  image: 'docker:images:delete',
  volume: 'docker:volumes:delete',
  network: 'docker:networks:edit',
  compose: 'docker:compose:manage',
} as const;

function assertResourceScopes(
  scopes: string[],
  baseScope: string,
  items: Array<{ nodeId: string; resourceKey: string }>
) {
  for (const item of items) {
    if (!hasDockerResourceScope(scopes, baseScope, item.nodeId, item.resourceKey))
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${baseScope}`);
  }
}

async function containerFolderVisibility(scopes: string[], viewScope: string) {
  const visibility = composeFolderVisibility(scopes, viewScope);
  if (!visibility.allowedResourceRefs.length) return visibility;
  const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
  const refs = await Promise.all(
    visibility.allowedResourceRefs.map(async ({ nodeId, resourceKey }) => {
      const [deployment] = await db
        .select({ name: dockerDeployments.name })
        .from(dockerDeployments)
        .where(and(eq(dockerDeployments.id, resourceKey), eq(dockerDeployments.nodeId, nodeId)))
        .limit(1);
      if (deployment) return { nodeId, resourceKey: deployment.name };
      const [resource] = await db
        .select({ resourceKey: dockerAccessResources.resourceKey })
        .from(dockerAccessResources)
        .where(
          and(
            eq(dockerAccessResources.id, resourceKey),
            eq(dockerAccessResources.nodeId, nodeId),
            eq(dockerAccessResources.resourceType, 'container')
          )
        )
        .limit(1);
      return resource ? { nodeId, resourceKey: resource.resourceKey } : null;
    })
  );
  return {
    ...visibility,
    allowedResourceRefs: refs.filter((ref): ref is { nodeId: string; resourceKey: string } => !!ref),
  };
}

function hasAnyDockerScope(scopes: string[], prefix: string): boolean {
  return scopes.some((scope) => scope === prefix || scope.startsWith(`${prefix}:`));
}

function requireAnyDockerScope(scopes: string[], prefix: string, message: string) {
  if (!hasAnyDockerScope(scopes, prefix)) {
    throw new AppError(403, 'FORBIDDEN', message);
  }
}

function composeFolderVisibility(scopes: string[], viewScope: string) {
  const targets = getResourceScopedIds(scopes, viewScope).filter((target) => !target.startsWith('folder/'));
  return {
    allowedNodeIds: targets.filter((target) => !target.includes('/')),
    allowedResourceRefs: targets.flatMap((target) => {
      const [nodeId, resourceKey, ...rest] = target.split('/');
      return nodeId && resourceKey && rest.length === 0 ? [{ nodeId, resourceKey }] : [];
    }),
  };
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

async function assertNetworkScopes(
  scopes: string[],
  baseScope: string,
  items: Array<{ nodeId: string; resourceKey: string }>
): Promise<void> {
  const resources = container.resolve(DockerNetworkAccessResourceService);
  for (const item of items) {
    const resourceId = await resources.resolveNetwork(item.nodeId, item.resourceKey);
    if (!resourceId || !hasDockerResourceScope(scopes, baseScope, item.nodeId, resourceId)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${baseScope}`);
    }
  }
}

function assertNetworkDestinationScope(
  scopes: string[],
  baseScope: string,
  nodeId: string,
  folderId: string | null
): void {
  if (
    hasScope(scopes, baseScope) ||
    hasScope(scopes, `${baseScope}:${nodeId}`) ||
    (!!folderId && hasScope(scopes, `${baseScope}:folder/${folderId}`))
  ) {
    return;
  }
  throw new AppError(403, 'FORBIDDEN', `Missing required destination scope: ${baseScope}`);
}

async function networkFolderVisibility(scopes: string[], viewScope: string) {
  const targets = getResourceScopedIds(scopes, viewScope).filter((target) => !target.startsWith('folder/'));
  const allowedNodeIds = targets.filter((target) => !target.includes('/'));
  const resources = container.resolve(DockerNetworkAccessResourceService);
  const allowedResourceRefs = (
    await Promise.all(
      targets
        .filter((target) => target.includes('/'))
        .map(async (target) => {
          const [nodeId, resourceId, ...rest] = target.split('/');
          if (!nodeId || !resourceId || rest.length > 0) return null;
          const resourceKey = await resources.resolveNetworkResourceKey(nodeId, resourceId);
          return resourceKey ? { nodeId, resourceKey } : null;
        })
    )
  ).filter((value): value is { nodeId: string; resourceKey: string } => !!value);
  return { allowedNodeIds, allowedResourceRefs };
}

export function registerDockerFolderRoutes(router: OpenAPIHono<AppEnv>) {
  router.openapi(listDockerFoldersRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    const resourceType = DockerFolderResourceTypeSchema.default('container').parse(c.req.query('resourceType'));
    const viewScope = VIEW_SCOPE_BY_RESOURCE_TYPE[resourceType];
    const createScope =
      resourceType === 'image'
        ? 'docker:images:pull'
        : resourceType === 'compose'
          ? 'docker:compose:create'
          : `docker:${resourceType}s:create`;
    if (
      !hasScopeBase(scopes, viewScope) &&
      !hasScopeBase(scopes, createScope) &&
      !hasScope(scopes, 'docker:containers:folders:manage')
    ) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'Docker folders require resource view access or docker:containers:folders:manage'
      );
    }
    const service = container.resolve(DockerFolderService);
    const canManageFolders = hasScope(scopes, 'docker:containers:folders:manage');
    const data = await service.getFolderTree(
      canManageFolders ||
        hasScope(scopes, viewScope) ||
        hasScope(scopes, createScope) ||
        getResourceScopedIds(scopes, createScope).some((id) => !id.includes('/'))
        ? { resourceType, includeAllFolders: true }
        : {
            resourceType,
            allowedFolderIds: getFolderScopedIds(scopes, [viewScope, createScope]),
            ...(resourceType === 'container'
              ? await containerFolderVisibility(scopes, viewScope)
              : resourceType === 'compose'
                ? composeFolderVisibility(scopes, viewScope)
                : resourceType === 'network'
                  ? await networkFolderVisibility(scopes, viewScope)
                  : composeFolderVisibility(scopes, viewScope)),
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
    if (input.resourceType === 'network') {
      await assertNetworkScopes(scopes, 'docker:networks:edit', input.items);
    }
    if (input.resourceType !== 'container' && input.resourceType !== 'network')
      assertResourceScopes(scopes, MOVE_SCOPE_BY_RESOURCE_TYPE[input.resourceType], input.items);
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
    for (const item of input.items)
      assertNetworkDestinationScope(scopes, 'docker:containers:edit', item.nodeId, input.folderId);
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
    if (input.resourceType === 'network') {
      await assertNetworkScopes(scopes, 'docker:networks:edit', input.items);
    }
    const moveScope = MOVE_SCOPE_BY_RESOURCE_TYPE[input.resourceType];
    if (input.resourceType !== 'container' && input.resourceType !== 'network')
      assertResourceScopes(scopes, moveScope, input.items);
    for (const item of input.items) assertNetworkDestinationScope(scopes, moveScope, item.nodeId, input.folderId);
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
    if (input.resourceType === 'network') {
      await assertNetworkScopes(scopes, viewScope, input.items);
    }
    if (input.resourceType !== 'container' && input.resourceType !== 'network')
      assertResourceScopes(scopes, viewScope, input.items);
    const service = container.resolve(DockerFolderService);
    const data = await service.getResourcePlacementsForRefs(input.resourceType, input.items);
    return c.json({ data });
  });
}
