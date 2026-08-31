import { OpenAPIHono } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeBase } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireScope, requireScopeForResource, sessionOnly } from '@/modules/auth/auth.middleware.js';
import {
  FileBrowseSchema,
  FileMoveSchema,
  FileUploadChunkQuerySchema,
  FileUploadCompleteSchema,
  FileUploadInitSchema,
} from '@/modules/docker/docker.schemas.js';
import { dockerScopedNodeIds } from '@/modules/docker/docker-access-resource.service.js';
import {
  daemonLogRelay,
  getDaemonLogHistory,
  getNginxLogHistory,
  logRelay,
  type RelayedDaemonLogEntry,
  type RelayedLogEntry,
} from '@/modules/monitoring/log-relay.service.js';
import { subscribeNginxHostLogs } from '@/modules/monitoring/nginx-log-subscriptions.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { AppEnv } from '@/types.js';
import { NodeFolderService } from './node-folders.service.js';
import { NodeMonitoringService } from './node-monitoring.service.js';
import {
  abortNodeFileUploadRoute,
  completeNodeFileUploadRoute,
  createNodeDirectoryRoute,
  createNodeFileRoute,
  createNodeFolderRoute,
  createNodeRoute,
  deleteNodeFileRoute,
  deleteNodeFolderRoute,
  deleteNodeRoute,
  getNodeBySlugRoute,
  getNodeConfigRoute,
  getNodeHealthHistoryRoute,
  getNodeRoute,
  initNodeFileUploadRoute,
  listNodeFilesRoute,
  listNodeFoldersRoute,
  listNodesRoute,
  moveNodeFileRoute,
  moveNodeFolderRoute,
  moveNodesToFolderRoute,
  nodeDaemonLogsRoute,
  nodeMonitoringStreamRoute,
  nodeNginxLogsRoute,
  readNodeFileRoute,
  reorderNodeFoldersRoute,
  reorderNodesRoute,
  testNodeConfigRoute,
  updateNodeConfigRoute,
  updateNodeFolderRoute,
  updateNodeRoute,
  updateNodeServiceCreationLockRoute,
  uploadNodeFileChunkRoute,
  writeNodeFileRoute,
} from './nodes.docs.js';
import {
  CreateNodeSchema,
  NodeListQuerySchema,
  UpdateNodeSchema,
  UpdateNodeServiceCreationLockSchema,
} from './nodes.schemas.js';
import { NodesService } from './nodes.service.js';

export const nodesRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

nodesRoutes.use('*', authMiddleware);

const NODE_FILE_LIST_MAX = 1000;

async function parseFileContentRequest(c: Parameters<Parameters<OpenAPIHono<AppEnv>['openapi']>[1]>[0]) {
  const path = FileBrowseSchema.parse(c.req.query()).path;
  const content = Buffer.from(await c.req.arrayBuffer());
  return { path, content };
}

const BROAD_DOCKER_VIEW_SCOPES = [
  'docker:containers:view',
  'docker:images:view',
  'docker:volumes:view',
  'docker:networks:view',
] as const;

const RESOURCE_SCOPED_DOCKER_NODE_SCOPES = [
  'docker:containers:view',
  'docker:containers:create',
  'docker:containers:manage',
  'docker:containers:config',
  'docker:containers:console',
  'docker:containers:migrate',
  'docker:containers:delete',
  'docker:containers:edit',
  'docker:containers:environment',
  'docker:containers:secrets',
  'docker:containers:files:read',
  'docker:containers:files:write',
  'docker:containers:export',
  'docker:containers:webhooks',
  'docker:containers:mounts',
  'docker:images:view',
  'docker:images:pull',
  'docker:images:delete',
  'docker:volumes:view',
  'docker:volumes:create',
  'docker:volumes:delete',
  'docker:volumes:files:read',
  'docker:volumes:files:write',
  'docker:networks:view',
  'docker:networks:create',
  'docker:networks:delete',
  'docker:networks:edit',
] as const;

function nginxLogEntryKey(entry: RelayedLogEntry): string {
  return [
    entry.hostId,
    entry.logType,
    entry.timestamp,
    entry.remoteAddr,
    entry.method,
    entry.path,
    entry.status,
    entry.bodyBytesSent,
    entry.raw,
    entry.level,
  ].join('\u0000');
}

function hasBroadDockerNodeListAccess(scopes: string[]) {
  return BROAD_DOCKER_VIEW_SCOPES.some((scope) => hasScope(scopes, scope));
}

function compactDockerNodeForDockerAccess(node: Record<string, unknown>) {
  const capabilities = node.capabilities as Record<string, unknown> | null | undefined;
  const health = node.lastHealthReport as Record<string, unknown> | null | undefined;
  const advertisedCapabilities = Array.isArray(capabilities?.capabilities) ? capabilities.capabilities : [];
  const networkInterfaces = Array.isArray(health?.networkInterfaces) ? health.networkInterfaces : [];
  return {
    id: node.id,
    slug: node.slug,
    type: node.type,
    hostname: node.hostname,
    displayName: node.displayName,
    appearanceColor: node.appearanceColor,
    serviceAddresses: node.serviceAddresses,
    serviceAddress: node.serviceAddress,
    secondaryServiceAddress: node.secondaryServiceAddress,
    effectiveServiceAddress: node.effectiveServiceAddress,
    status: node.status,
    serviceCreationLocked: node.serviceCreationLocked,
    daemonVersion: node.daemonVersion,
    osInfo: null,
    configVersionHash: null,
    capabilities: {
      ...(capabilities?.versionMismatch ? { versionMismatch: true } : {}),
      ...(capabilities?.cpuCores !== undefined ? { cpuCores: capabilities.cpuCores } : {}),
      ...(capabilities?.dockerRuntimeStatus ? { dockerRuntimeStatus: capabilities.dockerRuntimeStatus } : {}),
      ...(advertisedCapabilities.includes('docker_port_bind_ip_v1') ? { dockerPortBindIpV1: true } : {}),
      ...(advertisedCapabilities.includes('docker_volume_storage_images_v1')
        ? { dockerVolumeStorageImagesV1: true }
        : {}),
      ...(advertisedCapabilities.includes('nginx_pages_v1') ? { nginx_pages_v1: true } : {}),
      ...(advertisedCapabilities.includes('nginx_pages_config_v1') ? { nginx_pages_config_v1: true } : {}),
    },
    lastSeenAt: node.lastSeenAt,
    lastHealthReport: health
      ? {
          systemMemoryTotalBytes: health.systemMemoryTotalBytes,
          swapTotalBytes: health.swapTotalBytes,
          networkInterfaces: networkInterfaces.flatMap((value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
            const networkInterface = value as Record<string, unknown>;
            if (typeof networkInterface.name !== 'string') return [];
            return [
              {
                name: networkInterface.name,
                ipAddresses: Array.isArray(networkInterface.ipAddresses)
                  ? networkInterface.ipAddresses.filter((address): address is string => typeof address === 'string')
                  : [],
              },
            ];
          }),
        }
      : null,
    lastStatsReport: null,
    metadata: {},
    isConnected: node.isConnected,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

export function compactMonitoringHistorySnapshot(snapshot: any) {
  const health = snapshot?.health ?? {};
  const stats = snapshot?.stats ?? {};
  const traffic = snapshot?.traffic ?? null;
  return {
    timestamp: snapshot?.timestamp,
    health: {
      nginxRunning: health.nginxRunning,
      configValid: health.configValid,
      nginxUptimeSeconds: health.nginxUptimeSeconds,
      workerCount: health.workerCount,
      nginxVersion: health.nginxVersion,
      nginxRssBytes: health.nginxRssBytes,
      cpuPercent: health.cpuPercent,
      loadAverage1m: health.loadAverage1m,
      loadAverage5m: health.loadAverage5m,
      loadAverage15m: health.loadAverage15m,
      systemMemoryUsedBytes: health.systemMemoryUsedBytes,
      systemMemoryTotalBytes: health.systemMemoryTotalBytes,
      systemMemoryAvailableBytes: health.systemMemoryAvailableBytes,
      swapUsedBytes: health.swapUsedBytes,
      swapTotalBytes: health.swapTotalBytes,
      diskReadBytes: health.diskReadBytes,
      diskWriteBytes: health.diskWriteBytes,
      diskMounts: Array.isArray(health.diskMounts)
        ? health.diskMounts.map((mount: any) => ({
            mountPoint: mount.mountPoint,
            filesystem: mount.filesystem,
            device: mount.device,
            totalBytes: mount.totalBytes,
            usedBytes: mount.usedBytes,
            freeBytes: mount.freeBytes,
            usagePercent: mount.usagePercent,
          }))
        : undefined,
      diskUsagePercent: health.diskUsagePercent,
      networkRxBytes: health.networkRxBytes,
      networkTxBytes: health.networkTxBytes,
      networkInterfaces: health.networkInterfaces,
      gpuDevices: Array.isArray(health.gpuDevices) ? health.gpuDevices : undefined,
    },
    stats: {
      activeConnections: stats.activeConnections,
      accepts: stats.accepts,
      handled: stats.handled,
      requests: stats.requests,
      reading: stats.reading,
      writing: stats.writing,
      waiting: stats.waiting,
    },
    traffic,
  };
}

nodesRoutes.openapi(listNodesRoute, async (c) => {
  const service = container.resolve(NodesService);
  const query = NodeListQuerySchema.parse(c.req.query());
  const scopes = c.get('effectiveScopes') || [];
  const hasNodeDetails = hasScope(scopes, 'nodes:details');
  const canManageFolders = hasScope(scopes, 'nodes:folders:manage');
  const allowedNodeIds = getResourceScopedIds(scopes, 'nodes:details');
  const allowedDockerNodeIds =
    query.type === 'docker' ? dockerScopedNodeIds(scopes, RESOURCE_SCOPED_DOCKER_NODE_SCOPES) : [];
  const canListAllDockerNodes = query.type === 'docker' && hasBroadDockerNodeListAccess(scopes);
  const canListDockerNodes = canListAllDockerNodes || allowedDockerNodeIds.length > 0;
  const allowedIngressNodeIds = query.type === 'nginx' ? getResourceScopedIds(scopes, 'proxy:create') : [];
  const canListAllIngressNodes = query.type === 'nginx' && hasScope(scopes, 'proxy:create');
  const canListIngressNodes = canListAllIngressNodes || allowedIngressNodeIds.length > 0;
  if (
    !hasNodeDetails &&
    !canManageFolders &&
    allowedNodeIds.length === 0 &&
    !canListDockerNodes &&
    !canListIngressNodes
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Missing required node access scope');
  }
  const scopedNodeIds =
    query.type === 'docker' && !canListAllDockerNodes
      ? [...new Set([...allowedNodeIds, ...allowedDockerNodeIds])]
      : query.type === 'nginx' && !canListAllIngressNodes
        ? [...new Set([...allowedNodeIds, ...allowedIngressNodeIds])]
        : allowedNodeIds;
  const result = await service.list(
    query,
    hasNodeDetails || canManageFolders || canListAllDockerNodes || canListAllIngressNodes
      ? undefined
      : { allowedIds: scopedNodeIds }
  );
  if (query.type === 'docker' && canListDockerNodes && !hasNodeDetails) {
    return c.json({ ...result, data: result.data.map((node) => compactDockerNodeForDockerAccess(node as any)) });
  }
  if (query.type === 'nginx' && canListIngressNodes && !hasNodeDetails && !canManageFolders) {
    return c.json({ ...result, data: result.data.map((node) => compactDockerNodeForDockerAccess(node as any)) });
  }
  return c.json(result);
});

nodesRoutes.openapi(listNodeFoldersRoute, async (c) => {
  const service = container.resolve(NodeFolderService);
  const scopes = c.get('effectiveScopes') || [];
  const canManageFolders = hasScope(scopes, 'nodes:folders:manage');
  const hasNodeDetails = hasScope(scopes, 'nodes:details');
  const allowedNodeIds = getResourceScopedIds(scopes, 'nodes:details');
  if (!canManageFolders && !hasScopeBase(scopes, 'nodes:details')) {
    throw new AppError(403, 'FORBIDDEN', 'Missing required scope: nodes:details or nodes:folders:manage');
  }
  const data = await service.getFolderTree(
    canManageFolders || hasNodeDetails
      ? { includeAllFolders: canManageFolders }
      : { allowedResourceIds: allowedNodeIds }
  );
  return c.json({ data });
});

nodesRoutes.openapi({ ...createNodeFolderRoute, middleware: requireScope('nodes:folders:manage') }, async (c) => {
  const service = container.resolve(NodeFolderService);
  const user = c.get('user')!;
  const input = CreateResourceFolderSchema.parse(await c.req.json());
  const data = await service.createFolder(input, user.id);
  return c.json({ data }, 201);
});

nodesRoutes.openapi({ ...reorderNodeFoldersRoute, middleware: requireScope('nodes:folders:manage') }, async (c) => {
  const service = container.resolve(NodeFolderService);
  const input = ReorderResourceFoldersSchema.parse(await c.req.json());
  await service.reorderFolders(input);
  return c.json({ success: true });
});

nodesRoutes.openapi({ ...moveNodesToFolderRoute, middleware: requireScope('nodes:folders:manage') }, async (c) => {
  const service = container.resolve(NodeFolderService);
  const user = c.get('user')!;
  const input = MoveResourcesToFolderSchema.parse(await c.req.json());
  await service.moveResourcesToFolder(input, user.id);
  return c.json({ success: true });
});

nodesRoutes.openapi({ ...reorderNodesRoute, middleware: requireScope('nodes:folders:manage') }, async (c) => {
  const service = container.resolve(NodeFolderService);
  const input = ReorderResourcesSchema.parse(await c.req.json());
  await service.reorderResources(input);
  return c.json({ success: true });
});

nodesRoutes.openapi({ ...updateNodeFolderRoute, middleware: requireScope('nodes:folders:manage') }, async (c) => {
  const service = container.resolve(NodeFolderService);
  const user = c.get('user')!;
  const input = UpdateResourceFolderSchema.parse(await c.req.json());
  const data = await service.updateFolder(c.req.param('id')!, input, user.id);
  return c.json({ data });
});

nodesRoutes.openapi({ ...moveNodeFolderRoute, middleware: requireScope('nodes:folders:manage') }, async (c) => {
  const service = container.resolve(NodeFolderService);
  const user = c.get('user')!;
  const input = MoveResourceFolderSchema.parse(await c.req.json());
  const data = await service.moveFolder(c.req.param('id')!, input, user.id);
  return c.json({ data });
});

nodesRoutes.openapi({ ...deleteNodeFolderRoute, middleware: requireScope('nodes:folders:manage') }, async (c) => {
  const service = container.resolve(NodeFolderService);
  const user = c.get('user')!;
  await service.deleteFolder(c.req.param('id')!, user.id);
  return c.json({ success: true });
});

nodesRoutes.openapi(getNodeBySlugRoute, async (c) => {
  const service = container.resolve(NodesService);
  const node = await service.getBySlug(c.req.param('slug')!);
  const scopes = c.get('effectiveScopes') || [];
  if (!hasScope(scopes, `nodes:details:${node.id}`)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: nodes:details:${node.id}`);
  }
  return c.json({ data: node });
});

nodesRoutes.openapi({ ...getNodeRoute, middleware: requireScopeForResource('nodes:details', 'id') }, async (c) => {
  const service = container.resolve(NodesService);
  const id = c.req.param('id')!;
  const node = await service.get(id);
  return c.json({ data: node });
});

nodesRoutes.openapi(
  { ...getNodeHealthHistoryRoute, middleware: requireScopeForResource('nodes:details', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const healthHistory = await service.getHealthHistory(id);
    return c.json({ data: healthHistory });
  }
);

nodesRoutes.openapi(
  { ...listNodeFilesRoute, middleware: requireScopeForResource('nodes:files:read', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const { path } = FileBrowseSchema.parse(c.req.query());
    const data = await service.listFiles(id, path);
    const truncated = Array.isArray(data) && data.length > NODE_FILE_LIST_MAX;
    return c.json({
      data: truncated ? data.slice(0, NODE_FILE_LIST_MAX) : data,
      total: Array.isArray(data) ? data.length : undefined,
      limit: NODE_FILE_LIST_MAX,
      truncated,
    });
  }
);

nodesRoutes.openapi(
  { ...readNodeFileRoute, middleware: requireScopeForResource('nodes:files:read', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const { path } = FileBrowseSchema.parse(c.req.query());
    const data = await service.readFile(id, path);
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.byteLength),
      },
    });
  }
);

nodesRoutes.openapi(
  { ...writeNodeFileRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const user = c.get('user')!;
    const { path, content } = await parseFileContentRequest(c);
    await service.writeFile(id, path, content, user.id);
    return c.json({ success: true });
  }
);

nodesRoutes.openapi(
  { ...createNodeFileRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const user = c.get('user')!;
    const { path, content } = await parseFileContentRequest(c);
    await service.createFile(id, path, content, user.id);
    return c.json({ success: true });
  }
);

nodesRoutes.openapi(
  { ...initNodeFileUploadRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const user = c.get('user')!;
    const { path, totalBytes } = FileUploadInitSchema.parse(await c.req.json());
    const data = await service.initFileUpload(id, path, totalBytes, user.id);
    return c.json({ data });
  }
);

nodesRoutes.openapi(
  { ...uploadNodeFileChunkRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const uploadId = c.req.param('uploadId')!;
    const { offset } = FileUploadChunkQuerySchema.parse(c.req.query());
    const content = Buffer.from(await c.req.arrayBuffer());
    const data = await service.appendFileUploadChunk(id, uploadId, offset, content);
    return c.json({ data });
  }
);

nodesRoutes.openapi(
  { ...completeNodeFileUploadRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const uploadId = c.req.param('uploadId')!;
    const { path, totalBytes } = FileUploadCompleteSchema.parse(await c.req.json());
    await service.completeFileUpload(id, uploadId, path, totalBytes);
    return c.json({ success: true });
  }
);

nodesRoutes.openapi(
  { ...abortNodeFileUploadRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const uploadId = c.req.param('uploadId')!;
    await service.abortFileUpload(id, uploadId);
    return c.json({ success: true });
  }
);

nodesRoutes.openapi(
  { ...createNodeDirectoryRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const user = c.get('user')!;
    const { path } = FileBrowseSchema.parse(await c.req.json());
    await service.createDirectory(id, path, user.id);
    return c.json({ success: true });
  }
);

nodesRoutes.openapi(
  { ...deleteNodeFileRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const user = c.get('user')!;
    const { path } = FileBrowseSchema.parse(c.req.query());
    await service.deleteFile(id, path, user.id);
    return c.json({ success: true });
  }
);

nodesRoutes.openapi(
  { ...moveNodeFileRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const user = c.get('user')!;
    const { fromPath, toPath } = FileMoveSchema.parse(await c.req.json());
    await service.moveFile(id, fromPath, toPath, user.id);
    return c.json({ success: true });
  }
);

nodesRoutes.openapi({ ...createNodeRoute, middleware: requireScope('nodes:create') }, async (c) => {
  const service = container.resolve(NodesService);
  const user = c.get('user')!;
  const input = CreateNodeSchema.parse(await c.req.json());
  const result = await service.create(input, user.id);
  return c.json({ data: result }, 201);
});

nodesRoutes.openapi({ ...updateNodeRoute, middleware: requireScopeForResource('nodes:rename', 'id') }, async (c) => {
  const service = container.resolve(NodesService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const input = UpdateNodeSchema.parse(await c.req.json());
  const scopes = c.get('effectiveScopes') || [];
  if (
    input.serviceAddresses !== undefined ||
    input.serviceAddress !== undefined ||
    input.secondaryServiceAddress !== undefined
  ) {
    const current = await service.get(id);
    if (current.type === 'docker' && !hasScope(scopes, `docker:containers:config:${id}`)) {
      throw new AppError(403, 'FORBIDDEN', 'Editing the Docker service address requires Docker config access');
    }
    if (current.type === 'nginx' && !hasScope(scopes, `nodes:config:edit:${id}`)) {
      throw new AppError(403, 'FORBIDDEN', 'Editing the Nginx service address requires node config edit access');
    }
    if (current.type === 'nginx' && input.confirmDomainDnsUpdate && !hasScope(scopes, 'domains:edit')) {
      throw new AppError(403, 'FORBIDDEN', 'Updating assigned domain DNS targets requires domain edit access');
    }
    if (current.type !== 'docker' && current.type !== 'databases' && current.type !== 'nginx') {
      throw new AppError(
        400,
        'INVALID_SERVICE_ADDRESS_NODE',
        'Service address is only supported for Docker, database, and Nginx nodes'
      );
    }
    if (input.secondaryServiceAddress !== undefined && current.type !== 'nginx') {
      throw new AppError(
        400,
        'INVALID_SECONDARY_SERVICE_ADDRESS_NODE',
        'Secondary service address is only supported for Nginx nodes'
      );
    }
  }
  const node = await service.update(id, input, user.id);
  return c.json({ data: node });
});

nodesRoutes.openapi(
  { ...updateNodeServiceCreationLockRoute, middleware: requireScopeForResource('nodes:lock', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    const input = UpdateNodeServiceCreationLockSchema.parse(await c.req.json());
    const node = await service.updateServiceCreationLock(id, input, user.id);
    return c.json({ data: node });
  }
);

nodesRoutes.openapi({ ...deleteNodeRoute, middleware: requireScopeForResource('nodes:delete', 'id') }, async (c) => {
  const service = container.resolve(NodesService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  await service.remove(id, user.id, { cascadeOfflineProxyHosts: c.req.query('cascadeProxyHosts') === 'true' });
  return c.json({ success: true });
});

// Helper: check node type is nginx before nginx-specific operations
async function requireNginxNode(c: any): Promise<boolean> {
  const service = container.resolve(NodesService);
  const id = c.req.param('id')!;
  try {
    const node = await service.get(id);
    if (node.type !== 'nginx') {
      c.json({ code: 'NOT_NGINX', message: 'This operation is only available for nginx nodes' }, 400);
      return false;
    }
    return true;
  } catch {
    return true; // let the downstream handler produce the 404
  }
}

nodesRoutes.openapi({ ...getNodeConfigRoute, middleware: sessionOnly }, async (c) => {
  const requiredScope = `nodes:config:view:${c.req.param('id')!}`;
  if (!hasScope(c.get('effectiveScopes') || [], requiredScope)) {
    return c.json({ message: `Missing required scope: ${requiredScope}` }, 403);
  }
  if (!(await requireNginxNode(c))) return c.body(null);
  const { NodeDispatchService } = await import('@/services/node-dispatch.service.js');
  const dispatch = container.resolve(NodeDispatchService);
  const nodeId = c.req.param('id')!;
  const result = await dispatch.readGlobalConfig(nodeId);
  if (!result.success) {
    return c.json({ code: 'DISPATCH_ERROR', message: result.error || 'Failed to read config' }, 502);
  }
  return c.json({ data: { content: result.detail } });
});

nodesRoutes.openapi({ ...updateNodeConfigRoute, middleware: sessionOnly }, async (c) => {
  const requiredScope = `nodes:config:edit:${c.req.param('id')!}`;
  if (!hasScope(c.get('effectiveScopes') || [], requiredScope)) {
    return c.json({ message: `Missing required scope: ${requiredScope}` }, 403);
  }
  if (!(await requireNginxNode(c))) return c.body(null);
  const { NodeDispatchService } = await import('@/services/node-dispatch.service.js');
  const dispatch = container.resolve(NodeDispatchService);
  const nodeId = c.req.param('id')!;
  const body = await c.req.json<{ content: string }>();
  if (!body.content || typeof body.content !== 'string') {
    return c.json({ code: 'INVALID_BODY', message: 'content is required' }, 400);
  }
  if (body.content.length > 1_048_576) {
    return c.json({ data: { valid: false, error: 'Config exceeds 1MB limit' } }, 422);
  }
  const result = await dispatch.updateGlobalConfig(nodeId, body.content, '');
  if (!result.success) {
    return c.json({ data: { valid: false, error: result.error } }, 422);
  }
  return c.json({ data: { valid: true } });
});

// Test node's nginx config on the target node daemon.
// Do not run a backend-local nginx -t first, because node configs can contain
// valid host-specific includes/paths that do not exist inside the Gateway container.
nodesRoutes.openapi({ ...testNodeConfigRoute, middleware: sessionOnly }, async (c) => {
  const requiredScope = `nodes:config:edit:${c.req.param('id')!}`;
  if (!hasScope(c.get('effectiveScopes') || [], requiredScope)) {
    return c.json({ message: `Missing required scope: ${requiredScope}` }, 403);
  }
  if (!(await requireNginxNode(c))) return c.body(null);
  const { NodeDispatchService } = await import('@/services/node-dispatch.service.js');
  const dispatch = container.resolve(NodeDispatchService);
  const nodeId = c.req.param('id')!;
  await c.req.json<{ content?: string }>().catch(() => ({}) as { content?: string });

  // Remote test via daemon (tests the deployed config in the node environment)
  const result = await dispatch.testConfig(nodeId);
  return c.json({ data: { valid: result.success, error: result.error || undefined } });
});

// Node monitoring SSE stream — 5s for generic consumers, 2s for a focused Monitoring tab
nodesRoutes.openapi(
  { ...nodeMonitoringStreamRoute, middleware: requireScopeForResource('nodes:details', 'id') },
  async (c) => {
    const nodeId = c.req.param('id')!;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nodeId)) {
      return c.json({ code: 'INVALID_ID', message: 'Invalid node ID' }, 400);
    }

    const monitoringService = container.resolve(NodeMonitoringService);
    const focused = c.req.query('focused') === 'true';

    return streamSSE(c, async (stream) => {
      monitoringService.registerClient(nodeId, { focused });

      const history = monitoringService.getHistory(nodeId);
      await stream.writeSSE({
        data: JSON.stringify({ connected: true, nodeId, history: history.map(compactMonitoringHistorySnapshot) }),
        event: 'connected',
      });
      await stream.sleep(0);

      let _running = true;

      const onSnapshot = (data: { nodeId: string; snapshot: any }) => {
        if (data.nodeId === nodeId) {
          stream.writeSSE({ data: JSON.stringify(data.snapshot), event: 'snapshot' }).catch(() => {});
        }
      };
      monitoringService.on('snapshot', onSnapshot);

      const keepalive = setInterval(() => {
        stream.writeSSE({ data: '', event: 'ping' }).catch(() => clearInterval(keepalive));
      }, 30_000);

      stream.onAbort(() => {
        _running = false;
        clearInterval(keepalive);
        monitoringService.off('snapshot', onSnapshot);
        monitoringService.unregisterClient(nodeId, { focused });
      });

      await new Promise(() => {});
    });
  }
);

// Daemon logs SSE stream for a specific node
// Query params: ?level=info,warn,error  &search=keyword
nodesRoutes.openapi({ ...nodeDaemonLogsRoute, middleware: requireScopeForResource('nodes:logs', 'id') }, async (c) => {
  const nodeId = c.req.param('id')!;
  const levelFilter =
    c.req
      .query('level')
      ?.split(',')
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean) ?? [];
  const searchFilter = c.req.query('search')?.toLowerCase() ?? '';

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nodeId)) {
    return c.json({ code: 'INVALID_ID', message: 'Invalid node ID' }, 400);
  }

  const matchesFilter = (entry: RelayedDaemonLogEntry): boolean => {
    if (levelFilter.length > 0 && !levelFilter.includes((entry.level || '').toLowerCase())) return false;
    if (
      searchFilter &&
      !entry.message?.toLowerCase().includes(searchFilter) &&
      !entry.component?.toLowerCase().includes(searchFilter)
    )
      return false;
    return true;
  };

  return streamSSE(c, async (stream) => {
    // Send buffered history (filtered)
    const history = getDaemonLogHistory(nodeId).filter(matchesFilter).slice(-300);
    await stream.writeSSE({
      data: JSON.stringify({ connected: true, nodeId, historyCount: history.length }),
      event: 'connected',
    });
    for (const entry of history) {
      await stream.writeSSE({ data: JSON.stringify(entry), event: 'log' });
    }
    await stream.sleep(0);

    const onLog = (entry: RelayedDaemonLogEntry) => {
      if (entry.nodeId === nodeId && matchesFilter(entry)) {
        stream.writeSSE({ data: JSON.stringify(entry), event: 'log' }).catch(() => {});
      }
    };
    daemonLogRelay.on('log', onLog);

    const keepalive = setInterval(() => {
      stream.writeSSE({ data: '', event: 'ping' }).catch(() => clearInterval(keepalive));
    }, 30_000);

    stream.onAbort(() => {
      clearInterval(keepalive);
      daemonLogRelay.off('log', onLog);
    });

    await new Promise(() => {});
  });
});

// Nginx access logs SSE stream for all hosts on a node
// Query params: ?search=keyword&status=2xx,4xx,5xx
nodesRoutes.openapi({ ...nodeNginxLogsRoute, middleware: requireScopeForResource('nodes:logs', 'id') }, async (c) => {
  if (!(await requireNginxNode(c))) return c.body(null);
  const nodeId = c.req.param('id')!;
  const searchFilter = c.req.query('search')?.toLowerCase() ?? '';
  const statusFilter =
    c.req
      .query('status')
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? [];

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nodeId)) {
    return c.json({ code: 'INVALID_ID', message: 'Invalid node ID' }, 400);
  }

  // Get all host IDs assigned to this node
  const { eq } = await import('drizzle-orm');
  const { proxyHosts } = await import('@/db/schema/index.js');
  const { TOKENS } = await import('@/container.js');
  const db = container.resolve(TOKENS.DrizzleClient) as any;
  const hosts = await db.select({ id: proxyHosts.id }).from(proxyHosts).where(eq(proxyHosts.nodeId, nodeId));
  const visibleHostIds = new Set<string>(hosts.map((h: any) => h.id as string));

  const matchesFilter = (entry: RelayedLogEntry): boolean => {
    if (!visibleHostIds.has(entry.hostId)) return false;
    if (
      searchFilter &&
      !entry.path?.toLowerCase().includes(searchFilter) &&
      !entry.remoteAddr?.includes(searchFilter) &&
      !entry.raw?.toLowerCase().includes(searchFilter)
    )
      return false;
    if (statusFilter.length > 0) {
      const code = entry.status;
      const isError = entry.logType === 'error';
      const matches = statusFilter.some((f) => {
        if (f === 'error') return isError;
        if (isError) return false;
        if (f === '2xx') return code >= 200 && code < 300;
        if (f === '3xx') return code >= 300 && code < 400;
        if (f === '4xx') return code >= 400 && code < 500;
        if (f === '5xx') return code >= 500;
        return false;
      });
      if (!matches) return false;
    }
    return true;
  };

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      data: JSON.stringify({ connected: true, nodeId, hostCount: visibleHostIds.size }),
      event: 'connected',
    });

    if (visibleHostIds.size === 0) {
      await stream.writeSSE({
        data: JSON.stringify({ message: 'No proxy hosts are assigned to this nginx node' }),
        event: 'log-error',
      });
    }

    const nodeRegistry = container.resolve(NodeRegistryService);
    const sentKeys = new Set<string>();
    const writeLog = async (entry: RelayedLogEntry) => {
      if (entry.nodeId !== nodeId) return;
      if (!matchesFilter(entry)) return;
      const key = nginxLogEntryKey(entry);
      if (sentKeys.has(key)) return;
      sentKeys.add(key);
      await stream.writeSSE({ data: JSON.stringify(entry), event: 'log' });
    };

    const onLog = (entry: RelayedLogEntry) => {
      writeLog(entry).catch(() => {});
    };
    logRelay.on('log', onLog);

    for (const hostId of visibleHostIds) {
      for (const entry of getNginxLogHistory(hostId)) {
        await writeLog(entry);
      }
    }

    const subscriptions = Array.from(visibleHostIds, (hostId) =>
      subscribeNginxHostLogs(nodeRegistry, nodeId, hostId, 200)
    );
    const subscriptionErrors = subscriptions.filter((subscription) => !subscription.ok);
    if (visibleHostIds.size > 0 && subscriptionErrors.length === subscriptions.length) {
      await stream.writeSSE({
        data: JSON.stringify({ message: subscriptionErrors[0]?.message ?? 'Nginx log stream is not connected' }),
        event: 'log-error',
      });
    }

    const keepalive = setInterval(() => {
      stream.writeSSE({ data: '', event: 'ping' }).catch(() => clearInterval(keepalive));
    }, 30_000);

    stream.onAbort(() => {
      clearInterval(keepalive);
      logRelay.off('log', onLog);
      for (const subscription of subscriptions) {
        if (subscription.ok) subscription.cleanup();
      }
    });

    await new Promise(() => {});
  });
});
