import type { OpenAPIHono } from '@hono/zod-openapi';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { requireScopeBase, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import type { AppEnv } from '@/types.js';
import { assertComposeChildMutationAllowed } from './compose/compose-child.guard.js';
import { isComposeOwnedContainer } from './compose/compose-discovery.service.js';
import {
  abortContainerFileUploadRoute,
  completeContainerFileUploadRoute,
  containerEnvRoute,
  containerLogsRoute,
  containerStatsHistoryRoute,
  containerStatsRoute,
  containerTopRoute,
  createContainerDirectoryRoute,
  createContainerFileRoute,
  createContainerRoute,
  createContainerSecretRoute,
  deleteContainerFileRoute,
  deleteContainerSecretRoute,
  duplicateContainerRoute,
  exportContainerArchiveRoute,
  importContainerArchiveRoute,
  initContainerFileUploadRoute,
  inspectContainerByNameRoute,
  inspectContainerRoute,
  killContainerRoute,
  listContainerFilesRoute,
  listContainerGpuUsageRoute,
  listContainerSecretsRoute,
  listContainersRoute,
  liveUpdateContainerRoute,
  moveContainerFileRoute,
  planContainerArchiveImportRoute,
  readContainerFileRoute,
  recreateContainerRoute,
  removeContainerRoute,
  renameContainerRoute,
  restartContainerRoute,
  startContainerRoute,
  stopContainerRoute,
  updateContainerEnvRoute,
  updateContainerRoute,
  updateContainerSecretRoute,
  uploadContainerFileChunkRoute,
  writeContainerFileRoute,
} from './docker.docs.js';
import {
  ContainerArchiveExportQuerySchema,
  ContainerArchiveImportQuerySchema,
  ContainerArchivePlanSchema,
  ContainerArchiveResolutionSchema,
  ContainerCreateSchema,
  ContainerDuplicateSchema,
  ContainerKillSchema,
  ContainerLiveUpdateSchema,
  ContainerRecreateSchema,
  ContainerRenameSchema,
  ContainerStopSchema,
  ContainerUpdateSchema,
  EnvUpdateSchema,
  FileBrowseSchema,
  FileMoveSchema,
  FileUploadChunkQuerySchema,
  FileUploadCompleteSchema,
  FileUploadInitSchema,
  LogQuerySchema,
  SecretCreateSchema,
  SecretUpdateSchema,
} from './docker.schemas.js';
import { DockerManagementService } from './docker.service.js';
import {
  assertDockerNodeScope,
  filterDockerResourcesForScope,
  requireDockerContainerScope,
} from './docker-access.middleware.js';
import { hasDockerResourceScope } from './docker-access-resource.service.js';
import { importGwca, openGwcaExport } from './docker-container-archive.js';
import { DOCKER_DEPLOYMENT_MANAGED_LABEL } from './docker-deployment-labels.js';
import { envListToMap } from './docker-env-operations.js';
import { DockerEnvironmentService } from './docker-environment.service.js';
import { dockerGpuAttachmentFromInspect } from './docker-gpu-attachment.js';
import { assertUserContainerAccessible, inspectUserContainer } from './docker-internal-containers.js';
import { DockerMigrationDispatchAdapter } from './docker-migration-dispatch.js';
import { DockerRegistryService } from './docker-registry.service.js';
import { resolveDockerContainerByName } from './docker-route-resolvers.js';
import { DockerSecretService } from './docker-secret.service.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';
import { DockerSnapshotReconciler } from './docker-snapshot-reconciler.service.js';
import { assertDockerMountChangeAllowed } from './docker-socket-mount.guard.js';

const DOCKER_RESOURCE_LIST_MAX = 1000;
const DOCKER_CONTAINER_PORT_PREVIEW_MAX = 64;
const ARCHIVE_IMAGE_REFERENCE_LABEL = 'wiolett.gateway.archive.image.reference';

function assertUserContainerSnapshot(data: Record<string, any> | null | undefined): void {
  assertUserContainerAccessible(data);
}

function filterContainerDatabaseLinksForScopes(data: any, scopes: string[]) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.databaseLinks)) return data;
  const databaseLinks = data.databaseLinks.filter((link: any) => {
    const databaseId = String(link?.database?.id ?? '');
    return hasScopeForResource(scopes, 'databases:view', databaseId);
  });
  return {
    ...data,
    databaseLinks,
    secureLinkDown: Boolean(data.secureLinkDown),
  };
}

function archiveImportPlanAccess(actorScopes: readonly string[], nodeId: string) {
  return {
    canViewNetworks: hasScopeForResource([...actorScopes], 'docker:networks:view', nodeId),
    canCreateNetworks: hasScopeForResource([...actorScopes], 'docker:networks:create', nodeId),
    canViewVolumes: hasScopeForResource([...actorScopes], 'docker:volumes:view', nodeId),
    canCreateVolumes: hasScopeForResource([...actorScopes], 'docker:volumes:create', nodeId),
  };
}

async function parseFileContentRequest(c: Parameters<Parameters<OpenAPIHono<AppEnv>['openapi']>[1]>[0]) {
  const path = FileBrowseSchema.parse(c.req.query()).path;
  const content = Buffer.from(await c.req.arrayBuffer());
  return { path, content };
}

export function compactContainerListItem(container: Record<string, any>) {
  const ports = container.ports ?? container.Ports;
  const labels = (container.labels ?? container.Labels ?? {}) as Record<string, string>;
  return {
    id: container.id ?? container.Id,
    name: ((container.name ?? container.Name ?? '') as string).replace(/^\//, ''),
    image: labels[ARCHIVE_IMAGE_REFERENCE_LABEL] || container.image || container.Image,
    state: container.state ?? container.State,
    status: container.status ?? container.Status,
    created: container.created ?? container.Created,
    ports: Array.isArray(ports) ? ports.slice(0, DOCKER_CONTAINER_PORT_PREVIEW_MAX) : ports,
    portsCount: Array.isArray(ports) ? ports.length : undefined,
    portsTruncated: Array.isArray(ports) && ports.length > DOCKER_CONTAINER_PORT_PREVIEW_MAX,
    kind: container.kind ?? 'container',
    deploymentId: container.deploymentId,
    activeSlot: container.activeSlot,
    primaryRoute: container.primaryRoute,
    activeSlotContainerId: container.activeSlotContainerId,
    healthCheckId: container.healthCheckId,
    healthCheckEnabled: container.healthCheckEnabled,
    healthStatus: container.healthStatus,
    secureLinkDown: Boolean(container.secureLinkDown),
    lastHealthCheckAt: container.lastHealthCheckAt,
    folderId: container.folderId,
    folderIsSystem: container.folderIsSystem,
    folderSortOrder: container.folderSortOrder,
    scopeResourceId: container.scopeResourceId,
    _transition: container._transition,
  };
}

export function matchesContainerSearch(container: Record<string, any>, search: string | undefined) {
  if (!search) return true;
  const ports = container.ports ?? container.Ports;
  const portText = Array.isArray(ports)
    ? ports.map((port: any) => [port.ip, port.publicPort, port.privatePort, port.type].join(' ')).join(' ')
    : '';
  const haystack = [
    container.id ?? container.Id,
    container.name ?? container.Name,
    container.image ?? container.Image,
    container.state ?? container.State,
    container.status ?? container.Status,
    container.kind,
    container.deploymentId,
    container.activeSlot,
    portText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(search);
}

/** Resolve container name from container ID via inspect */
async function resolveContainerName(nodeId: string, containerId: string): Promise<string> {
  const dockerService = container.resolve(DockerManagementService);
  const inspect = await dockerService.inspectContainer(nodeId, containerId);
  const labels = inspect?.Config?.Labels ?? {};
  if (labels?.[DOCKER_DEPLOYMENT_MANAGED_LABEL] === 'true') {
    throw new AppError(
      409,
      'MANAGED_DEPLOYMENT_CONTAINER',
      'This container is managed by a blue/green deployment. Use deployment actions instead.'
    );
  }
  const name = (inspect?.Name ?? '').replace(/^\//, '');
  if (!name) throw new Error('Could not resolve container name');
  return name;
}

export function registerContainerRoutes(router: OpenAPIHono<AppEnv>) {
  // ─── Container routes ────────────────────────────────────────────────

  // List containers
  router.openapi({ ...listContainersRoute, middleware: requireScopeBase('docker:containers:view') }, async (c) => {
    const service = container.resolve(DockerManagementService);
    const snapshots = container.resolve(DockerSnapshotService);
    const nodeId = c.req.param('nodeId')!;
    assertDockerNodeScope(c.get('effectiveScopes') ?? [], 'docker:containers:view', nodeId);
    await snapshots.assertDockerNode(nodeId);
    const snapshot = await snapshots.getList<any[]>(nodeId, 'containers');
    const data = await service.decoratePublicContainerSnapshot(
      nodeId,
      snapshot.data.filter((item) => !isComposeOwnedContainer(item))
    );
    if (!Array.isArray(data)) return c.json({ data });
    const search = c.req.query('search')?.trim().toLowerCase();
    const visible = filterDockerResourcesForScope(
      data.map((item) => compactContainerListItem(item)),
      c.get('effectiveScopes') ?? [],
      'docker:containers:view',
      nodeId
    );
    const compacted = visible
      .filter((item) => matchesContainerSearch(item, search))
      .map((item) => ({
        ...item,
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
  });

  router.openapi(
    { ...listContainerGpuUsageRoute, middleware: requireScopeBase('docker:containers:view') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const scopes = c.get('effectiveScopes') ?? [];
      assertDockerNodeScope(scopes, 'docker:containers:view', nodeId);

      const users = filterDockerResourcesForScope(
        await service.listGpuAttachmentUsers(nodeId, scopes),
        scopes,
        'docker:containers:view',
        nodeId
      );
      const byDeviceId = new Map<string, Array<{ name: string }>>();
      for (const user of users) {
        for (const deviceId of user.deviceIds) {
          const containers = byDeviceId.get(deviceId) ?? [];
          containers.push({ name: user.name });
          byDeviceId.set(deviceId, containers);
        }
      }

      const data = [...byDeviceId.entries()]
        .map(([deviceId, containers]) => {
          const sorted = containers.sort((a, b) => a.name.localeCompare(b.name));
          return { deviceId, containerCount: sorted.length, containers: sorted };
        })
        .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
      return c.json({ data });
    }
  );

  // Create container
  router.openapi(
    { ...createContainerRoute, middleware: requireScopeForResource('docker:containers:create', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const user = c.get('user')!;
      const body = await c.req.json();
      const config = ContainerCreateSchema.parse(body);
      const data = await service.createContainer(nodeId, config, user.id, c.get('effectiveScopes') || []);
      return c.json({ data }, 201);
    }
  );

  // Inspect container
  router.openapi(
    {
      ...inspectContainerByNameRoute,
      middleware: requireDockerContainerScope('docker:containers:view', 'containerName', {
        allowBroadWithoutResolve: true,
      }),
    },
    async (c) => {
      const snapshots = container.resolve(DockerSnapshotService);
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      if (c.req.query('_t')) {
        const reconciler = container.resolve(DockerSnapshotReconciler);
        await reconciler.refreshNow(nodeId, 'containers');
        await reconciler.refreshNow(nodeId, 'container-detail', c.req.param('containerName')!);
      }
      const detail = await snapshots.getContainerDetailSnapshot(nodeId, c.req.param('containerName')!);
      const resolved = await resolveDockerContainerByName(
        { inspectContainer: async () => detail.data },
        nodeId,
        c.req.param('containerName')!
      );
      assertUserContainerSnapshot(resolved);
      const data = filterContainerDatabaseLinksForScopes(
        await service.decoratePublicContainerDetailSnapshot(nodeId, resolved),
        c.get('effectiveScopes') ?? []
      );
      return c.json({
        data: {
          ...(data && typeof data === 'object' ? data : { value: data }),
          nodeId,
          availability: snapshots.availability(nodeId, detail),
        },
      });
    }
  );

  router.openapi(
    {
      ...inspectContainerRoute,
      middleware: requireDockerContainerScope('docker:containers:view', 'containerId', {
        allowBroadWithoutResolve: true,
      }),
    },
    async (c) => {
      const snapshots = container.resolve(DockerSnapshotService);
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      if (c.req.query('_t')) {
        const reconciler = container.resolve(DockerSnapshotReconciler);
        await reconciler.refreshNow(nodeId, 'containers');
        await reconciler.refreshNow(nodeId, 'container-detail', containerId);
      }
      const detail = await snapshots.getContainerDetailSnapshot(nodeId, containerId);
      assertUserContainerSnapshot(detail.data);
      const data = filterContainerDatabaseLinksForScopes(
        await service.decoratePublicContainerDetailSnapshot(nodeId, detail.data),
        c.get('effectiveScopes') ?? []
      );
      return c.json({
        data: {
          ...(data && typeof data === 'object' ? data : { value: data }),
          nodeId,
          availability: snapshots.availability(nodeId, detail),
        },
      });
    }
  );

  // Start container
  router.openapi(
    { ...startContainerRoute, middleware: requireDockerContainerScope('docker:containers:manage') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      await service.startContainer(nodeId, containerId, user.id);
      return c.json({ success: true });
    }
  );

  // Stop container
  router.openapi(
    { ...stopContainerRoute, middleware: requireDockerContainerScope('docker:containers:manage') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json().catch(() => ({}));
      const { timeout } = ContainerStopSchema.parse(body);
      await service.stopContainer(nodeId, containerId, timeout, user.id);
      return c.json({ success: true });
    }
  );

  // Restart container
  router.openapi(
    { ...restartContainerRoute, middleware: requireDockerContainerScope('docker:containers:manage') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json().catch(() => ({}));
      const { timeout } = ContainerStopSchema.parse(body);
      await service.restartContainer(nodeId, containerId, timeout, user.id);
      return c.json({ success: true });
    }
  );

  // Kill container
  router.openapi(
    {
      ...killContainerRoute,
      middleware: requireDockerContainerScope('docker:containers:manage', 'containerId', {
        allowTransitionIdentityFallback: true,
      }),
    },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json().catch(() => ({}));
      const { signal } = ContainerKillSchema.parse(body);
      await service.killContainer(nodeId, containerId, signal, user.id);
      return c.json({ success: true });
    }
  );

  // Remove container
  router.openapi(
    { ...removeContainerRoute, middleware: requireDockerContainerScope('docker:containers:delete') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const force = c.req.query('force') === 'true';
      await service.removeContainer(nodeId, containerId, force, user.id);
      return c.json({ success: true });
    }
  );

  // Rename container
  router.openapi(
    { ...renameContainerRoute, middleware: requireDockerContainerScope('docker:containers:edit') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json();
      const { name } = ContainerRenameSchema.parse(body);
      await service.renameContainer(nodeId, containerId, name, user.id);
      return c.json({ success: true });
    }
  );

  // Duplicate container
  router.openapi(
    { ...duplicateContainerRoute, middleware: requireScopeForResource('docker:containers:create', 'nodeId') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json();
      const { name } = ContainerDuplicateSchema.parse(body);
      const data = await service.duplicateContainer(nodeId, containerId, name, user.id, c.get('effectiveScopes') || []);
      return c.json({ data }, 201);
    }
  );

  router.openapi(
    { ...exportContainerArchiveRoute, middleware: requireDockerContainerScope('docker:containers:export') },
    async (c) => {
      // LICENSE ENFORCEMENT: Archive operations are Personal entitlements under the project license/TOS.
      await container.resolve(LicensePolicyService).requireFeature('container-export');
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const query = ContainerArchiveExportQuerySchema.parse(c.req.query());
      const actorScopes = c.get('effectiveScopes') || [];
      const docker = container.resolve(DockerManagementService);
      const inspected = await inspectUserContainer(docker, nodeId, containerId);
      if (dockerGpuAttachmentFromInspect(inspected).mode !== 'none') {
        throw new AppError(
          409,
          'GPU_ARCHIVE_UNSUPPORTED',
          'Containers with GPU mappings cannot be exported as portable archives.'
        );
      }
      const scopeResourceId = String(inspected?.scopeResourceId ?? '');
      if (
        query.imageMode === 'portable' &&
        !hasDockerResourceScope(actorScopes, 'docker:containers:files:read', nodeId, scopeResourceId)
      ) {
        throw new AppError(403, 'FORBIDDEN', 'Exporting a portable container archive requires files access');
      }
      if (
        query.includeEnvironment &&
        !hasDockerResourceScope(actorScopes, 'docker:containers:environment', nodeId, scopeResourceId)
      ) {
        throw new AppError(403, 'FORBIDDEN', 'Exporting a container archive requires environment access');
      }
      if (
        query.includeSecrets &&
        !hasDockerResourceScope(actorScopes, 'docker:containers:secrets', nodeId, scopeResourceId)
      ) {
        throw new AppError(403, 'FORBIDDEN', 'Exporting archive secrets is not permitted for this container');
      }
      let environment: Record<string, string> = {};
      let secrets: Record<string, string> = {};
      let secretKeys: string[] = [];
      if (query.includeEnvironment) {
        environment = envListToMap(await docker.getContainerEnv(nodeId, containerId));
        const containerName = String(inspected?.Name ?? '').replace(/^\/+/, '');
        if (!containerName) throw new AppError(409, 'GWCA_SOURCE_INVALID', 'Could not resolve container name');
        const secretService = container.resolve(DockerSecretService);
        if (query.includeSecrets) {
          secrets = await secretService.getDecryptedMap(nodeId, containerName);
        } else {
          secretKeys = [...(await secretService.getSecretKeys(nodeId, containerName))];
        }
      }
      const dispatch = container.resolve(DockerMigrationDispatchAdapter);
      const archive = await openGwcaExport({
        dispatch,
        nodeId,
        containerId,
        includeWritableLayer: query.includeWritableLayer,
        imageMode: query.imageMode,
        environment,
        secrets,
        secretKeys,
        includeEnvironment: query.includeEnvironment,
        includeSecrets: query.includeSecrets,
      });
      await container.resolve(AuditService).log({
        action: 'docker.container.archive.export',
        userId: c.get('user')!.id,
        resourceType: 'docker-container',
        resourceId: containerId,
        details: {
          nodeId,
          includeWritableLayer: query.includeWritableLayer,
          includeEnvironment: query.includeEnvironment,
          includeSecrets: query.includeSecrets,
          imageMode: query.imageMode,
        },
      });
      return new Response(archive.stream, {
        headers: {
          'Content-Type': 'application/vnd.wiolett.gwca',
          'Content-Disposition': `attachment; filename="${archive.filename}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
  );

  router.openapi(
    { ...planContainerArchiveImportRoute, middleware: requireScopeForResource('docker:containers:create', 'nodeId') },
    async (c) => {
      await container.resolve(LicensePolicyService).requireFeature('container-export');
      const nodeId = c.req.param('nodeId')!;
      const body = ContainerArchivePlanSchema.parse(await c.req.json());
      await assertNodeAllowsServiceCreation(container.resolve(TOKENS.DrizzleClient) as DrizzleClient, nodeId, 'docker');
      const actorScopes = c.get('effectiveScopes') || [];
      const data = await container.resolve(DockerMigrationDispatchAdapter).planArchiveImport(nodeId, {
        manifest: { schemaVersion: 1, ...body },
        ...archiveImportPlanAccess(actorScopes, nodeId),
      });
      const managedNames = new Set(
        (await container.resolve(DockerManagementService).listManagedVolumeOptions(nodeId)).map((row) => row.name)
      );
      data.volumes = data.volumes.filter((volume) => managedNames.has(volume.name));
      return c.json({ data });
    }
  );

  router.openapi(
    { ...importContainerArchiveRoute, middleware: requireScopeForResource('docker:containers:create', 'nodeId') },
    async (c) => {
      await container.resolve(LicensePolicyService).requireFeature('container-export');
      const nodeId = c.req.param('nodeId')!;
      const query = ContainerArchiveImportQuerySchema.parse(c.req.query());
      if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/vnd.wiolett.gwca') {
        throw new AppError(415, 'GWCA_MEDIA_TYPE_REQUIRED', 'Content-Type must be application/vnd.wiolett.gwca');
      }
      const body = c.req.raw.body;
      if (!body) throw new AppError(400, 'GWCA_EMPTY', 'Container archive body is required');
      await assertNodeAllowsServiceCreation(container.resolve(TOKENS.DrizzleClient) as DrizzleClient, nodeId, 'docker');
      let resolution: ReturnType<typeof ContainerArchiveResolutionSchema.parse> = {};
      if (query.resolution) {
        try {
          resolution = ContainerArchiveResolutionSchema.parse(JSON.parse(query.resolution));
        } catch {
          throw new AppError(400, 'GWCA_RESOLUTION_INVALID', 'Archive import resolution is invalid');
        }
      }
      const dispatch = container.resolve(DockerMigrationDispatchAdapter);
      const actorScopes = c.get('effectiveScopes') || [];
      const registryService = container.resolve(DockerRegistryService);
      const data = await importGwca({
        dispatch,
        nodeId,
        name: query.name,
        body,
        resolution,
        authorizeContents: async (archiveContainer) => {
          assertDockerMountChangeAllowed({
            nodeId,
            actorScopes,
            currentDefinitions: [],
            nextDefinitions: (archiveContainer.mounts ?? []).map((mount) => ({
              type: mount.type,
              source: mount.source,
              target: mount.target,
              readOnly: mount.readOnly,
            })),
          });
          if (
            Object.keys(archiveContainer.environment ?? {}).length > 0 &&
            !hasDockerResourceScope(actorScopes, 'docker:containers:environment', nodeId, '')
          ) {
            throw new AppError(403, 'FORBIDDEN', 'Importing archive environment is not permitted on the target node');
          }
          if (
            Object.keys(archiveContainer.secrets ?? {}).length > 0 &&
            !hasDockerResourceScope(actorScopes, 'docker:containers:secrets', nodeId, '')
          ) {
            throw new AppError(403, 'FORBIDDEN', 'Importing archive secrets is not permitted on the target node');
          }
          const canCreateNetworks = hasScopeForResource(actorScopes, 'docker:networks:create', nodeId);
          if (!canCreateNetworks && (archiveContainer.networks ?? []).some((network) => network.createNew)) {
            throw new AppError(403, 'FORBIDDEN', 'Creating archive networks is not permitted on the target node');
          }
          for (const network of archiveContainer.networks ?? []) {
            if (!canCreateNetworks) network.createable = false;
          }
          const canCreateVolumes = hasScopeForResource(actorScopes, 'docker:volumes:create', nodeId);
          if (!canCreateVolumes && (archiveContainer.mounts ?? []).some((mount) => mount.createNew)) {
            throw new AppError(403, 'FORBIDDEN', 'Creating archive volumes is not permitted on the target node');
          }
          await container.resolve(DockerManagementService).assertManagedVolumeSelections(
            nodeId,
            (archiveContainer.mounts ?? [])
              .filter((mount) => mount.type === 'volume' && !mount.createNew)
              .map((mount) => mount.source)
          );
        },
        resolveRegistryAuthCandidates: async (imageReference) =>
          (
            await registryService.resolveAuthCandidatesForImagePull(nodeId, imageReference, undefined, {
              actorScopes,
            })
          ).map((candidate) => candidate.authJson),
      });
      const docker = container.resolve(DockerManagementService);
      try {
        await container.resolve(DockerEnvironmentService).replace(nodeId, data.containerName, data.environment);
        await container
          .resolve(DockerSecretService)
          .replaceImported(nodeId, data.containerName, data.secrets, c.get('user')!.id);
        await docker.registerImportedContainer(nodeId, data.containerName, data.containerId);
        await docker.registerImportedManagedVolumes(nodeId, data.createdVolumes, c.get('user')!.id);
      } catch (error) {
        await container
          .resolve(DockerEnvironmentService)
          .deleteImported(nodeId, data.containerName)
          .catch(() => undefined);
        await container
          .resolve(DockerSecretService)
          .deleteImported(nodeId, data.containerName)
          .catch(() => undefined);
        await docker.removeContainer(nodeId, data.containerId, true, c.get('user')!.id).catch(() => undefined);
        await dispatch.cleanupArchiveImport(nodeId, data.archiveId).catch(() => undefined);
        throw error;
      }
      await container.resolve(AuditService).log({
        action: 'docker.container.archive.import',
        userId: c.get('user')!.id,
        resourceType: 'docker-container',
        resourceId: data.containerId,
        details: {
          nodeId,
          requestedName: query.name,
          name: data.containerName,
          imageId: data.imageId,
          resolution,
          importedSecretKeys: Object.keys(data.secrets),
        },
      });
      return c.json(
        {
          data: {
            containerId: data.containerId,
            containerName: data.containerName,
            imageId: data.imageId,
          },
        },
        201
      );
    }
  );

  // Update container (pull + redeploy)
  router.openapi(
    { ...updateContainerRoute, middleware: requireDockerContainerScope('docker:containers:edit') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json();
      const config = ContainerUpdateSchema.parse(body);
      const data = await service.updateContainer(nodeId, containerId, config, user.id, c.get('effectiveScopes') || []);
      return c.json({ data });
    }
  );

  // Live update container (no recreation — resource limits + restart policy)
  router.openapi(
    { ...liveUpdateContainerRoute, middleware: requireDockerContainerScope('docker:containers:edit') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json();
      const config = ContainerLiveUpdateSchema.parse(body);
      await service.liveUpdateContainer(nodeId, containerId, config, user.id);
      return c.json({ success: true });
    }
  );

  // Recreate container with new config (ports, mounts, entrypoint, etc.)
  router.openapi(
    { ...recreateContainerRoute, middleware: requireDockerContainerScope('docker:containers:manage') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json();
      const config = ContainerRecreateSchema.parse(body);
      const data = await service.recreateWithConfig(nodeId, containerId, config, user.id, {
        actorScopes: c.get('effectiveScopes') || [],
        backgroundImagePull: true,
      });
      return c.json({ data });
    }
  );

  // Container logs
  router.openapi(
    { ...containerLogsRoute, middleware: requireDockerContainerScope('docker:containers:view') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const rawQuery = c.req.query();
      const { tail, timestamps } = LogQuerySchema.parse(rawQuery);
      const data = await service.getContainerLogs(nodeId, containerId, tail, timestamps);
      return c.json({ data });
    }
  );

  // Container stats from background health reports (never dispatches from this GET)
  router.openapi(
    { ...containerStatsRoute, middleware: requireDockerContainerScope('docker:containers:view') },
    async (c) => {
      const { NodeMonitoringService } = await import('@/modules/nodes/node-monitoring.service.js');
      const monitoring = container.resolve(NodeMonitoringService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const data = monitoring.getLatestContainerStats(nodeId, containerId);
      return c.json({ data });
    }
  );

  // Container stats history (for sparklines)
  router.openapi(
    { ...containerStatsHistoryRoute, middleware: requireDockerContainerScope('docker:containers:view') },
    async (c) => {
      const { NodeMonitoringService } = await import('@/modules/nodes/node-monitoring.service.js');
      const monitoring = container.resolve(NodeMonitoringService);
      const containerId = c.req.param('containerId')!;
      const data = await monitoring.getContainerStatsHistory(containerId);
      return c.json({ data });
    }
  );

  // Container top (process list)
  router.openapi(
    { ...containerTopRoute, middleware: requireDockerContainerScope('docker:containers:view') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const data = await service.getContainerTop(nodeId, containerId);
      if (Array.isArray(data?.Processes) && data.Processes.length > DOCKER_RESOURCE_LIST_MAX) {
        return c.json({
          data: {
            ...data,
            Processes: data.Processes.slice(0, DOCKER_RESOURCE_LIST_MAX),
            totalProcesses: data.Processes.length,
            limit: DOCKER_RESOURCE_LIST_MAX,
            truncated: true,
          },
          truncated: true,
        });
      }
      return c.json({ data });
    }
  );

  // Get container env
  router.openapi(
    { ...containerEnvRoute, middleware: requireDockerContainerScope('docker:containers:environment') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const data = await service.getContainerEnv(nodeId, containerId);
      return c.json({ data });
    }
  );

  // Update container env
  router.openapi(
    { ...updateContainerEnvRoute, middleware: requireDockerContainerScope('docker:containers:environment') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const body = await c.req.json();
      const { env, removeEnv } = EnvUpdateSchema.parse(body);
      const data = await service.updateContainerEnv(nodeId, containerId, env, removeEnv, user.id);
      return c.json({ data });
    }
  );

  // ─── Secret routes ────────────────────────────────────────────────────

  // List secrets (values masked unless user has docker:containers:secrets scope)
  router.openapi(
    { ...listContainerSecretsRoute, middleware: requireDockerContainerScope('docker:containers:secrets') },
    async (c) => {
      const service = container.resolve(DockerSecretService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const containerName = await resolveContainerName(nodeId, containerId);
      const data = await service.list(nodeId, containerName, true);
      return c.json({ data });
    }
  );

  // Create secret
  router.openapi(
    { ...createContainerSecretRoute, middleware: requireDockerContainerScope('docker:containers:secrets') },
    async (c) => {
      const service = container.resolve(DockerSecretService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const containerName = await resolveContainerName(nodeId, containerId);
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const user = c.get('user')!;
      const body = await c.req.json();
      const { key, value } = SecretCreateSchema.parse(body);
      const data = await service.create(nodeId, containerName, key, value, user.id);
      return c.json({ data }, 201);
    }
  );

  // Update secret
  router.openapi(
    { ...updateContainerSecretRoute, middleware: requireDockerContainerScope('docker:containers:secrets') },
    async (c) => {
      const service = container.resolve(DockerSecretService);
      const nodeId = c.req.param('nodeId')!;
      const secretId = c.req.param('secretId')!;
      await assertComposeChildMutationAllowed(nodeId, c.req.param('containerId')!);
      const user = c.get('user')!;
      const body = await c.req.json();
      const { value } = SecretUpdateSchema.parse(body);
      const data = await service.update(secretId, nodeId, value, user.id);
      return c.json({ data });
    }
  );

  // Delete secret
  router.openapi(
    { ...deleteContainerSecretRoute, middleware: requireDockerContainerScope('docker:containers:secrets') },
    async (c) => {
      const service = container.resolve(DockerSecretService);
      const nodeId = c.req.param('nodeId')!;
      const secretId = c.req.param('secretId')!;
      await assertComposeChildMutationAllowed(nodeId, c.req.param('containerId')!);
      const user = c.get('user')!;
      await service.delete(secretId, nodeId, user.id);
      return c.json({ success: true });
    }
  );

  // ─── File browser routes ─────────────────────────────────────────────

  // List directory
  router.openapi(
    { ...listContainerFilesRoute, middleware: requireDockerContainerScope('docker:containers:files:read') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const rawQuery = c.req.query();
      const { path } = FileBrowseSchema.parse(rawQuery);
      const data = await service.listDirectory(nodeId, containerId, path);
      const truncated = Array.isArray(data) && data.length > DOCKER_RESOURCE_LIST_MAX;
      return c.json({
        data: truncated ? data.slice(0, DOCKER_RESOURCE_LIST_MAX) : data,
        total: Array.isArray(data) ? data.length : undefined,
        limit: DOCKER_RESOURCE_LIST_MAX,
        truncated,
      });
    }
  );

  // Read file
  router.openapi(
    { ...readContainerFileRoute, middleware: requireDockerContainerScope('docker:containers:files:read') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const rawQuery = c.req.query();
      const { path } = FileBrowseSchema.parse(rawQuery);
      const data = await service.readFile(nodeId, containerId, path);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(data.byteLength),
        },
      });
    }
  );

  // Write file
  router.openapi(
    { ...writeContainerFileRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      const { path, content } = await parseFileContentRequest(c);
      await service.writeFile(nodeId, containerId, path, content, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...createContainerFileRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      const { path, content } = await parseFileContentRequest(c);
      await service.createFile(nodeId, containerId, path, content, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...initContainerFileUploadRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      const { path, totalBytes } = FileUploadInitSchema.parse(await c.req.json());
      const data = await service.initFileUpload(nodeId, containerId, path, totalBytes, user.id);
      return c.json({ data });
    }
  );

  router.openapi(
    { ...uploadContainerFileChunkRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const uploadId = c.req.param('uploadId')!;
      const { offset } = FileUploadChunkQuerySchema.parse(c.req.query());
      const content = Buffer.from(await c.req.arrayBuffer());
      const data = await service.appendFileUploadChunk(nodeId, containerId, uploadId, offset, content);
      return c.json({ data });
    }
  );

  router.openapi(
    { ...completeContainerFileUploadRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const uploadId = c.req.param('uploadId')!;
      const { path, totalBytes } = FileUploadCompleteSchema.parse(await c.req.json());
      await service.completeFileUpload(nodeId, containerId, uploadId, path, totalBytes);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...abortContainerFileUploadRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const uploadId = c.req.param('uploadId')!;
      await service.abortFileUpload(nodeId, containerId, uploadId);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...createContainerDirectoryRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      const body = await c.req.json();
      const { path } = FileBrowseSchema.parse(body);
      await service.createDirectory(nodeId, containerId, path, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...deleteContainerFileRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      const rawQuery = c.req.query();
      const { path } = FileBrowseSchema.parse(rawQuery);
      await service.deleteFile(nodeId, containerId, path, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...moveContainerFileRoute, middleware: requireDockerContainerScope('docker:containers:files:write') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const containerId = c.req.param('containerId')!;
      const user = c.get('user')!;
      const body = await c.req.json();
      const { fromPath, toPath } = FileMoveSchema.parse(body);
      await service.moveFile(nodeId, containerId, fromPath, toPath, user.id);
      return c.json({ success: true });
    }
  );
}
