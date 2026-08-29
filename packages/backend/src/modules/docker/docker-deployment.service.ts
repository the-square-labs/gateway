import { randomUUID } from 'node:crypto';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type DockerDeploymentDesiredConfig,
  type DockerDeploymentSlot,
  dockerDeploymentReleases,
  dockerDeploymentRoutes,
  dockerDeploymentSlots,
  dockerDeployments,
  dockerWebhooks,
  nodes,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { type LicensePolicyService, requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type { DockerAccessResourceService } from './docker-access-resource.service.js';
import type {
  DockerDeploymentCreateInput,
  DockerDeploymentDeployInput,
  DockerDeploymentSwitchInput,
  DockerDeploymentUpdateInput,
} from './docker-deployment.schemas.js';
import {
  deploymentRoutesEqual,
  imageWithTag,
  inactiveSlot,
  isBusyDeploymentStatus,
  normalizeHealth,
  normalizeRoutes,
  shortId,
} from './docker-deployment-helpers.js';
import { DOCKER_DEPLOYMENT_MANAGED_LABEL, dockerDeploymentLabels } from './docker-deployment-labels.js';
import {
  type DockerDeploymentOperationContext,
  deleteWebhook,
  getWebhook,
  kill as killDeployment,
  regenerateWebhook,
  remove as removeDeployment,
  restart as restartDeployment,
  start as startDeployment,
  stop as stopDeployment,
  stopSlot,
  triggerWebhook,
  upsertWebhook,
} from './docker-deployment-operations.js';
import { desiredConfigForRegistryAttempt, isRegistryRetryableError } from './docker-deployment-registry.js';
import { toSyntheticRow } from './docker-deployment-synthetic.js';
import { hasDockerGpuV1Capability } from './docker-gpu-attachment.js';
import type { DockerHealthCheckDto, DockerHealthCheckService } from './docker-health-check.service.js';
import type { DockerImageCleanupService } from './docker-image-cleanup.service.js';
import { assertManagedMountMutation } from './docker-managed-mounts.js';
import type { DockerMigrationGuard } from './docker-migration-guard.js';
import type { DockerRegistryService } from './docker-registry.service.js';
import type { DockerSecretService } from './docker-secret.service.js';
import { assertDockerMountChangeAllowed, normalizeMountDefinitionsFromConfig } from './docker-socket-mount.guard.js';
import type { DockerTaskService } from './docker-task.service.js';

type DeploymentRow = typeof dockerDeployments.$inferSelect;
type DeploymentRouteRow = typeof dockerDeploymentRoutes.$inferSelect;
type DeploymentSlotRow = typeof dockerDeploymentSlots.$inferSelect;
type DeploymentReleaseRow = typeof dockerDeploymentReleases.$inferSelect;
type DeploymentTransition =
  | 'creating'
  | 'deploying'
  | 'switching'
  | 'rolling_back'
  | 'starting'
  | 'stopping'
  | 'restarting'
  | 'killing'
  | 'removing';

export interface DockerDeploymentDetail extends DeploymentRow {
  routes: DeploymentRouteRow[];
  slots: DeploymentSlotRow[];
  releases: DeploymentReleaseRow[];
  webhook?: typeof dockerWebhooks.$inferSelect | null;
  healthCheck?: DockerHealthCheckDto | null;
  _transition?: DeploymentTransition;
}

export interface DockerDeploymentSummary extends DeploymentRow {
  routes: DeploymentRouteRow[];
  slots: DeploymentSlotRow[];
  healthCheck?: Pick<DockerHealthCheckDto, 'id' | 'enabled' | 'healthStatus' | 'lastHealthCheckAt'> | null;
  _transition?: DeploymentTransition;
}

export class DockerDeploymentService {
  private licensePolicy?: LicensePolicyService;
  private eventBus?: EventBusService;
  private healthCheckService?: DockerHealthCheckService;
  private imageCleanupService?: DockerImageCleanupService;
  private deploymentTransitions = new Map<string, DeploymentTransition>();
  private migrationGuard?: DockerMigrationGuard;
  private accessResourceService?: DockerAccessResourceService;

  constructor(
    private db: DrizzleClient,
    private audit: AuditService,
    private dispatch: NodeDispatchService,
    private registry: DockerRegistryService,
    private tasks: DockerTaskService,
    private nodeRegistry: NodeRegistryService,
    private secrets?: DockerSecretService
  ) {}

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  setHealthCheckService(service: DockerHealthCheckService) {
    this.healthCheckService = service;
  }

  setImageCleanupService(service: DockerImageCleanupService) {
    this.imageCleanupService = service;
  }

  setMigrationGuard(guard: DockerMigrationGuard) {
    this.migrationGuard = guard;
  }

  setAccessResourceService(service: DockerAccessResourceService) {
    this.accessResourceService = service;
  }

  private emit(action: string, deploymentId: string, nodeId: string, extra?: Record<string, unknown>) {
    const eventData = { ...(extra ?? {}) };
    if (action === 'failed') {
      const error = eventData.error;
      const legacyOperation = typeof eventData.action === 'string' ? eventData.action : undefined;
      delete eventData.error;
      delete eventData.action;
      eventData.operation = eventData.operation ?? legacyOperation ?? 'deployment';
      eventData.failureCode = eventData.failureCode ?? this.failureCode(error);
    }
    this.eventBus?.publish('docker.deployment.changed', { ...eventData, action, deploymentId, nodeId });
    this.eventBus?.publish('docker.container.changed', { action: 'deployment', deploymentId, nodeId });
  }

  private failureCode(error: unknown): string {
    if (error instanceof AppError) return error.code;
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (/timeout|timed out/i.test(message)) return 'timeout';
    if (/offline|unavailable|disconnect/i.test(message)) return 'node_unavailable';
    if (/health|probe|status/i.test(message)) return 'health_check_failed';
    if (/image|manifest|registry|pull/i.test(message)) return 'image_unavailable';
    return 'deployment_failed';
  }

  private transitionKey(nodeId: string, deploymentId: string) {
    return `${nodeId}:${deploymentId}`;
  }

  private getTransition(nodeId: string, deploymentId: string): DeploymentTransition | undefined {
    return this.deploymentTransitions.get(this.transitionKey(nodeId, deploymentId));
  }

  private requireDeploymentIdle(deployment: Pick<DockerDeploymentDetail, 'id' | 'nodeId' | 'status'>) {
    const current = this.getTransition(deployment.nodeId, deployment.id);
    if (current) {
      throw new AppError(409, 'DEPLOYMENT_BUSY', `Deployment is currently ${current}`);
    }
    if (isBusyDeploymentStatus(deployment.status)) {
      throw new AppError(409, 'DEPLOYMENT_BUSY', `Deployment is currently ${deployment.status}`);
    }
  }

  private setTransition(
    deployment: Pick<DockerDeploymentDetail, 'id' | 'nodeId' | 'name'>,
    transition: DeploymentTransition
  ) {
    this.deploymentTransitions.set(this.transitionKey(deployment.nodeId, deployment.id), transition);
    this.eventBus?.publish('docker.deployment.changed', {
      action: 'transitioning',
      deploymentId: deployment.id,
      nodeId: deployment.nodeId,
      name: deployment.name,
      transition,
    });
    this.eventBus?.publish('docker.container.changed', {
      action: 'transitioning',
      deploymentId: deployment.id,
      nodeId: deployment.nodeId,
      name: deployment.name,
      id: deployment.id,
      transition,
    });
  }

  private clearTransition(deployment: Pick<DockerDeploymentDetail, 'id' | 'nodeId' | 'name'>) {
    this.deploymentTransitions.delete(this.transitionKey(deployment.nodeId, deployment.id));
  }

  private parseResult(result: { success: boolean; error?: string; detail?: string }) {
    if (!result.success) throw new AppError(502, 'DISPATCH_ERROR', result.error || 'Command failed on daemon');
    try {
      return result.detail ? JSON.parse(result.detail) : null;
    } catch {
      return result.detail;
    }
  }

  private async validateDockerNode(nodeId: string, requireCapability = true, requireConnected = true) {
    const [node] = await this.db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) throw new AppError(404, 'NOT_FOUND', 'Node not found');
    if (node.type !== 'docker') throw new AppError(400, 'NOT_DOCKER', 'Node is not a Docker node');
    if (requireConnected && !this.nodeRegistry.getNode(nodeId)) {
      throw new AppError(502, 'NODE_OFFLINE', 'Node is offline');
    }

    const capabilities = (node.capabilities ?? {}) as Record<string, unknown>;
    const advertised = Array.isArray(capabilities.capabilities) ? capabilities.capabilities : [];
    const hasCapability =
      capabilities.dockerDeploymentsV1 === true ||
      capabilities.docker_deployments_v1 === true ||
      advertised.includes('docker_deployments_v1');
    if (requireCapability && !hasCapability) {
      throw new AppError(409, 'UNSUPPORTED_DAEMON', 'Docker node does not support blue/green deployments');
    }
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

  private async assertRuntimeProfile(
    nodeId: string,
    desiredConfig: DockerDeploymentDesiredConfig,
    currentProfile?: DockerDeploymentDesiredConfig['runtimeProfile']
  ): Promise<void> {
    if (desiredConfig.runtimeProfile !== 'secure') return;
    if (currentProfile !== 'secure') {
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
    if ((desiredConfig.gpu?.deviceIds?.length ?? 0) > 0) {
      throw new AppError(
        409,
        'SECURE_RUNTIME_GPU_UNSUPPORTED',
        'Remove GPU attachments before selecting Secure Runtime'
      );
    }
    if (desiredConfig.mounts?.some((mount) => !!mount.hostPath)) {
      throw new AppError(409, 'SECURE_RUNTIME_BIND_UNSUPPORTED', 'Secure Runtime does not support host bind mounts');
    }
  }

  private async assertNameAvailable(nodeId: string, name: string, excludeDeploymentId?: string) {
    const existingDeploymentQuery = this.db
      .select({ id: dockerDeployments.id })
      .from(dockerDeployments)
      .where(
        excludeDeploymentId
          ? and(
              eq(dockerDeployments.nodeId, nodeId),
              eq(dockerDeployments.name, name),
              ne(dockerDeployments.id, excludeDeploymentId)
            )
          : and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.name, name))
      )
      .limit(1);
    const [existingDeployment] = await existingDeploymentQuery;
    if (existingDeployment) throw new AppError(409, 'NAME_IN_USE', `A deployment named "${name}" already exists`);

    const result = await this.dispatch.sendDockerContainerCommand(nodeId, 'list');
    const containers = this.parseResult(result);
    if (Array.isArray(containers)) {
      const collision = containers.some((item: any) => {
        const labels = item.labels ?? item.Labels ?? {};
        if (labels[DOCKER_DEPLOYMENT_MANAGED_LABEL] === 'true') return false;
        const itemName = ((item.name ?? item.Name ?? '') as string).replace(/^\//, '');
        return itemName === name;
      });
      if (collision) throw new AppError(409, 'NAME_IN_USE', `A container named "${name}" already exists`);
    }
  }

  private async loadDeployment(nodeId: string, deploymentId: string): Promise<DockerDeploymentDetail> {
    const [deployment] = await this.db
      .select()
      .from(dockerDeployments)
      .where(and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.id, deploymentId)))
      .limit(1);
    if (!deployment) throw new AppError(404, 'NOT_FOUND', 'Deployment not found');

    const [routes, slots, releases, webhookRows] = await Promise.all([
      this.db.select().from(dockerDeploymentRoutes).where(eq(dockerDeploymentRoutes.deploymentId, deploymentId)),
      this.db.select().from(dockerDeploymentSlots).where(eq(dockerDeploymentSlots.deploymentId, deploymentId)),
      this.db
        .select()
        .from(dockerDeploymentReleases)
        .where(eq(dockerDeploymentReleases.deploymentId, deploymentId))
        .orderBy(desc(dockerDeploymentReleases.createdAt))
        .limit(20),
      this.db.select().from(dockerWebhooks).where(eq(dockerWebhooks.deploymentId, deploymentId)).limit(1),
    ]);

    const healthCheck = await this.healthCheckService?.getDeployment(nodeId, deploymentId).catch(() => null);
    const detail = { ...deployment, routes, slots, releases, webhook: webhookRows[0] ?? null, healthCheck };
    const transition = this.getTransition(nodeId, deploymentId);
    return transition ? { ...detail, _transition: transition } : detail;
  }

  private async loadDeploymentSummary(nodeId: string, deploymentId: string): Promise<DockerDeploymentSummary> {
    const [deployment] = await this.db
      .select()
      .from(dockerDeployments)
      .where(and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.id, deploymentId)))
      .limit(1);
    if (!deployment) throw new AppError(404, 'NOT_FOUND', 'Deployment not found');

    const [routes, slots, healthRows] = await Promise.all([
      this.db.select().from(dockerDeploymentRoutes).where(eq(dockerDeploymentRoutes.deploymentId, deploymentId)),
      this.db.select().from(dockerDeploymentSlots).where(eq(dockerDeploymentSlots.deploymentId, deploymentId)),
      this.healthCheckService?.getRowsForDeployments([deploymentId]).catch(() => new Map()) ??
        Promise.resolve(new Map()),
    ]);
    const health = healthRows.get(deploymentId);
    const detail: DockerDeploymentSummary = {
      ...deployment,
      routes,
      slots,
      healthCheck: health
        ? {
            id: health.id,
            enabled: health.enabled,
            healthStatus: health.healthStatus,
            lastHealthCheckAt: health.lastHealthCheckAt,
          }
        : null,
    };
    const transition = this.getTransition(nodeId, deploymentId);
    return transition ? { ...detail, _transition: transition } : detail;
  }

  private secretContainerName(deploymentId: string) {
    return `deployment:${deploymentId}`;
  }

  private async desiredConfigWithSecrets(
    nodeId: string,
    deploymentId: string,
    desiredConfig: DockerDeploymentDesiredConfig
  ) {
    const secrets = await this.secrets?.getDecryptedMap(nodeId, this.secretContainerName(deploymentId));
    if (!secrets || Object.keys(secrets).length === 0) return desiredConfig;
    return { ...desiredConfig, env: { ...(desiredConfig.env ?? {}), ...secrets } };
  }

  async list(nodeId: string) {
    await this.validateDockerNode(nodeId, false, false);
    const deployments = await this.db
      .select()
      .from(dockerDeployments)
      .where(eq(dockerDeployments.nodeId, nodeId))
      .orderBy(dockerDeployments.name);
    return Promise.all(deployments.map((deployment) => this.loadDeployment(nodeId, deployment.id)));
  }

  async listSummary(nodeId: string) {
    await this.validateDockerNode(nodeId, false, false);
    const deployments = await this.db
      .select()
      .from(dockerDeployments)
      .where(eq(dockerDeployments.nodeId, nodeId))
      .orderBy(dockerDeployments.name);
    return Promise.all(deployments.map((deployment) => this.loadDeploymentSummary(nodeId, deployment.id)));
  }

  async syntheticRows(nodeId: string) {
    const deployments = await this.listSummary(nodeId);
    return deployments.map((deployment) => toSyntheticRow(deployment));
  }

  async get(nodeId: string, deploymentId: string) {
    await this.validateDockerNode(nodeId, false, false);
    return this.loadDeployment(nodeId, deploymentId);
  }

  async createPending(nodeId: string, input: DockerDeploymentCreateInput, userId: string, actorScopes: string[] = []) {
    await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('blue-green');
    await assertNodeAllowsServiceCreation(this.db, nodeId, 'docker');
    await this.validateDockerNode(nodeId);
    normalizeRoutes(input.routes);
    const health = normalizeHealth(input.health);
    await this.assertNameAvailable(nodeId, input.name);

    const id = randomUUID();
    const suffix = shortId(id);
    const desiredConfig: DockerDeploymentDesiredConfig = {
      image: input.image,
      env: input.env,
      mounts: input.mounts,
      command: input.command,
      entrypoint: input.entrypoint,
      workingDir: input.workingDir,
      user: input.user,
      labels: input.labels,
      restartPolicy: input.restartPolicy,
      runtimeProfile: input.runtimeProfile ?? 'default',
      runtime: input.runtime,
      gpu: input.gpu,
    };
    await this.assertRuntimeProfile(nodeId, desiredConfig);
    assertDockerMountChangeAllowed({ nodeId, actorScopes, nextConfig: desiredConfig, currentDefinitions: [] });

    await this.db.transaction(async (tx) => {
      await tx.insert(dockerDeployments).values({
        id,
        nodeId,
        name: input.name,
        desiredConfig,
        activeSlot: 'blue',
        status: 'creating',
        routerName: `gwdep-${suffix}-router`,
        routerImage: input.routerImage,
        networkName: `gwdep-${suffix}-net`,
        healthConfig: health,
        drainSeconds: input.drainSeconds,
        createdById: userId,
        updatedById: userId,
      });
      await tx.insert(dockerDeploymentRoutes).values(
        input.routes.map((route) => ({
          deploymentId: id,
          hostPort: route.hostPort,
          containerPort: route.containerPort,
          isPrimary: route.isPrimary,
        }))
      );
      await tx.insert(dockerDeploymentSlots).values([
        {
          deploymentId: id,
          slot: 'blue',
          containerName: `gwdep-${suffix}-blue`,
          status: 'empty',
          health: 'unknown',
        },
        {
          deploymentId: id,
          slot: 'green',
          containerName: `gwdep-${suffix}-green`,
          status: 'empty',
          health: 'unknown',
        },
      ]);
    });
    await this.healthCheckService?.ensureDeploymentDefault(nodeId, id);
    await this.audit.log({
      action: 'docker.deployment.create_pending_source',
      userId,
      resourceType: 'docker-deployment',
      resourceId: id,
      details: { nodeId, name: input.name },
    });
    this.emit('created', id, nodeId, { pendingSourceBuild: true });
    return this.loadDeployment(nodeId, id);
  }

  async activatePending(
    nodeId: string,
    deploymentId: string,
    image: string,
    userId: string | null,
    source = 'git_push_to_deploy'
  ) {
    await this.validateDockerNode(nodeId);
    const deployment = await this.loadDeployment(nodeId, deploymentId);
    if (deployment.status !== 'creating' || deployment.slots.some((slot) => Boolean(slot.containerId))) {
      throw new AppError(409, 'DEPLOYMENT_NOT_PENDING_SOURCE', 'Deployment is not awaiting its first source build');
    }
    const desiredConfig = { ...deployment.desiredConfig, image };
    await this.assertRuntimeProfile(nodeId, desiredConfig, deployment.desiredConfig.runtimeProfile);
    const daemonDesiredConfig = await this.desiredConfigWithSecrets(nodeId, deploymentId, desiredConfig);
    const registryAuthCandidates = await this.registry.resolveAuthCandidatesForImagePull(nodeId, image, undefined, {
      actorScopes: [],
    });
    const registryAttempts = registryAuthCandidates.length ? registryAuthCandidates : [null];
    let data: any = null;
    let successfulRegistryId: string | undefined;
    let deployedDesiredConfig = daemonDesiredConfig;

    try {
      for (const registryAuth of registryAttempts) {
        const attemptDesiredConfig = desiredConfigForRegistryAttempt(daemonDesiredConfig, registryAuth);
        try {
          const result = await this.dispatch.sendDockerDeploymentCommand(nodeId, 'create', {
            deploymentId,
            slot: 'blue',
            configJson: JSON.stringify({
              deploymentId,
              name: deployment.name,
              activeSlot: 'blue',
              routerName: deployment.routerName,
              routerImage: deployment.routerImage,
              networkName: deployment.networkName,
              slots: Object.fromEntries(deployment.slots.map((slot) => [slot.slot, slot.containerName])),
              routes: deployment.routes,
              health: deployment.healthConfig,
              desiredConfig: attemptDesiredConfig,
              registryAuthJson: registryAuth?.authJson,
              labels: dockerDeploymentLabels(deploymentId, 'app', 'blue'),
            }),
          });
          data = this.parseResult(result) ?? {};
          successfulRegistryId = registryAuth?.registryId;
          deployedDesiredConfig = attemptDesiredConfig;
          break;
        } catch (error) {
          if (registryAuth === registryAttempts.at(-1) || !isRegistryRetryableError(error)) throw error;
        }
      }

      await this.registry.rememberImageRegistry(nodeId, image, successfulRegistryId);
      await this.db.transaction(async (tx) => {
        await tx
          .update(dockerDeployments)
          .set({ status: 'ready', desiredConfig, updatedAt: new Date(), updatedById: userId })
          .where(eq(dockerDeployments.id, deploymentId));
        await tx
          .update(dockerDeploymentSlots)
          .set({
            containerId: data.blueContainerId ?? data.containerId ?? null,
            image,
            desiredConfig,
            status: 'running',
            health: 'healthy',
            updatedAt: new Date(),
          })
          .where(and(eq(dockerDeploymentSlots.deploymentId, deploymentId), eq(dockerDeploymentSlots.slot, 'blue')));
        await tx
          .update(dockerDeploymentSlots)
          .set({
            containerId: data.greenContainerId ?? null,
            image,
            desiredConfig,
            status: 'created',
            health: 'unknown',
            updatedAt: new Date(),
          })
          .where(and(eq(dockerDeploymentSlots.deploymentId, deploymentId), eq(dockerDeploymentSlots.slot, 'green')));
        await tx.insert(dockerDeploymentReleases).values({
          deploymentId,
          toSlot: 'blue',
          image,
          triggerSource: source,
          status: 'succeeded',
          createdById: userId,
          completedAt: new Date(),
        });
      });
      await this.audit.log({
        action: 'docker.deployment.activate_source',
        userId,
        resourceType: 'docker-deployment',
        resourceId: deploymentId,
        details: { nodeId, image: deployedDesiredConfig.image },
      });
      this.emit('created', deploymentId, nodeId, { source });
      return this.loadDeployment(nodeId, deploymentId);
    } catch (error) {
      await this.audit
        .log({
          action: 'docker.deployment.activate_source_failed',
          userId,
          resourceType: 'docker-deployment',
          resourceId: deploymentId,
          details: { nodeId, image, failureCode: this.failureCode(error) },
        })
        .catch(() => undefined);
      this.emit('failed', deploymentId, nodeId, { operation: 'source_activation', error });
      throw error;
    }
  }

  async discardPending(nodeId: string, deploymentId: string): Promise<boolean> {
    const deployment = await this.loadDeployment(nodeId, deploymentId).catch(() => null);
    if (!deployment || deployment.status !== 'creating' || deployment.slots.some((slot) => Boolean(slot.containerId))) {
      return false;
    }
    await this.db.delete(dockerDeployments).where(eq(dockerDeployments.id, deploymentId));
    return true;
  }

  async create(nodeId: string, input: DockerDeploymentCreateInput, userId: string, actorScopes: string[] = []) {
    // LICENSE ENFORCEMENT: New blue/green deployments require Personal under the project license/TOS.
    await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('blue-green');
    await assertNodeAllowsServiceCreation(this.db, nodeId, 'docker');
    await this.validateDockerNode(nodeId);
    if (input.gpu !== undefined) await this.assertDockerGpuCapability(nodeId);
    normalizeRoutes(input.routes);
    const health = normalizeHealth(input.health);
    await this.assertNameAvailable(nodeId, input.name);

    const id = randomUUID();
    const suffix = shortId(id);
    const routerName = `gwdep-${suffix}-router`;
    const networkName = `gwdep-${suffix}-net`;
    const blueName = `gwdep-${suffix}-blue`;
    const greenName = `gwdep-${suffix}-green`;
    const desiredConfig: DockerDeploymentDesiredConfig = {
      image: input.image,
      env: input.env,
      mounts: input.mounts,
      command: input.command,
      entrypoint: input.entrypoint,
      workingDir: input.workingDir,
      user: input.user,
      labels: input.labels,
      restartPolicy: input.restartPolicy,
      runtimeProfile: input.runtimeProfile ?? 'default',
      runtime: input.runtime,
      gpu: input.gpu,
    };
    await this.assertRuntimeProfile(nodeId, desiredConfig);
    assertDockerMountChangeAllowed({ nodeId, actorScopes, nextConfig: desiredConfig, currentDefinitions: [] });
    await assertManagedMountMutation({
      db: this.db,
      dispatch: this.dispatch,
      parseResult: (result) => this.parseResult(result),
      nodeId,
      current: [],
      next: normalizeMountDefinitionsFromConfig(desiredConfig),
    });

    await this.db.transaction(async (tx) => {
      await tx.insert(dockerDeployments).values({
        id,
        nodeId,
        name: input.name,
        desiredConfig,
        activeSlot: 'blue',
        status: 'creating',
        routerName,
        routerImage: input.routerImage,
        networkName,
        healthConfig: health,
        drainSeconds: input.drainSeconds,
        createdById: userId,
        updatedById: userId,
      });
      await tx.insert(dockerDeploymentRoutes).values(
        input.routes.map((route) => ({
          deploymentId: id,
          hostPort: route.hostPort,
          containerPort: route.containerPort,
          isPrimary: route.isPrimary,
        }))
      );
      await tx.insert(dockerDeploymentSlots).values([
        {
          deploymentId: id,
          slot: 'blue',
          containerName: blueName,
          image: input.image,
          desiredConfig,
          status: 'creating',
        },
        {
          deploymentId: id,
          slot: 'green',
          containerName: greenName,
          image: input.image,
          desiredConfig,
          status: 'creating',
        },
      ]);
    });
    await this.healthCheckService?.ensureDeploymentDefault(nodeId, id);

    const daemonDesiredConfig = await this.desiredConfigWithSecrets(nodeId, id, desiredConfig);
    const registryAuthCandidates = await this.registry.resolveAuthCandidatesForImagePull(
      nodeId,
      input.image,
      input.registryId,
      { actorScopes }
    );
    const registryAttempts = registryAuthCandidates.length ? registryAuthCandidates : [null];

    try {
      let data: any = null;
      let successfulRegistryId: string | undefined;
      let deployedDesiredConfig = daemonDesiredConfig;
      for (const registryAuth of registryAttempts) {
        const attemptDesiredConfig = desiredConfigForRegistryAttempt(daemonDesiredConfig, registryAuth);
        const payload = {
          deploymentId: id,
          name: input.name,
          activeSlot: 'blue',
          routerName,
          routerImage: input.routerImage,
          networkName,
          slots: { blue: blueName, green: greenName },
          routes: input.routes,
          health,
          desiredConfig: attemptDesiredConfig,
          registryAuthJson: registryAuth?.authJson,
          labels: dockerDeploymentLabels(id, 'app', 'blue'),
        };

        try {
          const result = await this.dispatch.sendDockerDeploymentCommand(nodeId, 'create', {
            deploymentId: id,
            slot: 'blue',
            configJson: JSON.stringify(payload),
          });
          data = this.parseResult(result) ?? {};
          successfulRegistryId = registryAuth?.registryId;
          deployedDesiredConfig = attemptDesiredConfig;
          break;
        } catch (err) {
          if (registryAuth === registryAttempts.at(-1) || !isRegistryRetryableError(err)) {
            throw err;
          }
        }
      }
      await this.registry.rememberImageRegistry(nodeId, deployedDesiredConfig.image, successfulRegistryId);
      await this.db.transaction(async (tx) => {
        await tx
          .update(dockerDeployments)
          // `deployedDesiredConfig` contains decrypted runtime secrets. Keep
          // only the encrypted-at-rest desired configuration in PostgreSQL.
          .set({ status: 'ready', desiredConfig, updatedAt: new Date() })
          .where(eq(dockerDeployments.id, id));
        await tx
          .update(dockerDeploymentSlots)
          .set({
            containerId: data.blueContainerId ?? data.containerId ?? null,
            image: desiredConfig.image,
            desiredConfig,
            status: 'running',
            health: 'healthy',
            updatedAt: new Date(),
          })
          .where(and(eq(dockerDeploymentSlots.deploymentId, id), eq(dockerDeploymentSlots.slot, 'blue')));
        await tx
          .update(dockerDeploymentSlots)
          .set({
            containerId: data.greenContainerId ?? null,
            image: desiredConfig.image,
            desiredConfig,
            status: 'created',
            health: 'unknown',
            updatedAt: new Date(),
          })
          .where(and(eq(dockerDeploymentSlots.deploymentId, id), eq(dockerDeploymentSlots.slot, 'green')));
        await tx.insert(dockerDeploymentReleases).values({
          deploymentId: id,
          toSlot: 'blue',
          image: deployedDesiredConfig.image,
          triggerSource: 'create',
          status: 'succeeded',
          createdById: userId,
          completedAt: new Date(),
        });
      });
      await this.audit.log({
        action: 'docker.deployment.create',
        userId,
        resourceType: 'docker-deployment',
        resourceId: id,
        details: { nodeId, name: input.name },
      });
      this.emit('created', id, nodeId);
      return this.loadDeployment(nodeId, id);
    } catch (err) {
      await this.db
        .update(dockerDeployments)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(dockerDeployments.id, id))
        .catch(() => {});
      throw err;
    }
  }

  async update(
    nodeId: string,
    deploymentId: string,
    input: DockerDeploymentUpdateInput,
    userId: string,
    actorScopes: string[] = []
  ) {
    await this.migrationGuard?.assertDeploymentAllowed(nodeId, deploymentId);
    await this.validateDockerNode(nodeId);
    const current = await this.loadDeployment(nodeId, deploymentId);
    if (input.name && input.name !== current.name) await this.assertNameAvailable(nodeId, input.name, deploymentId);
    const routes = input.routes ? normalizeRoutes(input.routes) : undefined;
    const health = input.health ? normalizeHealth(input.health) : current.healthConfig;
    const desiredConfig = input.desiredConfig
      ? { ...current.desiredConfig, ...input.desiredConfig }
      : current.desiredConfig;
    if (input.desiredConfig && Object.hasOwn(input.desiredConfig, 'gpu')) {
      await this.assertDockerGpuCapability(nodeId);
    }
    await this.assertRuntimeProfile(nodeId, desiredConfig, current.desiredConfig.runtimeProfile);
    assertDockerMountChangeAllowed({
      nodeId,
      resourceId: deploymentId,
      actorScopes,
      nextConfig: desiredConfig,
      currentDefinitions: normalizeMountDefinitionsFromConfig(current.desiredConfig),
    });
    await assertManagedMountMutation({
      db: this.db,
      dispatch: this.dispatch,
      parseResult: (result) => this.parseResult(result),
      nodeId,
      current: normalizeMountDefinitionsFromConfig(current.desiredConfig),
      next: normalizeMountDefinitionsFromConfig(desiredConfig),
    });

    if (routes && !deploymentRoutesEqual(current.routes, routes)) {
      try {
        const result = await this.dispatch.sendDockerDeploymentCommand(nodeId, 'update_router', {
          deploymentId,
          configJson: JSON.stringify({
            deployment: { ...current, routes, healthConfig: health, desiredConfig },
            routes,
          }),
        });
        this.parseResult(result);
      } catch (err) {
        await this.db.transaction(async (tx) => {
          await tx
            .update(dockerDeployments)
            .set({ status: 'stopped', updatedAt: new Date(), updatedById: userId })
            .where(eq(dockerDeployments.id, deploymentId));
          await tx
            .update(dockerDeploymentSlots)
            .set({ status: 'stopped', health: 'unknown', drainingUntil: null, updatedAt: new Date() })
            .where(eq(dockerDeploymentSlots.deploymentId, deploymentId));
        });
        this.emit('failed', deploymentId, nodeId, {
          operation: 'update_router',
          name: current.name,
          failureCode: this.failureCode(err),
        });
        throw err;
      }
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(dockerDeployments)
        .set({
          name: input.name ?? current.name,
          desiredConfig,
          healthConfig: health,
          drainSeconds: input.drainSeconds ?? current.drainSeconds,
          updatedById: userId,
          updatedAt: new Date(),
        })
        .where(eq(dockerDeployments.id, deploymentId));
      if (routes) {
        await tx.delete(dockerDeploymentRoutes).where(eq(dockerDeploymentRoutes.deploymentId, deploymentId));
        await tx.insert(dockerDeploymentRoutes).values(
          routes.map((route) => ({
            deploymentId,
            hostPort: route.hostPort,
            containerPort: route.containerPort,
            isPrimary: route.isPrimary,
          }))
        );
      }
    });
    await this.healthCheckService?.alignDeploymentHealthCheck(nodeId, deploymentId);
    this.emit('updated', deploymentId, nodeId, {
      ...(input.name && input.name !== current.name ? { oldName: current.name, name: input.name } : {}),
    });
    return this.loadDeployment(nodeId, deploymentId);
  }

  /**
   * Attach or detach a Gateway-owned private network and roll a deployment so
   * both blue/green slots receive the same desired network topology. This is
   * deliberately not part of the public deployment input surface.
   */
  async setManagedDatabaseBindingNetwork(
    nodeId: string,
    deploymentId: string,
    networkName: string,
    enabled: boolean,
    userId: string | null,
    forceRollout = false
  ) {
    if (!/^gateway-db-[a-z0-9-]{8,64}$/.test(networkName)) {
      throw new AppError(400, 'INVALID_MANAGED_DATABASE_NETWORK', 'Invalid managed database network');
    }
    await this.validateDockerNode(nodeId);
    const current = await this.loadDeployment(nodeId, deploymentId);
    const currentNetworks = current.desiredConfig.networks ?? [];
    const networks = enabled
      ? [...new Set([...currentNetworks, networkName])]
      : currentNetworks.filter((name) => name !== networkName);
    const unchanged =
      networks.length === currentNetworks.length && currentNetworks.every((name, index) => name === networks[index]);
    if (unchanged && !forceRollout) {
      return current;
    }
    if (!unchanged) {
      await this.db
        .update(dockerDeployments)
        .set({ desiredConfig: { ...current.desiredConfig, networks }, updatedById: userId, updatedAt: new Date() })
        .where(eq(dockerDeployments.id, deploymentId));
    }
    this.emit('updated', deploymentId, nodeId, { managedDatabaseNetwork: enabled ? 'attached' : 'detached' });
    return this.deploy(nodeId, deploymentId, {}, userId, 'managed_database_binding');
  }

  async deploy(
    nodeId: string,
    deploymentId: string,
    input: DockerDeploymentDeployInput,
    userId: string | null,
    source = 'manual',
    actorScopes: string[] = []
  ) {
    await this.migrationGuard?.assertDeploymentAllowed(nodeId, deploymentId);
    await this.validateDockerNode(nodeId);
    const deployment = await this.loadDeployment(nodeId, deploymentId);
    this.requireDeploymentIdle(deployment);
    this.setTransition(deployment, 'deploying');
    const toSlot = inactiveSlot(deployment.activeSlot);
    const targetImage = input.image ?? imageWithTag(deployment.desiredConfig.image, input.tag);
    const desiredConfig = {
      ...deployment.desiredConfig,
      image: targetImage,
      env: input.env ?? deployment.desiredConfig.env,
    };
    if (desiredConfig.gpu !== undefined) await this.assertDockerGpuCapability(nodeId);
    await this.assertRuntimeProfile(nodeId, desiredConfig, deployment.desiredConfig.runtimeProfile);
    assertDockerMountChangeAllowed({
      nodeId,
      resourceId: deploymentId,
      actorScopes,
      nextConfig: desiredConfig,
      currentDefinitions: normalizeMountDefinitionsFromConfig(deployment.desiredConfig),
    });
    let task: Awaited<ReturnType<DockerTaskService['create']>> | null = null;
    let release: DeploymentReleaseRow | null = null;

    try {
      task = await this.tasks.create({
        nodeId,
        containerId: deploymentId,
        containerName: deployment.name,
        type: 'deployment_deploy',
      });
      await this.tasks.update(task.id, { status: 'running', progress: `Deploying ${targetImage} to ${toSlot}` });
      [release] = await this.db
        .insert(dockerDeploymentReleases)
        .values({
          deploymentId,
          fromSlot: deployment.activeSlot,
          toSlot,
          image: targetImage,
          triggerSource: source,
          taskId: task.id,
          status: 'running',
          createdById: userId,
        })
        .returning();

      await this.db
        .update(dockerDeployments)
        .set({ status: 'deploying', desiredConfig, updatedAt: new Date(), updatedById: userId })
        .where(eq(dockerDeployments.id, deploymentId));
      this.emit('deploying', deploymentId, nodeId, { toSlot });

      await this.switchToSlot(nodeId, deploymentId, { slot: toSlot, force: false }, userId, {
        releaseId: release.id,
        image: targetImage,
        source,
        registryId: input.registryId,
      });
      await this.tasks.update(task.id, {
        status: 'succeeded',
        progress: `Deployed ${targetImage}`,
        completedAt: new Date(),
      });
      this.imageCleanupService?.scheduleCleanupForDeployment(nodeId, deploymentId, targetImage).catch(() => {});
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Deployment failed';
      await Promise.all([
        task ? this.tasks.update(task.id, { status: 'failed', error, completedAt: new Date() }).catch(() => {}) : null,
        release
          ? this.db
              .update(dockerDeploymentReleases)
              .set({ status: 'failed', error, completedAt: new Date() })
              .where(eq(dockerDeploymentReleases.id, release.id))
              .catch(() => {})
          : null,
        this.db
          .update(dockerDeployments)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(eq(dockerDeployments.id, deploymentId)),
      ]);
      this.emit('failed', deploymentId, nodeId, {
        operation: 'deploy',
        name: deployment.name,
        failureCode: this.failureCode(err),
      });
      throw err;
    } finally {
      this.clearTransition(deployment);
    }
    return this.loadDeployment(nodeId, deploymentId);
  }

  async switchToSlot(
    nodeId: string,
    deploymentId: string,
    input: DockerDeploymentSwitchInput,
    userId: string | null,
    releaseContext?: {
      releaseId?: string;
      image?: string;
      source?: string;
      registryId?: string;
      desiredConfig?: DockerDeploymentDesiredConfig;
    },
    actorScopes: string[] = []
  ) {
    await this.validateDockerNode(nodeId);
    const deployment = await this.loadDeployment(nodeId, deploymentId);
    const managesTransition = !releaseContext;
    const target = deployment.slots.find((slot) => slot.slot === input.slot);
    if (!target?.containerName) throw new AppError(404, 'SLOT_NOT_FOUND', 'Slot does not exist');
    if (managesTransition) {
      this.requireDeploymentIdle(deployment);
      this.setTransition(deployment, 'switching');
    }
    const previous = deployment.activeSlot;
    const desiredConfig = {
      ...deployment.desiredConfig,
      ...releaseContext?.desiredConfig,
      image: releaseContext?.image ?? deployment.desiredConfig.image,
    };
    if (desiredConfig.gpu !== undefined) await this.assertDockerGpuCapability(nodeId);
    await this.assertRuntimeProfile(nodeId, desiredConfig, deployment.desiredConfig.runtimeProfile);
    assertDockerMountChangeAllowed({
      nodeId,
      resourceId: deploymentId,
      actorScopes,
      nextConfig: desiredConfig,
      currentDefinitions: normalizeMountDefinitionsFromConfig(deployment.desiredConfig),
    });
    await assertManagedMountMutation({
      db: this.db,
      dispatch: this.dispatch,
      parseResult: (result) => this.parseResult(result),
      nodeId,
      current: normalizeMountDefinitionsFromConfig(deployment.desiredConfig),
      next: normalizeMountDefinitionsFromConfig(desiredConfig),
    });
    const daemonDesiredConfig = await this.desiredConfigWithSecrets(nodeId, deploymentId, desiredConfig);
    const registryAuthCandidates = await this.registry.resolveAuthCandidatesForImagePull(
      nodeId,
      daemonDesiredConfig.image,
      releaseContext?.registryId,
      { actorScopes }
    );
    const registryAttempts = registryAuthCandidates.length ? registryAuthCandidates : [null];
    let data: any;
    let successfulDesiredConfig = daemonDesiredConfig;
    try {
      let successfulRegistryId: string | undefined;
      for (const registryAuth of registryAttempts) {
        const attemptDesiredConfig = desiredConfigForRegistryAttempt(daemonDesiredConfig, registryAuth);
        try {
          const result = await this.dispatch.sendDockerDeploymentCommand(
            nodeId,
            'switch',
            {
              deploymentId,
              slot: input.slot,
              configJson: JSON.stringify({
                deployment,
                activeSlot: input.slot,
                routes: deployment.routes,
                force: input.force,
                desiredConfig: attemptDesiredConfig,
                registryAuthJson: registryAuth?.authJson,
              }),
            },
            (deployment.healthConfig.deployTimeoutSeconds + 30) * 1000
          );
          data = this.parseResult(result) ?? {};
          successfulRegistryId = registryAuth?.registryId;
          successfulDesiredConfig = attemptDesiredConfig;
          break;
        } catch (err) {
          if (registryAuth === registryAttempts.at(-1) || !isRegistryRetryableError(err)) {
            throw err;
          }
        }
      }
      await this.registry.rememberImageRegistry(nodeId, successfulDesiredConfig.image, successfulRegistryId);
    } catch (err) {
      this.emit('failed', deploymentId, nodeId, {
        operation: 'switch',
        name: deployment.name,
        failureCode: this.failureCode(err),
      });
      if (managesTransition) this.clearTransition(deployment);
      throw err;
    }

    const drainingUntil =
      deployment.drainSeconds > 0 ? new Date(Date.now() + deployment.drainSeconds * 1000) : new Date();
    try {
      await this.db.transaction(async (tx) => {
        await tx
          .update(dockerDeployments)
          .set({
            activeSlot: input.slot,
            status: 'ready',
            // Never persist the daemon payload here: it includes decrypted
            // deployment secrets (including managed database credentials).
            desiredConfig,
            updatedAt: new Date(),
            updatedById: userId,
          })
          .where(eq(dockerDeployments.id, deploymentId));
        await tx
          .update(dockerDeploymentSlots)
          .set({
            containerId: data.containerId ?? target.containerId,
            image: desiredConfig.image,
            desiredConfig,
            status: 'running',
            health: 'healthy',
            drainingUntil: null,
            updatedAt: new Date(),
          })
          .where(and(eq(dockerDeploymentSlots.deploymentId, deploymentId), eq(dockerDeploymentSlots.slot, input.slot)));
        await tx
          .update(dockerDeploymentSlots)
          .set({ status: 'draining', drainingUntil, updatedAt: new Date() })
          .where(and(eq(dockerDeploymentSlots.deploymentId, deploymentId), eq(dockerDeploymentSlots.slot, previous)));
        if (releaseContext?.releaseId) {
          await tx
            .update(dockerDeploymentReleases)
            .set({ image: desiredConfig.image, status: 'succeeded', completedAt: new Date() })
            .where(eq(dockerDeploymentReleases.id, releaseContext.releaseId));
        } else {
          await tx.insert(dockerDeploymentReleases).values({
            deploymentId,
            fromSlot: previous,
            toSlot: input.slot,
            image: desiredConfig.image,
            triggerSource: releaseContext?.source ?? 'switch',
            status: 'succeeded',
            createdById: userId,
            completedAt: new Date(),
          });
        }
      });

      this.scheduleDrainCleanup(nodeId, deploymentId, previous, deployment.drainSeconds, drainingUntil);
      await this.audit.log({
        action: 'docker.deployment.switch',
        userId,
        resourceType: 'docker-deployment',
        resourceId: deploymentId,
        details: { nodeId, from: previous, to: input.slot, force: input.force },
      });
      this.emit('switched', deploymentId, nodeId, { activeSlot: input.slot });
      return this.loadDeployment(nodeId, deploymentId);
    } finally {
      if (managesTransition) this.clearTransition(deployment);
    }
  }

  async rollback(
    nodeId: string,
    deploymentId: string,
    force: boolean,
    userId: string | null,
    actorScopes: string[] = []
  ) {
    const deployment = await this.loadDeployment(nodeId, deploymentId);
    this.requireDeploymentIdle(deployment);
    this.setTransition(deployment, 'rolling_back');
    try {
      const rollbackSlot = deployment.slots.find((slot) => slot.slot === inactiveSlot(deployment.activeSlot));
      if (!rollbackSlot?.image) {
        throw new AppError(409, 'ROLLBACK_UNAVAILABLE', 'Rollback slot does not have a previous image');
      }
      const desiredConfig = rollbackSlot.desiredConfig ?? { ...deployment.desiredConfig, image: rollbackSlot.image };
      assertDockerMountChangeAllowed({
        nodeId,
        resourceId: deploymentId,
        actorScopes,
        nextConfig: desiredConfig,
        currentDefinitions: normalizeMountDefinitionsFromConfig(deployment.desiredConfig),
      });
      await this.switchToSlot(
        nodeId,
        deploymentId,
        { slot: inactiveSlot(deployment.activeSlot), force },
        userId,
        {
          image: desiredConfig.image,
          source: 'rollback',
          desiredConfig,
        },
        actorScopes
      );
    } finally {
      this.clearTransition(deployment);
    }
    return this.loadDeployment(nodeId, deploymentId);
  }

  private deploymentOperationContext(): DockerDeploymentOperationContext {
    return {
      db: this.db,
      audit: this.audit,
      dispatch: this.dispatch,
      eventBus: this.eventBus,
      validateDockerNode: (nodeId) => this.validateDockerNode(nodeId),
      loadDeployment: (nodeId, deploymentId) => this.loadDeployment(nodeId, deploymentId),
      requireDeploymentIdle: (deployment) => this.requireDeploymentIdle(deployment),
      setTransition: (deployment, transition) => this.setTransition(deployment, transition),
      clearTransition: (deployment) => this.clearTransition(deployment),
      parseResult: (result) => this.parseResult(result),
      emit: (action, deploymentId, nodeId, extra) => this.emit(action, deploymentId, nodeId, extra),
      removeAccessScopes: (nodeId, deploymentId) =>
        this.accessResourceService?.removeDeployment(nodeId, deploymentId) ?? Promise.resolve(),
      deploy: (nodeId, deploymentId, input, userId, source) => this.deploy(nodeId, deploymentId, input, userId, source),
    };
  }

  async stopSlot(nodeId: string, deploymentId: string, slot: DockerDeploymentSlot, userId: string | null) {
    await this.migrationGuard?.assertDeploymentAllowed(nodeId, deploymentId);
    await stopSlot(this.deploymentOperationContext(), nodeId, deploymentId, slot, userId);
  }

  async start(nodeId: string, deploymentId: string, userId: string | null) {
    await this.migrationGuard?.assertDeploymentAllowed(nodeId, deploymentId);
    return startDeployment(this.deploymentOperationContext(), nodeId, deploymentId, userId);
  }

  async stop(nodeId: string, deploymentId: string, userId: string | null) {
    await this.migrationGuard?.assertDeploymentAllowed(nodeId, deploymentId);
    return stopDeployment(this.deploymentOperationContext(), nodeId, deploymentId, userId);
  }

  async restart(nodeId: string, deploymentId: string, userId: string | null) {
    await this.migrationGuard?.assertDeploymentAllowed(nodeId, deploymentId);
    return restartDeployment(this.deploymentOperationContext(), nodeId, deploymentId, userId);
  }

  async kill(nodeId: string, deploymentId: string, userId: string | null) {
    await this.migrationGuard?.assertDeploymentAllowed(nodeId, deploymentId);
    return killDeployment(this.deploymentOperationContext(), nodeId, deploymentId, userId);
  }

  async remove(nodeId: string, deploymentId: string, userId: string) {
    await this.migrationGuard?.assertDeploymentAllowed(nodeId, deploymentId);
    await removeDeployment(this.deploymentOperationContext(), nodeId, deploymentId, userId);
  }

  async getWebhook(nodeId: string, deploymentId: string) {
    return getWebhook(this.deploymentOperationContext(), nodeId, deploymentId);
  }

  async upsertWebhook(nodeId: string, deploymentId: string, input: { enabled?: boolean }, userId: string) {
    await this.migrationGuard?.assertDeploymentAllowed(nodeId, deploymentId);
    return upsertWebhook(this.deploymentOperationContext(), nodeId, deploymentId, input, userId);
  }

  async deleteWebhook(nodeId: string, deploymentId: string, userId: string) {
    await this.migrationGuard?.assertDeploymentAllowed(nodeId, deploymentId);
    await deleteWebhook(this.deploymentOperationContext(), nodeId, deploymentId, userId);
  }

  async regenerateWebhook(nodeId: string, deploymentId: string, userId: string) {
    await this.migrationGuard?.assertDeploymentAllowed(nodeId, deploymentId);
    return regenerateWebhook(this.deploymentOperationContext(), nodeId, deploymentId, userId);
  }

  async triggerWebhook(webhookId: string, tag?: string) {
    return triggerWebhook(this.deploymentOperationContext(), webhookId, tag);
  }

  scheduleDrainCleanup(
    nodeId: string,
    deploymentId: string,
    slot: DockerDeploymentSlot,
    delaySeconds: number,
    expectedDrainingUntil: Date
  ) {
    if (delaySeconds <= 0) {
      void this.runDrainCleanup(nodeId, deploymentId, slot, expectedDrainingUntil).catch(() => {});
      return;
    }
    setTimeout(() => {
      void this.runDrainCleanup(nodeId, deploymentId, slot, expectedDrainingUntil).catch(() => {});
    }, delaySeconds * 1000);
  }

  private async runDrainCleanup(
    nodeId: string,
    deploymentId: string,
    slot: DockerDeploymentSlot,
    expectedDrainingUntil: Date
  ) {
    if (this.getTransition(nodeId, deploymentId)) {
      setTimeout(() => {
        void this.runDrainCleanup(nodeId, deploymentId, slot, expectedDrainingUntil).catch(() => {});
      }, 5000);
      return;
    }

    const deployment = await this.loadDeployment(nodeId, deploymentId);
    if (deployment.activeSlot === slot) return;

    const slotRow = deployment.slots.find((item) => item.slot === slot);
    if (!slotRow || slotRow.status !== 'draining' || !slotRow.drainingUntil) return;

    const currentDrainUntil =
      slotRow.drainingUntil instanceof Date
        ? slotRow.drainingUntil.getTime()
        : new Date(slotRow.drainingUntil).getTime();
    if (currentDrainUntil !== expectedDrainingUntil.getTime()) return;

    await this.stopSlot(nodeId, deploymentId, slot, null);
  }
}
