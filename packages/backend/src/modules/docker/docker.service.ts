import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerDeployments, dockerManagedVolumes, nodes } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { type LicensePolicyService, requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import type { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { type DockerRuntimeStatus, DockerRuntimeStatusSchema } from './docker.schemas.js';
import { type DockerAccessResourceService, hasDockerResourceScope } from './docker-access-resource.service.js';
import {
  createContainer as createDockerContainer,
  type DockerContainerMutationContext,
  duplicateContainer as duplicateDockerContainer,
  killContainer as killDockerContainer,
  liveUpdateContainer as liveUpdateDockerContainer,
  recreateWithConfig as recreateDockerContainerWithConfig,
  removeContainer as removeDockerContainerMutation,
  renameContainer as renameDockerContainer,
  restartContainer as restartDockerContainer,
  rollbackCreatedContainer as rollbackDockerCreatedContainer,
  startContainer as startDockerContainer,
  stopContainer as stopDockerContainer,
  updateContainer as updateDockerContainer,
  updateContainerEnv as updateDockerContainerEnv,
} from './docker-container-mutation-operations.js';
import { type ContainerTransition, DockerContainerTransitions } from './docker-container-transitions.js';
import type { DockerDeploymentService } from './docker-deployment.service.js';
import { DOCKER_DEPLOYMENT_ID_LABEL, DOCKER_DEPLOYMENT_MANAGED_LABEL } from './docker-deployment-labels.js';
import { getContainerEnv as getDockerContainerEnv } from './docker-env-operations.js';
import type { DockerEnvironmentService } from './docker-environment.service.js';
import type { DockerFolderService } from './docker-folder.service.js';
import { deriveDockerGpuAttachment, hasDockerGpuV1Capability } from './docker-gpu-attachment.js';
import type { DockerHealthCheckService } from './docker-health-check.service.js';
import type { DockerImageCleanupService } from './docker-image-cleanup.service.js';
import {
  listImages as listDockerImages,
  pruneImages as pruneDockerImages,
  pullImage as pullDockerImage,
  removeImage as removeDockerImage,
} from './docker-image-operations.js';
import { filterGatewayInternalContainers, isGatewayInternalContainer } from './docker-internal-containers.js';
import {
  type ContainerAction,
  type DockerLifecycleWatchContext,
  watchDockerRecreateByName,
  watchDockerTransition,
} from './docker-lifecycle-watch.js';
import { assertManagedMountMutation } from './docker-managed-mounts.js';
import type { DockerMigrationGuard } from './docker-migration-guard.js';
import { hasDockerPortBindIpV1Capability } from './docker-port-bindings.js';
import {
  abortFileUpload as abortDockerFileUpload,
  appendFileUploadChunk as appendDockerFileUploadChunk,
  completeFileUpload as completeDockerFileUpload,
  createDirectory as createDockerDirectory,
  createFile as createDockerFile,
  deleteFile as deleteDockerFile,
  getContainerLogs as getDockerContainerLogs,
  getContainerStats as getDockerContainerStats,
  getContainerTop as getDockerContainerTop,
  initFileUpload as initDockerFileUpload,
  listDirectory as listDockerDirectory,
  moveFile as moveDockerFile,
  readFile as readDockerFile,
  writeFile as writeDockerFile,
} from './docker-read-operations.js';
import { dockerDispatchErrorMessage } from './docker-recreate-watch.js';
import type { DockerRegistryService } from './docker-registry.service.js';
import { applyRuntimeSettingsToInspect } from './docker-runtime-inspect.js';
import type { DockerRuntimeOperationContext } from './docker-runtime-operations.js';
import type { DockerRuntimeSettingsService } from './docker-runtime-settings.service.js';
import type { DockerSecretService } from './docker-secret.service.js';
import type { DockerTaskService } from './docker-task.service.js';
import {
  abortVolumeFileUpload as abortDockerVolumeFileUpload,
  adoptVolume as adoptDockerVolume,
  appendVolumeFileUploadChunk as appendDockerVolumeFileUploadChunk,
  completeVolumeFileUpload as completeDockerVolumeFileUpload,
  connectContainerToNetwork as connectDockerContainerToNetwork,
  createNetwork as createDockerNetwork,
  createVolume as createDockerVolume,
  createVolumeDirectory as createDockerVolumeDirectory,
  createVolumeFile as createDockerVolumeFile,
  deleteVolumeFile as deleteDockerVolumeFile,
  disconnectContainerFromNetwork as disconnectDockerContainerFromNetwork,
  exportVolume as exportDockerVolume,
  initVolumeFileUpload as initDockerVolumeFileUpload,
  inspectVolume as inspectDockerVolume,
  listNetworks as listDockerNetworks,
  listVolumeFiles as listDockerVolumeFiles,
  listVolumes as listDockerVolumes,
  moveVolumeFile as moveDockerVolumeFile,
  readVolumeFile as readDockerVolumeFile,
  removeNetwork as removeDockerNetwork,
  removeVolume as removeDockerVolume,
  renameVolume as renameDockerVolume,
  updateVolumeLabels as updateDockerVolumeLabels,
  writeVolumeFile as writeDockerVolumeFile,
} from './docker-volume-network-operations.js';

const logger = createChildLogger('DockerManagementService');
const DEFAULT_CONTAINER_STOP_TIMEOUT_SECONDS = 20;
const CONTAINER_LIFECYCLE_TIMEOUT_BUFFER_SECONDS = 30;
const GPU_USAGE_INSPECTION_BATCH_SIZE = 8;

export type { ContainerTransition } from './docker-container-transitions.js';

export interface DockerGpuAttachmentUser {
  containerId: string;
  name: string;
  scopeResourceId: string | null;
  deviceIds: string[];
}

export class DockerManagementService {
  private static readonly LONG_DOCKER_OPERATION_TIMEOUT_MS = 600000; // 10 minutes

  /**
   * `${nodeId}:${containerName}` → current transition state.
   * Keyed by name (not ID) so the badge survives recreate/update, which
   * destroy the old container and create a new one with a different ID.
   */
  private containerTransitions = new DockerContainerTransitions();

  private taskService?: DockerTaskService;
  private environmentService?: DockerEnvironmentService;
  private runtimeSettingsService?: DockerRuntimeSettingsService;
  private secretService?: DockerSecretService;
  private folderService?: DockerFolderService;
  private deploymentService?: DockerDeploymentService;
  private healthCheckService?: DockerHealthCheckService;
  private registryService?: DockerRegistryService;
  private imageCleanupService?: DockerImageCleanupService;
  private eventBus?: EventBusService;
  private evaluator?: NotificationEvaluatorService;
  private migrationGuard?: DockerMigrationGuard;
  private accessResourceService?: DockerAccessResourceService;
  private licensePolicy?: LicensePolicyService;

  constructor(
    private db: DrizzleClient,
    private auditService: AuditService,
    private nodeDispatch: NodeDispatchService,
    private nodeRegistry: NodeRegistryService
  ) {}

  setTaskService(taskService: DockerTaskService) {
    this.taskService = taskService;
  }

  setEnvironmentService(environmentService: DockerEnvironmentService) {
    this.environmentService = environmentService;
  }

  setRuntimeSettingsService(runtimeSettingsService: DockerRuntimeSettingsService) {
    this.runtimeSettingsService = runtimeSettingsService;
  }

  setSecretService(secretService: DockerSecretService) {
    this.secretService = secretService;
  }

  setFolderService(folderService: DockerFolderService) {
    this.folderService = folderService;
  }

  setDeploymentService(deploymentService: DockerDeploymentService) {
    this.deploymentService = deploymentService;
  }

  setHealthCheckService(healthCheckService: DockerHealthCheckService) {
    this.healthCheckService = healthCheckService;
  }

  setRegistryService(registryService: DockerRegistryService) {
    this.registryService = registryService;
  }

  setImageCleanupService(imageCleanupService: DockerImageCleanupService) {
    this.imageCleanupService = imageCleanupService;
  }

  setEventBus(eventBus: EventBusService) {
    this.eventBus = eventBus;
  }

  setEvaluator(evaluator: NotificationEvaluatorService) {
    this.evaluator = evaluator;
  }

  setMigrationGuard(guard: DockerMigrationGuard) {
    this.migrationGuard = guard;
  }

  setAccessResourceService(service: DockerAccessResourceService) {
    this.accessResourceService = service;
  }

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  private emitContainer(
    nodeId: string,
    name: string,
    id: string,
    action: ContainerAction,
    extra?: Record<string, unknown>
  ) {
    const scopeResourceId = this.accessResourceService?.cachedContainerResourceId(nodeId, {
      name,
      runtimeId: id,
    });
    this.eventBus?.publish('docker.container.changed', {
      nodeId,
      name,
      id,
      action,
      ...(scopeResourceId ? { scopeResourceId } : {}),
      ...(extra || {}),
    });
    this.observeContainerLifecycle(nodeId, name, id, action, extra);
  }

  async registerImportedContainer(nodeId: string, name: string, runtimeId: string): Promise<void> {
    await this.accessResourceService?.ensureContainer(nodeId, name, runtimeId, false);
    this.emitContainer(nodeId, name, runtimeId, 'created', { source: 'gwca-import' });
  }

  emitTransition(nodeId: string, name: string, id: string, transition: ContainerTransition | null) {
    const scopeResourceId = this.accessResourceService?.cachedContainerResourceId(nodeId, {
      name,
      runtimeId: id,
    });
    this.eventBus?.publish('docker.container.changed', {
      nodeId,
      name,
      id,
      action: 'transitioning',
      transition,
      ...(scopeResourceId ? { scopeResourceId } : {}),
    });
  }

  private observeContainerLifecycle(
    nodeId: string,
    name: string,
    id: string,
    action: ContainerAction,
    extra?: Record<string, unknown>
  ) {
    const state = this.lifecycleStateForAction(action);
    if (!state) return;

    const observedPatterns = state === 'started' || state === 'removed' ? ['stopped', 'exited'] : [state];
    this.evaluator
      ?.observeStatefulEvent(
        'container',
        state,
        { type: 'container', id: name || id, name: name || id },
        { nodeId, containerId: id, action, ...(extra || {}) },
        observedPatterns
      )
      .catch((error) => {
        logger.debug('Container lifecycle stateful event observation failed', {
          nodeId,
          containerId: id,
          action,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private lifecycleStateForAction(action: ContainerAction): 'started' | 'stopped' | 'exited' | 'removed' | null {
    switch (action) {
      case 'started':
      case 'restarted':
      case 'recreated':
        return 'started';
      case 'stopped':
        return 'stopped';
      case 'killed':
        return 'exited';
      case 'removed':
        return 'removed';
      default:
        return null;
    }
  }

  private imageOperationContext() {
    return {
      nodeDispatch: this.nodeDispatch,
      auditService: this.auditService,
      taskService: this.taskService,
      registryService: this.registryService,
      eventBus: this.eventBus,
      parseResult: (result: { success: boolean; error?: string; detail?: string }) => this.parseResult(result),
      createTask: (nodeId: string, containerId: string, containerName: string, type: string) =>
        this.createTask(nodeId, containerId, containerName, type),
      longDockerOperationTimeoutMs: DockerManagementService.LONG_DOCKER_OPERATION_TIMEOUT_MS,
    };
  }

  private volumeNetworkOperationContext() {
    return {
      db: this.db,
      nodeDispatch: this.nodeDispatch,
      auditService: this.auditService,
      eventBus: this.eventBus,
      parseResult: (result: { success: boolean; error?: string; detail?: string }) => this.parseResult(result),
    };
  }

  private readOperationContext() {
    return {
      nodeDispatch: this.nodeDispatch,
      auditService: this.auditService,
      eventBus: this.eventBus,
      parseResult: (result: { success: boolean; error?: string; detail?: string }) => this.parseResult(result),
    };
  }

  private envOperationContext() {
    return {
      nodeDispatch: this.nodeDispatch,
      environmentService: this.environmentService,
      secretService: this.secretService,
      parseResult: (result: { success: boolean; error?: string; detail?: string }) => this.parseResult(result),
    };
  }

  private runtimeOperationContext(): DockerRuntimeOperationContext {
    return {
      db: this.db,
      nodeDispatch: this.nodeDispatch,
      nodeRegistry: this.nodeRegistry,
      runtimeSettingsService: this.runtimeSettingsService,
      parseResult: (result: { success: boolean; error?: string; detail?: string }) => this.parseResult(result),
    };
  }

  private lifecycleWatchContext(): DockerLifecycleWatchContext {
    return {
      nodeDispatch: this.nodeDispatch,
      taskService: this.taskService,
      eventBus: this.eventBus,
      parseResult: (result: { success: boolean; error?: string; detail?: string }) => this.parseResult(result),
      clearTransition: (nodeId: string, name: string) => this.clearTransition(nodeId, name),
      emitContainer: (nodeId, name, id, action, extra) => this.emitContainer(nodeId, name, id, action, extra),
      failTask: (taskId, error, nodeId, containerName) => this.failTask(taskId, error, nodeId, containerName),
      preserveContainerIdentity: (nodeId, name, runtimeId) =>
        this.accessResourceService?.preserveContainerRuntimeId(nodeId, name, runtimeId) ?? Promise.resolve(),
    };
  }

  /**
   * Verify the target name is not already taken on this node.
   * Two-layer guard: (1) blocks if a name-keyed transition is in flight,
   * (2) lists containers and rejects if the name already exists.
   * Should be called BEFORE dispatching create/rename/duplicate to the daemon.
   */
  private async assertNameAvailable(nodeId: string, name: string) {
    if (this.getTransition(nodeId, name)) {
      throw new AppError(409, 'NAME_IN_USE', `A container named "${name}" is currently being modified on this node`);
    }
    const [deployment] = await this.db
      .select({ id: dockerDeployments.id })
      .from(dockerDeployments)
      .where(and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.name, name)))
      .limit(1);
    if (deployment) {
      throw new AppError(409, 'NAME_IN_USE', `A deployment named "${name}" already exists on this node`);
    }
    try {
      const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'list');
      const containers = this.parseResult(result);
      if (Array.isArray(containers)) {
        const collision = containers.some((c: any) => {
          if (this.isManagedDeploymentInternal(c)) return false;
          const cName = ((c.name ?? c.Name ?? '') as string).replace(/^\//, '');
          return cName === name;
        });
        if (collision) {
          throw new AppError(409, 'NAME_IN_USE', `A container named "${name}" already exists on this node`);
        }
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        502,
        'NAME_AVAILABILITY_CHECK_FAILED',
        `Could not verify whether the container name "${name}" is available`
      );
    }
  }

  /**
   * Translate a Docker name-conflict error from the daemon into a friendly
   * AppError. Pass any caught error through this on create/rename/duplicate.
   */
  private translateNameConflict(err: unknown, name: string): never {
    const message = err instanceof Error ? err.message : String(err);
    if (/already in use|name.*conflict|409/i.test(message)) {
      throw new AppError(409, 'NAME_IN_USE', `A container named "${name}" already exists on this node`);
    }
    throw err;
  }

  requireNoTransition(nodeId: string, name: string) {
    this.containerTransitions.requireIdle(nodeId, name);
  }

  setTransition(nodeId: string, name: string, state: ContainerTransition): boolean {
    return this.containerTransitions.set(nodeId, name, state);
  }

  clearTransition(nodeId: string, name: string) {
    this.containerTransitions.clear(nodeId, name);
  }

  private getTransition(nodeId: string, name: string): ContainerTransition | undefined {
    return this.containerTransitions.get(nodeId, name);
  }

  getContainerTransition(nodeId: string, name: string): ContainerTransition | undefined {
    return this.getTransition(nodeId, name);
  }

  private async resolveContainerName(nodeId: string, containerId: string): Promise<string> {
    try {
      const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
      const data = this.parseResult(result);
      return (data?.Name ?? '').replace(/^\//, '') || containerId.slice(0, 12);
    } catch {
      return containerId.slice(0, 12);
    }
  }

  private async resolveExpectedRecreateState(nodeId: string, containerId: string): Promise<'running' | 'created'> {
    try {
      const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
      const data = this.parseResult(result);
      return data?.State?.Status === 'running' ? 'running' : 'created';
    } catch {
      return 'running';
    }
  }

  private isManagedDeploymentInternal(data: any): boolean {
    const labels = data?.Config?.Labels ?? data?.Labels ?? data?.labels ?? {};
    return labels?.[DOCKER_DEPLOYMENT_MANAGED_LABEL] === 'true';
  }

  private async assertNotManagedDeploymentInternal(nodeId: string, containerId: string) {
    const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
    const data = this.parseResult(result);
    if (this.isManagedDeploymentInternal(data)) {
      throw new AppError(
        409,
        'MANAGED_DEPLOYMENT_CONTAINER',
        'This container is managed by a blue/green deployment. Use deployment actions instead.'
      );
    }
  }

  private async createTask(nodeId: string, containerId: string, containerName: string, type: string) {
    if (!this.taskService) return undefined;
    const task = await this.taskService.create({ nodeId, containerId, containerName, type });
    await this.taskService.update(task.id, { status: 'running' });
    return task;
  }

  private async failTask(taskId: string | undefined, error: string, nodeId?: string, containerName?: string) {
    if (nodeId && containerName) this.clearTransition(nodeId, containerName);
    if (nodeId && containerName) {
      this.eventBus?.publish('docker.container.changed', {
        nodeId,
        name: containerName,
        action: 'transitioning',
        transition: null,
      });
    }
    if (taskId && this.taskService) {
      await this.taskService.update(taskId, { status: 'failed', error, completedAt: new Date() }).catch(() => {});
    }
  }

  private async resolveContainerStopTimeout(nodeId: string, containerId: string, timeout: number | undefined) {
    if (timeout !== undefined) return timeout;

    try {
      const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
      const data = this.parseResult(result);
      const configuredRaw = data?.Config?.StopTimeout;
      const configured = typeof configuredRaw === 'number' ? configuredRaw : Number.NaN;
      if (Number.isInteger(configured) && configured >= 0) return configured;
    } catch {
      // Fall through to Gateway default if inspect fails; the lifecycle command will report its own error.
    }

    return DEFAULT_CONTAINER_STOP_TIMEOUT_SECONDS;
  }

  private lifecycleWatchTimeoutMs(
    stopTimeoutSeconds: number,
    bufferSeconds = CONTAINER_LIFECYCLE_TIMEOUT_BUFFER_SECONDS
  ) {
    return Math.max(60000, (stopTimeoutSeconds + bufferSeconds) * 1000);
  }

  private resolveStopTimeoutFromInspect(inspect: Record<string, any>, config?: Record<string, unknown>) {
    const configRaw = config?.stopTimeout;
    const configValue = typeof configRaw === 'number' ? configRaw : Number.NaN;
    if (Number.isInteger(configValue) && configValue >= 0) return configValue;

    const inspectRaw = inspect?.Config?.StopTimeout;
    const inspectValue = typeof inspectRaw === 'number' ? inspectRaw : Number.NaN;
    if (Number.isInteger(inspectValue) && inspectValue >= 0) return inspectValue;

    return DEFAULT_CONTAINER_STOP_TIMEOUT_SECONDS;
  }

  /**
   * Poll container state to detect when an async operation completes,
   * then mark the task as succeeded and clear the transition.
   */
  private watchTransition(
    nodeId: string,
    containerId: string,
    name: string,
    taskId: string | undefined,
    expectedState: string,
    progress: string,
    completedAction: ContainerAction,
    timeoutMs = 60000,
    isComplete?: (inspectData: Record<string, any>) => boolean
  ) {
    watchDockerTransition(
      this.lifecycleWatchContext(),
      nodeId,
      containerId,
      name,
      taskId,
      expectedState,
      progress,
      completedAction,
      timeoutMs,
      isComplete
    );
  }

  /**
   * Poll by container NAME to detect when a recreate completes.
   * Waits for a container with the given name to appear with a DIFFERENT ID
   * and reach the expected state.
   */
  private watchRecreateByName(
    nodeId: string,
    containerName: string,
    oldContainerId: string,
    taskId: string | undefined,
    progress: string,
    expectedState: string,
    timeoutMs = 60000,
    onComplete?: (newContainerId: string) => Promise<void>,
    daemonTaskId?: string
  ) {
    watchDockerRecreateByName(
      this.lifecycleWatchContext(),
      nodeId,
      containerName,
      oldContainerId,
      taskId,
      progress,
      expectedState,
      timeoutMs,
      onComplete,
      daemonTaskId
    );
  }

  private async validateDockerNode(nodeId: string) {
    const [node] = await this.db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) throw new AppError(404, 'NOT_FOUND', 'Node not found');
    if (node.type !== 'docker') throw new AppError(400, 'NOT_DOCKER', 'Node is not a Docker node');
    if (!this.nodeRegistry.getNode(nodeId)) throw new AppError(502, 'NODE_OFFLINE', 'Node is offline');
    return node;
  }

  private async assertDockerGpuCapability(nodeId: string): Promise<void> {
    const node = await this.validateDockerNode(nodeId);
    if (!hasDockerGpuV1Capability(node.capabilities)) {
      throw new AppError(
        409,
        'UNSUPPORTED_DAEMON',
        'Docker node does not support Gateway GPU attachments. Update the Docker daemon before changing GPU configuration.'
      );
    }
  }

  private async assertDockerPortBindIpCapability(nodeId: string): Promise<void> {
    const node = await this.validateDockerNode(nodeId);
    if (!hasDockerPortBindIpV1Capability(node.capabilities)) {
      throw new AppError(
        409,
        'UNSUPPORTED_DAEMON',
        'Docker node does not support interface-specific port publishing. Update the Docker daemon before changing the publish address.'
      );
    }
  }

  private async assertDockerRuntimeProfileAvailable(
    nodeId: string,
    profile: unknown,
    currentProfile?: unknown
  ): Promise<void> {
    if (profile !== 'secure') return;
    if (currentProfile !== 'secure') {
      // LICENSE ENFORCEMENT: A new transition to Secure Runtime requires Business under the project license/TOS.
      await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('secure-runtime');
    }
    const node = await this.validateDockerNode(nodeId);
    const status = (node.capabilities as Record<string, any> | null)?.dockerRuntimeStatus;
    if (status?.state !== 'healthy') {
      throw new AppError(
        409,
        'SECURE_RUNTIME_UNAVAILABLE',
        status?.message || 'Secure Runtime is not healthy on this node. Complete Setup in Node Details first.'
      );
    }
  }

  private parseResult(result: { success: boolean; error?: string; detail?: string }) {
    if (!result.success) {
      throw new AppError(502, 'DISPATCH_ERROR', dockerDispatchErrorMessage(result, 'Command failed on daemon'));
    }
    try {
      return result.detail ? JSON.parse(result.detail) : null;
    } catch {
      return result.detail;
    }
  }

  // ─── Container operations ──────────────────────────────────────────

  async listContainers(nodeId: string) {
    await this.validateDockerNode(nodeId);
    const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'list');
    const containers = this.parseResult(result);
    return this.decoratePublicContainerSnapshot(nodeId, containers);
  }

  /** Internal inventory for services that must account for Gateway-owned containers. */
  async listAllContainers(nodeId: string) {
    await this.validateDockerNode(nodeId);
    const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'list');
    const containers = this.parseResult(result);
    return this.decorateContainerSnapshot(nodeId, containers);
  }

  /**
   * Resolve the physical GPUs used by real containers on demand. Container
   * summaries intentionally omit HostConfig, so this read-only view inspects
   * each entry only when the Settings table needs it.
   */
  async listGpuAttachmentUsers(nodeId: string, actorScopes: string[]): Promise<DockerGpuAttachmentUser[]> {
    await this.validateDockerNode(nodeId);
    const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'list');
    const containers = this.parseResult(result);
    if (!Array.isArray(containers)) return [];

    const gpuInventory = await this.gpuInventoryForNode(nodeId);
    const resourceRows = (await this.accessResourceService?.listContainerResourceIdentities(nodeId)) ?? [];
    const resourceIdByName = new Map(resourceRows.map((row) => [row.name, row.id]));
    const resourceIdByRuntime = new Map(
      resourceRows.filter((row) => !!row.runtimeId).map((row) => [row.runtimeId!, row.id])
    );
    const visibleContainers = containers.flatMap((item) => {
      const container = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      if (isGatewayInternalContainer(container)) return [];
      const containerId = String(container.id ?? container.Id ?? '');
      if (!containerId) return [];
      const name = String(container.name ?? container.Name ?? '').replace(/^\/+/, '');
      const labels = (container.labels ?? container.Labels ?? {}) as Record<string, unknown>;
      const deploymentId = String(labels[DOCKER_DEPLOYMENT_ID_LABEL] ?? '');
      const scopeResourceId =
        labels[DOCKER_DEPLOYMENT_MANAGED_LABEL] === 'true' && deploymentId
          ? deploymentId
          : (resourceIdByRuntime.get(containerId) ?? resourceIdByName.get(name) ?? null);
      if (!hasDockerResourceScope(actorScopes, 'docker:containers:view', nodeId, scopeResourceId ?? '')) {
        return [];
      }
      return [{ containerId, name, scopeResourceId }];
    });
    const users: DockerGpuAttachmentUser[] = [];
    for (let offset = 0; offset < visibleContainers.length; offset += GPU_USAGE_INSPECTION_BATCH_SIZE) {
      const batch = visibleContainers.slice(offset, offset + GPU_USAGE_INSPECTION_BATCH_SIZE);
      const inspected = await Promise.all(
        batch.map(
          async ({ containerId, name: listedName, scopeResourceId }): Promise<DockerGpuAttachmentUser | null> => {
            try {
              const inspectResult = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', {
                containerId,
              });
              const detail = this.parseResult(inspectResult);
              if (!detail || typeof detail !== 'object') return null;
              const attachment = deriveDockerGpuAttachment(detail, gpuInventory);
              if (attachment.mode !== 'managed' || attachment.deviceIds.length === 0) return null;

              const name = String(
                (detail as Record<string, unknown>).Name ?? (detail as Record<string, unknown>).name ?? listedName
              ).replace(/^\/+/, '');
              if (!name) return null;

              return {
                containerId,
                name,
                scopeResourceId,
                deviceIds: attachment.deviceIds,
              };
            } catch (error) {
              // A container can disappear between the list and inspect calls.
              // Keep the rest of the shared-device view usable in that case.
              logger.debug('Skipping GPU usage inspection for container', {
                nodeId,
                containerId,
                error: error instanceof Error ? error.message : String(error),
              });
              return null;
            }
          }
        )
      );
      users.push(...inspected.filter((user): user is DockerGpuAttachmentUser => !!user));
    }
    return users;
  }

  /** Add DB-backed folders, health checks and deployment rows without contacting a daemon. */
  async decorateContainerSnapshot(nodeId: string, containers: any) {
    const folderAssignments =
      Array.isArray(containers) && this.folderService
        ? await this.folderService.syncNodeContainers(nodeId, containers as any[])
        : [];
    const folderByName = new Map(folderAssignments.map((item) => [item.containerName, item]));
    // Inject transition states into the list (looked up by name, not ID,
    // so the badge survives recreate/update which assigns a new ID).
    if (Array.isArray(containers)) {
      const visibleContainers = containers.filter((c: any) => !this.isManagedDeploymentInternal(c));
      const accessIds = this.accessResourceService
        ? await this.accessResourceService.syncContainers(
            nodeId,
            visibleContainers,
            new Set(
              visibleContainers
                .map((container: any) => String(container.name ?? container.Name ?? '').replace(/^\/+/, ''))
                .filter((name: string) => ['recreating', 'updating'].includes(this.getTransition(nodeId, name) ?? ''))
            )
          )
        : new Map<string, string>();
      const containerHealth =
        this.healthCheckService && visibleContainers.length > 0
          ? await this.healthCheckService.getRowsForContainers(
              nodeId,
              visibleContainers.map((c: any) => ((c.name ?? c.Name ?? '') as string).replace(/^\//, '')).filter(Boolean)
            )
          : new Map();
      for (const c of visibleContainers) {
        const cName = ((c.name ?? c.Name ?? '') as string).replace(/^\//, '');
        if (!cName) continue;
        const folder = folderByName.get(cName);
        if (folder) {
          c.folderId = folder.folderId;
          c.folderIsSystem = folder.folderIsSystem;
          c.folderSortOrder = folder.sortOrder;
        } else {
          c.folderId = null;
          c.folderIsSystem = false;
          c.folderSortOrder = 0;
        }
        const transition = this.getTransition(nodeId, cName);
        if (transition) c._transition = transition;
        c.scopeResourceId = accessIds.get(cName) ?? null;
        const health = containerHealth.get(cName);
        if (health) {
          c.healthCheckId = health.id;
          c.healthCheckEnabled = health.enabled;
          c.healthStatus = health.healthStatus;
          c.lastHealthCheckAt = health.lastHealthCheckAt;
        }
      }
      if (this.deploymentService) {
        const deploymentRows = await this.deploymentService.syntheticRows(nodeId);
        const deploymentHealth = this.healthCheckService
          ? await this.healthCheckService.getRowsForDeployments(
              deploymentRows.map((deployment: any) => deployment.deploymentId ?? deployment.id)
            )
          : new Map();
        if (this.folderService && deploymentRows.length > 0) {
          const placements = await this.folderService.getPlacementsForRefs(
            deploymentRows.map((deployment: any) => ({
              nodeId,
              containerName: deployment.name,
            }))
          );
          const placementByName = new Map(placements.map((placement) => [placement.containerName, placement]));
          for (const deployment of deploymentRows as any[]) {
            const placement = placementByName.get(deployment.name);
            if (!placement) continue;
            deployment.folderId = placement.folderId;
            deployment.folderIsSystem = placement.folderIsSystem;
            deployment.folderSortOrder = placement.sortOrder;
          }
        }
        for (const deployment of deploymentRows as any[]) {
          deployment.scopeResourceId = deployment.deploymentId ?? deployment.id;
          const health = deploymentHealth.get(deployment.deploymentId ?? deployment.id);
          if (!health) continue;
          deployment.healthCheckId = health.id;
          deployment.healthCheckEnabled = health.enabled;
          deployment.healthStatus = health.healthStatus;
          deployment.lastHealthCheckAt = health.lastHealthCheckAt;
        }
        visibleContainers.push(...deploymentRows);
      }
      return visibleContainers;
    }
    return containers;
  }

  /** User-facing decoration that keeps Gateway implementation containers private. */
  async decoratePublicContainerSnapshot(nodeId: string, containers: any) {
    const publicContainers = Array.isArray(containers) ? filterGatewayInternalContainers(containers) : containers;
    return this.decorateContainerSnapshot(nodeId, publicContainers);
  }

  async inspectContainer(nodeId: string, containerId: string) {
    await this.validateDockerNode(nodeId);
    const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
    const data = this.parseResult(result);
    if (data) {
      const cName = ((data.Name ?? '') as string).replace(/^\//, '');
      if (this.secretService && cName && Array.isArray(data?.Config?.Env)) {
        const secretKeys = await this.secretService.getSecretKeys(nodeId, cName);
        if (secretKeys.size > 0) {
          data.Config.Env = data.Config.Env.map((entry: string) => {
            const eqIndex = entry.indexOf('=');
            if (eqIndex === -1) return entry;
            const key = entry.slice(0, eqIndex);
            return secretKeys.has(key) ? `${key}=********` : entry;
          });
        }
      }
      return this.decorateContainerDetailSnapshot(nodeId, data);
    }
    return data;
  }

  private async gpuInventoryForNode(nodeId: string): Promise<unknown[]> {
    const liveHealth = this.nodeRegistry.getNode(nodeId)?.lastHealthReport as Record<string, unknown> | undefined;
    if (Array.isArray(liveHealth?.gpuDevices)) return liveHealth.gpuDevices;
    try {
      const [node] = await this.db
        .select({ lastHealthReport: nodes.lastHealthReport })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1);
      const persistedHealth = node?.lastHealthReport as Record<string, unknown> | null | undefined;
      return Array.isArray(persistedHealth?.gpuDevices) ? persistedHealth.gpuDevices : [];
    } catch {
      // Decoration must not make a normal inspect unavailable when a previous
      // health report cannot be read. An unrecognized host mapping remains
      // explicitly read-only until inventory is available again.
      return [];
    }
  }

  /** Add local transition/runtime state to a cached inspect without contacting a daemon. */
  async decorateContainerDetailSnapshot(nodeId: string, data: any, gpuInventory?: unknown[]) {
    if (!data) return data;
    const cName = ((data.Name ?? data.name ?? '') as string).replace(/^\/+/, '');
    const transition = cName ? this.getTransition(nodeId, cName) : undefined;
    if (transition) data._transition = transition;
    else delete data._transition;
    data.gpuAttachment = deriveDockerGpuAttachment(data, gpuInventory ?? (await this.gpuInventoryForNode(nodeId)));
    const runtimeId = String(data.Id ?? data.id ?? '');
    const labels = (data.Config?.Labels ?? data.config?.labels ?? {}) as Record<string, string>;
    const deploymentId = labels[DOCKER_DEPLOYMENT_ID_LABEL];
    if (labels[DOCKER_DEPLOYMENT_MANAGED_LABEL] === 'true' && deploymentId) {
      data.scopeResourceId = deploymentId;
    } else if (this.accessResourceService && cName && runtimeId) {
      data.scopeResourceId = await this.accessResourceService.ensureContainer(
        nodeId,
        cName,
        runtimeId,
        transition === 'recreating' || transition === 'updating'
      );
    }
    if (this.runtimeSettingsService && cName) {
      const persistedRuntime = await this.runtimeSettingsService.get(nodeId, cName);
      if (persistedRuntime) return applyRuntimeSettingsToInspect(data, persistedRuntime);
    }
    return data;
  }

  private containerMutationContext(): DockerContainerMutationContext {
    return {
      db: this.db,
      auditService: this.auditService,
      nodeDispatch: this.nodeDispatch,
      environmentService: this.environmentService,
      runtimeSettingsService: this.runtimeSettingsService,
      secretService: this.secretService,
      registryService: this.registryService,
      imageCleanupService: this.imageCleanupService,
      folderService: this.folderService,
      accessResourceService: this.accessResourceService,
      taskService: this.taskService,
      longDockerOperationTimeoutMs: DockerManagementService.LONG_DOCKER_OPERATION_TIMEOUT_MS,
      validateDockerNode: (nodeId) => this.validateDockerNode(nodeId),
      assertDockerGpuCapability: (nodeId) => this.assertDockerGpuCapability(nodeId),
      assertDockerPortBindIpCapability: (nodeId) => this.assertDockerPortBindIpCapability(nodeId),
      assertDockerRuntimeProfileAvailable: (nodeId, profile, currentProfile) =>
        this.assertDockerRuntimeProfileAvailable(nodeId, profile, currentProfile),
      assertNameAvailable: (nodeId, name) => this.assertNameAvailable(nodeId, name),
      assertNotManagedDeploymentInternal: (nodeId, containerId) =>
        this.assertNotManagedDeploymentInternal(nodeId, containerId),
      translateNameConflict: (err, name) => this.translateNameConflict(err, name),
      resolveContainerName: (nodeId, containerId) => this.resolveContainerName(nodeId, containerId),
      resolveExpectedRecreateState: (nodeId, containerId) => this.resolveExpectedRecreateState(nodeId, containerId),
      resolveContainerStopTimeout: (nodeId, containerId, timeout) =>
        this.resolveContainerStopTimeout(nodeId, containerId, timeout),
      resolveStopTimeoutFromInspect: (inspect, config) => this.resolveStopTimeoutFromInspect(inspect, config),
      lifecycleWatchTimeoutMs: (stopTimeoutSeconds, bufferSeconds) =>
        this.lifecycleWatchTimeoutMs(stopTimeoutSeconds, bufferSeconds),
      inspectContainer: (nodeId, containerId) => this.inspectContainer(nodeId, containerId),
      runtimeOperationContext: () => this.runtimeOperationContext(),
      requireNoTransition: (nodeId, name) => this.requireNoTransition(nodeId, name),
      setTransition: (nodeId, name, state) => this.setTransition(nodeId, name, state),
      clearTransition: (nodeId, name) => this.clearTransition(nodeId, name),
      emitContainer: (nodeId, name, id, action, extra) => this.emitContainer(nodeId, name, id, action, extra),
      emitTransition: (nodeId, name, id, transition) => this.emitTransition(nodeId, name, id, transition),
      createTask: (nodeId, containerId, containerName, type) =>
        this.createTask(nodeId, containerId, containerName, type),
      failTask: (taskId, error, nodeId, containerName) => this.failTask(taskId, error, nodeId, containerName),
      watchTransition: (
        nodeId,
        containerId,
        name,
        taskId,
        expectedState,
        progress,
        completedAction,
        timeoutMs,
        isComplete
      ) =>
        this.watchTransition(
          nodeId,
          containerId,
          name,
          taskId,
          expectedState,
          progress,
          completedAction,
          timeoutMs,
          isComplete
        ),
      watchRecreateByName: (
        nodeId,
        containerName,
        oldContainerId,
        taskId,
        progress,
        expectedState,
        timeoutMs,
        onComplete,
        daemonTaskId
      ) =>
        this.watchRecreateByName(
          nodeId,
          containerName,
          oldContainerId,
          taskId,
          progress,
          expectedState,
          timeoutMs,
          onComplete,
          daemonTaskId
        ),
      parseResult: (result) => this.parseResult(result),
    };
  }

  async createContainer(nodeId: string, config: Record<string, unknown>, userId: string, actorScopes: string[] = []) {
    const name = String(config.name ?? config.Name ?? '');
    if (name) await this.migrationGuard?.assertContainerNameAvailable(nodeId, name);
    return createDockerContainer(this.containerMutationContext(), nodeId, config, userId, actorScopes);
  }

  async rollbackCreatedContainer(nodeId: string, containerId: string, name: string | undefined, userId: string) {
    return rollbackDockerCreatedContainer(this.containerMutationContext(), nodeId, containerId, name, userId);
  }

  async startContainer(nodeId: string, containerId: string, userId: string) {
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    await startDockerContainer(this.containerMutationContext(), nodeId, containerId, userId);
  }

  async stopContainer(nodeId: string, containerId: string, timeout: number | undefined, userId: string) {
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    return stopDockerContainer(this.containerMutationContext(), nodeId, containerId, timeout, userId);
  }

  async restartContainer(nodeId: string, containerId: string, timeout: number | undefined, userId: string) {
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    return restartDockerContainer(this.containerMutationContext(), nodeId, containerId, timeout, userId);
  }

  async killContainer(nodeId: string, containerId: string, signal: string, userId: string) {
    const stableName = this.getTransition(nodeId, containerId) ? containerId : undefined;
    return killDockerContainer(this.containerMutationContext(), nodeId, containerId, signal, userId, stableName);
  }

  async removeContainer(nodeId: string, containerId: string, force: boolean, userId: string) {
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    await removeDockerContainerMutation(this.containerMutationContext(), nodeId, containerId, force, userId);
  }

  async renameContainer(nodeId: string, containerId: string, newName: string, userId: string) {
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    await this.migrationGuard?.assertContainerNameAvailable(nodeId, newName);
    await renameDockerContainer(this.containerMutationContext(), nodeId, containerId, newName, userId);
  }

  async duplicateContainer(
    nodeId: string,
    containerId: string,
    name: string,
    userId: string,
    actorScopes: string[] = []
  ) {
    return duplicateDockerContainer(this.containerMutationContext(), nodeId, containerId, name, userId, actorScopes);
  }

  async updateContainer(
    nodeId: string,
    containerId: string,
    config: Record<string, unknown>,
    userId: string,
    actorScopes: string[] = []
  ) {
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    return updateDockerContainer(this.containerMutationContext(), nodeId, containerId, config, userId, actorScopes);
  }

  async getContainerLogs(nodeId: string, containerId: string, tail: number, timestamps: boolean) {
    await this.validateDockerNode(nodeId);
    return getDockerContainerLogs(this.readOperationContext(), nodeId, containerId, tail, timestamps);
  }

  async getContainerEnv(nodeId: string, containerId: string) {
    await this.validateDockerNode(nodeId);
    await this.assertNotManagedDeploymentInternal(nodeId, containerId);
    return getDockerContainerEnv(this.envOperationContext(), nodeId, containerId);
  }

  async liveUpdateContainer(nodeId: string, containerId: string, config: Record<string, unknown>, userId: string) {
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    await liveUpdateDockerContainer(this.containerMutationContext(), nodeId, containerId, config, userId);
  }

  async recreateWithConfig(
    nodeId: string,
    containerId: string,
    config: Record<string, unknown>,
    userId: string,
    options?: { skipImagePull?: boolean; skipWebhookCleanup?: boolean; actorScopes?: string[] }
  ) {
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    return recreateDockerContainerWithConfig(
      this.containerMutationContext(),
      nodeId,
      containerId,
      config,
      userId,
      options
    );
  }

  async updateContainerEnv(
    nodeId: string,
    containerId: string,
    env: Record<string, string> | undefined,
    removeEnv: string[] | undefined,
    userId: string
  ) {
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    return updateDockerContainerEnv(this.containerMutationContext(), nodeId, containerId, env, removeEnv, userId);
  }

  // ─── Image operations ──────────────────────────────────────────────

  async listImages(nodeId: string) {
    await this.validateDockerNode(nodeId);
    return listDockerImages(this.imageOperationContext(), nodeId);
  }

  async pullImage(nodeId: string, imageRef: string, registryAuth?: string, userId?: string, registryId?: string) {
    await this.validateDockerNode(nodeId);
    return pullDockerImage(this.imageOperationContext(), nodeId, imageRef, registryAuth, userId, registryId);
  }

  async removeImage(nodeId: string, imageId: string, force: boolean, userId: string) {
    await this.validateDockerNode(nodeId);
    await removeDockerImage(this.imageOperationContext(), nodeId, imageId, force, userId);
  }

  async pruneImages(nodeId: string, userId: string) {
    await this.validateDockerNode(nodeId);
    return pruneDockerImages(this.imageOperationContext(), nodeId, userId);
  }

  // ─── Volume operations ─────────────────────────────────────────────

  async listVolumes(nodeId: string) {
    await this.validateDockerNode(nodeId);
    return listDockerVolumes(this.volumeNetworkOperationContext(), nodeId);
  }

  async inspectVolume(nodeId: string, name: string) {
    await this.validateDockerNode(nodeId);
    return inspectDockerVolume(this.volumeNetworkOperationContext(), nodeId, name);
  }

  async listVolumeFiles(nodeId: string, name: string, path: string) {
    await this.validateDockerNode(nodeId);
    return listDockerVolumeFiles(this.volumeNetworkOperationContext(), nodeId, name, path);
  }

  async readVolumeFile(nodeId: string, name: string, path: string) {
    await this.validateDockerNode(nodeId);
    return readDockerVolumeFile(this.volumeNetworkOperationContext(), nodeId, name, path);
  }

  async writeVolumeFile(nodeId: string, name: string, path: string, content: string | Buffer, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await writeDockerVolumeFile(this.volumeNetworkOperationContext(), nodeId, name, path, content, userId);
  }

  async createVolumeFile(nodeId: string, name: string, path: string, content: string | Buffer, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await createDockerVolumeFile(this.volumeNetworkOperationContext(), nodeId, name, path, content, userId);
  }

  async initVolumeFileUpload(nodeId: string, name: string, path: string, totalBytes: number, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    return initDockerVolumeFileUpload(this.volumeNetworkOperationContext(), nodeId, name, path, totalBytes, userId);
  }

  async appendVolumeFileUploadChunk(nodeId: string, name: string, uploadId: string, offset: number, content: Buffer) {
    await this.validateDockerNode(nodeId);
    return appendDockerVolumeFileUploadChunk(
      this.volumeNetworkOperationContext(),
      nodeId,
      name,
      uploadId,
      offset,
      content
    );
  }

  async completeVolumeFileUpload(nodeId: string, name: string, uploadId: string, path: string, totalBytes: number) {
    await this.validateDockerNode(nodeId);
    await completeDockerVolumeFileUpload(
      this.volumeNetworkOperationContext(),
      nodeId,
      name,
      uploadId,
      path,
      totalBytes
    );
  }

  async abortVolumeFileUpload(nodeId: string, name: string, uploadId: string) {
    await this.validateDockerNode(nodeId);
    await abortDockerVolumeFileUpload(this.volumeNetworkOperationContext(), nodeId, name, uploadId);
  }

  async createVolumeDirectory(nodeId: string, name: string, path: string, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await createDockerVolumeDirectory(this.volumeNetworkOperationContext(), nodeId, name, path, userId);
  }

  async deleteVolumeFile(nodeId: string, name: string, path: string, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await deleteDockerVolumeFile(this.volumeNetworkOperationContext(), nodeId, name, path, userId);
  }

  async moveVolumeFile(nodeId: string, name: string, fromPath: string, toPath: string, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await moveDockerVolumeFile(this.volumeNetworkOperationContext(), nodeId, name, fromPath, toPath, userId);
  }

  async exportVolume(nodeId: string, name: string) {
    await this.validateDockerNode(nodeId);
    return exportDockerVolume(this.volumeNetworkOperationContext(), nodeId, name);
  }

  async renameVolume(nodeId: string, name: string, newName: string, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await renameDockerVolume(this.volumeNetworkOperationContext(), nodeId, name, newName, userId);
    await this.folderService?.renameResourceAssignment(nodeId, 'volume', name, newName);
  }

  async updateVolumeLabels(nodeId: string, name: string, labels: Record<string, string>, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await updateDockerVolumeLabels(this.volumeNetworkOperationContext(), nodeId, name, labels, userId);
  }

  async createVolume(nodeId: string, config: { name: string }, userId: string) {
    await this.validateDockerNode(nodeId);
    return createDockerVolume(this.volumeNetworkOperationContext(), nodeId, config, userId);
  }

  async listManagedVolumeOptions(nodeId: string) {
    await this.validateDockerNode(nodeId);
    const rows = await this.db
      .select({ name: dockerManagedVolumes.volumeName })
      .from(dockerManagedVolumes)
      .where(eq(dockerManagedVolumes.nodeId, nodeId));
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async decoratePublicVolumeSnapshot(
    nodeId: string,
    volumes: Array<Record<string, any>>,
    containers: Array<Record<string, any>>
  ) {
    const managedRows = await this.db
      .select({ volumeName: dockerManagedVolumes.volumeName })
      .from(dockerManagedVolumes)
      .where(eq(dockerManagedVolumes.nodeId, nodeId));
    const managedNames = new Set(managedRows.map((row) => row.volumeName));
    const publicContainerNames = new Set(
      containers
        .filter((entry) => !isGatewayInternalContainer(entry))
        .flatMap((entry) => {
          const names = Array.isArray(entry.Names ?? entry.names) ? (entry.Names ?? entry.names) : [];
          const primary = String(entry.Name ?? entry.name ?? names[0] ?? '').replace(/^\//, '');
          return primary ? [primary] : [];
        })
    );
    const visible: Array<Record<string, any>> = volumes.flatMap((volume) => {
      const name = String(volume.Name ?? volume.name ?? '');
      if (!name) return [];
      const usedBy = Array.isArray(volume.UsedBy ?? volume.usedBy) ? (volume.UsedBy ?? volume.usedBy) : [];
      const managed = managedNames.has(name);
      if (!managed && !usedBy.some((containerName: string) => publicContainerNames.has(containerName))) return [];
      const driver = String(volume.Driver ?? volume.driver ?? '');
      const scope = String(volume.Scope ?? volume.scope ?? '');
      const options = volume.Options ?? volume.options ?? {};
      const adoptable = !managed && driver === 'local' && scope === 'local' && Object.keys(options ?? {}).length === 0;
      return [
        {
          ...volume,
          managementState: managed ? 'managed' : 'legacy',
          adoptable,
          adoptionReason:
            !managed && !adoptable ? 'Only local volumes without driver options can be migrated' : undefined,
        },
      ];
    });
    const returned = new Set(visible.map((volume) => String(volume.Name ?? volume.name ?? '')));
    for (const { volumeName } of managedRows) {
      if (!returned.has(volumeName)) {
        visible.push({
          Name: volumeName,
          Driver: 'local',
          Scope: 'local',
          UsedBy: [],
          managementState: 'managed',
          adoptable: false,
          availability: 'unavailable',
        });
      }
    }
    return visible;
  }

  async registerImportedManagedVolumes(nodeId: string, volumeNames: string[], userId: string) {
    const names = [...new Set(volumeNames.map((name) => name.trim()).filter(Boolean))];
    if (names.length === 0) return;
    await this.db
      .insert(dockerManagedVolumes)
      .values(names.map((volumeName) => ({ nodeId, volumeName, origin: 'created' as const, createdById: userId })))
      .onConflictDoNothing();
  }

  async assertManagedVolumeSelections(nodeId: string, volumeNames: string[]) {
    await assertManagedMountMutation({
      db: this.db,
      dispatch: this.nodeDispatch,
      parseResult: (result) => this.parseResult(result),
      nodeId,
      current: [],
      next: [...new Set(volumeNames)].map((source, index) => ({
        type: 'volume' as const,
        source,
        target: `/__gateway_archive_mount_${index}`,
        readOnly: false,
      })),
    });
  }

  async removeVolume(nodeId: string, name: string, force: boolean, userId: string | null) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await removeDockerVolume(this.volumeNetworkOperationContext(), nodeId, name, force, userId);
  }

  async adoptVolume(nodeId: string, name: string, userId: string) {
    await this.validateDockerNode(nodeId);
    return adoptDockerVolume(this.volumeNetworkOperationContext(), nodeId, name, userId);
  }

  async manageRunsc(nodeId: string, action: 'preflight' | 'install') {
    await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('secure-runtime');
    const node = await this.validateDockerNode(nodeId);
    const reportedStatus = (node.capabilities as Record<string, any> | null)?.dockerRuntimeStatus as
      | DockerRuntimeStatus
      | undefined;
    if (reportedStatus?.state === 'installing') {
      throw new AppError(409, 'RUNTIME_INSTALL_IN_PROGRESS', 'Secure Runtime setup is already in progress');
    }

    if (action === 'install') {
      await this.persistDockerRuntimeStatus(node, {
        state: 'installing',
        targetVersion: reportedStatus?.targetVersion,
        message: 'Installing and verifying Secure Runtime',
        checkedAt: new Date().toISOString(),
        remoteInstallable: reportedStatus?.remoteInstallable ?? true,
        localInstallCommand: reportedStatus?.localInstallCommand,
      });
    }

    let parsed: DockerRuntimeStatus;
    try {
      const result = await this.nodeDispatch.sendDockerRuntimeCommand(nodeId, action);
      parsed = DockerRuntimeStatusSchema.parse(this.parseResult(result));
    } catch (error) {
      if (action === 'install') {
        await this.persistDockerRuntimeStatus(node, {
          state: 'failed',
          targetVersion: reportedStatus?.targetVersion,
          reasonCode: 'INSTALL_FAILED',
          message: error instanceof Error ? error.message : 'Secure Runtime setup failed',
          checkedAt: new Date().toISOString(),
          remoteInstallable: reportedStatus?.remoteInstallable ?? true,
          localInstallCommand: reportedStatus?.localInstallCommand,
        });
      }
      throw error;
    }

    await this.persistDockerRuntimeStatus(node, parsed);
    return parsed;
  }

  private async persistDockerRuntimeStatus(
    node: { id: string; hostname: string; capabilities: unknown },
    status: DockerRuntimeStatus
  ) {
    await this.db
      .update(nodes)
      .set({
        capabilities: { ...((node.capabilities as Record<string, unknown> | null) ?? {}), dockerRuntimeStatus: status },
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, node.id));
    this.nodeRegistry.publishDockerRuntimeChanged(node.id, status);
  }

  private async assertContainerMigrationAllowed(nodeId: string, containerId: string): Promise<void> {
    if (!this.migrationGuard) return;
    const inspect = await this.inspectContainer(nodeId, containerId);
    const name = String(inspect?.Name ?? inspect?.name ?? containerId).replace(/^\//, '');
    await this.migrationGuard.assertContainerAllowed(nodeId, name);
    if (name !== containerId) await this.migrationGuard.assertContainerAllowed(nodeId, containerId);
  }

  // ─── Network operations ────────────────────────────────────────────

  async listNetworks(nodeId: string) {
    await this.validateDockerNode(nodeId);
    return listDockerNetworks(this.volumeNetworkOperationContext(), nodeId);
  }

  async createNetwork(
    nodeId: string,
    config: { name: string; driver: string; subnet?: string; gateway?: string },
    userId: string
  ) {
    await this.validateDockerNode(nodeId);
    return createDockerNetwork(this.volumeNetworkOperationContext(), nodeId, config, userId);
  }

  async removeNetwork(nodeId: string, networkId: string, userId: string) {
    await this.validateDockerNode(nodeId);
    await removeDockerNetwork(this.volumeNetworkOperationContext(), nodeId, networkId, userId);
  }

  async connectContainerToNetwork(nodeId: string, networkId: string, containerId: string, userId: string) {
    await this.validateDockerNode(nodeId);
    await connectDockerContainerToNetwork(this.volumeNetworkOperationContext(), nodeId, networkId, containerId, userId);
  }

  async disconnectContainerFromNetwork(nodeId: string, networkId: string, containerId: string, userId: string) {
    await this.validateDockerNode(nodeId);
    await disconnectDockerContainerFromNetwork(
      this.volumeNetworkOperationContext(),
      nodeId,
      networkId,
      containerId,
      userId
    );
  }

  // ─── Container stats ───────────────────────────────────────────────

  async getContainerStats(nodeId: string, containerId: string) {
    await this.validateDockerNode(nodeId);
    return getDockerContainerStats(this.readOperationContext(), nodeId, containerId);
  }

  async getContainerTop(nodeId: string, containerId: string) {
    await this.validateDockerNode(nodeId);
    return getDockerContainerTop(this.readOperationContext(), nodeId, containerId);
  }

  // ─── File browser ──────────────────────────────────────────────────

  async listDirectory(nodeId: string, containerId: string, path: string) {
    await this.validateDockerNode(nodeId);
    return listDockerDirectory(this.readOperationContext(), nodeId, containerId, path);
  }

  async readFile(nodeId: string, containerId: string, path: string) {
    await this.validateDockerNode(nodeId);
    return readDockerFile(this.readOperationContext(), nodeId, containerId, path);
  }

  async writeFile(nodeId: string, containerId: string, path: string, content: string | Buffer, userId: string) {
    await this.validateDockerNode(nodeId);
    await writeDockerFile(this.readOperationContext(), nodeId, containerId, path, content, userId);
  }

  async createFile(
    nodeId: string,
    containerId: string,
    path: string,
    content: string | Buffer | undefined,
    userId: string
  ) {
    await this.validateDockerNode(nodeId);
    await createDockerFile(this.readOperationContext(), nodeId, containerId, path, content, userId);
  }

  async initFileUpload(nodeId: string, containerId: string, path: string, totalBytes: number, userId: string) {
    await this.validateDockerNode(nodeId);
    return initDockerFileUpload(this.readOperationContext(), nodeId, containerId, path, totalBytes, userId);
  }

  async appendFileUploadChunk(nodeId: string, containerId: string, uploadId: string, offset: number, content: Buffer) {
    await this.validateDockerNode(nodeId);
    return appendDockerFileUploadChunk(this.readOperationContext(), nodeId, containerId, uploadId, offset, content);
  }

  async completeFileUpload(nodeId: string, containerId: string, uploadId: string, path: string, totalBytes: number) {
    await this.validateDockerNode(nodeId);
    await completeDockerFileUpload(this.readOperationContext(), nodeId, containerId, uploadId, path, totalBytes);
  }

  async abortFileUpload(nodeId: string, containerId: string, uploadId: string) {
    await this.validateDockerNode(nodeId);
    await abortDockerFileUpload(this.readOperationContext(), nodeId, containerId, uploadId);
  }

  async createDirectory(nodeId: string, containerId: string, path: string, userId: string) {
    await this.validateDockerNode(nodeId);
    await createDockerDirectory(this.readOperationContext(), nodeId, containerId, path, userId);
  }

  async deleteFile(nodeId: string, containerId: string, path: string, userId: string) {
    await this.validateDockerNode(nodeId);
    await deleteDockerFile(this.readOperationContext(), nodeId, containerId, path, userId);
  }

  async moveFile(nodeId: string, containerId: string, fromPath: string, toPath: string, userId: string) {
    await this.validateDockerNode(nodeId);
    await moveDockerFile(this.readOperationContext(), nodeId, containerId, fromPath, toPath, userId);
  }
}
