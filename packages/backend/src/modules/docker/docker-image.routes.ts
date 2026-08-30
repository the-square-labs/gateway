import type { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import {
  listImagesRoute,
  pruneImagesRoute,
  pullImageRoute,
  pullImageSyncRoute,
  removeImageRoute,
} from './docker.docs.js';
import { ImagePullSchema } from './docker.schemas.js';
import { DockerManagementService } from './docker.service.js';
import { filterGatewayInternalImages } from './docker-internal-images.js';
import { DockerRegistryService } from './docker-registry.service.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';

const DOCKER_RESOURCE_LIST_MAX = 1000;
const DOCKER_IMAGE_REF_PREVIEW_MAX = 20;

function dockerCommandErrorMessage(result: { error?: string; detail?: string }, fallback: string) {
  if (typeof result.error === 'string' && result.error.trim()) return result.error.trim();
  if (typeof result.detail === 'string' && result.detail.trim()) return result.detail.trim();
  return fallback;
}

export function compactImageListItem(image: Record<string, any>) {
  const repoTags = image.repoTags ?? image.RepoTags;
  const repoDigests = image.repoDigests ?? image.RepoDigests;
  return {
    id: image.id ?? image.Id,
    parentId: image.parentId ?? image.ParentId,
    repoTags: Array.isArray(repoTags) ? repoTags.slice(0, DOCKER_IMAGE_REF_PREVIEW_MAX) : repoTags,
    repoTagsCount: Array.isArray(repoTags) ? repoTags.length : undefined,
    repoTagsTruncated: Array.isArray(repoTags) && repoTags.length > DOCKER_IMAGE_REF_PREVIEW_MAX,
    repoDigests: Array.isArray(repoDigests) ? repoDigests.slice(0, DOCKER_IMAGE_REF_PREVIEW_MAX) : repoDigests,
    repoDigestsCount: Array.isArray(repoDigests) ? repoDigests.length : undefined,
    repoDigestsTruncated: Array.isArray(repoDigests) && repoDigests.length > DOCKER_IMAGE_REF_PREVIEW_MAX,
    created: image.created ?? image.Created,
    size: image.size ?? image.Size,
    virtualSize: image.virtualSize ?? image.VirtualSize,
    sharedSize: image.sharedSize ?? image.SharedSize,
    containers: image.containers ?? image.Containers,
  };
}

export function matchesImageSearch(image: Record<string, any>, search: string | undefined) {
  if (!search) return true;
  const repoTags = image.repoTags ?? image.RepoTags;
  const repoDigests = image.repoDigests ?? image.RepoDigests;
  const haystack = [
    image.id ?? image.Id,
    image.parentId ?? image.ParentId,
    ...(Array.isArray(repoTags) ? repoTags : []),
    ...(Array.isArray(repoDigests) ? repoDigests : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(search);
}

export function registerImageRoutes(router: OpenAPIHono<AppEnv>) {
  // ─── Image routes ────────────────────────────────────────────────────

  // List images
  router.openapi(
    { ...listImagesRoute, middleware: requireScopeForResource('docker:images:view', 'nodeId') },
    async (c) => {
      const snapshots = container.resolve(DockerSnapshotService);
      const nodeId = c.req.param('nodeId')!;
      await snapshots.assertDockerNode(nodeId);
      const snapshot = await snapshots.getList<any[]>(nodeId, 'images');
      const data = snapshot.data;
      if (!Array.isArray(data)) return c.json({ data });
      const search = c.req.query('search')?.trim().toLowerCase();
      const compacted = filterGatewayInternalImages(data)
        .filter((item) => matchesImageSearch(item, search))
        .map((item) => ({
          ...compactImageListItem(item),
          nodeId,
          availability: snapshots.availability(nodeId, snapshot),
        }));
      const truncated = compacted.length > DOCKER_RESOURCE_LIST_MAX;
      return c.json({
        data: truncated ? compacted.slice(0, DOCKER_RESOURCE_LIST_MAX) : compacted,
        total: compacted.length,
        limit: DOCKER_RESOURCE_LIST_MAX,
        truncated,
      });
    }
  );

  // Pull image
  router.openapi(
    { ...pullImageRoute, middleware: requireScopeForResource('docker:images:pull', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const registryService = container.resolve(DockerRegistryService);
      const nodeId = c.req.param('nodeId')!;
      const user = c.get('user')!;
      const body = await c.req.json();
      const { imageRef, registryId } = body;
      ImagePullSchema.parse({ imageRef, registryId });

      // Resolve registry credentials and prefix image ref if using private registry
      let finalImageRef = imageRef;
      let registryAuth: string | undefined;
      const auth = await registryService.resolveAuthForImagePull(nodeId, imageRef, registryId, {
        actorScopes: c.get('effectiveScopes') || [],
      });
      if (auth) {
        registryAuth = auth.authJson;
        // Prefix image ref with registry URL if not already prefixed
        if (!hasRegistryHost(imageRef)) {
          finalImageRef = `${auth.url}/${imageRef}`;
        }
      }

      const data = await service.pullImage(nodeId, finalImageRef, registryAuth, user.id, auth?.registryId);
      return c.json({ data });
    }
  );

  // Pull image (synchronous — waits for completion, validates image exists)
  router.openapi(
    { ...pullImageSyncRoute, middleware: requireScopeForResource('docker:images:pull', 'nodeId') },
    async (c) => {
      const registryService = container.resolve(DockerRegistryService);
      const nodeId = c.req.param('nodeId')!;
      const body = await c.req.json();
      const { imageRef, registryId } = body;
      ImagePullSchema.parse({ imageRef, registryId });

      let finalImageRef = imageRef;
      let registryAuth: string | undefined;
      const auth = await registryService.resolveAuthForImagePull(nodeId, imageRef, registryId, {
        actorScopes: c.get('effectiveScopes') || [],
      });
      if (auth) {
        registryAuth = auth.authJson;
        if (!hasRegistryHost(imageRef)) {
          finalImageRef = `${auth.url}/${imageRef}`;
        }
      }

      const { NodeDispatchService } = await import('@/services/node-dispatch.service.js');
      const dispatch = container.resolve(NodeDispatchService);
      const result = await dispatch.sendDockerImageCommand(
        nodeId,
        'pull',
        { imageRef: finalImageRef, registryAuthJson: registryAuth },
        600000
      );
      if (!result.success) {
        throw new AppError(400, 'PULL_FAILED', dockerCommandErrorMessage(result, `Failed to pull ${finalImageRef}`));
      }
      await registryService.rememberImageRegistry(nodeId, finalImageRef, auth?.registryId);
      return c.json({ data: { success: true, imageRef: finalImageRef } });
    }
  );

  // Remove image
  router.openapi(
    { ...removeImageRoute, middleware: requireScopeForResource('docker:images:delete', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const imageId = c.req.param('imageId')!;
      const user = c.get('user')!;
      const force = c.req.query('force') === 'true';
      await service.removeImage(nodeId, imageId, force, user.id);
      return c.json({ success: true });
    }
  );

  // Prune images
  router.openapi(
    { ...pruneImagesRoute, middleware: requireScopeForResource('docker:images:delete', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const user = c.get('user')!;
      const data = await service.pruneImages(nodeId, user.id);
      return c.json({ data });
    }
  );
}

function hasRegistryHost(imageRef: string) {
  const firstSegment = imageRef.split('/')[0] ?? '';
  return firstSegment === 'localhost' || firstSegment.includes('.') || firstSegment.includes(':');
}
