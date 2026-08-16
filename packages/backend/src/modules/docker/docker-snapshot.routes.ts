import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import type { AppEnv } from '@/types.js';
import { DockerManagementService } from './docker.service.js';
import { filterDockerResourcesForScope } from './docker-access.middleware.js';
import {
  DockerAccessResourceService,
  dockerScopedNodeIds,
  hasDockerResourceScope,
} from './docker-access-resource.service.js';
import { compactContainerListItem, matchesContainerSearch } from './docker-container.routes.js';
import { compactImageListItem, matchesImageSearch } from './docker-image.routes.js';
import { compactNetworkListItem, matchesNetworkSearch } from './docker-network.routes.js';
import {
  DOCKER_SNAPSHOT_KINDS,
  type DockerRefreshKind,
  type DockerSnapshotKind,
  DockerSnapshotService,
} from './docker-snapshot.service.js';
import { DockerSnapshotReconciler } from './docker-snapshot-reconciler.service.js';
import { compactVolumeListItem, matchesVolumeSearch } from './docker-volume.routes.js';

const MAX_ITEMS = 1000;
const RefreshSchema = z
  .object({
    nodeId: z.string().uuid().optional(),
    resource: z.enum([...DOCKER_SNAPSHOT_KINDS, 'container-detail', 'volume-detail']).optional(),
    kind: z.enum([...DOCKER_SNAPSHOT_KINDS, 'container-detail', 'volume-detail']).optional(),
    key: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const resource = value.resource ?? value.kind;
    if (!resource) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resource'], message: 'resource is required' });
    }
    if ((resource === 'container-detail' || resource === 'volume-detail') && !value.key) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['key'], message: 'key is required for detail refresh' });
    }
  });

const VIEW_SCOPE: Record<DockerRefreshKind, string> = {
  containers: 'docker:containers:view',
  images: 'docker:images:view',
  volumes: 'docker:volumes:view',
  networks: 'docker:networks:view',
  'container-detail': 'docker:containers:view',
  'volume-detail': 'docker:volumes:view',
};

async function canRefreshContainerDetail(scopes: string[], nodeId: string, key: string): Promise<boolean> {
  if (hasDockerResourceScope(scopes, 'docker:containers:view', nodeId, '')) return true;
  const resources = container.resolve(DockerAccessResourceService);
  const resourceId =
    (await resources.resolveContainer(nodeId, { runtimeId: key })) ??
    (await resources.resolveContainer(nodeId, { name: key }));
  return !!resourceId && hasDockerResourceScope(scopes, 'docker:containers:view', nodeId, resourceId);
}

function normalizeRows(kind: DockerSnapshotKind, data: Record<string, any>[], search?: string) {
  switch (kind) {
    case 'containers':
      return data.filter((item) => matchesContainerSearch(item, search)).map(compactContainerListItem);
    case 'images':
      return data.filter((item) => matchesImageSearch(item, search)).map(compactImageListItem);
    case 'volumes':
      return data.filter((item) => matchesVolumeSearch(item, search)).map(compactVolumeListItem);
    case 'networks':
      return data.map(compactNetworkListItem).filter((item) => matchesNetworkSearch(item, search));
  }
}

async function aggregate(c: any, kind: DockerSnapshotKind) {
  const snapshots = container.resolve(DockerSnapshotService);
  const docker = container.resolve(DockerManagementService);
  const scopes = c.get('effectiveScopes') || [];
  const requestedNodeId = c.req.query('nodeId')?.trim() || undefined;
  const search = c.req.query('search')?.trim().toLowerCase() || undefined;
  const visibleNodes = await snapshots.listVisibleNodes(kind, scopes, requestedNodeId);

  const results = await Promise.all(
    visibleNodes.map(async (node) => {
      const snapshot = await snapshots.getList<Record<string, any>[]>(node.id, kind);
      const source =
        kind === 'containers'
          ? await docker.decoratePublicContainerSnapshot(node.id, snapshot.data)
          : kind === 'volumes'
            ? await docker.decoratePublicVolumeSnapshot(
                node.id,
                snapshot.data,
                (await snapshots.getList<Record<string, any>[]>(node.id, 'containers')).data
              )
            : snapshot.data;
      const availability = snapshots.availability(node.id, snapshot);
      const normalized = normalizeRows(kind, Array.isArray(source) ? source : [], search);
      const scoped: Array<Record<string, unknown>> =
        kind === 'containers'
          ? filterDockerResourcesForScope(
              normalized as Array<Record<string, unknown> & { scopeResourceId?: string | null }>,
              scopes,
              'docker:containers:view',
              node.id
            )
          : normalized;
      const rows = scoped.map((item) => ({
        ...item,
        nodeId: node.id,
        availability,
      }));
      return { rows, node: snapshots.toNodeMetadata(node, snapshot) };
    })
  );

  const data = results.flatMap((result) => result.rows);
  const truncated = data.length > MAX_ITEMS;
  return c.json({
    data: truncated ? data.slice(0, MAX_ITEMS) : data,
    nodes: results.map((result) => result.node),
    total: data.length,
    limit: MAX_ITEMS,
    truncated,
  });
}

export function registerDockerSnapshotRoutes(router: OpenAPIHono<AppEnv>) {
  router.get('/containers', (c) => aggregate(c, 'containers'));
  router.get('/images', (c) => aggregate(c, 'images'));
  router.get('/volumes', (c) => aggregate(c, 'volumes'));
  router.get('/networks', (c) => aggregate(c, 'networks'));

  router.post('/snapshots/refresh', async (c) => {
    const input = RefreshSchema.parse(await c.req.json());
    const snapshots = container.resolve(DockerSnapshotService);
    const scopes = c.get('effectiveScopes') || [];
    const resource = (input.resource ?? input.kind)!;
    const reconciler = container.resolve(DockerSnapshotReconciler);
    if (input.nodeId) {
      await snapshots.assertDockerNode(input.nodeId);
      const hasContainerChildAccess =
        (resource === 'containers' || resource === 'container-detail') &&
        dockerScopedNodeIds(scopes, ['docker:containers:view']).includes(input.nodeId);
      if (!TokensService.hasScope(scopes, `${VIEW_SCOPE[resource]}:${input.nodeId}`) && !hasContainerChildAccess) {
        throw new AppError(403, 'FORBIDDEN', 'Missing required Docker node access scope');
      }
      if (resource === 'container-detail' && !(await canRefreshContainerDetail(scopes, input.nodeId, input.key!))) {
        throw new AppError(403, 'FORBIDDEN', 'Missing required Docker container access scope');
      }
      reconciler.enqueue({ nodeId: input.nodeId, kind: resource, key: input.key }, { urgent: true });
      return c.json({ accepted: true, nodeCount: 1 }, 202);
    }
    const listKind: DockerSnapshotKind =
      resource === 'container-detail' ? 'containers' : resource === 'volume-detail' ? 'volumes' : resource;
    const visibleNodes = await snapshots.listVisibleNodes(listKind, scopes);
    for (const node of visibleNodes) {
      if (resource === 'container-detail' && !(await canRefreshContainerDetail(scopes, node.id, input.key!))) {
        continue;
      }
      reconciler.enqueue({ nodeId: node.id, kind: resource, key: input.key }, { urgent: true });
    }
    return c.json({ accepted: true, nodeCount: visibleNodes.length }, 202);
  });
}
