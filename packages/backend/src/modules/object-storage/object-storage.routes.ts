import { Readable } from 'node:stream';
import { OpenAPIHono } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeBase, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireScope, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import type { AppEnv } from '@/types.js';
import {
  createBucketRoute,
  createObjectStorageConnectionRoute,
  createObjectStorageFolderRoute,
  createPrefixRoute,
  deleteBucketRoute,
  deleteObjectStorageConnectionRoute,
  deleteObjectStorageFolderRoute,
  deleteObjectsRoute,
  downloadObjectRoute,
  getObjectStorageConnectionBySlugRoute,
  getObjectStorageConnectionRoute,
  getObjectStorageHealthHistoryRoute,
  listBucketsRoute,
  listObjectStorageConnectionsRoute,
  listObjectStorageFoldersRoute,
  listObjectsRoute,
  moveObjectStorageFolderRoute,
  moveObjectStorageToFolderRoute,
  objectMetadataRoute,
  objectStorageMonitoringStreamRoute,
  presignObjectRoute,
  reorderObjectStorageFoldersRoute,
  reorderObjectStorageRoute,
  revealObjectStorageCredentialsRoute,
  testObjectStorageConnectionRoute,
  updateObjectStorageConnectionRoute,
  updateObjectStorageFolderRoute,
  uploadObjectRoute,
} from './object-storage.docs.js';
import {
  CreateBucketSchema,
  CreateObjectStorageConnectionSchema,
  CreatePrefixSchema,
  DeleteObjectsSchema,
  ListObjectsQuerySchema,
  ObjectMetadataQuerySchema,
  ObjectStorageListQuerySchema,
  PresignObjectSchema,
  UpdateObjectStorageConnectionSchema,
} from './object-storage.schemas.js';
import { ObjectStorageService } from './object-storage.service.js';
import { ObjectStorageFolderService } from './object-storage-folders.service.js';
import { ObjectStorageMonitoringService } from './object-storage-monitoring.service.js';

export const objectStorageRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

objectStorageRoutes.use('*', authMiddleware);

// ── Folders ─────────────────────────────────────────────────────────

objectStorageRoutes.openapi(listObjectStorageFoldersRoute, async (c) => {
  const service = container.resolve(ObjectStorageFolderService);
  const scopes = c.get('effectiveScopes') ?? [];
  const canManageFolders = hasScope(scopes, 'storage:folders:manage');
  const hasGlobalAccess = hasScope(scopes, 'storage:view');
  const allowedIds = getResourceScopedIds(scopes, 'storage:view');
  if (!canManageFolders && !hasScopeBase(scopes, 'storage:view')) {
    throw new AppError(403, 'FORBIDDEN', 'Missing required scope: storage:view or storage:folders:manage');
  }
  const data = await service.getFolderTree(
    canManageFolders || hasGlobalAccess ? { includeAllFolders: canManageFolders } : { allowedResourceIds: allowedIds }
  );
  return c.json({ data });
});

objectStorageRoutes.openapi(
  { ...createObjectStorageFolderRoute, middleware: requireScope('storage:folders:manage') },
  async (c) => {
    const service = container.resolve(ObjectStorageFolderService);
    const user = c.get('user')!;
    const input = CreateResourceFolderSchema.parse(await c.req.json());
    const data = await service.createFolder(input, user.id);
    return c.json({ data }, 201);
  }
);

objectStorageRoutes.openapi(
  { ...reorderObjectStorageFoldersRoute, middleware: requireScope('storage:folders:manage') },
  async (c) => {
    const service = container.resolve(ObjectStorageFolderService);
    const input = ReorderResourceFoldersSchema.parse(await c.req.json());
    await service.reorderFolders(input);
    return c.json({ success: true });
  }
);

objectStorageRoutes.openapi(
  { ...moveObjectStorageToFolderRoute, middleware: requireScope('storage:folders:manage') },
  async (c) => {
    const service = container.resolve(ObjectStorageFolderService);
    const user = c.get('user')!;
    const input = MoveResourcesToFolderSchema.parse(await c.req.json());
    await service.moveResourcesToFolder(input, user.id);
    return c.json({ success: true });
  }
);

objectStorageRoutes.openapi(
  { ...reorderObjectStorageRoute, middleware: requireScope('storage:folders:manage') },
  async (c) => {
    const service = container.resolve(ObjectStorageFolderService);
    const input = ReorderResourcesSchema.parse(await c.req.json());
    await service.reorderResources(input);
    return c.json({ success: true });
  }
);

objectStorageRoutes.openapi(
  { ...updateObjectStorageFolderRoute, middleware: requireScope('storage:folders:manage') },
  async (c) => {
    const service = container.resolve(ObjectStorageFolderService);
    const user = c.get('user')!;
    const input = UpdateResourceFolderSchema.parse(await c.req.json());
    const data = await service.updateFolder(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

objectStorageRoutes.openapi(
  { ...moveObjectStorageFolderRoute, middleware: requireScope('storage:folders:manage') },
  async (c) => {
    const service = container.resolve(ObjectStorageFolderService);
    const user = c.get('user')!;
    const input = MoveResourceFolderSchema.parse(await c.req.json());
    const data = await service.moveFolder(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

objectStorageRoutes.openapi(
  { ...deleteObjectStorageFolderRoute, middleware: requireScope('storage:folders:manage') },
  async (c) => {
    const service = container.resolve(ObjectStorageFolderService);
    const user = c.get('user')!;
    await service.deleteFolder(c.req.param('id')!, user.id);
    return c.json({ success: true });
  }
);

// ── Connections ─────────────────────────────────────────────────────

objectStorageRoutes.openapi(listObjectStorageConnectionsRoute, async (c) => {
  const service = container.resolve(ObjectStorageService);
  const scopes = c.get('effectiveScopes') ?? [];
  const hasGlobalAccess = hasScope(scopes, 'storage:view');
  const canManageFolders = hasScope(scopes, 'storage:folders:manage');
  const allowedIds = getResourceScopedIds(scopes, 'storage:view');
  if (!hasGlobalAccess && !canManageFolders && allowedIds.length === 0) {
    throw new AppError(403, 'FORBIDDEN', 'Missing required storage access scope');
  }
  const query = ObjectStorageListQuerySchema.parse(c.req.query());
  const data = await service.list(query, hasGlobalAccess || canManageFolders ? undefined : { allowedIds });
  return c.json(data);
});

objectStorageRoutes.openapi(createObjectStorageConnectionRoute, async (c) => {
  const service = container.resolve(ObjectStorageService);
  const user = c.get('user')!;
  const input = CreateObjectStorageConnectionSchema.parse(await c.req.json());
  if (!hasScopeForCreation(c.get('effectiveScopes') ?? [], 'storage:create', input.folderId))
    throw new AppError(403, 'FORBIDDEN', 'Missing storage:create permission for the selected folder');
  await container.resolve(ObjectStorageFolderService).assertFolderExists(input.folderId);
  const data = await service.create(input, user.id);
  return c.json({ data }, 201);
});

objectStorageRoutes.openapi(getObjectStorageConnectionBySlugRoute, async (c) => {
  const service = container.resolve(ObjectStorageService);
  const data = await service.getBySlug(c.req.param('slug')!);
  const scopes = c.get('effectiveScopes') ?? [];
  if (!hasScope(scopes, `storage:view:${data.id}`)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: storage:view:${data.id}`);
  }
  return c.json({ data });
});

objectStorageRoutes.openapi(
  { ...getObjectStorageConnectionRoute, middleware: requireScopeForResource('storage:view', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const data = await service.get(c.req.param('id')!);
    return c.json({ data });
  }
);

objectStorageRoutes.openapi(
  { ...getObjectStorageHealthHistoryRoute, middleware: requireScopeForResource('storage:view', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const data = await service.getHealthHistory(c.req.param('id')!);
    return c.json({ data });
  }
);

objectStorageRoutes.openapi(
  { ...updateObjectStorageConnectionRoute, middleware: requireScopeForResource('storage:edit', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const user = c.get('user')!;
    const input = UpdateObjectStorageConnectionSchema.parse(await c.req.json());
    const data = await service.update(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

objectStorageRoutes.openapi(
  { ...deleteObjectStorageConnectionRoute, middleware: requireScopeForResource('storage:delete', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const user = c.get('user')!;
    await service.delete(c.req.param('id')!, user.id);
    return c.json({ success: true });
  }
);

objectStorageRoutes.openapi(
  { ...testObjectStorageConnectionRoute, middleware: requireScopeForResource('storage:edit', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const user = c.get('user')!;
    const data = await service.testSavedConnection(c.req.param('id')!, user.id);
    return c.json({ data });
  }
);

objectStorageRoutes.openapi(
  { ...revealObjectStorageCredentialsRoute, middleware: requireScopeForResource('storage:credentials:reveal', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const data = await service.revealCredentials(c.req.param('id')!);
    return c.json({ data });
  }
);

objectStorageRoutes.openapi(
  { ...objectStorageMonitoringStreamRoute, middleware: requireScopeForResource('storage:view', 'id') },
  async (c) => {
    const storageId = c.req.param('id')!;
    const monitoring = container.resolve(ObjectStorageMonitoringService);
    const connections = container.resolve(ObjectStorageService);

    return streamSSE(c, async (stream) => {
      const details = await connections.get(storageId);
      const [healthHistory, history] = await Promise.all([
        connections.getHealthHistory(storageId),
        monitoring.getInitialHistory(details),
      ]);
      await stream.writeSSE({
        data: JSON.stringify({ connected: true, storageId, healthHistory, healthStatus: details.healthStatus }),
        event: 'connected',
      });
      await stream.sleep(0);

      await stream.writeSSE({ data: JSON.stringify({ storageId, history }), event: 'history' });
      if (stream.aborted) return;

      const onSnapshot = (payload: { storageId: string; snapshot: unknown }) => {
        if (payload.storageId !== storageId) return;
        stream.writeSSE({ data: JSON.stringify(payload.snapshot), event: 'snapshot' }).catch(() => {});
      };
      monitoring.on('snapshot', onSnapshot);
      monitoring.registerClient(storageId);

      const keepalive = setInterval(() => {
        stream.writeSSE({ data: '', event: 'ping' }).catch(() => clearInterval(keepalive));
      }, 30_000);

      await new Promise<void>((resolve) => {
        let closed = false;
        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepalive);
          monitoring.off('snapshot', onSnapshot);
          monitoring.unregisterClient(storageId);
          resolve();
        };
        stream.onAbort(cleanup);
        if (stream.aborted) cleanup();
      });
    });
  }
);

// ── Object browser ──────────────────────────────────────────────────

objectStorageRoutes.openapi(
  { ...listBucketsRoute, middleware: requireScopeForResource('storage:objects:read', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const data = await service.listBuckets(c.req.param('id')!);
    return c.json({ data });
  }
);

objectStorageRoutes.openapi(
  { ...createBucketRoute, middleware: requireScopeForResource('storage:objects:admin', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const user = c.get('user')!;
    const input = CreateBucketSchema.parse(await c.req.json());
    await service.createBucket(c.req.param('id')!, input.bucket, user.id);
    return c.json({ success: true }, 201);
  }
);

objectStorageRoutes.openapi(
  { ...deleteBucketRoute, middleware: requireScopeForResource('storage:objects:admin', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const user = c.get('user')!;
    const bucket = c.req.query('bucket')!;
    await service.deleteBucket(c.req.param('id')!, bucket, user.id);
    return c.json({ success: true });
  }
);

objectStorageRoutes.openapi(
  { ...listObjectsRoute, middleware: requireScopeForResource('storage:objects:read', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const query = ListObjectsQuerySchema.parse(c.req.query());
    const data = await service.listObjects(c.req.param('id')!, query);
    return c.json({ data });
  }
);

objectStorageRoutes.openapi(
  { ...objectMetadataRoute, middleware: requireScopeForResource('storage:objects:read', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const query = ObjectMetadataQuerySchema.parse(c.req.query());
    const data = await service.headObject(c.req.param('id')!, query.bucket, query.key);
    return c.json({ data });
  }
);

objectStorageRoutes.openapi(
  { ...downloadObjectRoute, middleware: requireScopeForResource('storage:objects:read', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const query = ObjectMetadataQuerySchema.parse(c.req.query());
    const { body, contentType, contentLength } = await service.getObjectStream(
      c.req.param('id')!,
      query.bucket,
      query.key
    );
    const rawName = query.key.split('/').pop() || 'download';
    // ASCII fallback: drop control chars / quotes / backslashes (header-injection safe),
    // replace remaining non-ASCII with '_'; the UTF-8 filename* carries the real name.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters from the header value is the point — they would allow header injection.
    const asciiName = rawName.replace(/[\u0000-\u001f\u007f"\\]/g, '').replace(/[^\x20-\x7e]/g, '_') || 'download';
    const encodedName = encodeURIComponent(rawName);
    c.header('Content-Type', contentType ?? 'application/octet-stream');
    if (contentLength != null) c.header('Content-Length', String(contentLength));
    c.header('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
    return c.body(Readable.toWeb(body) as ReadableStream);
  }
);

objectStorageRoutes.openapi(
  { ...presignObjectRoute, middleware: requireScopeForResource('storage:objects:read', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const input = PresignObjectSchema.parse(await c.req.json());
    if (input.operation === 'put') {
      const scopes = c.get('effectiveScopes') ?? [];
      const id = c.req.param('id')!;
      if (!hasScope(scopes, `storage:objects:write:${id}`) && !hasScope(scopes, 'storage:objects:write')) {
        throw new AppError(403, 'FORBIDDEN', 'Missing required scope: storage:objects:write');
      }
    }
    const data = await service.presignObject(c.req.param('id')!, input);
    return c.json({ data });
  }
);

objectStorageRoutes.openapi(
  { ...uploadObjectRoute, middleware: requireScopeForResource('storage:objects:write', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const user = c.get('user')!;
    const bucket = c.req.query('bucket')!;
    const key = c.req.query('key')!;
    const contentType = c.req.query('contentType') || undefined;
    const webBody = c.req.raw.body;
    if (!webBody) {
      throw new AppError(400, 'STORAGE_EMPTY_BODY', 'Request body is required');
    }
    // Stream the request body straight into S3 (multipart under the hood) rather than
    // buffering the whole object in memory. The body-size cap is enforced by the
    // per-route body-limit middleware in app.ts.
    const body = Readable.fromWeb(webBody as Parameters<typeof Readable.fromWeb>[0]);
    await service.uploadObject(c.req.param('id')!, { bucket, key, body, contentType }, user.id);
    return c.json({ success: true }, 201);
  }
);

objectStorageRoutes.openapi(
  { ...createPrefixRoute, middleware: requireScopeForResource('storage:objects:write', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const user = c.get('user')!;
    const input = CreatePrefixSchema.parse(await c.req.json());
    await service.createPrefix(c.req.param('id')!, input.bucket, input.prefix, user.id);
    return c.json({ success: true }, 201);
  }
);

objectStorageRoutes.openapi(
  { ...deleteObjectsRoute, middleware: requireScopeForResource('storage:objects:write', 'id') },
  async (c) => {
    const service = container.resolve(ObjectStorageService);
    const user = c.get('user')!;
    const input = DeleteObjectsSchema.parse(await c.req.json());
    await service.deleteObjects(c.req.param('id')!, input.bucket, input.keys, user.id);
    return c.json({ success: true });
  }
);
