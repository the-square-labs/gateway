import type { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { container } from '@/container.js';
import { sanitizeFilename } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import { requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import type { AppEnv } from '@/types.js';
import { assertComposeVolumeMutationAllowed } from './compose/compose-child.guard.js';
import { isComposeOwnedVolume } from './compose/compose-discovery.service.js';
import {
  abortVolumeFileUploadRoute,
  adoptVolumeRoute,
  completeVolumeFileUploadRoute,
  createVolumeDirectoryRoute,
  createVolumeFileRoute,
  createVolumeRoute,
  deleteVolumeFileRoute,
  exportVolumeRoute,
  getVolumeMetricsRoute,
  initVolumeFileUploadRoute,
  inspectVolumeRoute,
  listManagedVolumeOptionsRoute,
  listVolumeFilesRoute,
  listVolumesRoute,
  moveVolumeFileRoute,
  readVolumeFileRoute,
  removeVolumeRoute,
  renameVolumeRoute,
  resizeVolumeRoute,
  updateVolumeLabelsRoute,
  uploadVolumeFileChunkRoute,
  writeVolumeFileRoute,
} from './docker.docs.js';
import {
  FileBrowseSchema,
  FileMoveSchema,
  FileUploadChunkQuerySchema,
  FileUploadCompleteSchema,
  FileUploadInitSchema,
  VolumeCreateSchema,
  VolumeLabelsUpdateSchema,
  VolumeRenameSchema,
  VolumeResizeSchema,
} from './docker.schemas.js';
import { DockerManagementService } from './docker.service.js';
import { resolveDockerVolumeByName } from './docker-route-resolvers.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';
import { DockerSnapshotReconciler } from './docker-snapshot-reconciler.service.js';

const DOCKER_RESOURCE_LIST_MAX = 1000;
const DOCKER_VOLUME_USED_BY_PREVIEW_MAX = 100;

export function compactVolumeListItem(volume: Record<string, any>) {
  const usedBy = volume.usedBy ?? volume.UsedBy;
  return {
    name: volume.name ?? volume.Name,
    driver: volume.driver ?? volume.Driver,
    mountpoint: volume.mountpoint ?? volume.Mountpoint,
    scope: volume.scope ?? volume.Scope,
    managementState: volume.managementState,
    storageKind: volume.storageKind,
    capacityBytes: volume.capacityBytes,
    usedBytes: volume.usedBytes ?? null,
    adoptable: Boolean(volume.adoptable),
    adoptionReason: volume.adoptionReason,
    availability: volume.availability,
    createdAt: volume.createdAt ?? volume.CreatedAt,
    usedBy: Array.isArray(usedBy) ? usedBy.slice(0, DOCKER_VOLUME_USED_BY_PREVIEW_MAX) : usedBy,
    usedByCount: Array.isArray(usedBy) ? usedBy.length : undefined,
    usedByTruncated: Array.isArray(usedBy) && usedBy.length > DOCKER_VOLUME_USED_BY_PREVIEW_MAX,
  };
}

export function normalizeVolumeDetailItem(volume: Record<string, any>) {
  const usedBy = volume.usedBy ?? volume.UsedBy;
  const normalizedUsedBy = Array.isArray(usedBy) ? usedBy : [];
  return {
    name: volume.name ?? volume.Name,
    driver: volume.driver ?? volume.Driver,
    mountpoint: volume.mountpoint ?? volume.Mountpoint,
    labels: volume.labels ?? volume.Labels ?? {},
    options: volume.options ?? volume.Options ?? {},
    scope: volume.scope ?? volume.Scope,
    managementState: volume.managementState,
    storageKind: volume.storageKind,
    capacityBytes: volume.capacityBytes,
    adoptable: Boolean(volume.adoptable),
    adoptionReason: volume.adoptionReason,
    availability: volume.availability,
    createdAt: volume.createdAt ?? volume.CreatedAt,
    usedBy: normalizedUsedBy,
    usedByCount: normalizedUsedBy.length,
    usedByTruncated: false,
  };
}

export function matchesVolumeSearch(volume: Record<string, any>, search: string | undefined) {
  if (!search) return true;
  const usedBy = volume.usedBy ?? volume.UsedBy;
  const haystack = [
    volume.name ?? volume.Name,
    volume.driver ?? volume.Driver,
    volume.mountpoint ?? volume.Mountpoint,
    volume.scope ?? volume.Scope,
    ...(Array.isArray(usedBy) ? usedBy : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(search);
}

async function parseFileContentRequest(c: Parameters<Parameters<OpenAPIHono<AppEnv>['openapi']>[1]>[0]) {
  const path = FileBrowseSchema.parse(c.req.query()).path;
  const content = Buffer.from(await c.req.arrayBuffer());
  return { path, content };
}

export function registerVolumeRoutes(router: OpenAPIHono<AppEnv>) {
  // ─── Volume routes ───────────────────────────────────────────────────

  router.openapi(
    {
      ...listManagedVolumeOptionsRoute,
      middleware: requireScopeForResource('docker:containers:mounts', 'nodeId'),
    },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      return c.json({ data: await service.listManagedVolumeOptions(nodeId) });
    }
  );

  // List volumes
  router.openapi(
    { ...listVolumesRoute, middleware: requireScopeForResource('docker:volumes:view', 'nodeId') },
    async (c) => {
      const snapshots = container.resolve(DockerSnapshotService);
      const nodeId = c.req.param('nodeId')!;
      await snapshots.assertDockerNode(nodeId);
      const snapshot = await snapshots.getList<any[]>(nodeId, 'volumes');
      const containerSnapshot = await snapshots.getList<any[]>(nodeId, 'containers');
      const data = await container
        .resolve(DockerManagementService)
        .decoratePublicVolumeSnapshot(
          nodeId,
          Array.isArray(snapshot.data) ? snapshot.data : [],
          Array.isArray(containerSnapshot.data) ? containerSnapshot.data : []
        );
      if (!Array.isArray(data)) return c.json({ data });
      const metrics = await snapshots.getDetails<{ usedBytes?: number | null }>(nodeId, 'volume-metrics');
      const search = c.req.query('search')?.trim().toLowerCase();
      const compacted = data
        .filter((item) => !isComposeOwnedVolume(item))
        .filter((item) => matchesVolumeSearch(item, search))
        .map((item) => {
          const name = String(item.name ?? item.Name ?? '');
          return {
            ...compactVolumeListItem({ ...item, usedBytes: metrics[name]?.data?.usedBytes ?? null }),
            nodeId,
            availability: snapshots.availability(nodeId, snapshot),
          };
        });
      const truncated = compacted.length > DOCKER_RESOURCE_LIST_MAX;
      return c.json({
        data: truncated ? compacted.slice(0, DOCKER_RESOURCE_LIST_MAX) : compacted,
        total: compacted.length,
        limit: DOCKER_RESOURCE_LIST_MAX,
        truncated,
      });
    }
  );

  // Inspect volume
  router.openapi(
    { ...inspectVolumeRoute, middleware: requireScopeForResource('docker:volumes:view', 'nodeId') },
    async (c) => {
      const snapshots = container.resolve(DockerSnapshotService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const detail = await snapshots.getDetail(nodeId, 'volume-detail', name);
      const data = await resolveDockerVolumeByName({ inspectVolume: async () => detail?.data }, nodeId, name);
      const containerSnapshot = await snapshots.getList<any[]>(nodeId, 'containers');
      const [decorated] = await container
        .resolve(DockerManagementService)
        .decoratePublicVolumeSnapshot(
          nodeId,
          [data],
          Array.isArray(containerSnapshot.data) ? containerSnapshot.data : []
        );
      if (!decorated) throw new HTTPException(404, { message: 'Volume not found' });
      return c.json({
        data: {
          ...normalizeVolumeDetailItem(decorated),
          nodeId,
          availability: detail ? snapshots.availability(nodeId, detail) : 'unavailable',
        },
      });
    }
  );

  // List volume files
  router.openapi(
    { ...listVolumeFilesRoute, middleware: requireScopeForResource('docker:volumes:files:read', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const rawQuery = Object.fromEntries(new URL(c.req.url).searchParams.entries());
      const { path } = FileBrowseSchema.parse(rawQuery);
      const data = await service.listVolumeFiles(nodeId, name, path);
      return c.json({ data });
    }
  );

  router.openapi(
    { ...readVolumeFileRoute, middleware: requireScopeForResource('docker:volumes:files:read', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const rawQuery = Object.fromEntries(new URL(c.req.url).searchParams.entries());
      const { path } = FileBrowseSchema.parse(rawQuery);
      const data = await service.readVolumeFile(nodeId, name, path);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(data.byteLength),
        },
      });
    }
  );

  router.openapi(
    { ...writeVolumeFileRoute, middleware: requireScopeForResource('docker:volumes:files:write', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { path, content } = await parseFileContentRequest(c);
      await service.writeVolumeFile(nodeId, name, path, content, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...createVolumeFileRoute, middleware: requireScopeForResource('docker:volumes:files:write', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { path, content } = await parseFileContentRequest(c);
      await service.createVolumeFile(nodeId, name, path, content, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...initVolumeFileUploadRoute, middleware: requireScopeForResource('docker:volumes:files:write', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { path, totalBytes } = FileUploadInitSchema.parse(await c.req.json());
      const data = await service.initVolumeFileUpload(nodeId, name, path, totalBytes, user.id);
      return c.json({ data });
    }
  );

  router.openapi(
    { ...uploadVolumeFileChunkRoute, middleware: requireScopeForResource('docker:volumes:files:write', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const uploadId = c.req.param('uploadId')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { offset } = FileUploadChunkQuerySchema.parse(c.req.query());
      const content = Buffer.from(await c.req.arrayBuffer());
      const data = await service.appendVolumeFileUploadChunk(nodeId, name, uploadId, offset, content);
      return c.json({ data });
    }
  );

  router.openapi(
    { ...completeVolumeFileUploadRoute, middleware: requireScopeForResource('docker:volumes:files:write', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const uploadId = c.req.param('uploadId')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { path, totalBytes } = FileUploadCompleteSchema.parse(await c.req.json());
      await service.completeVolumeFileUpload(nodeId, name, uploadId, path, totalBytes);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...abortVolumeFileUploadRoute, middleware: requireScopeForResource('docker:volumes:files:write', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const uploadId = c.req.param('uploadId')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      await service.abortVolumeFileUpload(nodeId, name, uploadId);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...createVolumeDirectoryRoute, middleware: requireScopeForResource('docker:volumes:files:write', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { path } = FileBrowseSchema.parse(await c.req.json());
      await service.createVolumeDirectory(nodeId, name, path, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...deleteVolumeFileRoute, middleware: requireScopeForResource('docker:volumes:files:write', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const rawQuery = Object.fromEntries(new URL(c.req.url).searchParams.entries());
      const { path } = FileBrowseSchema.parse(rawQuery);
      await service.deleteVolumeFile(nodeId, name, path, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...moveVolumeFileRoute, middleware: requireScopeForResource('docker:volumes:files:write', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { fromPath, toPath } = FileMoveSchema.parse(await c.req.json());
      await service.moveVolumeFile(nodeId, name, fromPath, toPath, user.id);
      return c.json({ success: true });
    }
  );

  // Export volume
  router.openapi(
    { ...exportVolumeRoute, middleware: requireScopeForResource('docker:volumes:export', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const data = await service.exportVolume(nodeId, name);
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="${sanitizeFilename(name)}.tar.gz"`,
        },
      });
    }
  );

  // Rename volume
  router.openapi(
    { ...renameVolumeRoute, middleware: requireScopeForResource('docker:volumes:create', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const scopes = c.get('effectiveScopes') ?? [];
      if (!TokensService.hasScope(scopes, `docker:volumes:delete:${nodeId}`)) {
        throw new HTTPException(403, { message: `Missing required scope: docker:volumes:delete:${nodeId}` });
      }
      const body = await c.req.json();
      const { name: newName } = VolumeRenameSchema.parse(body);
      await service.renameVolume(nodeId, name, newName, user.id);
      return c.json({ success: true });
    }
  );

  // Update volume labels
  router.openapi(
    { ...updateVolumeLabelsRoute, middleware: requireScopeForResource('docker:volumes:create', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const scopes = c.get('effectiveScopes') ?? [];
      if (!TokensService.hasScope(scopes, `docker:volumes:delete:${nodeId}`)) {
        throw new HTTPException(403, { message: `Missing required scope: docker:volumes:delete:${nodeId}` });
      }
      const body = await c.req.json();
      const { labels } = VolumeLabelsUpdateSchema.parse(body);
      await service.updateVolumeLabels(nodeId, name, labels, user.id);
      return c.json({ success: true });
    }
  );

  // Create volume
  router.openapi(
    { ...createVolumeRoute, middleware: requireScopeForResource('docker:volumes:create', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const user = c.get('user')!;
      const body = await c.req.json();
      const config = VolumeCreateSchema.parse(body);
      const data = await service.createVolume(nodeId, config, user.id);
      return c.json({ data }, 201);
    }
  );

  router.openapi(
    { ...getVolumeMetricsRoute, middleware: requireScopeForResource('docker:volumes:view', 'nodeId') },
    async (c) => {
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const snapshots = container.resolve(DockerSnapshotService);
      await snapshots.assertDockerNode(nodeId);
      const volumes = await snapshots.getList<Array<Record<string, unknown>>>(nodeId, 'volumes');
      const exists = volumes.data.some((volume) => String(volume.name ?? volume.Name ?? '') === name);
      if (!exists) throw new AppError(404, 'VOLUME_NOT_FOUND', 'Volume not found');
      const metrics = await snapshots.getDetail(nodeId, 'volume-metrics', name);
      if (!metrics?.data) {
        container
          .resolve(DockerSnapshotReconciler)
          .enqueue({ nodeId, kind: 'volume-metrics', key: name }, { urgent: true });
        throw new AppError(
          503,
          'DOCKER_VOLUME_METRICS_PENDING',
          'Volume metrics are being collected in the background'
        );
      }
      return c.json({ data: metrics.data });
    }
  );

  router.openapi(
    { ...resizeVolumeRoute, middleware: requireScopeForResource('docker:volumes:create', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const { capacityBytes } = VolumeResizeSchema.parse(await c.req.json());
      await service.resizeVolume(nodeId, name, capacityBytes, user.id);
      return c.json({ success: true });
    }
  );

  // Remove volume
  router.openapi(
    { ...adoptVolumeRoute, middleware: requireScopeForResource('docker:volumes:create', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      const scopes = c.get('effectiveScopes') || [];
      if (!TokensService.hasScope(scopes, `docker:volumes:view:${nodeId}`)) {
        throw new HTTPException(403, { message: `Missing required scope: docker:volumes:view:${nodeId}` });
      }
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const data = await service.adoptVolume(nodeId, name, user.id);
      return c.json({ data });
    }
  );

  // Remove volume
  router.openapi(
    { ...removeVolumeRoute, middleware: requireScopeForResource('docker:volumes:delete', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const name = c.req.param('name')!;
      const user = c.get('user')!;
      await assertComposeVolumeMutationAllowed(nodeId, name);
      const force = c.req.query('force') === 'true';
      await service.removeVolume(nodeId, name, force, user.id);
      return c.json({ success: true });
    }
  );
}
