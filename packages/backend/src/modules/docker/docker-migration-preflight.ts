import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerDeployments, dockerEnvVars, dockerSecrets, nodes, proxyHosts } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { DockerManagementService } from './docker.service.js';
import type { DockerDeploymentService } from './docker-deployment.service.js';
import { dockerGpuAttachmentFromInspect } from './docker-gpu-attachment.js';
import type { DockerMigrationPreflight, DockerMigrationPreflightInput } from './docker-migration.schemas.js';
import {
  compareDockerMigrationCapabilities,
  migrationCapacityFreeBytes,
  migrationStateDirFreeBytes,
} from './docker-migration-capabilities.js';
import type { DockerMigrationDispatchAdapter } from './docker-migration-dispatch.js';
import { assertDockerMigrationPermissions } from './docker-migration-permissions.js';
import {
  allowedSourceConsumers,
  hasImageTagCollision,
  migrationContainerState,
  migrationEnvNames,
  migrationFingerprint,
  migrationImageIdentities,
  migrationItemName,
  migrationNetworkNames,
  migrationResourceName,
  migrationSourceHostPorts,
  migrationTargetHostPorts,
  migrationTargetNames,
  portableNetworkShape,
} from './docker-migration-preflight-rules.js';

type Issue = DockerMigrationPreflight['blockers'][number];
type NodeRow = typeof nodes.$inferSelect;

const COMPOSE_LABEL_PREFIX = 'com.docker.compose.';
const STABLE_CONTAINER_STATES = new Set(['running', 'exited', 'stopped']);
const STABLE_DEPLOYMENT_STATES = new Set(['ready', 'stopped']);
const CAPACITY_MIN_MARGIN_BYTES = 2 * 1024 * 1024 * 1024;

function issue(code: string, message: string, resource?: string): Issue {
  return { code, message, ...(resource ? { resource } : {}) };
}

function hasMigrationCapability(node: NodeRow): boolean {
  const values = (node.capabilities ?? {}) as Record<string, unknown>;
  const advertised = Array.isArray(values.capabilities) ? values.capabilities : [];
  return (
    values.dockerMigrationV1 === true ||
    values.docker_migration_v1 === true ||
    advertised.includes('docker_migration_v1')
  );
}

export class DockerMigrationPreflightService {
  private licensePolicy?: LicensePolicyService;
  constructor(
    private db: DrizzleClient,
    private docker: DockerManagementService,
    private deployments: DockerDeploymentService,
    private dispatch: DockerMigrationDispatchAdapter
  ) {}

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  async run(
    input: DockerMigrationPreflightInput,
    scopes: string[],
    enforcePermissions = true
  ): Promise<DockerMigrationPreflight> {
    // LICENSE ENFORCEMENT: Starting migration discovery requires Personal under the project license/TOS.
    await this.licensePolicy?.requireFeature('cross-node-migration');
    const blockers: Issue[] = [];
    const warnings: Issue[] = [];
    if (input.sourceNodeId === input.targetNodeId) {
      blockers.push(issue('MIGRATION_SAME_NODE', 'Source and target nodes must be different'));
    }

    const [sourceNode, targetNode] = await Promise.all([
      this.getDockerNode(input.sourceNodeId),
      this.getDockerNode(input.targetNodeId),
    ]);
    this.checkNode(sourceNode, 'source', blockers);
    this.checkNode(targetNode, 'target', blockers);
    const [sourceCapabilities, targetCapabilities] = await Promise.all([
      this.loadDaemonCapabilities(sourceNode.id, 'source', blockers),
      this.loadDaemonCapabilities(targetNode.id, 'target', blockers),
    ]);
    blockers.push(...compareDockerMigrationCapabilities(sourceCapabilities, targetCapabilities));

    let deployment: Awaited<ReturnType<DockerDeploymentService['get']>> | undefined;
    let inspect: Record<string, any> | undefined;
    if (input.resource.type === 'deployment') {
      deployment = await this.deployments.get(input.sourceNodeId, input.resource.deploymentId);
    } else {
      try {
        inspect = await this.docker.inspectContainer(input.sourceNodeId, input.resource.containerName);
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 404) throw error;
        throw new AppError(502, 'MIGRATION_SOURCE_INSPECT_FAILED', 'Could not inspect the source container');
      }
    }

    const name = migrationResourceName(input, deployment);
    const scopeResourceId = String(deployment?.id ?? inspect?.scopeResourceId ?? '');
    if (!scopeResourceId) {
      throw new AppError(500, 'DOCKER_ACCESS_RESOURCE_MISSING', 'Docker access resource identity is unavailable');
    }
    const metadataName = deployment ? `deployment:${deployment.id}` : name;
    const sourceState = deployment ? String(deployment.status) : migrationContainerState(inspect ?? {});
    const allowedStates = deployment ? STABLE_DEPLOYMENT_STATES : STABLE_CONTAINER_STATES;
    if (!allowedStates.has(sourceState)) {
      blockers.push(
        issue('MIGRATION_SOURCE_STATE_UNSUPPORTED', `Source state "${sourceState}" is not migratable`, name)
      );
    }

    const labels = (inspect?.Config?.Labels ?? {}) as Record<string, unknown>;
    if (Object.keys(labels).some((key) => key.startsWith(COMPOSE_LABEL_PREFIX))) {
      blockers.push(
        issue('MIGRATION_COMPOSE_UNSUPPORTED', 'Docker Compose managed resources cannot be migrated', name)
      );
    }

    const mounts = deployment
      ? ([
          ...(deployment.desiredConfig?.mounts ?? []),
          ...deployment.slots.flatMap((slot) => slot.desiredConfig?.mounts ?? []),
        ] as Array<Record<string, unknown>>)
      : ((inspect?.Mounts ?? []) as Array<Record<string, unknown>>);
    const volumeNames = new Set<string>();
    for (const mount of mounts) {
      const type = String(mount.Type ?? (mount.name ? 'volume' : 'bind')).toLowerCase();
      const mountName = String(mount.Name ?? mount.name ?? '');
      if (type !== 'volume') {
        blockers.push(issue('MIGRATION_MOUNT_UNSUPPORTED', `Mount type "${type}" is not portable`));
      } else if (!mountName) {
        blockers.push(issue('MIGRATION_ANONYMOUS_VOLUME', 'Anonymous volumes cannot be migrated safely'));
      } else {
        volumeNames.add(mountName);
      }
    }
    this.checkHostBoundSettings(inspect, blockers);
    this.checkDeploymentGpuSelection(deployment, blockers, name);

    const [
      sourceVolumes,
      sourceNetworkRows,
      sourceImages,
      targetContainers,
      targetImages,
      targetVolumes,
      targetNetworks,
      linkedProxyHosts,
      envRows,
      secretRows,
    ] = await Promise.all([
      this.safeList(() => this.docker.listVolumes(input.sourceNodeId)),
      this.safeList(() => this.docker.listNetworks(input.sourceNodeId)),
      this.safeList(() => this.docker.listImages(input.sourceNodeId)),
      this.safeList(() => this.docker.listAllContainers(input.targetNodeId)),
      this.safeList(() => this.docker.listImages(input.targetNodeId)),
      this.safeList(() => this.docker.listVolumes(input.targetNodeId)),
      this.safeList(() => this.docker.listNetworks(input.targetNodeId)),
      this.findProxyHosts(input, name),
      this.db
        .select({ key: dockerEnvVars.key, updatedAt: dockerEnvVars.updatedAt })
        .from(dockerEnvVars)
        .where(and(eq(dockerEnvVars.nodeId, input.sourceNodeId), eq(dockerEnvVars.containerName, metadataName))),
      this.db
        .select({ key: dockerSecrets.key, updatedAt: dockerSecrets.updatedAt })
        .from(dockerSecrets)
        .where(and(eq(dockerSecrets.nodeId, input.sourceNodeId), eq(dockerSecrets.containerName, metadataName))),
    ]);

    const targetNames = new Set(targetContainers.map(migrationItemName));
    for (const targetName of migrationTargetNames(name, deployment)) {
      if (targetNames.has(targetName)) {
        blockers.push(
          issue('MIGRATION_TARGET_NAME_COLLISION', `Target container name "${targetName}" already exists`, targetName)
        );
      }
    }
    if (input.resource.type === 'deployment') {
      const [collision] = await this.db
        .select({ id: dockerDeployments.id })
        .from(dockerDeployments)
        .where(and(eq(dockerDeployments.nodeId, input.targetNodeId), eq(dockerDeployments.name, name)))
        .limit(1);
      if (collision)
        blockers.push(issue('MIGRATION_TARGET_DEPLOYMENT_COLLISION', 'Target deployment name already exists'));
    }

    const targetVolumeNames = new Set(targetVolumes.map(migrationItemName).filter(Boolean));
    const allowedConsumers = allowedSourceConsumers(inspect, deployment);
    for (const volume of volumeNames) {
      const sourceVolume = sourceVolumes.find((item) => migrationItemName(item) === volume);
      const driver = String(sourceVolume?.Driver ?? sourceVolume?.driver ?? '');
      if (driver && driver !== 'local') {
        blockers.push(
          issue('MIGRATION_VOLUME_DRIVER_UNSUPPORTED', `Volume "${volume}" does not use the local driver`, volume)
        );
      }
      const consumers = (sourceVolume?.UsedBy ?? sourceVolume?.usedBy ?? []) as unknown[];
      if (consumers.some((consumer) => !allowedConsumers.has(String(consumer).replace(/^\//, '')))) {
        blockers.push(issue('MIGRATION_VOLUME_SHARED', `Volume "${volume}" has external consumers`, volume));
      }
      if (targetVolumeNames.has(volume)) {
        blockers.push(issue('MIGRATION_TARGET_VOLUME_COLLISION', `Target volume "${volume}" already exists`, volume));
      }
    }

    const sourceNetworks = migrationNetworkNames(inspect, deployment);
    const targetNetworkNames = new Set(targetNetworks.map(migrationItemName).filter(Boolean));
    const missingNetworks = sourceNetworks.filter(
      (network) => !targetNetworkNames.has(network) && network !== 'bridge'
    );
    for (const network of input.resource.type === 'container' ? missingNetworks : []) {
      blockers.push(
        issue(
          'MIGRATION_TARGET_NETWORK_MISSING',
          `Target network "${network}" does not exist; automatic network recreation is not available`,
          network
        )
      );
    }
    for (const network of sourceNetworks.filter((item) => targetNetworkNames.has(item) && item !== 'bridge')) {
      const sourceDefinition = sourceNetworkRows.find((item) => migrationItemName(item) === network);
      const targetDefinition = targetNetworks.find((item) => migrationItemName(item) === network);
      if (
        sourceDefinition &&
        targetDefinition &&
        portableNetworkShape(sourceDefinition) !== portableNetworkShape(targetDefinition)
      ) {
        blockers.push(
          issue('MIGRATION_TARGET_NETWORK_COLLISION', `Target network "${network}" is incompatible`, network)
        );
      }
    }
    const occupiedPorts = migrationTargetHostPorts(targetContainers);
    for (const port of migrationSourceHostPorts(inspect, deployment)) {
      if (occupiedPorts.has(port)) {
        blockers.push(issue('MIGRATION_TARGET_PORT_COLLISION', `Target host port ${port} is in use`));
      }
    }
    if (hasImageTagCollision(inspect, targetImages)) {
      blockers.push(
        issue('MIGRATION_TARGET_IMAGE_TAG_COLLISION', 'A source image tag points to another image on the target')
      );
    }
    const imageIdentities = migrationImageIdentities(inspect, deployment);
    const artifactSizes = new Map<string, number>();
    let requiredBytes = 0;
    for (const identity of imageIdentities) {
      const image = sourceImages.find((candidate) => {
        const id = String(candidate.Id ?? candidate.id ?? '');
        const tags = (candidate.RepoTags ?? candidate.repoTags ?? []) as string[];
        return id === identity || tags.includes(identity);
      });
      const size = Number(image?.Size ?? image?.size ?? 0);
      if (size > 0) {
        artifactSizes.set(`image:${identity}`, size);
        requiredBytes += size;
      }
    }
    for (const volumeName of volumeNames) {
      try {
        const measured = await this.dispatch.measureVolume(input.sourceNodeId, volumeName);
        artifactSizes.set(`volume:${volumeName}`, measured.logicalBytes);
        requiredBytes += measured.logicalBytes;
      } catch (error) {
        blockers.push(
          issue(
            'MIGRATION_VOLUME_MEASURE_FAILED',
            error instanceof Error ? error.message : `Could not measure volume ${volumeName}`,
            volumeName
          )
        );
      }
    }
    const availableBytes = migrationCapacityFreeBytes(targetCapabilities);
    const sourceSpoolBytes = migrationStateDirFreeBytes(sourceCapabilities);
    const marginBytes = Math.max(CAPACITY_MIN_MARGIN_BYTES, Math.ceil(requiredBytes * 0.1));
    if (requiredBytes === 0 || availableBytes === null) {
      blockers.push(issue('MIGRATION_CAPACITY_UNKNOWN', 'Target Docker storage capacity or artifact size is unknown'));
    } else if (availableBytes < requiredBytes + marginBytes) {
      blockers.push(
        issue('MIGRATION_CAPACITY_INSUFFICIENT', 'Target Docker storage does not have the required safety margin')
      );
    }
    if (sourceSpoolBytes !== null && sourceSpoolBytes < requiredBytes + marginBytes) {
      blockers.push(
        issue('MIGRATION_SOURCE_SPOOL_INSUFFICIENT', 'Source daemon state directory lacks migration spool space')
      );
    }

    const proxyNodeIds = [...new Set(linkedProxyHosts.map((host) => host.nodeId).filter((id): id is string => !!id))];
    const proxyNodeRows =
      proxyNodeIds.length > 0
        ? await this.db
            .select({ id: nodes.id, status: nodes.status })
            .from(nodes)
            .where(inArray(nodes.id, proxyNodeIds))
        : [];
    const proxyNodeStatus = new Map(proxyNodeRows.map((node) => [node.id, node.status]));
    for (const host of linkedProxyHosts) {
      if (
        host.enabled &&
        (host.isSystem ||
          host.type !== 'proxy' ||
          host.rawConfigEnabled ||
          !host.nodeId ||
          proxyNodeStatus.get(host.nodeId) !== 'online')
      ) {
        blockers.push(
          issue(
            'MIGRATION_PROXY_MAINTENANCE_UNAVAILABLE',
            'A linked enabled proxy host cannot enter managed maintenance',
            host.id
          )
        );
      }
    }

    const artifacts = [
      ...(imageIdentities.map((identity) => ({
        kind: 'image' as const,
        sourceIdentity: identity,
        targetIdentity: identity,
        sizeBytes: artifactSizes.get(`image:${identity}`) ?? null,
      })) ?? []),
      ...[...volumeNames].map((identity) => ({
        kind: 'volume' as const,
        sourceIdentity: identity,
        targetIdentity: identity,
        sizeBytes: artifactSizes.get(`volume:${identity}`) ?? null,
      })),
    ];

    if (enforcePermissions) {
      assertDockerMigrationPermissions(scopes, {
        sourceNodeId: input.sourceNodeId,
        sourceResourceId: scopeResourceId,
        targetNodeId: input.targetNodeId,
        keepSource: input.keepSource,
        hasVolumes: volumeNames.size > 0,
        createsNetworks: input.resource.type === 'deployment' && missingNetworks.length > 0,
        hasProxyHosts: linkedProxyHosts.length > 0,
      });
    }

    const deploymentEnvNames = Object.keys(deployment?.desiredConfig?.env ?? {}).sort();
    const runtimeEnvNames = [...new Set([...migrationEnvNames(inspect?.Config?.Env), ...deploymentEnvNames])];
    const fingerprint = migrationFingerprint({
      resource: input.resource,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      keepSource: input.keepSource,
      sourceIdentity: inspect?.Id ?? deployment?.id,
      sourceState,
      image: inspect?.Image ?? deployment?.desiredConfig?.image,
      labels,
      mounts: [...volumeNames].sort(),
      networks: sourceNetworks,
      envNames: [...new Set([...runtimeEnvNames, ...envRows.map((row) => row.key)])].sort(),
      envVersions: envRows.map((row) => row.updatedAt.toISOString()).sort(),
      secretNames: secretRows.map((row) => row.key).sort(),
      secretVersions: secretRows.map((row) => row.updatedAt.toISOString()).sort(),
      proxy: linkedProxyHosts.map((host) => [host.id, host.updatedAt.toISOString()]).sort(),
    });

    if (!input.keepSource && inspect?.SizeRw && Number(inspect.SizeRw) > 0) {
      warnings.push(issue('MIGRATION_WRITABLE_LAYER_NOT_PRESERVED', 'Writable-layer changes are not preserved'));
    }
    return {
      fingerprint,
      resourceType: input.resource.type,
      resourceName: name,
      sourceResourceId:
        input.resource.type === 'container' ? String(inspect?.Id ?? name) : String(deployment?.id ?? name),
      scopeResourceId,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      targetNodeSlug: targetNode.slug,
      keepSource: input.keepSource,
      sourceState,
      blockers,
      warnings,
      plannedChanges: [
        'Transfer exact source images and verified local named volumes',
        'Preserve environment and secrets without persisting plaintext in migration records',
        ...(linkedProxyHosts.length ? ['Enter managed proxy maintenance and cut traffic over to the target'] : []),
        input.keepSource
          ? 'Keep the source stopped, restart-disabled, and migration-guarded'
          : 'Delete the verified source resource and exclusive source volumes after cutover',
      ],
      capacity: {
        requiredBytes,
        availableBytes,
        marginBytes,
        sufficient: requiredBytes > 0 && availableBytes !== null && availableBytes >= requiredBytes + marginBytes,
      },
      artifacts,
      deletionPlan: input.keepSource
        ? []
        : [
            { type: input.resource.type, name },
            ...[...volumeNames].map((volumeName) => ({
              type: 'volume' as const,
              name: volumeName,
              sizeBytes: artifactSizes.get(`volume:${volumeName}`),
            })),
          ],
      proxyHosts: linkedProxyHosts.map((host) => ({
        id: host.id,
        enabled: host.enabled,
        maintenanceAlreadyEnabled: host.maintenanceEnabled,
      })),
      verificationPlan: [
        'Docker image digest equality',
        'Volume artifact digest, logical tree root, metadata, counts, bytes, and fsync evidence',
        'Portable Docker create-manifest comparison',
        'In-memory effective environment and secret value comparison',
        ...(sourceState === 'running' || sourceState === 'ready' ? ['Application health gate'] : []),
      ],
      environmentKeyCount: new Set([...runtimeEnvNames, ...envRows.map((row) => row.key)]).size,
      secretKeyCount: secretRows.length,
    };
  }

  private async getDockerNode(id: string): Promise<NodeRow> {
    const [node] = await this.db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Docker node not found');
    if (node.type !== 'docker') throw new AppError(400, 'NOT_DOCKER', 'Migration nodes must be Docker nodes');
    return node;
  }

  private checkNode(node: NodeRow, side: string, blockers: Issue[]) {
    if (node.status !== 'online') blockers.push(issue('MIGRATION_NODE_OFFLINE', `${side} node is not online`, node.id));
    if (node.serviceCreationLocked) blockers.push(issue('MIGRATION_NODE_LOCKED', `${side} node is locked`, node.id));
    if (!hasMigrationCapability(node)) {
      blockers.push(issue('MIGRATION_PROTOCOL_UNSUPPORTED', `${side} node lacks docker_migration_v1`, node.id));
    }
  }

  private async loadDaemonCapabilities(nodeId: string, side: string, blockers: Issue[]) {
    try {
      return await this.dispatch.capabilities(nodeId);
    } catch (error) {
      blockers.push(
        issue(
          'MIGRATION_CAPABILITY_UNAVAILABLE',
          error instanceof Error ? error.message : `${side} Docker capabilities are unavailable`,
          nodeId
        )
      );
      return null;
    }
  }

  private checkHostBoundSettings(inspect: Record<string, any> | undefined, blockers: Issue[]) {
    if (!inspect) return;
    const host = inspect.HostConfig ?? {};
    const namespaceModes = [host.NetworkMode, host.PidMode, host.IpcMode, host.UTSMode];
    if (namespaceModes.some((mode) => mode === 'host' || String(mode ?? '').startsWith('container:'))) {
      blockers.push(issue('MIGRATION_NAMESPACE_UNSUPPORTED', 'Host or container namespace sharing is not portable'));
    }
    const gpuAttachment = dockerGpuAttachmentFromInspect(inspect);
    if (gpuAttachment.mode !== 'none') {
      blockers.push(issue('GPU_MIGRATION_UNSUPPORTED', 'GPU-mapped containers cannot be migrated in this version'));
      return;
    }
    if ((host.Devices?.length ?? 0) > 0 || (host.DeviceRequests?.length ?? 0) > 0) {
      blockers.push(
        issue('MIGRATION_DEVICE_VALIDATION_REQUIRED', 'Device mappings require target manifest validation')
      );
    }
  }

  private checkDeploymentGpuSelection(
    deployment: Awaited<ReturnType<DockerDeploymentService['get']>> | undefined,
    blockers: Issue[],
    name: string
  ) {
    if (!deployment) return;
    const configs = [deployment.desiredConfig, ...deployment.slots.map((slot) => slot.desiredConfig)];
    const hasGpuSelection = configs.some((config) => {
      const gpu = config?.gpu;
      if (gpu === undefined) return false;
      return !Array.isArray(gpu.deviceIds) || gpu.deviceIds.length > 0;
    });
    if (hasGpuSelection) {
      blockers.push(
        issue('GPU_MIGRATION_UNSUPPORTED', 'GPU-mapped deployments cannot be migrated in this version', name)
      );
    }
  }

  private async safeList(load: () => Promise<any>): Promise<Record<string, any>[]> {
    const value = await load();
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.Volumes)) return value.Volumes;
    throw new AppError(502, 'MIGRATION_PREFLIGHT_INSPECTION_FAILED', 'A Docker preflight inventory was unavailable');
  }

  private findProxyHosts(input: DockerMigrationPreflightInput, name: string) {
    const condition =
      input.resource.type === 'container'
        ? and(
            eq(proxyHosts.upstreamKind, 'docker_container'),
            eq(proxyHosts.dockerNodeId, input.sourceNodeId),
            eq(proxyHosts.dockerContainerName, name)
          )
        : and(
            eq(proxyHosts.upstreamKind, 'docker_deployment'),
            eq(proxyHosts.dockerDeploymentId, input.resource.deploymentId)
          );
    return this.db
      .select({
        id: proxyHosts.id,
        enabled: proxyHosts.enabled,
        maintenanceEnabled: proxyHosts.maintenanceEnabled,
        isSystem: proxyHosts.isSystem,
        type: proxyHosts.type,
        rawConfigEnabled: proxyHosts.rawConfigEnabled,
        nodeId: proxyHosts.nodeId,
        updatedAt: proxyHosts.updatedAt,
      })
      .from(proxyHosts)
      .where(condition);
  }
}
