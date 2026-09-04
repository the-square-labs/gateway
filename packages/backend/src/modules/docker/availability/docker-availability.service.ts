import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import {
  type DockerAvailabilityPolicyStatus,
  dockerArtifactPins,
  dockerAvailabilityOperations,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  dockerBuildArtifacts,
  dockerComposeProjects,
  dockerComposeRevisions,
  dockerDeploymentReleases,
  dockerDeploymentSlots,
  dockerDeployments,
  nodes,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import { imageWithTag } from '@/modules/docker/docker-deployment-helpers.js';
import type { DockerEnvironmentService } from '@/modules/docker/docker-environment.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import {
  encodeComposeServiceTarget,
  removeComposePublishedPortsForAvailability,
} from '../compose/compose-managed-bindings.js';
import type {
  DockerAvailabilityAdapter,
  DockerAvailabilityCandidateNode,
  DockerAvailabilityIssue,
  DockerAvailabilityPolicyInput,
  DockerAvailabilityPolicyUpdateInput,
  DockerAvailabilityQueuedOperation,
  DockerAvailabilityResolvedResource,
  DockerAvailabilityResource,
} from './docker-availability.types.js';
import type { DockerAvailabilityArtifactService } from './docker-availability-artifact.service.js';
import { DockerWorkloadResolverService } from './docker-workload-resolver.service.js';

const logger = createChildLogger('DockerAvailabilityService');
const OPERATION_LEASE_MS = 20 * 60_000;
const WAITING_RETRY_BASE_MS = 30_000;
const WAITING_RETRY_MAX_MS = 10 * 60_000;
const MAX_OPERATION_BATCH = 20;
const AVAILABILITY_TRANSITION_STATUSES = new Set<DockerAvailabilityPolicyStatus>([
  'enabling',
  'scaling',
  'rolling_out',
  'disabling',
]);

export function resolveAvailabilityLogicalSurfaceState(
  status: DockerAvailabilityPolicyStatus,
  serving: number,
  desired: number,
  shouldRun = true,
  activeLifecycle?: 'start' | 'stop' | 'restart'
) {
  if (activeLifecycle) {
    const lifecycleStatus = { start: 'starting', stop: 'stopping', restart: 'restarting' } as const;
    return {
      status: lifecycleStatus[activeLifecycle],
      healthStatus: shouldRun ? ('online' as const) : ('stopped' as const),
    };
  }
  if (!shouldRun) return { status: 'stopped' as const, healthStatus: 'stopped' as const };
  const transitioning = AVAILABILITY_TRANSITION_STATUSES.has(status);
  const healthStatus = transitioning
    ? ('online' as const)
    : serving === 0
      ? ('offline' as const)
      : serving < desired
        ? ('degraded' as const)
        : ('online' as const);
  return {
    status: transitioning ? ('rolling_out' as const) : healthStatus,
    healthStatus,
  };
}

export function sanitizeAvailabilityErrorMessage(value: unknown): string {
  return Array.from(String(value), (character) => {
    const code = character.charCodeAt(0);
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      return `\\x${code.toString(16).padStart(2, '0')}`;
    }
    return character;
  })
    .join('')
    .slice(0, 4000);
}

export function shouldReconcileAvailabilityResourceDrift(_kind: string): boolean {
  return false;
}

export function initialAvailabilityPlacementState(running: boolean) {
  return {
    desiredState: running ? ('serving' as const) : ('stopped' as const),
    actualState: 'pending' as const,
    serving: false,
    dependencyState: 'pending' as const,
    applicationHealth: 'unknown' as const,
  };
}

export function isCurrentServingAvailabilityPlacement(
  placement: { generation: number; serving: boolean; actualState: string },
  targetGeneration: number,
  nodeOnline: boolean
): boolean {
  return (
    nodeOnline && placement.generation === targetGeneration && placement.serving && placement.actualState === 'serving'
  );
}

type PolicyRow = typeof dockerAvailabilityPolicies.$inferSelect;
type PlacementRow = typeof dockerAvailabilityPlacements.$inferSelect;
type OperationRow = typeof dockerAvailabilityOperations.$inferSelect;

export interface DockerAvailabilityDisableInput {
  survivingPlacementId: string;
  confirmation: string;
}

export interface DockerAvailabilityManagedDatabaseTarget {
  targetNodeId: string;
  targetType: 'container' | 'deployment' | 'compose_service';
  targetResourceId: string;
}

export interface DockerAvailabilityLogicalState {
  stopped: boolean;
  status: 'rolling_out' | 'online' | 'degraded' | 'offline' | 'stopped' | 'starting' | 'stopping' | 'restarting';
  healthStatus: 'online' | 'degraded' | 'offline' | 'stopped';
  serving: number;
  desired: number;
  sourceImageReference?: string;
  serviceCount?: number;
  runningServiceCount?: number;
}

function policySourceImageReference(policy: PolicyRow): string | undefined {
  const spec = policy.portableSpec as Record<string, any>;
  const candidates = [spec.image, spec.desiredConfig?.image, spec.sourceImageReference, policy.imageReference];
  return candidates
    .map((candidate) => String(candidate ?? '').trim())
    .find(
      (candidate) =>
        candidate.length > 0 &&
        !/^sha256:[0-9a-f]{64}$/i.test(candidate) &&
        !/^127\.0\.0\.1:5443\//i.test(candidate) &&
        !/(^|\/)gateway\/availability\//i.test(candidate)
    );
}

function policyComposeServiceCount(policy: PolicyRow): number | undefined {
  if (policy.resourceKind !== 'compose') return undefined;
  const model = (policy.portableSpec as Record<string, any>).normalizedModel as Record<string, any> | undefined;
  return Object.keys(model?.services ?? {}).length;
}

export interface DockerAvailabilityRuntimeAccessIdentity {
  nodeId: string;
  resourceId: string;
}

export class DockerAvailabilityService {
  private readonly adapters = new Map<string, DockerAvailabilityAdapter>();
  private readonly replacementTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly canonicalImageRepairs = new Map<string, Promise<string | null>>();
  private readonly healChecks = new Map<string, Promise<void>>();
  private readonly activeLeases = new Map<string, string>();
  private waitingRetryTimer?: ReturnType<typeof setTimeout>;
  private startupReconciliationTimer?: ReturnType<typeof setTimeout>;
  private artifactCleanupTimer?: ReturnType<typeof setInterval>;
  private unsubscribeNodeEvents?: () => void;
  private processing = false;
  private readonly workloads: DockerWorkloadResolverService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly nodeRegistry: NodeRegistryService,
    private readonly licensePolicy: LicensePolicyService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly artifacts?: DockerAvailabilityArtifactService,
    private readonly environment?: DockerEnvironmentService,
    workloadResolver?: DockerWorkloadResolverService
  ) {
    this.workloads = workloadResolver ?? new DockerWorkloadResolverService(db);
  }

  registerAdapter(adapter: DockerAvailabilityAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  async resolveRuntimeAccessIdentity(
    nodeId: string,
    containerIdOrName: string
  ): Promise<DockerAvailabilityRuntimeAccessIdentity | null> {
    const runtimeOwner = await this.workloads.findRuntimeOwner(nodeId, containerIdOrName);
    const workload =
      runtimeOwner?.workload ??
      (await this.workloads.resolve({
        type: 'container',
        nodeId,
        containerName: containerIdOrName,
      }));
    if (!workload) return null;
    const policy = workload.policy;
    if (policy.resourceKind === 'compose') {
      if (!policy.composeProjectId || !runtimeOwner?.composeServiceName) return null;
      return {
        nodeId: workload.managementTarget.nodeId,
        resourceId: encodeComposeServiceTarget({
          projectId: policy.composeProjectId,
          serviceName: runtimeOwner.composeServiceName,
        }),
      };
    }
    if (policy.resourceKind === 'deployment') {
      if (!policy.deploymentId) return null;
      return {
        nodeId: workload.managementTarget.nodeId,
        resourceId: policy.deploymentId,
      };
    }
    if (!policy.containerName) return null;
    return {
      nodeId: workload.managementTarget.nodeId,
      resourceId: policy.containerName,
    };
  }

  start(): void {
    if (this.unsubscribeNodeEvents) return;
    this.unsubscribeNodeEvents = this.events.subscribe('node.changed', (payload) => {
      const event = payload as { id?: unknown; status?: unknown };
      if (typeof event.id !== 'string' || typeof event.status !== 'string') return;
      if (event.status === 'offline' || event.status === 'error') {
        void this.handleNodeUnavailable(event.id).catch((error) => {
          logger.error('Failed to handle unavailable node for Docker Availability', { nodeId: event.id, error });
        });
      } else if (event.status === 'online') {
        void this.handleNodeOnline(event.id).catch((error) => {
          logger.error('Failed to reconcile returning Docker Availability node', { nodeId: event.id, error });
        });
      }
    });
    void this.recoverInterruptedOperations();
    this.startupReconciliationTimer = setTimeout(() => {
      this.startupReconciliationTimer = undefined;
      void this.reconcileEnabledPoliciesAfterStartup().catch((error) => {
        logger.error('Failed to reconcile Docker Availability after startup', { error });
      });
    }, 10_000);
    this.startupReconciliationTimer.unref?.();
    this.artifactCleanupTimer = setInterval(() => {
      void this.cleanupRemovedContainers().catch((error) => {
        logger.warn('Removed Availability container cleanup failed; will retry', { error });
      });
      void this.artifacts?.collectUnusedArtifacts().catch((error) => {
        logger.warn('Automatic Availability artifact cleanup failed; will retry', { error });
      });
    }, 60_000);
    this.artifactCleanupTimer.unref?.();
  }

  stop(): void {
    if (this.artifactCleanupTimer) clearInterval(this.artifactCleanupTimer);
    this.artifactCleanupTimer = undefined;
    this.unsubscribeNodeEvents?.();
    this.unsubscribeNodeEvents = undefined;
    for (const timer of this.replacementTimers.values()) clearTimeout(timer);
    this.replacementTimers.clear();
    if (this.waitingRetryTimer) clearTimeout(this.waitingRetryTimer);
    this.waitingRetryTimer = undefined;
    if (this.startupReconciliationTimer) clearTimeout(this.startupReconciliationTimer);
    this.startupReconciliationTimer = undefined;
  }

  async preflight(input: DockerAvailabilityPolicyInput, scopes: string[]) {
    await this.licensePolicy.requireFeature('multi-node-availability');
    this.validatePolicyInput(input);
    const adapter = this.requireAdapter(input.resource.type);
    const currentPolicy = await this.findPolicyByResourceReference(input.resource);
    const resource =
      currentPolicy && currentPolicy.mode !== 'single'
        ? await this.resolvePolicyResource(currentPolicy)
        : await adapter.resolve(input.resource);
    this.assertResourceAccess(scopes, resource, 'manage');

    const candidateNodes = await this.resolveCandidateNodes(input, resource);
    const blockers: DockerAvailabilityIssue[] = [];
    const warnings: DockerAvailabilityIssue[] = [];
    const compatible = candidateNodes.filter((candidate) => candidate.compatible);
    const requiredNodes = input.mode === 'replicated' ? Math.max(2, input.desiredReplicaCount) : 2;
    if (compatible.length < requiredNodes) {
      blockers.push({
        code: 'INSUFFICIENT_ELIGIBLE_NODES',
        message: `${requiredNodes} compatible Docker nodes are required but only ${compatible.length} are available`,
      });
    }
    for (const candidate of compatible) {
      this.collectCandidatePermissionBlockers(scopes, resource, candidate.id, blockers);
    }
    if (!this.artifacts) {
      blockers.push({
        code: 'AVAILABILITY_IMAGE_DELIVERY_UNAVAILABLE',
        message: 'Internal registry delivery over Secure Links is unavailable',
      });
    } else {
      try {
        await this.artifacts.preflight(resource);
      } catch (error) {
        blockers.push({
          code: error instanceof AppError ? error.code : 'AVAILABILITY_IMAGE_DELIVERY_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'Internal registry delivery is unavailable',
        });
      }
    }
    const adapterResult = await adapter.preflight(resource, compatible, scopes);
    blockers.push(...adapterResult.blockers);
    warnings.push(...adapterResult.warnings);
    return {
      eligible: blockers.length === 0,
      resource: input.resource,
      proposedPolicy: this.normalizePolicyInput(input),
      blockers,
      warnings,
      candidateNodes: candidateNodes.map(({ rank: _rank, capacity: _capacity, ...candidate }) => candidate),
      currentPolicy: currentPolicy ? await this.policyView(currentPolicy) : null,
    };
  }

  async enable(input: DockerAvailabilityPolicyInput, userId: string, scopes: string[]) {
    const preflight = await this.preflight(input, scopes);
    if (!preflight.eligible) {
      throw new AppError(409, 'AVAILABILITY_PREFLIGHT_BLOCKED', 'Multi-node Availability preflight has blockers', {
        blockers: preflight.blockers,
      });
    }
    const adapter = this.requireAdapter(input.resource.type);
    const resource = await adapter.resolve(input.resource);
    const normalized = this.normalizePolicyInput(input);
    const created = await this.db.transaction(async (tx) => {
      await this.lockResource(tx, resource);
      const existing = await this.findPolicyByResolvedResource(resource, tx);
      if (existing?.portableSpec.removedContainer === true) {
        throw new AppError(
          409,
          'AVAILABILITY_CLEANUP_PENDING',
          'The previous container is still being cleaned up. Retry enabling Availability after cleanup completes.',
          { retryable: true }
        );
      }
      if (existing && existing.mode !== 'single') {
        throw new AppError(409, 'AVAILABILITY_ALREADY_ENABLED', 'Multi-node Availability is already enabled');
      }
      const generation = (existing?.desiredGeneration ?? 0) + 1;
      const policy = existing
        ? (
            await tx
              .update(dockerAvailabilityPolicies)
              .set({
                ...this.resourceColumns(resource),
                ...normalized,
                desiredGeneration: generation,
                status: 'enabling',
                lastErrorCode: null,
                lastErrorMessage: null,
                updatedById: userId,
                updatedAt: new Date(),
              })
              .where(eq(dockerAvailabilityPolicies.id, existing.id))
              .returning()
          )[0]
        : (
            await tx
              .insert(dockerAvailabilityPolicies)
              .values({
                ...this.resourceColumns(resource),
                ...normalized,
                desiredGeneration: generation,
                status: 'enabling',
                createdById: userId,
                updatedById: userId,
              })
              .returning()
          )[0];
      if (!policy) throw new Error('Availability policy was not persisted');
      const operation = await this.insertOperation(tx, {
        policyId: policy.id,
        type: 'enable',
        targetGeneration: generation,
        requestedPolicy: normalized,
        userId,
        idempotencyKey: `availability:enable:${policy.id}:${generation}`,
      });
      await tx
        .insert(dockerAvailabilityPlacements)
        .values({
          policyId: policy.id,
          nodeId: resource.currentNodeId,
          generation,
          ...initialAvailabilityPlacementState(resource.running),
          specFingerprint: resource.specFingerprint,
          imageReference: resource.imageReference,
          composeRevisionId: resource.composeRevisionId,
          lastObservedAt: new Date(),
          operationId: operation.id,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [dockerAvailabilityPlacements.policyId, dockerAvailabilityPlacements.nodeId],
          set: {
            generation,
            ...initialAvailabilityPlacementState(resource.running),
            specFingerprint: resource.specFingerprint,
            imageReference: resource.imageReference,
            composeRevisionId: resource.composeRevisionId,
            runtimeIdentity: {},
            unavailableSince: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            operationId: operation.id,
            updatedAt: new Date(),
          },
        });
      return policy;
    });
    await this.recordMutation('enabled', created.id, userId, { mode: created.mode });
    this.kick();
    return this.policyView(created);
  }

  async getByResource(resourceRef: DockerAvailabilityResource, scopes: string[]) {
    const existingPolicy = await this.findPolicyByResourceReference(resourceRef);
    if (existingPolicy) {
      const resource = await this.resolvePolicyResource(existingPolicy);
      this.assertResourceAccess(scopes, resource, 'view');
      return this.policyView(existingPolicy);
    }
    const adapter = this.requireAdapter(resourceRef.type);
    const resource = await adapter.resolve(resourceRef);
    this.assertResourceAccess(scopes, resource, 'view');
    const policy = await this.findPolicyByResolvedResource(resource);
    return policy ? this.policyView(policy) : null;
  }

  async resolveManagedDatabaseBindingPolicyId(target: DockerAvailabilityManagedDatabaseTarget): Promise<string | null> {
    const reference: DockerAvailabilityResource =
      target.targetType === 'container'
        ? {
            type: 'container',
            nodeId: target.targetNodeId,
            containerName: target.targetResourceId,
          }
        : target.targetType === 'deployment'
          ? { type: 'deployment', deploymentId: target.targetResourceId }
          : {
              type: 'compose',
              composeProjectId: target.targetResourceId.split(':', 1)[0]!,
            };
    const policy = await this.findPolicyByResourceReference(reference);
    return policy && policy.mode !== 'single' ? policy.id : null;
  }

  async queueDependencyRollout(policyId: string, userId: string | null): Promise<string | null> {
    await this.licensePolicy.requireFeature('multi-node-availability');
    const queued = await this.db.transaction(async (tx) => {
      await this.lockPolicy(tx, policyId);
      const policy = await this.requirePolicy(policyId, tx);
      if (policy.mode === 'single') return null;
      await this.supersedeQueuedOperations(tx, policyId);
      const generation = policy.desiredGeneration + 1;
      await tx
        .update(dockerAvailabilityPolicies)
        .set({
          desiredGeneration: generation,
          status: 'rolling_out',
          lastErrorCode: null,
          lastErrorMessage: null,
          ...(userId ? { updatedById: userId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(dockerAvailabilityPolicies.id, policyId));
      const operation = await this.insertOperation(tx, {
        policyId,
        type: 'rollout',
        targetGeneration: generation,
        requestedPolicy: { dependencyRefresh: 'managed_database_binding' },
        ...(userId ? { userId } : {}),
        idempotencyKey: `availability:database-dependency:${policyId}:${generation}`,
      });
      return operation.id;
    });
    if (queued === null) return null;
    this.publishPolicy(policyId, 'database_dependency_rollout_queued');
    this.kick();
    return queued;
  }

  async removeManagedDatabaseBinding(policyId: string, userId: string | null): Promise<void> {
    const operationId = await this.queueDependencyRollout(policyId, userId);
    if (!operationId) return;
    await this.waitForOperationCompletion(operationId);
  }

  private async waitForOperationCompletion(operationId: string): Promise<void> {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const [operation] = await this.db
        .select()
        .from(dockerAvailabilityOperations)
        .where(eq(dockerAvailabilityOperations.id, operationId))
        .limit(1);
      if (!operation)
        throw new AppError(409, 'AVAILABILITY_OPERATION_NOT_FOUND', 'Availability rollout operation disappeared');
      if (operation.status === 'completed') return;
      if (['failed', 'cleanup_pending', 'cancelled'].includes(operation.status)) {
        throw new AppError(
          409,
          operation.errorCode ?? 'AVAILABILITY_ROLLOUT_FAILED',
          operation.errorMessage ?? 'Availability rollout failed'
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new AppError(503, 'AVAILABILITY_ROLLOUT_TIMEOUT', 'Availability rollout did not finish in time', {
      retryable: true,
    });
  }

  async updateContainerConfiguration(
    nodeId: string,
    containerName: string,
    patch: Record<string, unknown>,
    userId: string | null,
    options: { waitForCompletion?: boolean; forceRollout?: boolean } = {}
  ): Promise<boolean> {
    const policy = await this.findActiveContainerPolicy(nodeId, containerName);
    if (!policy) return false;
    await this.licensePolicy.requireFeature('multi-node-availability');
    if (
      (Array.isArray(patch.mounts) && patch.mounts.length > 0) ||
      (Array.isArray(patch.volumes) && patch.volumes.length > 0)
    ) {
      throw new AppError(
        409,
        'AVAILABILITY_MOUNTS_UNSUPPORTED',
        'Containers with Availability cannot use volumes or mounts'
      );
    }

    const portableSpec = JSON.parse(JSON.stringify(policy.portableSpec)) as Record<string, unknown>;
    const mappedKeys: Array<[string, string]> = [
      ['image', 'image'],
      ['entrypoint', 'entrypoint'],
      ['command', 'cmd'],
      ['stopTimeout', 'stopTimeout'],
      ['workingDir', 'working_dir'],
      ['user', 'user'],
      ['hostname', 'hostname'],
      ['labels', 'labels'],
      ['ports', 'ports'],
      ['networks', 'networks'],
      ['restartPolicy', 'restartPolicy'],
      ['runtimeProfile', 'runtimeProfile'],
      ['maxRetries', 'maxRetries'],
      ['memoryLimit', 'memoryLimit'],
      ['memorySwap', 'memorySwap'],
      ['nanoCPUs', 'nanoCPUs'],
      ['cpuShares', 'cpuShares'],
      ['pidsLimit', 'pidsLimit'],
      ['gpu', 'gpu'],
    ];
    for (const [source, target] of mappedKeys) {
      if (Object.hasOwn(patch, source)) portableSpec[target] = patch[source];
    }
    const imageReference =
      typeof patch.image === 'string' && patch.image.trim() ? patch.image.trim() : policy.imageReference;
    if (Object.hasOwn(patch, 'image') && imageReference) {
      portableSpec.image = imageReference;
      portableSpec.sourceImageReference = imageReference;
    }
    const specFingerprint = createHash('sha256').update(JSON.stringify(portableSpec)).digest('hex');
    const unchanged = specFingerprint === policy.specFingerprint && imageReference === policy.imageReference;
    if (!unchanged || options.forceRollout) {
      const operationId = await this.queueCanonicalRollout(
        policy.id,
        {
          portableSpec,
          specFingerprint,
          imageReference: imageReference ?? null,
          shouldRun: policy.shouldRun,
        },
        userId,
        'configuration'
      );
      if (options.waitForCompletion) {
        if (!operationId) throw new AppError(409, 'AVAILABILITY_NOT_ENABLED', 'Container rollout was not queued');
        await this.waitForOperationCompletion(operationId);
      }
    }
    return true;
  }

  async updateContainerEnvironment(
    nodeId: string,
    containerName: string,
    env: Record<string, string> | undefined,
    removeEnv: string[] | undefined,
    userId: string
  ): Promise<boolean> {
    const policy = await this.findActiveContainerPolicy(nodeId, containerName);
    if (!policy) return false;
    await this.licensePolicy.requireFeature('multi-node-availability');
    if (!this.environment) {
      throw new AppError(
        503,
        'AVAILABILITY_ENVIRONMENT_UNAVAILABLE',
        'Availability environment storage is unavailable'
      );
    }
    const next = {
      ...(await this.environment.getDecryptedMap(nodeId, containerName)),
      ...(env ?? {}),
    };
    for (const key of removeEnv ?? []) delete next[key];
    await this.environment.replace(nodeId, containerName, next);
    await this.queueCanonicalRollout(
      policy.id,
      {
        portableSpec: policy.portableSpec,
        specFingerprint: policy.specFingerprint,
        imageReference: policy.imageReference,
        shouldRun: policy.shouldRun,
      },
      userId,
      'environment'
    );
    return true;
  }

  async getContainerEnvironment(nodeId: string, containerName: string): Promise<string[] | null> {
    const policy = await this.findActiveContainerPolicy(nodeId, containerName);
    if (!policy) return null;
    if (!this.environment) {
      throw new AppError(
        503,
        'AVAILABILITY_ENVIRONMENT_UNAVAILABLE',
        'Availability environment storage is unavailable'
      );
    }
    const values = await this.environment.getDecryptedMap(
      policy.sourceNodeId ?? policy.originNodeId ?? nodeId,
      policy.containerName ?? containerName
    );
    return Object.entries(values).map(([key, value]) => `${key}=${value}`);
  }

  async getContainerConfiguration(
    nodeId: string,
    containerName: string
  ): Promise<{
    image: string;
    runtimeProfile?: string;
    shouldRun: boolean;
    nodeId: string;
    containerName: string;
  } | null> {
    const policy = await this.findActiveContainerPolicy(nodeId, containerName);
    if (!policy) return null;
    const spec = policy.portableSpec;
    const candidates = [...new Set([spec.sourceImageReference, spec.image].map((value) => String(value ?? '').trim()))];
    let image =
      candidates.find(
        (value) => value && !/^127\.0\.0\.1:5443\//i.test(value) && !/(^|\/)gateway\/availability\//i.test(value)
      ) ?? '';
    if (!image) {
      for (const candidate of candidates) {
        const buildReference = candidate.match(
          /^127\.0\.0\.1:5443\/(gateway\/builds\/[a-z0-9._/-]+)@(sha256:[0-9a-f]{64})$/
        );
        if (!buildReference) continue;
        const [artifact] = await this.db
          .select({ id: dockerBuildArtifacts.id })
          .from(dockerBuildArtifacts)
          .where(
            and(
              eq(dockerBuildArtifacts.registryRepository, buildReference[1]!),
              eq(dockerBuildArtifacts.digest, buildReference[2]!),
              eq(dockerBuildArtifacts.status, 'ready')
            )
          )
          .limit(1);
        if (artifact) {
          image = candidate;
          break;
        }
      }
    }
    return {
      image,
      ...(typeof spec.runtimeProfile === 'string' ? { runtimeProfile: spec.runtimeProfile } : {}),
      shouldRun: policy.shouldRun,
      nodeId: policy.sourceNodeId ?? policy.originNodeId ?? nodeId,
      containerName: policy.containerName ?? containerName,
    };
  }

  async deployDeployment(
    deploymentId: string,
    input: { image?: string; tag?: string; env?: Record<string, string>; desiredConfig?: Record<string, any> },
    targetActiveSlot: 'blue' | 'green',
    userId: string | null,
    source: string,
    releaseId?: string
  ) {
    const policy = await this.findPolicyByResourceReference({ type: 'deployment', deploymentId });
    if (!policy || policy.mode === 'single') {
      throw new AppError(409, 'AVAILABILITY_NOT_ENABLED', 'Deployment is no longer managed by Availability');
    }
    await this.licensePolicy.requireFeature('multi-node-availability');
    const portableSpec = JSON.parse(JSON.stringify(policy.portableSpec)) as Record<string, any>;
    const desiredConfig = {
      ...(input.desiredConfig ?? portableSpec.desiredConfig),
      image: input.image ?? imageWithTag(String(portableSpec.desiredConfig?.image ?? ''), input.tag),
      ...(input.env !== undefined ? { env: input.env } : {}),
    };
    if ((desiredConfig.mounts?.length ?? 0) > 0) {
      throw new AppError(
        409,
        'AVAILABILITY_MOUNTS_UNSUPPORTED',
        'Deployments with Availability cannot use volumes or mounts'
      );
    }
    portableSpec.desiredConfig = desiredConfig;
    if (policy.shouldRun) portableSpec.activeSlot = targetActiveSlot;
    const operationId = await this.queueCanonicalRollout(
      policy.id,
      {
        portableSpec,
        specFingerprint: createHash('sha256').update(JSON.stringify(portableSpec)).digest('hex'),
        imageReference: desiredConfig.image,
        shouldRun: policy.shouldRun,
      },
      userId,
      source,
      {
        deploymentDeploy: true,
        ...(releaseId ? { deploymentReleaseId: releaseId } : {}),
        ...(policy.shouldRun ? { targetActiveSlot } : {}),
      }
    );
    if (!operationId) throw new AppError(409, 'AVAILABILITY_NOT_ENABLED', 'Deployment rollout was not queued');
    await this.db
      .update(dockerDeployments)
      .set({ desiredConfig, updatedById: userId, updatedAt: new Date() })
      .where(eq(dockerDeployments.id, deploymentId));
    await this.waitForOperationCompletion(operationId);
    const current = await this.requirePolicy(policy.id);
    return {
      desiredConfig,
      shouldRun: current.shouldRun,
      activeSlot: (current.shouldRun ? targetActiveSlot : portableSpec.activeSlot === 'green' ? 'green' : 'blue') as
        | 'blue'
        | 'green',
    };
  }

  async setContainerRunning(
    nodeId: string,
    containerName: string,
    running: boolean,
    userId: string,
    restart = false
  ): Promise<boolean> {
    const policy = await this.findActiveContainerPolicy(nodeId, containerName);
    if (!policy) return false;
    await this.licensePolicy.requireFeature('multi-node-availability');
    await this.queueLifecycle(policy.id, restart ? 'restart' : running ? 'start' : 'stop', userId);
    return true;
  }

  private async findActiveContainerPolicy(nodeId: string, containerName: string): Promise<PolicyRow | null> {
    const policy = await this.findPolicyByResourceReference({ type: 'container', nodeId, containerName });
    return policy && policy.mode !== 'single' ? policy : null;
  }

  async isContainerManaged(nodeId: string, containerName: string): Promise<boolean> {
    return Boolean(await this.findActiveContainerPolicy(nodeId, containerName));
  }

  async isDeploymentManaged(deploymentId: string): Promise<boolean> {
    const policy = await this.findPolicyByResourceReference({ type: 'deployment', deploymentId });
    return Boolean(policy && policy.mode !== 'single');
  }

  async updateDeploymentConfiguration(
    deploymentId: string,
    snapshot: {
      name: string;
      desiredConfig: Record<string, any>;
      health: Record<string, any>;
      routes: Array<Record<string, any>>;
      drainSeconds: number;
    },
    userId: string | null,
    reason = 'configuration'
  ): Promise<boolean> {
    const policy = await this.findPolicyByResourceReference({ type: 'deployment', deploymentId });
    if (!policy || policy.mode === 'single') return false;
    await this.licensePolicy.requireFeature('multi-node-availability');
    if ((snapshot.desiredConfig.mounts?.length ?? 0) > 0) {
      throw new AppError(
        409,
        'AVAILABILITY_MOUNTS_UNSUPPORTED',
        'Deployments with Availability cannot use volumes or mounts'
      );
    }
    const portableSpec = JSON.parse(JSON.stringify(policy.portableSpec)) as Record<string, any>;
    portableSpec.name = snapshot.name;
    portableSpec.desiredConfig = { ...snapshot.desiredConfig, networks: [] };
    portableSpec.health = snapshot.health;
    portableSpec.routes = snapshot.routes.map((route) => ({ ...route, hostIp: '127.0.0.1' }));
    portableSpec.drainSeconds = snapshot.drainSeconds;
    const specFingerprint = createHash('sha256').update(JSON.stringify(portableSpec)).digest('hex');
    const imageReference = String(snapshot.desiredConfig.image ?? policy.imageReference ?? '');
    if (specFingerprint === policy.specFingerprint && imageReference === policy.imageReference) return true;
    await this.queueCanonicalRollout(
      policy.id,
      {
        portableSpec,
        specFingerprint,
        imageReference,
        shouldRun: policy.shouldRun,
      },
      userId,
      reason
    );
    return true;
  }

  async setDeploymentRunning(
    deploymentId: string,
    running: boolean,
    userId: string | null,
    restart = false
  ): Promise<boolean> {
    const policy = await this.findPolicyByResourceReference({ type: 'deployment', deploymentId });
    if (!policy || policy.mode === 'single') return false;
    await this.licensePolicy.requireFeature('multi-node-availability');
    await this.queueLifecycle(policy.id, restart ? 'restart' : running ? 'start' : 'stop', userId);
    return true;
  }

  async switchDeploymentSlot(
    deploymentId: string,
    targetActiveSlot: 'blue' | 'green',
    userId: string | null
  ): Promise<boolean> {
    const policy = await this.findPolicyByResourceReference({ type: 'deployment', deploymentId });
    if (!policy || policy.mode === 'single') return false;
    await this.licensePolicy.requireFeature('multi-node-availability');
    const portableSpec = JSON.parse(JSON.stringify(policy.portableSpec)) as Record<string, any>;
    portableSpec.activeSlot = targetActiveSlot;
    const specFingerprint = createHash('sha256').update(JSON.stringify(portableSpec)).digest('hex');
    const operationId = await this.queueCanonicalRollout(
      policy.id,
      {
        portableSpec,
        specFingerprint,
        imageReference: policy.imageReference,
        shouldRun: policy.shouldRun,
      },
      userId,
      'deployment_slot_switch',
      { targetActiveSlot }
    );
    if (operationId) await this.waitForOperationCompletion(operationId);
    await this.db.transaction(async (tx) => {
      await tx
        .update(dockerDeployments)
        .set({ activeSlot: targetActiveSlot, status: 'ready', updatedById: userId, updatedAt: new Date() })
        .where(eq(dockerDeployments.id, deploymentId));
      await tx
        .update(dockerDeploymentSlots)
        .set({ status: 'running', health: 'healthy', drainingUntil: null, updatedAt: new Date() })
        .where(
          and(eq(dockerDeploymentSlots.deploymentId, deploymentId), eq(dockerDeploymentSlots.slot, targetActiveSlot))
        );
      await tx
        .update(dockerDeploymentSlots)
        .set({ status: 'created', health: 'unknown', drainingUntil: null, updatedAt: new Date() })
        .where(
          and(eq(dockerDeploymentSlots.deploymentId, deploymentId), ne(dockerDeploymentSlots.slot, targetActiveSlot))
        );
    });
    return true;
  }

  async isComposeManaged(projectId: string): Promise<boolean> {
    const policy = await this.findPolicyByResourceReference({ type: 'compose', composeProjectId: projectId });
    return Boolean(policy && policy.mode !== 'single');
  }

  // Invoked only after Docker has confirmed removal of the ordinary survivor.
  // Retained single-mode metadata must no longer keep its mirrored image alive.
  async containerRemoved(nodeId: string, containerName: string): Promise<void> {
    const policy = await this.findPolicyByResourceReference({ type: 'container', nodeId, containerName });
    if (
      !policy ||
      policy.mode !== 'single' ||
      AVAILABILITY_TRANSITION_STATUSES.has(policy.status) ||
      policy.resourceKind !== 'container' ||
      policy.containerName !== containerName ||
      (policy.sourceNodeId ?? policy.originNodeId) !== nodeId
    )
      return;
    await this.db.transaction(async (tx) => {
      await this.lockPolicy(tx, policy.id);
      const current = await this.requirePolicy(policy.id, tx);
      if (current.mode !== 'single' || AVAILABILITY_TRANSITION_STATUSES.has(current.status)) return;
      await tx
        .update(dockerAvailabilityPolicies)
        .set({
          portableSpec: { ...current.portableSpec, removedContainer: true },
          shouldRun: false,
          updatedAt: new Date(),
        })
        .where(eq(dockerAvailabilityPolicies.id, policy.id));
      await tx
        .update(dockerAvailabilityPlacements)
        .set({
          desiredState: 'removed',
          actualState: 'removed',
          serving: false,
          updatedAt: new Date(),
        })
        .where(
          and(eq(dockerAvailabilityPlacements.policyId, policy.id), eq(dockerAvailabilityPlacements.nodeId, nodeId))
        );
    });
    // Persist the tombstone before external cleanup. The scheduled retry retains
    // policy ownership while an offline retired replica still needs removal.
    await this.cleanupRemovedContainers();
  }

  private async cleanupRemovedContainers(): Promise<void> {
    const policies = await this.db
      .select()
      .from(dockerAvailabilityPolicies)
      .where(
        and(
          eq(dockerAvailabilityPolicies.resourceKind, 'container'),
          eq(dockerAvailabilityPolicies.mode, 'single'),
          sql`${dockerAvailabilityPolicies.portableSpec}->>'removedContainer' = 'true'`
        )
      );
    for (const policy of policies) {
      const [placements, operations] = await Promise.all([
        this.db
          .select({ id: dockerAvailabilityPlacements.id })
          .from(dockerAvailabilityPlacements)
          .where(
            and(
              eq(dockerAvailabilityPlacements.policyId, policy.id),
              ne(dockerAvailabilityPlacements.actualState, 'removed')
            )
          ),
        this.db
          .select({ id: dockerAvailabilityOperations.id })
          .from(dockerAvailabilityOperations)
          .where(
            and(
              eq(dockerAvailabilityOperations.policyId, policy.id),
              inArray(dockerAvailabilityOperations.status, ['pending', 'running', 'waiting'])
            )
          ),
      ]);
      if (placements.length || operations.length) continue;
      await this.artifacts?.cleanup(policy.id);
      await this.db
        .delete(dockerAvailabilityPolicies)
        .where(
          and(
            eq(dockerAvailabilityPolicies.id, policy.id),
            eq(dockerAvailabilityPolicies.mode, 'single'),
            sql`${dockerAvailabilityPolicies.portableSpec}->>'removedContainer' = 'true'`
          )
        );
    }
  }

  async removeComposeManaged(projectId: string, userId: string | null): Promise<boolean> {
    const policy = await this.findPolicyByResourceReference({ type: 'compose', composeProjectId: projectId });
    if (!policy || policy.mode === 'single') return false;
    const resource = await this.resolvePolicyResource(policy);
    const adapter = this.requireAdapter(policy.resourceKind);
    const placements = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.policyId, policy.id));
    const generation = policy.desiredGeneration + 1;
    const leaseOwner = `compose-delete:${crypto.randomUUID()}`;
    const operation = await this.insertOperation(this.db, {
      policyId: policy.id,
      type: 'stale_cleanup',
      targetGeneration: generation,
      requestedPolicy: {},
      userId,
      idempotencyKey: `compose-delete:${policy.id}`,
    });
    await this.db
      .update(dockerAvailabilityOperations)
      .set({
        status: 'running',
        leaseOwner,
        leaseHeartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + OPERATION_LEASE_MS),
        updatedAt: new Date(),
      })
      .where(eq(dockerAvailabilityOperations.id, operation.id));
    this.activeLeases.set(operation.id, leaseOwner);
    try {
      for (const placement of placements) {
        if (placement.actualState === 'removed') continue;
        if (!this.nodeRegistry.getNode(placement.nodeId)) {
          throw new AppError(
            503,
            'AVAILABILITY_COMPOSE_CLEANUP_PENDING',
            `Availability placement node ${placement.nodeId} is offline`,
            { retryable: true }
          );
        }
        await adapter.removePlacement({
          policyId: policy.id,
          placementId: placement.id,
          operationId: operation.id,
          leaseOwner,
          nodeId: placement.nodeId,
          generation,
          idempotencyKey: `compose-delete:${policy.id}:${placement.id}`,
          resource,
        });
      }
    } finally {
      if (this.activeLeases.get(operation.id) === leaseOwner) this.activeLeases.delete(operation.id);
    }
    await this.artifacts?.cleanup(policy.id);
    await this.db.delete(dockerAvailabilityPolicies).where(eq(dockerAvailabilityPolicies.id, policy.id));
    return true;
  }

  async applyComposeRevision(projectId: string, revisionId: string, userId: string | null): Promise<boolean> {
    const policy = await this.findPolicyByResourceReference({ type: 'compose', composeProjectId: projectId });
    if (!policy || policy.mode === 'single') return false;
    await this.licensePolicy.requireFeature('multi-node-availability');
    const [revision] = await this.db
      .select()
      .from(dockerComposeRevisions)
      .where(and(eq(dockerComposeRevisions.id, revisionId), eq(dockerComposeRevisions.projectId, projectId)))
      .limit(1);
    if (!revision) throw new AppError(404, 'COMPOSE_REVISION_NOT_FOUND', 'Compose revision not found');
    const normalizedModel = JSON.parse(JSON.stringify(revision.normalizedModel)) as Record<string, any>;
    const services = Object.values(normalizedModel.services ?? {}) as Array<Record<string, any>>;
    if (
      Object.keys(normalizedModel.volumes ?? {}).length > 0 ||
      services.some((service) => (service.volumes?.length ?? 0) > 0)
    ) {
      throw new AppError(
        409,
        'AVAILABILITY_MOUNTS_UNSUPPORTED',
        'Compose projects with Availability cannot use volumes or mounts'
      );
    }
    const portableSpec = {
      revisionId: revision.id,
      configDigest: revision.configDigest,
      yaml: removeComposePublishedPortsForAvailability(revision.originalYaml),
      normalizedModel,
      variables: revision.variables,
      secretKeys: revision.secretKeys,
    };
    const specFingerprint = createHash('sha256').update(JSON.stringify(portableSpec)).digest('hex');
    const operationId = await this.queueCanonicalRollout(
      policy.id,
      {
        portableSpec,
        specFingerprint,
        imageReference: policy.imageReference,
        composeRevisionId: revision.id,
        shouldRun: policy.shouldRun,
      },
      userId,
      'compose_revision'
    );
    if (operationId) await this.waitForOperationCompletion(operationId);
    await this.db
      .update(dockerComposeProjects)
      .set({ activeRevisionId: revision.id, status: 'running', updatedById: userId, updatedAt: new Date() })
      .where(eq(dockerComposeProjects.id, projectId));
    return true;
  }

  async setComposeRunning(
    projectId: string,
    running: boolean,
    userId: string | null,
    restart = false
  ): Promise<boolean> {
    const policy = await this.findPolicyByResourceReference({ type: 'compose', composeProjectId: projectId });
    if (!policy || policy.mode === 'single') return false;
    await this.licensePolicy.requireFeature('multi-node-availability');
    await this.queueLifecycle(policy.id, restart ? 'restart' : running ? 'start' : 'stop', userId);
    return true;
  }

  private async queueLifecycle(policyId: string, type: 'start' | 'stop' | 'restart', userId: string | null) {
    const operation = await this.db.transaction(async (tx) => {
      await this.lockPolicy(tx, policyId);
      const policy = await this.requirePolicy(policyId, tx);
      if (policy.mode === 'single') return null;
      await this.supersedeQueuedOperations(tx, policyId);
      // Lifecycle changes do not change the spec or immutable runtime labels.
      // The operation lease serializes commands within this same generation.
      const [lastRollout] =
        type === 'stop'
          ? []
          : await tx
              .select()
              .from(dockerAvailabilityOperations)
              .where(
                and(
                  eq(dockerAvailabilityOperations.policyId, policyId),
                  eq(dockerAvailabilityOperations.type, 'rollout')
                )
              )
              .orderBy(desc(dockerAvailabilityOperations.createdAt), desc(dockerAvailabilityOperations.id))
              .limit(1);
      // Scaling/healing may already have superseded this rollout's generation.
      // Recover only pending configuration belonging to the current policy.
      const applyDeferred = Boolean(
        lastRollout &&
          lastRollout.targetGeneration === policy.desiredGeneration &&
          (lastRollout.requestedPolicy.deferredUntilStart === true || lastRollout.status !== 'completed')
      );
      const generation = policy.desiredGeneration + (applyDeferred ? 1 : 0);
      const deferredSlot =
        applyDeferred && policy.resourceKind === 'deployment'
          ? policy.portableSpec.activeSlot === 'green'
            ? 'blue'
            : 'green'
          : undefined;
      const deferredSpec = deferredSlot ? { ...policy.portableSpec, activeSlot: deferredSlot } : undefined;
      await tx
        .update(dockerAvailabilityOperations)
        .set({
          status: 'cancelled',
          phase: 'done',
          errorCode: 'AVAILABILITY_OPERATION_SUPERSEDED',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(dockerAvailabilityOperations.policyId, policyId),
            inArray(dockerAvailabilityOperations.type, ['start', 'stop', 'restart']),
            eq(dockerAvailabilityOperations.status, 'failed')
          )
        );
      await tx
        .update(dockerAvailabilityPolicies)
        .set({
          shouldRun: type !== 'stop',
          status: 'rolling_out',
          ...(applyDeferred ? { desiredGeneration: generation } : {}),
          ...(deferredSpec
            ? {
                portableSpec: deferredSpec,
                specFingerprint: createHash('sha256').update(JSON.stringify(deferredSpec)).digest('hex'),
              }
            : {}),
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedById: userId,
          updatedAt: new Date(),
        })
        .where(eq(dockerAvailabilityPolicies.id, policyId));
      if (policy.composeProjectId) {
        await tx
          .update(dockerComposeProjects)
          .set({
            desiredState: type === 'stop' ? 'stopped' : 'running',
            updatedById: userId,
            updatedAt: new Date(),
          })
          .where(eq(dockerComposeProjects.id, policy.composeProjectId));
      }
      return this.insertOperation(tx, {
        policyId,
        type: applyDeferred ? 'rollout' : type,
        targetGeneration: generation,
        userId,
        ...(applyDeferred
          ? {
              requestedPolicy: {
                ...lastRollout!.requestedPolicy,
                deferredUntilStart: false,
                source: `${type}_deferred_configuration`,
                ...(deferredSlot ? { targetActiveSlot: deferredSlot } : {}),
              },
            }
          : {}),
        idempotencyKey: `availability:${type}:${policyId}:${randomUUID()}`,
      });
    });
    if (!operation) return null;
    if (userId)
      await this.recordMutation('updated', policyId, userId, { source: type, generation: operation.targetGeneration });
    this.publishPolicy(policyId, `${type}_queued`);
    this.kick();
    return operation.id;
  }

  private async queueCanonicalRollout(
    policyId: string,
    resource: Pick<PolicyRow, 'portableSpec' | 'specFingerprint' | 'imageReference' | 'shouldRun'> & {
      composeRevisionId?: string | null;
    },
    userId: string | null,
    reason: string,
    requestedPolicy: Record<string, unknown> = {}
  ): Promise<string | null> {
    const queued = await this.db.transaction(async (tx) => {
      await this.lockPolicy(tx, policyId);
      const policy = await this.requirePolicy(policyId, tx);
      if (policy.mode === 'single') return null;
      await this.supersedeQueuedOperations(tx, policyId);
      const nextGeneration = policy.desiredGeneration + 1;
      await tx
        .update(dockerAvailabilityPolicies)
        .set({
          ...resource,
          shouldRun: policy.shouldRun,
          desiredGeneration: nextGeneration,
          status: 'rolling_out',
          lastErrorCode: null,
          lastErrorMessage: null,
          ...(userId ? { updatedById: userId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(dockerAvailabilityPolicies.id, policyId));
      const operation = await this.insertOperation(tx, {
        policyId,
        type: 'rollout',
        targetGeneration: nextGeneration,
        requestedPolicy: { source: reason, ...requestedPolicy, deferredUntilStart: !policy.shouldRun },
        ...(userId ? { userId } : {}),
        idempotencyKey: `availability:${reason}:${policyId}:${nextGeneration}`,
      });
      return { generation: nextGeneration, operationId: operation.id };
    });
    if (queued === null) return null;
    if (userId) {
      await this.recordMutation('updated', policyId, userId, { generation: queued.generation, source: reason });
    } else {
      this.publishPolicy(policyId, `${reason}_rollout_queued`);
    }
    this.kick();
    return queued.operationId;
  }

  async get(policyId: string, scopes: string[]) {
    const policy = await this.requirePolicy(policyId);
    const resource = await this.resolvePolicyResource(policy);
    this.assertResourceAccess(scopes, resource, 'view');
    return this.policyView(policy);
  }

  private async activeLifecycleTypes(policies: PolicyRow[]): Promise<Map<string, 'start' | 'stop' | 'restart'>> {
    const operations = await this.db
      .select({
        policyId: dockerAvailabilityOperations.policyId,
        type: dockerAvailabilityOperations.type,
        targetGeneration: dockerAvailabilityOperations.targetGeneration,
      })
      .from(dockerAvailabilityOperations)
      .where(
        and(
          inArray(
            dockerAvailabilityOperations.policyId,
            policies.map((policy) => policy.id)
          ),
          inArray(dockerAvailabilityOperations.type, ['start', 'stop', 'restart']),
          inArray(dockerAvailabilityOperations.status, ['pending', 'running', 'waiting'])
        )
      )
      .orderBy(desc(dockerAvailabilityOperations.createdAt), desc(dockerAvailabilityOperations.id));
    const generations = new Map(policies.map((policy) => [policy.id, policy.desiredGeneration]));
    const result = new Map<string, 'start' | 'stop' | 'restart'>();
    for (const operation of operations) {
      if (result.has(operation.policyId) || operation.targetGeneration !== generations.get(operation.policyId))
        continue;
      if (operation.type === 'start' || operation.type === 'stop' || operation.type === 'restart') {
        result.set(operation.policyId, operation.type);
      }
    }
    return result;
  }

  async listContainerSurfaceStates(
    nodeId: string,
    resources: Array<{ name: string; deploymentId?: string | null }>
  ): Promise<Record<string, DockerAvailabilityLogicalState>> {
    const containerNames = resources.filter((item) => !item.deploymentId).map((item) => item.name);
    const deploymentIds = resources.map((item) => item.deploymentId).filter((value): value is string => Boolean(value));
    const [containerPolicies, deploymentPolicies] = await Promise.all([
      containerNames.length
        ? this.db
            .select()
            .from(dockerAvailabilityPolicies)
            .where(
              and(
                eq(dockerAvailabilityPolicies.resourceKind, 'container'),
                eq(dockerAvailabilityPolicies.sourceNodeId, nodeId),
                inArray(dockerAvailabilityPolicies.containerName, containerNames),
                inArray(dockerAvailabilityPolicies.mode, ['replicated', 'failover'])
              )
            )
        : Promise.resolve([] as PolicyRow[]),
      deploymentIds.length
        ? this.db
            .select()
            .from(dockerAvailabilityPolicies)
            .where(
              and(
                eq(dockerAvailabilityPolicies.resourceKind, 'deployment'),
                inArray(dockerAvailabilityPolicies.deploymentId, deploymentIds),
                inArray(dockerAvailabilityPolicies.mode, ['replicated', 'failover'])
              )
            )
        : Promise.resolve([] as PolicyRow[]),
    ]);
    const policies = [...containerPolicies, ...deploymentPolicies];
    if (policies.length === 0) return {};
    const lifecycleTypes = await this.activeLifecycleTypes(policies);
    const placements = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(
        inArray(
          dockerAvailabilityPlacements.policyId,
          policies.map((policy) => policy.id)
        )
      );
    const result: Record<string, DockerAvailabilityLogicalState> = {};
    for (const policy of policies) {
      const policyPlacements = placements.filter((placement) => placement.policyId === policy.id);
      const serving = policyPlacements.filter(
        (placement) => placement.serving && placement.actualState === 'serving'
      ).length;
      const desired = policy.mode === 'replicated' ? policy.desiredReplicaCount : 1;
      const { status, healthStatus } = resolveAvailabilityLogicalSurfaceState(
        policy.status,
        serving,
        desired,
        policy.shouldRun,
        lifecycleTypes.get(policy.id)
      );
      const key =
        policy.resourceKind === 'deployment'
          ? `deployment:${policy.deploymentId}`
          : `container:${policy.containerName}`;
      const configuredSourceImage = policySourceImageReference(policy);
      const sourceImageReference =
        configuredSourceImage ?? (await this.resolveCanonicalSourceImage(policy, '')) ?? undefined;
      result[key] = {
        stopped: policy.shouldRun === false,
        status,
        healthStatus,
        serving,
        desired,
        sourceImageReference,
      };
    }
    return result;
  }

  async listComposeSurfaceStates(projectIds: string[]): Promise<Record<string, DockerAvailabilityLogicalState>> {
    if (projectIds.length === 0) return {};
    const policies = await this.db
      .select()
      .from(dockerAvailabilityPolicies)
      .where(
        and(
          eq(dockerAvailabilityPolicies.resourceKind, 'compose'),
          inArray(dockerAvailabilityPolicies.composeProjectId, projectIds),
          inArray(dockerAvailabilityPolicies.mode, ['replicated', 'failover'])
        )
      );
    if (policies.length === 0) return {};
    const lifecycleTypes = await this.activeLifecycleTypes(policies);
    const placements = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(
        inArray(
          dockerAvailabilityPlacements.policyId,
          policies.map((policy) => policy.id)
        )
      );
    const result: Record<string, DockerAvailabilityLogicalState> = {};
    for (const policy of policies) {
      const serving = placements.filter(
        (placement) => placement.policyId === policy.id && placement.serving && placement.actualState === 'serving'
      ).length;
      const desired = policy.mode === 'replicated' ? policy.desiredReplicaCount : 1;
      const { status, healthStatus } = resolveAvailabilityLogicalSurfaceState(
        policy.status,
        serving,
        desired,
        policy.shouldRun,
        lifecycleTypes.get(policy.id)
      );
      result[policy.composeProjectId!] = {
        stopped: policy.shouldRun === false,
        status,
        healthStatus,
        serving,
        desired,
        sourceImageReference: policySourceImageReference(policy),
        serviceCount: policyComposeServiceCount(policy),
        runningServiceCount: serving > 0 ? policyComposeServiceCount(policy) : 0,
      };
    }
    return result;
  }

  async listOperations(policyId: string, scopes: string[]) {
    const policy = await this.requirePolicy(policyId);
    const resource = await this.resolvePolicyResource(policy);
    this.assertResourceAccess(scopes, resource, 'view');
    return this.db
      .select()
      .from(dockerAvailabilityOperations)
      .where(eq(dockerAvailabilityOperations.policyId, policyId))
      .orderBy(desc(dockerAvailabilityOperations.createdAt));
  }

  async listOperationsPage(policyId: string, scopes: string[], page: number, limit: number) {
    const policy = await this.requirePolicy(policyId);
    const resource = await this.resolvePolicyResource(policy);
    this.assertResourceAccess(scopes, resource, 'view');
    const rows = await this.db
      .select()
      .from(dockerAvailabilityOperations)
      .where(eq(dockerAvailabilityOperations.policyId, policyId))
      .orderBy(desc(dockerAvailabilityOperations.createdAt))
      .limit(limit + 1)
      .offset((page - 1) * limit);
    return {
      data: rows.slice(0, limit),
      nextPage: rows.length > limit ? page + 1 : null,
    };
  }

  async update(policyId: string, input: DockerAvailabilityPolicyUpdateInput, userId: string, scopes: string[]) {
    await this.licensePolicy.requireFeature('multi-node-availability');
    const current = await this.requirePolicy(policyId);
    const resource = await this.resolvePolicyResource(current);
    this.assertResourceAccess(scopes, resource, 'manage');
    if (current.mode === 'single') throw new AppError(409, 'AVAILABILITY_NOT_ENABLED', 'Availability is not enabled');
    const proposed: DockerAvailabilityPolicyInput = {
      resource: resource.reference,
      mode: input.mode ?? (current.mode as 'replicated' | 'failover'),
      desiredReplicaCount: input.desiredReplicaCount ?? current.desiredReplicaCount,
      nodeSelectionMode: input.nodeSelectionMode ?? current.nodeSelectionMode,
      selectedNodeIds: input.selectedNodeIds ?? current.selectedNodeIds,
      rolloutPolicy: input.rolloutPolicy ?? current.rolloutPolicy,
      offlineReplacementGraceSeconds: input.offlineReplacementGraceSeconds ?? current.offlineReplacementGraceSeconds,
    };
    const preflight = await this.preflight(proposed, scopes);
    if (!preflight.eligible) {
      throw new AppError(409, 'AVAILABILITY_PREFLIGHT_BLOCKED', 'Multi-node Availability preflight has blockers', {
        blockers: preflight.blockers,
      });
    }
    const normalized = this.normalizePolicyInput(proposed);
    const updated = await this.db.transaction(async (tx) => {
      await this.lockPolicy(tx, policyId);
      const fresh = await this.requirePolicy(policyId, tx);
      await this.supersedeQueuedOperations(tx, policyId);
      const generation = fresh.desiredGeneration + 1;
      const [policy] = await tx
        .update(dockerAvailabilityPolicies)
        .set({
          ...this.resourceColumns(resource),
          ...normalized,
          desiredGeneration: generation,
          status: 'scaling',
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedById: userId,
          updatedAt: new Date(),
        })
        .where(eq(dockerAvailabilityPolicies.id, policyId))
        .returning();
      await this.insertOperation(tx, {
        policyId,
        type: 'scale',
        targetGeneration: generation,
        requestedPolicy: normalized,
        userId,
        idempotencyKey: `availability:scale:${policyId}:${generation}`,
      });
      return policy;
    });
    if (!updated) throw new Error('Availability policy update failed');
    await this.recordMutation('updated', policyId, userId, { generation: updated.desiredGeneration });
    this.kick();
    return this.policyView(updated);
  }

  async disable(policyId: string, input: DockerAvailabilityDisableInput, userId: string, scopes: string[]) {
    const policy = await this.requirePolicy(policyId);
    const resource = await this.resolvePolicyResource(policy);
    this.assertResourceAccess(scopes, resource, 'manage');
    if (policy.mode === 'single') return this.policyView(policy);
    if (input.confirmation !== resource.displayName) {
      throw new AppError(400, 'AVAILABILITY_CONFIRMATION_MISMATCH', 'Confirmation does not match the resource name');
    }
    const [survivor] = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(
        and(
          eq(dockerAvailabilityPlacements.id, input.survivingPlacementId),
          eq(dockerAvailabilityPlacements.policyId, policyId)
        )
      )
      .limit(1);
    if (!survivor || !this.disableSurvivorIsValid(policy, survivor)) {
      throw new AppError(409, 'AVAILABILITY_SURVIVOR_INVALID', 'Select a healthy reachable placement to keep');
    }
    const updated = await this.db.transaction(async (tx) => {
      await this.lockPolicy(tx, policyId);
      const fresh = await this.requirePolicy(policyId, tx);
      await this.supersedeQueuedOperations(tx, policyId);
      const generation = fresh.desiredGeneration + 1;
      const [next] = await tx
        .update(dockerAvailabilityPolicies)
        .set({ status: 'disabling', desiredGeneration: generation, updatedById: userId, updatedAt: new Date() })
        .where(eq(dockerAvailabilityPolicies.id, policyId))
        .returning();
      await this.insertOperation(tx, {
        policyId,
        type: 'disable',
        targetGeneration: generation,
        requestedPolicy: { survivingPlacementId: survivor.id },
        userId,
        idempotencyKey: `availability:disable:${policyId}:${generation}`,
      });
      return next;
    });
    if (!updated) throw new Error('Availability disable operation was not persisted');
    await this.recordMutation('disable_requested', policyId, userId, { survivingPlacementId: survivor.id });
    this.kick();
    return this.policyView(updated);
  }

  async retryOperation(policyId: string, operationId: string, userId: string, scopes: string[]) {
    const policy = await this.requirePolicy(policyId);
    const resource = await this.resolvePolicyResource(policy);
    this.assertResourceAccess(scopes, resource, 'manage');
    const [failed] = await this.db
      .select()
      .from(dockerAvailabilityOperations)
      .where(and(eq(dockerAvailabilityOperations.id, operationId), eq(dockerAvailabilityOperations.policyId, policyId)))
      .limit(1);
    if (!failed || !['failed', 'cleanup_pending', 'waiting'].includes(failed.status)) {
      throw new AppError(409, 'AVAILABILITY_OPERATION_NOT_RETRYABLE', 'Availability operation cannot be retried');
    }
    if (failed.targetGeneration < policy.desiredGeneration) {
      throw new AppError(
        409,
        'AVAILABILITY_OPERATION_SUPERSEDED',
        'A newer Availability generation superseded this operation'
      );
    }
    if (
      !['disable', 'stale_cleanup'].includes(failed.type) &&
      !(await this.licensePolicy.hasFeature('multi-node-availability'))
    ) {
      throw new AppError(
        403,
        'AVAILABILITY_ENTITLEMENT_REQUIRED_FOR_RETRY',
        'Restoring or changing Availability requires Business or Enterprise'
      );
    }
    if (failed.status === 'waiting') {
      const retry = await this.db.transaction(async (tx) => {
        await this.lockPolicy(tx, policyId);
        const [otherActive] = await tx
          .select({ id: dockerAvailabilityOperations.id })
          .from(dockerAvailabilityOperations)
          .where(
            and(
              eq(dockerAvailabilityOperations.policyId, policyId),
              ne(dockerAvailabilityOperations.id, failed.id),
              inArray(dockerAvailabilityOperations.status, ['pending', 'waiting', 'running'])
            )
          )
          .limit(1);
        if (otherActive) {
          throw new AppError(409, 'AVAILABILITY_OPERATION_ACTIVE', 'Wait for the active Availability operation');
        }
        const [updated] = await tx
          .update(dockerAvailabilityOperations)
          .set({
            status: 'pending',
            errorCode: null,
            errorMessage: null,
            retryAttempts: 0,
            nextAttemptAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(eq(dockerAvailabilityOperations.id, failed.id), eq(dockerAvailabilityOperations.status, 'waiting'))
          )
          .returning();
        if (!updated) {
          throw new AppError(409, 'AVAILABILITY_OPERATION_NOT_RETRYABLE', 'Availability operation cannot be retried');
        }
        return updated;
      });
      this.kick();
      return retry;
    }
    if (failed.type === 'rollout' && failed.requestedPolicy.isRollback !== true) {
      const retry = await this.db.transaction(async (tx) => {
        await this.lockPolicy(tx, policyId);
        const [active] = await tx
          .select({ id: dockerAvailabilityOperations.id })
          .from(dockerAvailabilityOperations)
          .where(
            and(
              eq(dockerAvailabilityOperations.policyId, policyId),
              inArray(dockerAvailabilityOperations.status, ['pending', 'waiting', 'running'])
            )
          )
          .limit(1);
        if (active) {
          throw new AppError(409, 'AVAILABILITY_OPERATION_ACTIVE', 'Wait for the active Availability operation');
        }
        const latest = await this.requirePolicy(policyId, tx);
        const generation = latest.desiredGeneration + 1;
        await tx
          .update(dockerAvailabilityPolicies)
          .set({
            desiredGeneration: generation,
            status: 'rolling_out',
            lastErrorCode: null,
            lastErrorMessage: null,
            updatedById: userId,
            updatedAt: new Date(),
          })
          .where(eq(dockerAvailabilityPolicies.id, policyId));
        return this.insertOperation(
          tx,
          {
            policyId,
            type: 'rollout',
            targetGeneration: generation,
            requestedPolicy: {
              specFingerprint: latest.specFingerprint,
              rollbackResource: failed.requestedPolicy.rollbackResource,
            },
            userId,
            idempotencyKey: `availability:retry-rollout:${failed.id}:${generation}`,
          },
          failed.id
        );
      });
      this.kick();
      return retry;
    }
    const retry = await this.db.transaction(async (tx) => {
      await this.lockPolicy(tx, policyId);
      const [active] = await tx
        .select({ id: dockerAvailabilityOperations.id })
        .from(dockerAvailabilityOperations)
        .where(
          and(
            eq(dockerAvailabilityOperations.policyId, policyId),
            inArray(dockerAvailabilityOperations.status, ['pending', 'waiting', 'running'])
          )
        )
        .limit(1);
      if (active) {
        throw new AppError(409, 'AVAILABILITY_OPERATION_ACTIVE', 'Wait for the active Availability operation');
      }
      return this.insertOperation(
        tx,
        {
          policyId,
          type: failed.type,
          targetGeneration: failed.targetGeneration,
          requestedPolicy: failed.requestedPolicy,
          userId,
          idempotencyKey: `availability:retry:${failed.id}:${randomUUID()}`,
        },
        failed.id
      );
    });
    this.kick();
    return retry;
  }

  async recoverInterruptedOperations(): Promise<void> {
    const now = new Date();
    await this.db
      .update(dockerAvailabilityOperations)
      .set({
        status: 'pending',
        leaseOwner: null,
        leaseHeartbeatAt: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        updatedAt: now,
      })
      .where(eq(dockerAvailabilityOperations.status, 'running'));
    this.kick();
  }

  async processPendingOperations(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.reconcileResourceDrift();
      const operations = await this.db
        .select({ id: dockerAvailabilityOperations.id })
        .from(dockerAvailabilityOperations)
        .where(
          or(
            eq(dockerAvailabilityOperations.status, 'pending'),
            and(
              eq(dockerAvailabilityOperations.status, 'waiting'),
              or(
                isNull(dockerAvailabilityOperations.nextAttemptAt),
                lt(dockerAvailabilityOperations.nextAttemptAt, new Date())
              )
            )
          )
        )
        .orderBy(asc(dockerAvailabilityOperations.createdAt))
        .limit(MAX_OPERATION_BATCH);
      for (const operation of operations) {
        await this.processOperation(operation.id).catch((error) => {
          logger.error('Docker Availability operation failed', { operationId: operation.id, error });
        });
      }
      await this.scheduleNextWaitingOperation();
    } finally {
      this.processing = false;
    }
  }

  private async scheduleNextWaitingOperation(): Promise<void> {
    if (this.waitingRetryTimer) clearTimeout(this.waitingRetryTimer);
    this.waitingRetryTimer = undefined;
    const [next] = await this.db
      .select({ nextAttemptAt: dockerAvailabilityOperations.nextAttemptAt })
      .from(dockerAvailabilityOperations)
      .where(
        and(eq(dockerAvailabilityOperations.status, 'waiting'), isNotNull(dockerAvailabilityOperations.nextAttemptAt))
      )
      .orderBy(asc(dockerAvailabilityOperations.nextAttemptAt))
      .limit(1);
    if (!next?.nextAttemptAt) return;
    const delayMs = Math.max(0, next.nextAttemptAt.getTime() - Date.now());
    this.waitingRetryTimer = setTimeout(() => {
      this.waitingRetryTimer = undefined;
      this.kick();
    }, delayMs);
  }

  private async reconcileResourceDrift(): Promise<void> {
    const policies = await this.db
      .select()
      .from(dockerAvailabilityPolicies)
      .where(inArray(dockerAvailabilityPolicies.mode, ['replicated', 'failover']));
    for (const policy of policies) {
      try {
        // Every Availability runtime is controller-owned and may use mirrored
        // images, generated labels, and placement-local networking. Treating
        // that runtime as desired-state input creates self-induced rollout
        // loops. Container/deployment edits and Compose revisions explicitly
        // call the Availability coordinator instead.
        if (!shouldReconcileAvailabilityResourceDrift(policy.resourceKind)) continue;
        const [active] = await this.db
          .select({ id: dockerAvailabilityOperations.id })
          .from(dockerAvailabilityOperations)
          .where(
            and(
              eq(dockerAvailabilityOperations.policyId, policy.id),
              inArray(dockerAvailabilityOperations.status, ['pending', 'waiting', 'running'])
            )
          )
          .limit(1);
        if (active) continue;
        const current = await this.requireAdapter(policy.resourceKind).resolve(this.policyResourceReference(policy));
        if (
          current.specFingerprint === policy.specFingerprint &&
          (current.composeRevisionId ?? null) === (policy.composeRevisionId ?? null)
        ) {
          continue;
        }
        if (!(await this.licensePolicy.hasFeature('multi-node-availability'))) {
          await this.refreshPolicyStatus(
            policy.id,
            'AVAILABILITY_ENTITLEMENT_REQUIRED_FOR_ROLLOUT',
            'A workload update is waiting because Availability is no longer licensed'
          );
          continue;
        }
        await this.db.transaction(async (tx) => {
          await this.lockPolicy(tx, policy.id);
          const latest = await this.requirePolicy(policy.id, tx);
          if (latest.specFingerprint === current.specFingerprint) return;
          const generation = latest.desiredGeneration + 1;
          await tx
            .update(dockerAvailabilityPolicies)
            .set({
              ...this.resourceColumns(current),
              desiredGeneration: generation,
              status: 'rolling_out',
              lastErrorCode: null,
              lastErrorMessage: null,
              updatedAt: new Date(),
            })
            .where(eq(dockerAvailabilityPolicies.id, policy.id));
          await this.insertOperation(tx, {
            policyId: policy.id,
            type: 'rollout',
            targetGeneration: generation,
            requestedPolicy: {
              specFingerprint: current.specFingerprint,
              rollbackResource: {
                specFingerprint: latest.specFingerprint,
                portableSpec: latest.portableSpec,
                imageReference: latest.imageReference,
                composeRevisionId: latest.composeRevisionId,
              },
            },
            idempotencyKey: `availability:rollout:${policy.id}:${generation}`,
          });
        });
        this.publishPolicy(policy.id, 'rollout_queued');
      } catch (error) {
        logger.warn('Failed to inspect Docker Availability resource drift', { policyId: policy.id, error });
      }
    }
  }

  async reconcileNode(nodeId: string): Promise<void> {
    const placements = await this.db
      .select({ policyId: dockerAvailabilityPlacements.policyId })
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.nodeId, nodeId));
    for (const policyId of new Set(placements.map((placement) => placement.policyId))) {
      await this.queueHealIfNeeded(policyId);
    }
    this.kick();
  }

  async assertContainerMutationAllowed(nodeId: string, containerName: string): Promise<void> {
    const [placement] = await this.db
      .select({ id: dockerAvailabilityPlacements.id })
      .from(dockerAvailabilityPlacements)
      .innerJoin(dockerAvailabilityPolicies, eq(dockerAvailabilityPolicies.id, dockerAvailabilityPlacements.policyId))
      .where(
        and(
          eq(dockerAvailabilityPlacements.nodeId, nodeId),
          eq(dockerAvailabilityPolicies.resourceKind, 'container'),
          eq(dockerAvailabilityPolicies.containerName, containerName),
          inArray(dockerAvailabilityPolicies.mode, ['replicated', 'failover']),
          inArray(dockerAvailabilityPlacements.actualState, [
            'pending',
            'preparing_image',
            'preparing_dependencies',
            'starting',
            'checking_health',
            'ready',
            'serving',
            'draining',
            'stopped',
            'unreachable',
            'stale',
            'failed',
            'cleanup_pending',
          ])
        )
      )
      .limit(1);
    if (placement) {
      throw new AppError(
        409,
        'AVAILABILITY_PLACEMENT_MANAGED',
        'This container is controlled by Availability. Update or disable the logical workload instead.'
      );
    }
  }

  private async processOperation(operationId: string): Promise<void> {
    const leaseOwner = randomUUID();
    const claimed = await this.db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(dockerAvailabilityOperations)
        .where(eq(dockerAvailabilityOperations.id, operationId))
        .limit(1);
      if (!operation || !['pending', 'waiting'].includes(operation.status)) return null;
      await this.lockPolicy(tx, operation.policyId);
      const [current] = await tx
        .select()
        .from(dockerAvailabilityOperations)
        .where(eq(dockerAvailabilityOperations.id, operationId))
        .limit(1);
      if (!current || !['pending', 'waiting'].includes(current.status)) return null;
      const currentPolicy = await this.requirePolicy(current.policyId, tx);
      if (current.targetGeneration < currentPolicy.desiredGeneration) {
        await tx
          .update(dockerAvailabilityOperations)
          .set({
            status: 'cancelled',
            phase: 'done',
            errorCode: 'AVAILABILITY_OPERATION_SUPERSEDED',
            errorMessage: null,
            nextAttemptAt: null,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(dockerAvailabilityOperations.id, current.id),
              inArray(dockerAvailabilityOperations.status, ['pending', 'waiting'])
            )
          );
        return null;
      }
      const [otherRunning] = await tx
        .select({ id: dockerAvailabilityOperations.id })
        .from(dockerAvailabilityOperations)
        .where(
          and(
            eq(dockerAvailabilityOperations.policyId, current.policyId),
            eq(dockerAvailabilityOperations.status, 'running')
          )
        )
        .limit(1);
      if (otherRunning) return null;
      const expiresAt = new Date(Date.now() + OPERATION_LEASE_MS);
      const [next] = await tx
        .update(dockerAvailabilityOperations)
        .set({
          status: 'running',
          phase: 'locking',
          leaseOwner,
          leaseHeartbeatAt: new Date(),
          leaseExpiresAt: expiresAt,
          startedAt: operation.startedAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(dockerAvailabilityOperations.id, operation.id),
            inArray(dockerAvailabilityOperations.status, ['pending', 'waiting'])
          )
        )
        .returning();
      return next;
    });
    if (!claimed) return;
    this.activeLeases.set(claimed.id, leaseOwner);
    try {
      if (
        !['disable', 'stale_cleanup'].includes(claimed.type) &&
        !(await this.licensePolicy.hasFeature('multi-node-availability'))
      ) {
        throw new AppError(
          403,
          'AVAILABILITY_ENTITLEMENT_REQUIRED_FOR_EXECUTION',
          'Executing Availability changes requires Business or Enterprise',
          { retryable: true }
        );
      }
      if (claimed.type === 'disable') await this.executeDisable(claimed);
      else if (claimed.type === 'stale_cleanup') await this.executeStaleCleanup(claimed);
      else if (['start', 'stop', 'restart'].includes(claimed.type)) await this.executeLifecycle(claimed);
      else await this.executeReconcile(claimed);
      if (claimed.type === 'rollout' && claimed.requestedPolicy.deferredUntilStart === false) {
        const policy = await this.requirePolicy(claimed.policyId);
        const slot = claimed.requestedPolicy.targetActiveSlot;
        if (policy.shouldRun && policy.deploymentId) {
          if (slot === 'blue' || slot === 'green') {
            await this.db
              .update(dockerDeployments)
              .set({ activeSlot: slot, updatedAt: new Date() })
              .where(eq(dockerDeployments.id, policy.deploymentId));
          }
          await this.completeLifecycleSnapshots(policy, true);
          if (typeof claimed.requestedPolicy.deploymentReleaseId === 'string') {
            await this.db
              .update(dockerDeploymentReleases)
              .set({ status: 'succeeded', error: null, completedAt: new Date() })
              .where(eq(dockerDeploymentReleases.id, claimed.requestedPolicy.deploymentReleaseId));
          }
        }
      }
      if (!['start', 'stop', 'restart'].includes(claimed.type))
        await this.artifacts?.releaseObsoletePins(claimed.policyId).catch((error) => {
          logger.warn('Availability artifact pins will be reconciled by scheduled cleanup', {
            policyId: claimed.policyId,
            error,
          });
        });
      await this.db
        .update(dockerAvailabilityOperations)
        .set({
          status: 'completed',
          phase: 'done',
          leaseOwner: null,
          leaseHeartbeatAt: null,
          leaseExpiresAt: null,
          errorCode: null,
          errorMessage: null,
          retryAttempts: 0,
          nextAttemptAt: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(eq(dockerAvailabilityOperations.id, claimed.id), eq(dockerAvailabilityOperations.leaseOwner, leaseOwner))
        );
      this.events.publish('docker.availability.operation.changed', {
        policyId: claimed.policyId,
        operationId: claimed.id,
        action: 'completed',
      });
    } catch (error) {
      const normalized = this.normalizeError(error);
      const retryAttempts = claimed.retryAttempts + 1;
      const retryDelayMs = Math.min(WAITING_RETRY_MAX_MS, WAITING_RETRY_BASE_MS * 2 ** (retryAttempts - 1));
      await this.db
        .update(dockerAvailabilityOperations)
        .set({
          status: normalized.retryable ? 'waiting' : 'failed',
          errorCode: normalized.code,
          errorMessage: normalized.message,
          retryAttempts,
          nextAttemptAt: normalized.retryable ? new Date(Date.now() + retryDelayMs) : null,
          leaseOwner: null,
          leaseHeartbeatAt: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(eq(dockerAvailabilityOperations.id, claimed.id), eq(dockerAvailabilityOperations.leaseOwner, leaseOwner))
        );
      await this.refreshPolicyStatus(claimed.policyId, normalized.code, normalized.message);
      throw error;
    } finally {
      if (this.activeLeases.get(claimed.id) === leaseOwner) this.activeLeases.delete(claimed.id);
    }
  }

  private async executeReconcile(operation: OperationRow): Promise<void> {
    const policy = await this.requirePolicy(operation.policyId);
    const policyResource = await this.resolvePolicyResource(policy);
    let resource = this.operationResourceOverride(operation, policyResource) ?? policyResource;
    const isRollback = operation.requestedPolicy.isRollback === true;
    const adapter = this.requireAdapter(policy.resourceKind);
    if (operation.type === 'heal' && operation.requestedPolicy.cleanupOnly === true && resource.running) {
      const placements = await this.db
        .select()
        .from(dockerAvailabilityPlacements)
        .where(eq(dockerAvailabilityPlacements.policyId, policy.id))
        .orderBy(asc(dockerAvailabilityPlacements.createdAt));
      const desired = policy.mode === 'replicated' ? policy.desiredReplicaCount : 1;
      const retained = placements
        .filter((placement) =>
          isCurrentServingAvailabilityPlacement(
            placement,
            operation.targetGeneration,
            Boolean(this.nodeRegistry.getNode(placement.nodeId))
          )
        )
        .sort((left, right) => this.placementKeepScore(right, resource) - this.placementKeepScore(left, resource))
        .slice(0, desired);
      // Revalidate capacity under the operation lease. Cleanup of excess members
      // needs no image preparation, restart, or spec/generation changes.
      if (retained.length >= desired) {
        await this.removeSurplusLifecyclePlacements(adapter, resource, policy, operation, placements, retained);
        await this.db
          .update(dockerAvailabilityPolicies)
          .set({
            status: 'healthy',
            lastErrorCode: null,
            lastErrorMessage: null,
            updatedAt: new Date(),
          })
          .where(eq(dockerAvailabilityPolicies.id, policy.id));
        this.publishPolicy(policy.id, 'reconciled');
        return;
      }
    }
    await this.updateOperationPhase(operation.id, 'selecting_nodes');
    const candidates = await this.resolveCandidateNodes(this.policyInput(policy, resource), resource);
    const compatible = candidates.filter((candidate) => candidate.compatible);
    if (!resource.running) {
      await this.executeStoppedReconcile(operation, policy, resource, adapter);
      return;
    }
    if (!this.artifacts) {
      throw new AppError(
        503,
        'AVAILABILITY_IMAGE_DELIVERY_UNAVAILABLE',
        'Internal registry delivery over Secure Links is unavailable',
        { retryable: true }
      );
    }
    await this.updateOperationPhase(operation.id, 'preparing_images');
    const originNodeId = resource.currentNodeId;
    const mirrorNodeId = !this.nodeRegistry.getNode(originNodeId)
      ? compatible.find((candidate) => this.nodeRegistry.getNode(candidate.id))?.id
      : originNodeId;
    if (!mirrorNodeId)
      throw new AppError(
        409,
        'AVAILABILITY_IMAGE_SOURCE_UNAVAILABLE',
        'No compatible online image source is available',
        { retryable: true }
      );
    resource = {
      ...(await this.artifacts.prepare({
        policyId: policy.id,
        generation: operation.targetGeneration,
        resource: mirrorNodeId === originNodeId ? resource : { ...resource, currentNodeId: mirrorNodeId },
        candidateNodes: compatible,
        reuseExistingArtifacts: operation.type === 'heal' || operation.type === 'scale',
      })),
      currentNodeId: originNodeId,
    };
    if (operation.type === 'rollout') {
      await this.executeRollout(operation, policy, resource, adapter, compatible, isRollback);
      return;
    }
    const placements = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.policyId, policy.id))
      .orderBy(asc(dockerAvailabilityPlacements.createdAt));

    for (const placement of placements) {
      if (this.nodeRegistry.getNode(placement.nodeId)) continue;
      if (placement.actualState === 'removed') continue;
      await this.db
        .update(dockerAvailabilityPlacements)
        .set({
          actualState: 'unreachable',
          serving: false,
          unavailableSince: placement.unavailableSince ?? new Date(),
          updatedAt: new Date(),
        })
        .where(eq(dockerAvailabilityPlacements.id, placement.id));
    }

    const observed = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.policyId, policy.id))
      .orderBy(asc(dockerAvailabilityPlacements.createdAt));
    const desired = policy.mode === 'replicated' ? policy.desiredReplicaCount : 1;
    const servingToKeep = new Set(
      observed
        .filter((placement) =>
          isCurrentServingAvailabilityPlacement(
            placement,
            operation.targetGeneration,
            Boolean(this.nodeRegistry.getNode(placement.nodeId))
          )
        )
        .sort((a, b) => this.placementKeepScore(b, resource) - this.placementKeepScore(a, resource))
        .slice(0, desired)
        .map((placement) => placement.id)
    );
    for (const placement of observed) {
      if (!servingToKeep.has(placement.id)) continue;
      await adapter.refreshPlacementDependencies(
        {
          policyId: policy.id,
          placementId: placement.id,
          operationId: operation.id,
          leaseOwner: this.requireActiveLeaseOwner(operation.id),
          nodeId: placement.nodeId,
          generation: placement.generation,
          idempotencyKey: `${operation.idempotencyKey}:${placement.nodeId}:refresh-dependencies`,
          resource,
        },
        {
          acknowledgedGeneration: placement.generation,
          actualState: 'serving',
          serving: true,
          dependencyState: placement.dependencyState,
          applicationHealth: placement.applicationHealth,
          runtimeIdentity: placement.runtimeIdentity,
          imageReference: placement.imageReference ?? undefined,
          composeRevisionId: placement.composeRevisionId ?? undefined,
        }
      );
    }
    const canRemoveExtrasBeforeHealing = servingToKeep.size >= desired;
    for (const placement of observed) {
      if (!this.nodeRegistry.getNode(placement.nodeId)) continue;
      if (placement.actualState === 'draining') {
        if (!canRemoveExtrasBeforeHealing) continue;
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - placement.updatedAt.getTime()) / 1_000));
        await this.removePlacement(
          adapter,
          resource,
          policy,
          operation,
          placement,
          Math.max(0, policy.rolloutPolicy.drainSeconds - elapsedSeconds)
        );
        continue;
      }
      if (['removed', 'cleanup_pending'].includes(placement.actualState)) continue;
      if (canRemoveExtrasBeforeHealing && !servingToKeep.has(placement.id)) {
        await this.removePlacement(
          adapter,
          resource,
          policy,
          operation,
          placement,
          placement.serving ? policy.rolloutPolicy.drainSeconds : 0
        );
        continue;
      }
      if (
        servingToKeep.has(placement.id) &&
        placement.specFingerprint === resource.specFingerprint &&
        (placement.generation === operation.targetGeneration || ['scale', 'heal'].includes(operation.type))
      ) {
        continue;
      }
      if (placement.generation > operation.targetGeneration) continue;
      try {
        const result = await adapter.ensurePlacement({
          policyId: policy.id,
          placementId: placement.id,
          operationId: operation.id,
          leaseOwner: this.requireActiveLeaseOwner(operation.id),
          nodeId: placement.nodeId,
          generation: operation.targetGeneration,
          idempotencyKey: `${operation.idempotencyKey}:${placement.nodeId}:ensure`,
          recovering: !placement.serving || placement.actualState !== 'serving',
          resource,
        });
        await this.persistPlacementResult(placement.id, operation, resource, result);
      } catch (error) {
        const normalized = this.normalizeError(error);
        if (normalized.code === 'AVAILABILITY_PLACEMENT_RETIRED') {
          await this.db.delete(dockerAvailabilityPlacements).where(eq(dockerAvailabilityPlacements.id, placement.id));
          continue;
        }
        await this.db
          .update(dockerAvailabilityPlacements)
          .set({
            actualState: 'failed',
            serving: false,
            dependencyState: 'failed',
            applicationHealth: 'unhealthy',
            lastErrorCode: normalized.code,
            lastErrorMessage: normalized.message,
            operationId: operation.id,
            updatedAt: new Date(),
          })
          .where(eq(dockerAvailabilityPlacements.id, placement.id));
      }
    }

    const refreshed = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.policyId, policy.id))
      .orderBy(asc(dockerAvailabilityPlacements.createdAt));
    const serving = refreshed.filter(
      (placement) =>
        placement.serving && placement.actualState === 'serving' && this.nodeRegistry.getNode(placement.nodeId)
    );

    if (serving.length > desired) {
      await this.updateOperationPhase(operation.id, 'draining');
      const remove = serving
        .slice()
        .sort((a, b) => this.placementKeepScore(b, resource) - this.placementKeepScore(a, resource))
        .slice(desired);
      for (const placement of remove) {
        await this.removePlacement(adapter, resource, policy, operation, placement, policy.rolloutPolicy.drainSeconds);
      }
    }

    const afterScaleDown = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.policyId, policy.id));
    const servingAfterScaleDown = afterScaleDown.filter(
      (placement) =>
        placement.serving && placement.actualState === 'serving' && this.nodeRegistry.getNode(placement.nodeId)
    );
    let missing = desired - servingAfterScaleDown.length;
    if (missing > 0) {
      if (!(await this.licensePolicy.hasFeature('multi-node-availability'))) {
        throw new AppError(
          403,
          'AVAILABILITY_ENTITLEMENT_REQUIRED_FOR_HEALING',
          'Restoring Availability redundancy requires Business or Enterprise',
          { retryable: true }
        );
      }
      await this.updateOperationPhase(operation.id, 'preparing_images');
      const occupied = new Set(
        afterScaleDown.filter((placement) => placement.actualState !== 'removed').map((placement) => placement.nodeId)
      );
      for (const candidate of compatible) {
        if (missing <= 0) break;
        if (occupied.has(candidate.id)) continue;
        const placement = await this.createPlacement(policy, operation, resource, candidate.id);
        occupied.add(candidate.id);
        try {
          await this.updateOperationPhase(operation.id, 'preparing_dependencies');
          const result = await adapter.ensurePlacement({
            policyId: policy.id,
            placementId: placement.id,
            operationId: operation.id,
            leaseOwner: this.requireActiveLeaseOwner(operation.id),
            nodeId: placement.nodeId,
            generation: operation.targetGeneration,
            idempotencyKey: `${operation.idempotencyKey}:${placement.nodeId}`,
            recovering: true,
            resource,
          });
          await this.persistPlacementResult(placement.id, operation, resource, result);
          if (result.serving) missing -= 1;
        } catch (error) {
          const normalized = this.normalizeError(error);
          if (normalized.code === 'AVAILABILITY_PLACEMENT_RETIRED') {
            await this.db.delete(dockerAvailabilityPlacements).where(eq(dockerAvailabilityPlacements.id, placement.id));
            continue;
          }
          await this.db
            .update(dockerAvailabilityPlacements)
            .set({
              actualState: 'failed',
              serving: false,
              dependencyState: 'failed',
              applicationHealth: 'unhealthy',
              lastErrorCode: normalized.code,
              lastErrorMessage: normalized.message,
              updatedAt: new Date(),
            })
            .where(eq(dockerAvailabilityPlacements.id, placement.id));
        }
      }
    }

    let finalPlacements = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.policyId, policy.id));
    const finalServing = finalPlacements.filter(
      (placement) =>
        placement.serving &&
        placement.actualState === 'serving' &&
        this.nodeRegistry.getNode(placement.nodeId) &&
        (placement.generation === operation.targetGeneration ||
          (['scale', 'heal'].includes(operation.type) && placement.specFingerprint === resource.specFingerprint))
    );
    if (finalServing.length < desired) {
      throw new AppError(409, 'AVAILABILITY_CAPACITY_UNAVAILABLE', 'Desired serving placement count is not available', {
        retryable: true,
        desired,
        serving: finalServing.length,
      });
    }

    const finalServingToKeep = new Set(
      finalServing
        .slice()
        .sort((a, b) => this.placementKeepScore(b, resource) - this.placementKeepScore(a, resource))
        .slice(0, desired)
        .map((placement) => placement.id)
    );
    const finalExtras = finalPlacements.filter(
      (placement) => placement.actualState !== 'removed' && !finalServingToKeep.has(placement.id)
    );
    if (finalExtras.length > 0) {
      await this.updateOperationPhase(operation.id, 'cleaning_up');
      for (const placement of finalExtras) {
        await this.removePlacement(
          adapter,
          resource,
          policy,
          operation,
          placement,
          placement.serving ? policy.rolloutPolicy.drainSeconds : 0
        );
      }
      finalPlacements = await this.db
        .select()
        .from(dockerAvailabilityPlacements)
        .where(eq(dockerAvailabilityPlacements.policyId, policy.id));
    }
    await this.db
      .update(dockerAvailabilityPolicies)
      .set({ status: 'healthy', lastErrorCode: null, lastErrorMessage: null, updatedAt: new Date() })
      .where(eq(dockerAvailabilityPolicies.id, policy.id));
    this.publishPolicy(policy.id, 'reconciled');
  }

  private async executeLifecycle(operation: OperationRow): Promise<void> {
    const policy = await this.requirePolicy(operation.policyId);
    const resource = await this.resolvePolicyResource(policy);
    const adapter = this.requireAdapter(policy.resourceKind);
    const phase = operation.type === 'stop' ? 'stopping' : operation.type === 'restart' ? 'restarting' : 'starting';
    await this.updateOperationPhase(operation.id, phase);
    const placements = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.policyId, policy.id))
      .orderBy(asc(dockerAvailabilityPlacements.createdAt));
    const eligible = placements.filter(
      (placement) =>
        placement.desiredState !== 'removed' &&
        !['removed', 'cleanup_pending', 'stale'].includes(placement.actualState) &&
        (operation.type === 'stop' || placement.generation === operation.targetGeneration)
    );
    const desired = policy.mode === 'replicated' ? policy.desiredReplicaCount : 1;
    const targets =
      operation.type === 'stop'
        ? eligible
        : eligible
            .filter((placement) => !['standby', 'draining'].includes(placement.desiredState))
            .sort((left, right) => this.placementKeepScore(right, resource) - this.placementKeepScore(left, resource))
            .slice(0, desired);
    if (targets.length === 0) {
      throw new AppError(
        409,
        'AVAILABILITY_LIFECYCLE_RUNTIME_MISSING',
        'No existing placements are available for this lifecycle operation'
      );
    }
    let unavailable = false;
    for (const placement of targets) {
      if (!this.nodeRegistry.getNode(placement.nodeId)) {
        unavailable = true;
        await this.db
          .update(dockerAvailabilityPlacements)
          .set({
            desiredState: operation.type === 'stop' ? 'stopped' : 'serving',
            actualState: 'unreachable',
            serving: false,
            unavailableSince: placement.unavailableSince ?? new Date(),
            updatedAt: new Date(),
          })
          .where(eq(dockerAvailabilityPlacements.id, placement.id));
        continue;
      }
      if (
        placement.operationId === operation.id &&
        placement.generation === operation.targetGeneration &&
        (operation.type === 'stop'
          ? placement.actualState === 'stopped'
          : placement.serving && placement.actualState === 'serving')
      )
        continue;
      const placementResource = {
        ...resource,
        specFingerprint: placement.specFingerprint,
        imageReference: placement.imageReference ?? resource.imageReference,
        composeRevisionId: placement.composeRevisionId ?? resource.composeRevisionId,
      };
      const context = {
        policyId: policy.id,
        placementId: placement.id,
        operationId: operation.id,
        leaseOwner: this.requireActiveLeaseOwner(operation.id),
        nodeId: placement.nodeId,
        generation: operation.targetGeneration,
        idempotencyKey: `${operation.idempotencyKey}:${placement.id}`,
        resource: placementResource,
        reportProgress: async (_phase: unknown, message: string) => {
          await this.updateOperationPhase(operation.id, phase, { message, activePlacementId: placement.id });
        },
      };
      // Withdraw routes before stopping, and publish only after readiness succeeds.
      if (operation.type !== 'start') {
        const stopped = await adapter.stopPlacement({ ...context, idempotencyKey: `${context.idempotencyKey}:stop` });
        await this.persistPlacementResult(placement.id, operation, placementResource, stopped);
      }
      if (operation.type !== 'stop') {
        const started = await adapter.startPlacement({ ...context, idempotencyKey: `${context.idempotencyKey}:start` });
        await this.persistPlacementResult(placement.id, operation, placementResource, started);
      }
    }
    const retained = targets
      .slice()
      .sort((left, right) => this.placementKeepScore(right, resource) - this.placementKeepScore(left, resource))
      .slice(0, desired);
    await this.removeSurplusLifecyclePlacements(adapter, resource, policy, operation, placements, retained);
    if (unavailable) {
      throw new AppError(
        409,
        'AVAILABILITY_LIFECYCLE_NODE_UNAVAILABLE',
        'Waiting for existing placement nodes to reconnect',
        { retryable: true }
      );
    }
    await this.completeLifecycleSnapshots(policy, operation.type !== 'stop');
    await this.db
      .update(dockerAvailabilityPolicies)
      .set({
        status: operation.type === 'stop' || targets.length >= desired ? 'healthy' : 'degraded',
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(dockerAvailabilityPolicies.id, policy.id));
    this.publishPolicy(
      policy.id,
      operation.type === 'stop' ? 'stopped' : operation.type === 'restart' ? 'restarted' : 'started'
    );
  }

  private async completeLifecycleSnapshots(policy: PolicyRow, running: boolean): Promise<void> {
    const nodeId = policy.originNodeId ?? policy.sourceNodeId;
    const action = running ? 'started' : 'stopped';
    if (policy.deploymentId) {
      await this.db
        .update(dockerDeployments)
        .set({ status: running ? 'ready' : 'stopped', updatedAt: new Date() })
        .where(eq(dockerDeployments.id, policy.deploymentId));
      await this.db
        .update(dockerDeploymentSlots)
        .set({ status: 'stopped', health: 'unknown', updatedAt: new Date() })
        .where(eq(dockerDeploymentSlots.deploymentId, policy.deploymentId));
      if (running) {
        await this.db
          .update(dockerDeploymentSlots)
          .set({ status: 'running', health: 'healthy', updatedAt: new Date() })
          .where(
            and(
              eq(dockerDeploymentSlots.deploymentId, policy.deploymentId),
              eq(
                dockerDeploymentSlots.slot,
                sql`(select active_slot from docker_deployments where id = ${policy.deploymentId})`
              )
            )
          );
      }
      this.events.publish('docker.deployment.changed', { deploymentId: policy.deploymentId, nodeId, action });
    }
    if (policy.composeProjectId) {
      await this.db
        .update(dockerComposeProjects)
        .set({
          status: running ? 'running' : 'stopped',
          desiredState: running ? 'running' : 'stopped',
          updatedAt: new Date(),
        })
        .where(eq(dockerComposeProjects.id, policy.composeProjectId));
      this.events.publish('docker.compose.changed', { projectId: policy.composeProjectId, nodeId, action });
    }
    this.events.publish('docker.container.changed', {
      nodeId,
      action,
      containerName: policy.containerName,
      deploymentId: policy.deploymentId,
    });
  }

  private async executeStoppedReconcile(
    operation: OperationRow,
    policy: PolicyRow,
    resource: DockerAvailabilityResolvedResource,
    adapter: DockerAvailabilityAdapter
  ): Promise<void> {
    await this.updateOperationPhase(operation.id, 'stopping');
    const placements = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.policyId, policy.id))
      .orderBy(asc(dockerAvailabilityPlacements.createdAt));
    for (const placement of placements) {
      if (placement.desiredState === 'removed' || ['removed', 'cleanup_pending'].includes(placement.actualState))
        continue;
      if (!this.nodeRegistry.getNode(placement.nodeId)) {
        await this.db
          .update(dockerAvailabilityPlacements)
          .set({
            desiredState: 'stopped',
            actualState: 'unreachable',
            serving: false,
            unavailableSince: placement.unavailableSince ?? new Date(),
            operationId: operation.id,
            updatedAt: new Date(),
          })
          .where(eq(dockerAvailabilityPlacements.id, placement.id));
        continue;
      }
      const result = await adapter.stopPlacement({
        policyId: policy.id,
        placementId: placement.id,
        operationId: operation.id,
        leaseOwner: this.requireActiveLeaseOwner(operation.id),
        nodeId: placement.nodeId,
        generation: operation.targetGeneration,
        idempotencyKey: `${operation.idempotencyKey}:${placement.nodeId}:stop`,
        resource,
      });
      await this.persistPlacementResult(placement.id, operation, resource, result);
    }
    const refreshed = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.policyId, policy.id));
    const desired = policy.mode === 'replicated' ? policy.desiredReplicaCount : 1;
    const retained = refreshed
      .filter(
        (placement) =>
          placement.desiredState !== 'removed' && !['removed', 'cleanup_pending'].includes(placement.actualState)
      )
      .sort((left, right) => this.placementKeepScore(right, resource) - this.placementKeepScore(left, resource))
      .slice(0, desired);
    await this.removeSurplusLifecyclePlacements(adapter, resource, policy, operation, refreshed, retained);
    const activeNotStopped = retained.filter(
      (placement) =>
        this.nodeRegistry.getNode(placement.nodeId) &&
        !['removed', 'cleanup_pending', 'stopped'].includes(placement.actualState)
    );
    if (activeNotStopped.length > 0) {
      throw new AppError(409, 'AVAILABILITY_STOP_INCOMPLETE', 'Not every reachable placement stopped', {
        retryable: true,
        placementIds: activeNotStopped.map((placement) => placement.id),
      });
    }
    await this.db
      .update(dockerAvailabilityPolicies)
      .set({ status: 'healthy', lastErrorCode: null, lastErrorMessage: null, updatedAt: new Date() })
      .where(eq(dockerAvailabilityPolicies.id, policy.id));
    this.publishPolicy(policy.id, 'stopped');
  }

  private async removeSurplusLifecyclePlacements(
    adapter: DockerAvailabilityAdapter,
    resource: DockerAvailabilityResolvedResource,
    policy: PolicyRow,
    operation: OperationRow,
    placements: PlacementRow[],
    retained: PlacementRow[]
  ): Promise<void> {
    const retainedIds = new Set(retained.map((placement) => placement.id));
    const desired = policy.mode === 'replicated' ? policy.desiredReplicaCount : 1;
    const extras = placements.filter(
      (placement) =>
        placement.actualState !== 'removed' &&
        !retainedIds.has(placement.id) &&
        (retained.length >= desired ||
          placement.desiredState === 'removed' ||
          placement.actualState === 'cleanup_pending')
    );
    // Do not turn a stale/ineligible source placement into accidental deletion.
    // Explicitly retired source placements still follow their existing cleanup intent.
    if (
      extras.some((placement) => placement.nodeId === resource.currentNodeId && placement.desiredState !== 'removed')
    ) {
      throw new AppError(
        409,
        'AVAILABILITY_SOURCE_PLACEMENT_PROTECTED',
        'The source placement must be retained during lifecycle scale-down'
      );
    }
    const pending: string[] = [];
    for (const placement of extras) {
      const removed = await this.removePlacement(
        adapter,
        resource,
        policy,
        operation,
        placement,
        resource.running && operation.type !== 'stop' && placement.serving ? policy.rolloutPolicy.drainSeconds : 0
      );
      if (!removed) pending.push(placement.id);
    }
    if (pending.length > 0) {
      throw new AppError(409, 'AVAILABILITY_SCALE_CLEANUP_PENDING', 'Surplus placement removal is pending', {
        retryable: true,
        placementIds: pending,
      });
    }
  }

  private async executeRollout(
    operation: OperationRow,
    policy: PolicyRow,
    resource: DockerAvailabilityResolvedResource,
    adapter: DockerAvailabilityAdapter,
    compatible: DockerAvailabilityCandidateNode[],
    isRollback: boolean
  ): Promise<void> {
    const desired = policy.mode === 'replicated' ? policy.desiredReplicaCount : 1;
    const requestedTargetSlot = operation.requestedPolicy.targetActiveSlot;
    const targetActiveSlot: 'blue' | 'green' | undefined =
      requestedTargetSlot === 'blue' || requestedTargetSlot === 'green' ? requestedTargetSlot : undefined;
    const completedPlacementIds = new Set<string>();
    const contextFor = (placement: PlacementRow, suffix: string) => ({
      policyId: policy.id,
      placementId: placement.id,
      operationId: operation.id,
      leaseOwner: this.requireActiveLeaseOwner(operation.id),
      nodeId: placement.nodeId,
      generation: operation.targetGeneration,
      idempotencyKey: `${operation.idempotencyKey}:${placement.nodeId}:${suffix}`,
      targetActiveSlot,
      reportProgress: (phase: OperationRow['phase'], message: string) =>
        this.updateOperationPhase(operation.id, phase, {
          message,
          activePlacementId: placement.id,
          totalPlacements: desired,
          completedPlacements: completedPlacementIds.size,
          completedPlacementIds: [...completedPlacementIds],
        }),
      resource,
    });
    try {
      let placements = await this.db
        .select()
        .from(dockerAvailabilityPlacements)
        .where(eq(dockerAvailabilityPlacements.policyId, policy.id))
        .orderBy(asc(dockerAvailabilityPlacements.createdAt));
      const supersededNonServing = placements.filter(
        (placement) =>
          placement.generation !== operation.targetGeneration &&
          !placement.serving &&
          !['removed', 'cleanup_pending'].includes(placement.actualState)
      );
      for (const placement of supersededNonServing) {
        await this.removePlacement(adapter, resource, policy, operation, placement, 0);
      }
      if (supersededNonServing.length > 0) {
        placements = await this.db
          .select()
          .from(dockerAvailabilityPlacements)
          .where(eq(dockerAvailabilityPlacements.policyId, policy.id))
          .orderBy(asc(dockerAvailabilityPlacements.createdAt));
      }
      for (const placement of placements) {
        if (!this.nodeRegistry.getNode(placement.nodeId)) continue;
        if (['removed', 'cleanup_pending'].includes(placement.actualState)) continue;
        if (
          placement.generation === operation.targetGeneration &&
          placement.specFingerprint === resource.specFingerprint &&
          placement.serving
        ) {
          completedPlacementIds.add(placement.id);
          continue;
        }
        const serving = await this.db
          .select()
          .from(dockerAvailabilityPlacements)
          .where(
            and(
              eq(dockerAvailabilityPlacements.policyId, policy.id),
              eq(dockerAvailabilityPlacements.actualState, 'serving'),
              eq(dockerAvailabilityPlacements.serving, true)
            )
          );
        const exceedsUnavailableBudget = this.rolloutExceedsUnavailableBudget(
          resource.kind,
          placement.serving,
          serving.length,
          desired,
          policy.rolloutPolicy.maxUnavailable
        );
        if (exceedsUnavailableBudget && policy.rolloutPolicy.maxSurge > 0) {
          const currentPlacements = await this.db
            .select()
            .from(dockerAvailabilityPlacements)
            .where(eq(dockerAvailabilityPlacements.policyId, policy.id));
          const occupied = new Set(
            currentPlacements.filter((item) => item.actualState !== 'removed').map((item) => item.nodeId)
          );
          const surgeNode = compatible.find((candidate) => !occupied.has(candidate.id));
          if (!surgeNode) {
            throw new AppError(
              409,
              'AVAILABILITY_ROLLOUT_SURGE_UNAVAILABLE',
              'No compatible spare node is available for a zero-unavailable rollout'
            );
          }
          const surge = await this.createPlacement(policy, operation, resource, surgeNode.id);
          await this.updateOperationPhase(operation.id, 'preparing_dependencies');
          const result = await adapter.ensurePlacement(contextFor(surge, 'surge'));
          await this.persistPlacementResult(surge.id, operation, resource, result);
          completedPlacementIds.add(surge.id);
          await this.removePlacement(
            adapter,
            resource,
            policy,
            operation,
            placement,
            policy.rolloutPolicy.drainSeconds
          );
          continue;
        }
        if (exceedsUnavailableBudget) {
          throw new AppError(
            409,
            'AVAILABILITY_ROLLOUT_BUDGET_EXHAUSTED',
            'The rollout would exceed maxUnavailable and no surge placement is allowed'
          );
        }
        await this.updateOperationPhase(operation.id, 'preparing_dependencies');
        const result = await adapter.ensurePlacement(contextFor(placement, 'rollout'));
        await this.persistPlacementResult(placement.id, operation, resource, result);
        completedPlacementIds.add(placement.id);
      }

      let finalPlacements = await this.db
        .select()
        .from(dockerAvailabilityPlacements)
        .where(eq(dockerAvailabilityPlacements.policyId, policy.id));
      let currentGenerationServing = finalPlacements.filter(
        (placement) =>
          placement.serving &&
          placement.actualState === 'serving' &&
          placement.generation === operation.targetGeneration &&
          placement.specFingerprint === resource.specFingerprint &&
          this.nodeRegistry.getNode(placement.nodeId)
      );
      let missing = desired - currentGenerationServing.length;
      if (missing > 0) {
        const occupied = new Set(
          finalPlacements
            .filter((placement) => placement.actualState !== 'removed')
            .map((placement) => placement.nodeId)
        );
        for (const candidate of compatible) {
          if (missing <= 0) break;
          if (occupied.has(candidate.id)) continue;
          const placement = await this.createPlacement(policy, operation, resource, candidate.id);
          occupied.add(candidate.id);
          try {
            await this.updateOperationPhase(operation.id, 'preparing_dependencies');
            const result = await adapter.ensurePlacement(contextFor(placement, 'backfill'));
            await this.persistPlacementResult(placement.id, operation, resource, result);
            if (result.serving) completedPlacementIds.add(placement.id);
            if (result.serving) missing -= 1;
          } catch (error) {
            const normalized = this.normalizeError(error);
            if (normalized.code === 'AVAILABILITY_PLACEMENT_RETIRED') {
              await this.db
                .delete(dockerAvailabilityPlacements)
                .where(eq(dockerAvailabilityPlacements.id, placement.id));
              continue;
            }
            await this.db
              .update(dockerAvailabilityPlacements)
              .set({
                actualState: 'failed',
                serving: false,
                dependencyState: 'failed',
                applicationHealth: 'unhealthy',
                lastErrorCode: normalized.code,
                lastErrorMessage: normalized.message,
                operationId: operation.id,
                updatedAt: new Date(),
              })
              .where(eq(dockerAvailabilityPlacements.id, placement.id));
          }
        }
        finalPlacements = await this.db
          .select()
          .from(dockerAvailabilityPlacements)
          .where(eq(dockerAvailabilityPlacements.policyId, policy.id));
        currentGenerationServing = finalPlacements.filter(
          (placement) =>
            placement.serving &&
            placement.actualState === 'serving' &&
            placement.generation === operation.targetGeneration &&
            placement.specFingerprint === resource.specFingerprint &&
            this.nodeRegistry.getNode(placement.nodeId)
        );
      }
      const serving = finalPlacements.filter(
        (placement) =>
          placement.serving && placement.actualState === 'serving' && this.nodeRegistry.getNode(placement.nodeId)
      );
      if (serving.length > desired) {
        const remove = serving
          .slice()
          .sort((left, right) => {
            const rightScore =
              (right.generation === operation.targetGeneration ? 1_000 : 0) + this.placementKeepScore(right, resource);
            const leftScore =
              (left.generation === operation.targetGeneration ? 1_000 : 0) + this.placementKeepScore(left, resource);
            return rightScore - leftScore;
          })
          .slice(desired);
        for (const placement of remove) {
          await this.removePlacement(
            adapter,
            resource,
            policy,
            operation,
            placement,
            policy.rolloutPolicy.drainSeconds
          );
        }
      }
      const afterScaleDown = await this.db
        .select()
        .from(dockerAvailabilityPlacements)
        .where(eq(dockerAvailabilityPlacements.policyId, policy.id));
      const healthy = afterScaleDown.filter(
        (placement) =>
          placement.serving &&
          placement.actualState === 'serving' &&
          placement.generation === operation.targetGeneration &&
          placement.specFingerprint === resource.specFingerprint &&
          this.nodeRegistry.getNode(placement.nodeId)
      );
      if (healthy.length < desired) {
        throw new AppError(409, 'AVAILABILITY_ROLLOUT_INCOMPLETE', 'The rollout did not reach every desired placement');
      }
      await this.db
        .update(dockerAvailabilityPolicies)
        .set(
          isRollback
            ? {
                status: 'failed',
                lastErrorCode: 'AVAILABILITY_ROLLOUT_ROLLED_BACK',
                lastErrorMessage: 'The previous workload update failed and all placements were rolled back',
                updatedAt: new Date(),
              }
            : { status: 'healthy', lastErrorCode: null, lastErrorMessage: null, updatedAt: new Date() }
        )
        .where(eq(dockerAvailabilityPolicies.id, policy.id));
      this.publishPolicy(policy.id, isRollback ? 'rollout_rolled_back' : 'rollout_completed');
    } catch (error) {
      if (!isRollback) await this.queueRolloutRollback(operation, policy);
      throw error;
    }
  }

  private async queueRolloutRollback(operation: OperationRow, policy: PolicyRow): Promise<void> {
    const rollbackResource = operation.requestedPolicy.rollbackResource;
    if (!rollbackResource || typeof rollbackResource !== 'object' || Array.isArray(rollbackResource)) return;
    await this.db.transaction(async (tx) => {
      await this.lockPolicy(tx, policy.id);
      const latest = await this.requirePolicy(policy.id, tx);
      const generation = Math.max(latest.desiredGeneration, operation.targetGeneration) + 1;
      await tx
        .update(dockerAvailabilityPolicies)
        .set({
          desiredGeneration: generation,
          status: 'rolling_out',
          lastErrorCode: 'AVAILABILITY_ROLLOUT_ROLLBACK_QUEUED',
          lastErrorMessage: 'A placement update failed; coordinated rollback is queued',
          updatedAt: new Date(),
        })
        .where(eq(dockerAvailabilityPolicies.id, policy.id));
      await this.insertOperation(tx, {
        policyId: policy.id,
        type: 'rollout',
        targetGeneration: generation,
        requestedPolicy: {
          isRollback: true,
          rollbackOfOperationId: operation.id,
          resourceOverride: rollbackResource,
        },
        idempotencyKey: `availability:rollback:${policy.id}:${operation.id}:${generation}`,
      });
    });
    this.publishPolicy(policy.id, 'rollback_queued');
    this.kick();
  }

  private async executeStaleCleanup(operation: OperationRow): Promise<void> {
    const policy = await this.requirePolicy(operation.policyId);
    const resource = await this.resolvePolicyResource(policy);
    const adapter = this.requireAdapter(policy.resourceKind);
    const placementId = String(operation.requestedPolicy.placementId ?? '');
    const [placement] = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(
        and(eq(dockerAvailabilityPlacements.id, placementId), eq(dockerAvailabilityPlacements.policyId, policy.id))
      )
      .limit(1);
    if (!placement) {
      await this.refreshPolicyAfterStaleCleanup(policy);
      return;
    }
    const context = {
      policyId: policy.id,
      placementId: placement.id,
      operationId: operation.id,
      leaseOwner: this.requireActiveLeaseOwner(operation.id),
      nodeId: placement.nodeId,
      generation: policy.desiredGeneration,
      idempotencyKey: `${operation.idempotencyKey}:${placement.nodeId}:remove-stale`,
      resource,
    };
    if (placement.actualState === 'removed') {
      if (this.nodeRegistry.getNode(placement.nodeId)) await adapter.removePlacement(context);
      await this.refreshPolicyAfterStaleCleanup(policy);
      return;
    }
    if (placement.serving && placement.actualState === 'serving') {
      await this.queueHealIfNeeded(policy.id);
      return;
    }
    if (
      placement.generation >= policy.desiredGeneration &&
      placement.desiredState !== 'removed' &&
      placement.actualState !== 'cleanup_pending'
    ) {
      await this.queueHealIfNeeded(policy.id);
      return;
    }
    await this.updateOperationPhase(operation.id, 'cleaning_up');
    if (!this.nodeRegistry.getNode(placement.nodeId)) {
      await this.db
        .update(dockerAvailabilityPlacements)
        .set({
          desiredState: 'removed',
          actualState: 'cleanup_pending',
          serving: false,
          lastErrorCode: 'AVAILABILITY_CLEANUP_NODE_UNAVAILABLE',
          lastErrorMessage: 'Waiting for the placement node to reconnect',
          updatedAt: new Date(),
        })
        .where(eq(dockerAvailabilityPlacements.id, placement.id));
      throw new AppError(
        409,
        'AVAILABILITY_CLEANUP_NODE_UNAVAILABLE',
        'Placement cleanup requires its node to reconnect',
        { retryable: true }
      );
    }
    await this.db
      .update(dockerAvailabilityPlacements)
      .set({
        desiredState: 'removed',
        actualState: 'stale',
        serving: false,
        operationId: operation.id,
        updatedAt: new Date(),
      })
      .where(eq(dockerAvailabilityPlacements.id, placement.id));
    try {
      await adapter.removePlacement(context);
    } catch (error) {
      const normalized = this.normalizeError(error);
      await this.db
        .update(dockerAvailabilityPlacements)
        .set({
          actualState: 'cleanup_pending',
          lastErrorCode: normalized.code,
          lastErrorMessage: normalized.message,
          updatedAt: new Date(),
        })
        .where(eq(dockerAvailabilityPlacements.id, placement.id));
      throw error;
    }
    await this.db
      .update(dockerAvailabilityPlacements)
      .set({ actualState: 'removed', serving: false, updatedAt: new Date() })
      .where(eq(dockerAvailabilityPlacements.id, placement.id));
    await this.refreshPolicyAfterStaleCleanup(policy);
    this.publishPolicy(policy.id, 'stale_removed', placement.nodeId);
  }

  private async refreshPolicyAfterStaleCleanup(policy: PolicyRow): Promise<void> {
    const [activeMutation] = await this.db
      .select({ id: dockerAvailabilityOperations.id })
      .from(dockerAvailabilityOperations)
      .where(
        and(
          eq(dockerAvailabilityOperations.policyId, policy.id),
          ne(dockerAvailabilityOperations.type, 'stale_cleanup'),
          inArray(dockerAvailabilityOperations.status, ['pending', 'running', 'waiting'])
        )
      )
      .limit(1);
    if (activeMutation) return;
    const placements = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.policyId, policy.id));
    const cleanupPending = placements.some(
      (placement) => placement.desiredState === 'removed' && placement.actualState !== 'removed'
    );
    const desired = policy.mode === 'replicated' ? policy.desiredReplicaCount : 1;
    const serving = placements.filter(
      (placement) =>
        placement.serving &&
        placement.actualState === 'serving' &&
        placement.generation === policy.desiredGeneration &&
        Boolean(this.nodeRegistry.getNode(placement.nodeId))
    ).length;
    const converged = policy.mode === 'single' || policy.shouldRun === false || serving >= desired;
    if (!cleanupPending && converged) {
      await this.db
        .update(dockerAvailabilityPolicies)
        .set({ status: 'healthy', lastErrorCode: null, lastErrorMessage: null, updatedAt: new Date() })
        .where(eq(dockerAvailabilityPolicies.id, policy.id));
      return;
    }
    await this.queueHealIfNeeded(policy.id);
  }

  private async executeDisable(operation: OperationRow): Promise<void> {
    const policy = await this.requirePolicy(operation.policyId);
    const resource = await this.resolvePolicyResource(policy);
    const adapter = this.requireAdapter(policy.resourceKind);
    const survivorId = String(operation.requestedPolicy.survivingPlacementId ?? '');
    const placements = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.policyId, policy.id));
    const requestedSurvivor = placements.find((placement) => placement.id === survivorId);
    const currentSurvivor =
      operation.retryOfOperationId || operation.retryAttempts > 0
        ? placements.find(
            (placement) => placement.nodeId === resource.currentNodeId && this.disableSurvivorIsValid(policy, placement)
          )
        : undefined;
    const survivor = currentSurvivor
      ? currentSurvivor
      : requestedSurvivor && this.disableSurvivorIsValid(policy, requestedSurvivor)
        ? requestedSurvivor
        : placements
            .filter((placement) => this.disableSurvivorIsValid(policy, placement))
            .sort(
              (left, right) => this.placementKeepScore(right, resource) - this.placementKeepScore(left, resource)
            )[0];
    if (!survivor) {
      throw new AppError(409, 'AVAILABILITY_SURVIVOR_INVALID', 'Surviving placement is no longer healthy and current');
    }
    const canonicalResource = policy.resourceKind === 'compose' ? await adapter.resolve(resource.reference) : resource;
    const survivorResource = this.disableSurvivorResource(resource, survivor, canonicalResource);
    const adoptionContext = {
      policyId: policy.id,
      placementId: survivor.id,
      operationId: operation.id,
      leaseOwner: this.requireActiveLeaseOwner(operation.id),
      nodeId: survivor.nodeId,
      generation: operation.targetGeneration,
      idempotencyKey: `${operation.idempotencyKey}:${survivor.nodeId}:adopt-single`,
      resource: survivorResource,
    };
    await adapter.adoptPlacementAsSingle(adoptionContext);
    await this.db
      .update(dockerAvailabilityPolicies)
      .set({
        mode: 'single',
        desiredReplicaCount: 1,
        nodeSelectionMode: 'selected',
        selectedNodeIds: [survivor.nodeId],
        originNodeId: survivor.nodeId,
        sourceNodeId: policy.resourceKind === 'container' ? survivor.nodeId : policy.sourceNodeId,
        status: 'disabling',
        updatedAt: new Date(),
      })
      .where(eq(dockerAvailabilityPolicies.id, policy.id));
    await adapter.finalizePlacementAsSingle(adoptionContext);
    await this.updateOperationPhase(operation.id, 'draining');
    for (const placement of placements) {
      if (placement.id === survivor.id || placement.actualState === 'removed') continue;
      await this.removePlacement(
        adapter,
        resource,
        policy,
        operation,
        placement,
        placement.serving ? policy.rolloutPolicy.drainSeconds : 0
      );
    }
    await this.artifacts?.cleanup(policy.id);
    await this.db.transaction(async (tx) => {
      await this.lockPolicy(tx, policy.id);
      await tx
        .update(dockerAvailabilityPlacements)
        .set({
          generation: operation.targetGeneration,
          desiredState: policy.shouldRun ? 'serving' : 'stopped',
          actualState: policy.shouldRun ? 'serving' : 'stopped',
          serving: policy.shouldRun,
          dependencyState: policy.shouldRun ? 'ready' : 'pending',
          applicationHealth: policy.shouldRun ? 'healthy' : 'unknown',
          operationId: operation.id,
          updatedAt: new Date(),
        })
        .where(eq(dockerAvailabilityPlacements.id, survivor.id));
      await tx
        .update(dockerAvailabilityPolicies)
        .set({
          mode: 'single',
          desiredReplicaCount: 1,
          nodeSelectionMode: 'selected',
          selectedNodeIds: [survivor.nodeId],
          originNodeId: survivor.nodeId,
          sourceNodeId: policy.resourceKind === 'container' ? survivor.nodeId : policy.sourceNodeId,
          desiredGeneration: operation.targetGeneration,
          status: 'single',
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(dockerAvailabilityPolicies.id, policy.id));
    });
    this.publishPolicy(policy.id, 'disabled');
  }

  private disableSurvivorResource(
    resource: DockerAvailabilityResolvedResource,
    survivor: PlacementRow,
    canonicalResource: DockerAvailabilityResolvedResource = resource
  ): DockerAvailabilityResolvedResource {
    return {
      ...resource,
      portableSpec:
        resource.kind === 'deployment' || resource.kind === 'compose'
          ? canonicalResource.portableSpec
          : resource.portableSpec,
      specFingerprint: survivor.specFingerprint,
      imageReference: survivor.imageReference ?? resource.imageReference,
    };
  }

  private async removePlacement(
    adapter: DockerAvailabilityAdapter,
    resource: DockerAvailabilityResolvedResource,
    policy: PolicyRow,
    operation: OperationRow,
    placement: PlacementRow,
    drainSeconds: number
  ): Promise<boolean> {
    const context = {
      policyId: policy.id,
      placementId: placement.id,
      operationId: operation.id,
      leaseOwner: this.requireActiveLeaseOwner(operation.id),
      nodeId: placement.nodeId,
      generation: operation.targetGeneration,
      idempotencyKey: `${operation.idempotencyKey}:${placement.nodeId}:remove`,
      resource,
    };
    await this.db
      .update(dockerAvailabilityPlacements)
      .set({
        desiredState: 'draining',
        actualState: 'draining',
        serving: false,
        operationId: operation.id,
        updatedAt: new Date(),
      })
      .where(eq(dockerAvailabilityPlacements.id, placement.id));
    await this.updateOperationPhase(operation.id, 'draining', {
      activePlacementId: placement.id,
      message: `Draining existing connections for up to ${drainSeconds} seconds`,
    });
    if (this.nodeRegistry.getNode(placement.nodeId)) {
      try {
        await adapter.drainPlacement(context, drainSeconds);
        await this.updateOperationPhase(operation.id, 'cleaning_up', {
          activePlacementId: placement.id,
          message: 'Removing the retired placement and its private links',
        });
        await adapter.removePlacement(context);
      } catch (error) {
        const normalized = this.normalizeError(error);
        await this.db
          .update(dockerAvailabilityPlacements)
          .set({
            desiredState: 'removed',
            actualState: 'cleanup_pending',
            serving: false,
            lastErrorCode: normalized.code,
            lastErrorMessage: normalized.message,
            updatedAt: new Date(),
          })
          .where(eq(dockerAvailabilityPlacements.id, placement.id));
        await this.queueOperation({
          policyId: policy.id,
          type: 'stale_cleanup',
          targetGeneration: policy.desiredGeneration,
          idempotencyKey: `availability:cleanup:${placement.id}:${policy.desiredGeneration}`,
          requestedPolicy: { placementId: placement.id },
        });
        logger.warn('Availability placement cleanup deferred', {
          policyId: policy.id,
          placementId: placement.id,
          nodeId: placement.nodeId,
          error: normalized.message,
        });
        return false;
      }
    } else {
      await this.db
        .update(dockerAvailabilityPlacements)
        .set({
          desiredState: 'removed',
          actualState: 'cleanup_pending',
          serving: false,
          lastErrorCode: 'AVAILABILITY_CLEANUP_NODE_UNAVAILABLE',
          lastErrorMessage: 'Waiting for the surplus placement node to reconnect',
          updatedAt: new Date(),
        })
        .where(eq(dockerAvailabilityPlacements.id, placement.id));
      await this.queueOperation({
        policyId: policy.id,
        type: 'stale_cleanup',
        targetGeneration: policy.desiredGeneration,
        idempotencyKey: `availability:cleanup:${placement.id}:${policy.desiredGeneration}`,
        requestedPolicy: { placementId: placement.id },
      });
      return false;
    }
    await this.db
      .update(dockerAvailabilityPlacements)
      .set({ desiredState: 'removed', actualState: 'removed', serving: false, updatedAt: new Date() })
      .where(eq(dockerAvailabilityPlacements.id, placement.id));
    return true;
  }

  private async handleNodeUnavailable(nodeId: string): Promise<void> {
    const affected = await this.db
      .update(dockerAvailabilityPlacements)
      .set({ actualState: 'unreachable', serving: false, unavailableSince: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(dockerAvailabilityPlacements.nodeId, nodeId),
          inArray(dockerAvailabilityPlacements.actualState, [
            'pending',
            'preparing_image',
            'preparing_dependencies',
            'starting',
            'checking_health',
            'ready',
            'serving',
            'draining',
          ])
        )
      )
      .returning({
        id: dockerAvailabilityPlacements.id,
        policyId: dockerAvailabilityPlacements.policyId,
        nodeId: dockerAvailabilityPlacements.nodeId,
        generation: dockerAvailabilityPlacements.generation,
      });
    for (const placement of affected) {
      const policy = await this.requirePolicy(placement.policyId);
      if (policy.mode !== 'failover') await this.deactivateUnavailablePlacement(placement, nodeId);
    }
    for (const policyId of new Set(affected.map((row) => row.policyId))) {
      this.publishPolicy(policyId, 'node_unavailable', nodeId);
      const policy = await this.requirePolicy(policyId);
      const existingTimer = this.replacementTimers.get(policyId);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        this.replacementTimers.delete(policyId);
        void (async () => {
          if (policy.mode === 'failover') {
            for (const placement of affected.filter((row) => row.policyId === policyId)) {
              await this.deactivateUnavailablePlacement(placement, nodeId);
            }
          }
          await this.queueHealIfNeeded(policyId);
          this.kick();
        })();
      }, policy.offlineReplacementGraceSeconds * 1000);
      timer.unref?.();
      this.replacementTimers.set(policyId, timer);
    }
  }

  private async deactivateUnavailablePlacement(
    placement: Pick<PlacementRow, 'id' | 'policyId' | 'nodeId' | 'generation'>,
    nodeId: string
  ): Promise<void> {
    try {
      const policy = await this.requirePolicy(placement.policyId);
      const resource = await this.resolvePolicyResource(policy);
      await this.requireAdapter(policy.resourceKind).deactivatePlacementDependencies({
        policyId: policy.id,
        placementId: placement.id,
        operationId: `node-unavailable:${placement.id}`,
        nodeId: placement.nodeId,
        generation: placement.generation,
        idempotencyKey: `availability:unroute:${placement.id}:${placement.generation}`,
        resource,
      });
    } catch (error) {
      logger.error('Failed to remove unavailable Availability placement from ingress', {
        placementId: placement.id,
        nodeId,
        error,
      });
    }
  }

  private async handleNodeOnline(nodeId: string): Promise<void> {
    const affectedPolicyIds = new Set<string>();
    const placements = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.nodeId, nodeId));
    for (const placement of placements) {
      const policy = await this.requirePolicy(placement.policyId);
      affectedPolicyIds.add(policy.id);
      const timer = this.replacementTimers.get(policy.id);
      if (timer) {
        clearTimeout(timer);
        this.replacementTimers.delete(policy.id);
      }
      if (placement.desiredState === 'removed' || placement.actualState === 'cleanup_pending') {
        await this.queueOperation({
          policyId: policy.id,
          type: 'stale_cleanup',
          targetGeneration: policy.desiredGeneration,
          idempotencyKey: `availability:cleanup:${placement.id}:${policy.desiredGeneration}`,
          requestedPolicy: { placementId: placement.id },
        });
      }
    }
    const enabledPolicies = await this.db
      .select({ id: dockerAvailabilityPolicies.id })
      .from(dockerAvailabilityPolicies)
      .where(and(ne(dockerAvailabilityPolicies.mode, 'single'), eq(dockerAvailabilityPolicies.shouldRun, true)));
    for (const policy of enabledPolicies) affectedPolicyIds.add(policy.id);
    for (const policyId of affectedPolicyIds) {
      this.publishPolicy(policyId, 'node_reconnected', nodeId);
      void this.queueHealIfNeeded(policyId).catch((error) => {
        logger.error('Failed to reconcile Docker Availability policy after node reconnect', {
          nodeId,
          policyId,
          error,
        });
      });
    }
    this.kick();
  }

  private async reconcileEnabledPoliciesAfterStartup(): Promise<void> {
    // Node registration can race service startup and leave an in-memory heal
    // check waiting on a connection that was replaced moments later. Active
    // database operations are checked below, so dropping only these transient
    // single-flight guards is safe and lets every policy be reconsidered.
    this.healChecks.clear();
    const enabledPolicies = await this.db
      .select({ id: dockerAvailabilityPolicies.id })
      .from(dockerAvailabilityPolicies)
      .where(and(ne(dockerAvailabilityPolicies.mode, 'single'), eq(dockerAvailabilityPolicies.shouldRun, true)));
    for (const policy of enabledPolicies) {
      this.healChecks.delete(policy.id);
      void this.queueHealIfNeeded(policy.id).catch((error) => {
        logger.error('Failed to reconcile Docker Availability policy after startup', { policyId: policy.id, error });
      });
    }
    this.kick();
  }

  private async queueHealIfNeeded(policyId: string): Promise<void> {
    const current = this.healChecks.get(policyId);
    if (current) return current;
    const check = this.queueHealIfNeededOnce(policyId).finally(() => {
      if (this.healChecks.get(policyId) === check) this.healChecks.delete(policyId);
    });
    this.healChecks.set(policyId, check);
    return check;
  }

  private async queueHealIfNeededOnce(policyId: string): Promise<void> {
    const policy = await this.requirePolicy(policyId);
    if (policy.mode === 'single') return;
    if (policy.shouldRun === false) return;
    const desired = policy.mode === 'replicated' ? policy.desiredReplicaCount : 1;
    const placements = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.policyId, policyId));
    const serving = placements.filter(
      (placement) =>
        placement.serving &&
        placement.actualState === 'serving' &&
        placement.generation === policy.desiredGeneration &&
        this.nodeRegistry.getNode(placement.nodeId)
    ).length;
    const cleanupPending = placements.some(
      (placement) => placement.desiredState === 'removed' && placement.actualState !== 'removed'
    );
    const hasSurplus = placements.filter((placement) => placement.actualState !== 'removed').length > desired;
    if (serving >= desired && !cleanupPending && !hasSurplus) {
      if (policy.status !== 'healthy' || policy.lastErrorCode || policy.lastErrorMessage) {
        await this.db
          .update(dockerAvailabilityPolicies)
          .set({ status: 'healthy', lastErrorCode: null, lastErrorMessage: null, updatedAt: new Date() })
          .where(eq(dockerAvailabilityPolicies.id, policyId));
        this.publishPolicy(policyId, 'healthy');
      }
      return;
    }
    const [activeHeal] = await this.db
      .select({ id: dockerAvailabilityOperations.id })
      .from(dockerAvailabilityOperations)
      .where(
        and(
          eq(dockerAvailabilityOperations.policyId, policyId),
          inArray(dockerAvailabilityOperations.status, ['pending', 'waiting', 'running'])
        )
      )
      .limit(1);
    if (activeHeal) return;
    if (!(await this.licensePolicy.hasFeature('multi-node-availability'))) {
      await this.refreshPolicyStatus(
        policyId,
        'AVAILABILITY_ENTITLEMENT_REQUIRED_FOR_HEALING',
        'Availability is degraded; creating a replacement requires Business or Enterprise'
      );
      return;
    }
    const reconnectingFailoverPlacement =
      policy.mode === 'failover' &&
      placements.some(
        (placement) =>
          placement.actualState === 'unreachable' &&
          placement.desiredState !== 'removed' &&
          Boolean(this.nodeRegistry.getNode(placement.nodeId))
      );
    const generation =
      policy.mode === 'failover' && !reconnectingFailoverPlacement && serving < desired
        ? policy.desiredGeneration + 1
        : policy.desiredGeneration;
    const healEpoch = placements.reduce((latest, placement) => {
      const observed = placement.unavailableSince ?? placement.updatedAt;
      return Math.max(latest, observed instanceof Date ? observed.getTime() : 0);
    }, 0);
    if (generation !== policy.desiredGeneration) {
      await this.db
        .update(dockerAvailabilityPolicies)
        .set({ desiredGeneration: generation, status: 'degraded', updatedAt: new Date() })
        .where(eq(dockerAvailabilityPolicies.id, policyId));
    }
    await this.queueOperation({
      policyId,
      type: 'heal',
      targetGeneration: generation,
      ...(serving >= desired ? { requestedPolicy: { cleanupOnly: true } } : {}),
      idempotencyKey: `availability:heal:${policyId}:${generation}:${serving}:${healEpoch}${serving >= desired ? ':cleanup' : ''}`,
    });
  }

  private async queueOperation(input: DockerAvailabilityQueuedOperation): Promise<OperationRow> {
    return this.insertOperation(this.db, input);
  }

  private async supersedeQueuedOperations(tx: DrizzleTransaction, policyId: string): Promise<void> {
    const [running] = await tx
      .select({ id: dockerAvailabilityOperations.id })
      .from(dockerAvailabilityOperations)
      .where(
        and(eq(dockerAvailabilityOperations.policyId, policyId), eq(dockerAvailabilityOperations.status, 'running'))
      )
      .limit(1);
    if (running) {
      throw new AppError(409, 'AVAILABILITY_OPERATION_ACTIVE', 'Wait for the active Availability operation');
    }
    const now = new Date();
    await tx
      .update(dockerAvailabilityOperations)
      .set({
        status: 'cancelled',
        phase: 'done',
        errorCode: 'AVAILABILITY_OPERATION_SUPERSEDED',
        errorMessage: null,
        leaseOwner: null,
        leaseHeartbeatAt: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(dockerAvailabilityOperations.policyId, policyId),
          inArray(dockerAvailabilityOperations.status, ['pending', 'waiting'])
        )
      );
  }

  private async insertOperation(
    writer: Pick<DrizzleClient, 'insert' | 'select'> | DrizzleTransaction,
    input: DockerAvailabilityQueuedOperation,
    retryOfOperationId?: string
  ): Promise<OperationRow> {
    const [inserted] = await writer
      .insert(dockerAvailabilityOperations)
      .values({
        policyId: input.policyId,
        type: input.type,
        targetGeneration: input.targetGeneration,
        idempotencyKey: input.idempotencyKey,
        requestedPolicy: input.requestedPolicy ?? {},
        retryOfOperationId,
        createdById: input.userId ?? null,
      })
      .onConflictDoNothing({ target: dockerAvailabilityOperations.idempotencyKey })
      .returning();
    if (inserted) return inserted;
    const [existing] = await writer
      .select()
      .from(dockerAvailabilityOperations)
      .where(eq(dockerAvailabilityOperations.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (!existing) throw new Error('Availability operation idempotency lookup failed');
    return existing;
  }

  private async createPlacement(
    policy: PolicyRow,
    operation: OperationRow,
    resource: DockerAvailabilityResolvedResource,
    nodeId: string
  ): Promise<PlacementRow> {
    const [retired] = await this.db
      .select({ id: dockerAvailabilityPlacements.id, actualState: dockerAvailabilityPlacements.actualState })
      .from(dockerAvailabilityPlacements)
      .where(and(eq(dockerAvailabilityPlacements.policyId, policy.id), eq(dockerAvailabilityPlacements.nodeId, nodeId)))
      .limit(1);
    if (retired?.actualState === 'removed') {
      await this.db.delete(dockerAvailabilityPlacements).where(eq(dockerAvailabilityPlacements.id, retired.id));
    }
    const [placement] = await this.db
      .insert(dockerAvailabilityPlacements)
      .values({
        policyId: policy.id,
        nodeId,
        generation: operation.targetGeneration,
        desiredState: 'serving',
        actualState: 'preparing_image',
        serving: false,
        specFingerprint: resource.specFingerprint,
        imageReference: resource.imageReference,
        composeRevisionId: resource.composeRevisionId,
        operationId: operation.id,
      })
      .onConflictDoUpdate({
        target: [dockerAvailabilityPlacements.policyId, dockerAvailabilityPlacements.nodeId],
        set: {
          generation: operation.targetGeneration,
          desiredState: 'serving',
          actualState: 'preparing_image',
          serving: false,
          specFingerprint: resource.specFingerprint,
          imageReference: resource.imageReference,
          composeRevisionId: resource.composeRevisionId,
          operationId: operation.id,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!placement) throw new Error('Availability placement was not persisted');
    return placement;
  }

  private async persistPlacementResult(
    placementId: string,
    operation: OperationRow,
    resource: DockerAvailabilityResolvedResource,
    result: Awaited<ReturnType<DockerAvailabilityAdapter['ensurePlacement']>>
  ): Promise<void> {
    if (result.acknowledgedGeneration !== operation.targetGeneration) {
      throw new AppError(
        409,
        'AVAILABILITY_STALE_ACKNOWLEDGEMENT',
        'Docker node acknowledged a different Availability generation',
        {
          retryable: result.acknowledgedGeneration < operation.targetGeneration,
          expectedGeneration: operation.targetGeneration,
          acknowledgedGeneration: result.acknowledgedGeneration,
        }
      );
    }
    await this.db
      .update(dockerAvailabilityPlacements)
      .set({
        generation: operation.targetGeneration,
        desiredState: result.serving ? 'serving' : 'stopped',
        actualState: result.actualState,
        serving: result.serving,
        dependencyState: result.dependencyState,
        applicationHealth: result.applicationHealth,
        // Record the applied, artifact-prepared spec, not the previous placement
        // or canonical policy spec. Stopping does not apply deferred config.
        ...(result.serving ? { specFingerprint: resource.specFingerprint } : {}),
        runtimeIdentity: result.runtimeIdentity ?? {},
        imageReference: result.imageReference ?? resource.imageReference,
        composeRevisionId: result.composeRevisionId ?? resource.composeRevisionId,
        lastObservedAt: new Date(),
        unavailableSince: null,
        operationId: operation.id,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(dockerAvailabilityPlacements.id, placementId));
  }

  private async resolveCandidateNodes(
    input: DockerAvailabilityPolicyInput,
    resource: DockerAvailabilityResolvedResource
  ): Promise<Array<DockerAvailabilityCandidateNode & { capacity: number }>> {
    const rows = await this.db
      .select({
        id: nodes.id,
        slug: nodes.slug,
        hostname: nodes.hostname,
        type: nodes.type,
        status: nodes.status,
        serviceCreationLocked: nodes.serviceCreationLocked,
        capabilities: nodes.capabilities,
        metadata: nodes.metadata,
        lastHealthReport: nodes.lastHealthReport,
      })
      .from(nodes)
      .where(eq(nodes.type, 'docker'));
    const selected = new Set(input.selectedNodeIds);
    const originArchitecture = this.nodeArchitecture(
      rows.find((node) => node.id === resource.currentNodeId)?.capabilities
    );
    const requiresSecureRuntime =
      resource.portableSpec.runtimeProfile === 'secure' ||
      (resource.portableSpec.desiredConfig as Record<string, unknown> | undefined)?.runtimeProfile === 'secure';
    return rows
      .filter((node) => input.nodeSelectionMode === 'all_compatible' || selected.has(node.id))
      .map((node) => {
        let reasonCode: string | undefined;
        const candidateArchitecture = this.nodeArchitecture(node.capabilities);
        if (node.status !== 'online' || !this.nodeRegistry.getNode(node.id)) reasonCode = 'NODE_OFFLINE';
        else if (node.serviceCreationLocked) reasonCode = 'NODE_SERVICE_CREATION_LOCKED';
        else if (this.nodeRegistry.isNodeUpdateInProgress(node.id)) reasonCode = 'NODE_UPDATING';
        else if (!this.nodeRegistry.hasCapability(node.id, 'docker_availability_v1')) {
          reasonCode = 'AVAILABILITY_CAPABILITY_UNAVAILABLE';
        } else if (originArchitecture && candidateArchitecture !== originArchitecture) {
          reasonCode = 'NODE_ARCHITECTURE_INCOMPATIBLE';
        } else if (requiresSecureRuntime && !this.nodeRegistry.hasCapability(node.id, 'docker_runsc_healthy_v1')) {
          reasonCode = 'SECURE_RUNTIME_UNAVAILABLE';
        }
        return {
          id: node.id,
          slug: node.slug,
          hostname: node.hostname,
          compatible: !reasonCode,
          reasonCode,
          rank: this.candidateRank(node.id, node.lastHealthReport, resource.resourceId),
          capacity: this.candidateCapacity(node.lastHealthReport),
        };
      })
      .sort((a, b) => b.capacity - a.capacity || b.rank - a.rank || a.id.localeCompare(b.id));
  }

  private nodeArchitecture(capabilities: unknown): 'amd64' | 'arm64' | null {
    const raw =
      capabilities && typeof capabilities === 'object'
        ? String((capabilities as Record<string, unknown>).architecture ?? '').toLowerCase()
        : '';
    if (raw === 'amd64' || raw === 'x86_64' || raw === 'x64') return 'amd64';
    if (raw === 'arm64' || raw === 'aarch64') return 'arm64';
    return null;
  }

  private candidateCapacity(health: { diskFreeBytes?: number; systemMemoryAvailableBytes?: number } | null): number {
    return (
      Math.max(0, Number(health?.diskFreeBytes ?? 0)) + Math.max(0, Number(health?.systemMemoryAvailableBytes ?? 0))
    );
  }

  private candidateRank(nodeId: string, _health: unknown, seed: string): number {
    return Number.parseInt(createHash('sha256').update(`${seed}:${nodeId}`).digest('hex').slice(0, 8), 16);
  }

  private collectCandidatePermissionBlockers(
    scopes: string[],
    resource: DockerAvailabilityResolvedResource,
    nodeId: string,
    blockers: DockerAvailabilityIssue[]
  ): void {
    const required =
      resource.kind === 'compose'
        ? ['docker:compose:create', 'docker:compose:manage']
        : [
            'docker:containers:create',
            'docker:containers:manage',
            'docker:containers:environment',
            'docker:containers:secrets',
          ];
    for (const scope of required) {
      if (!hasDockerResourceScope(scopes, scope, nodeId, resource.resourceId)) {
        blockers.push({
          code: 'AVAILABILITY_PERMISSION_DENIED',
          message: `Missing ${scope} on candidate Docker node`,
          nodeId,
        });
      }
    }
  }

  private assertResourceAccess(
    scopes: string[],
    resource: DockerAvailabilityResolvedResource,
    action: 'view' | 'manage'
  ): void {
    const scope = action === 'view' ? resource.viewScope : 'docker:availability:manage';
    if (!hasDockerResourceScope(scopes, scope, resource.currentNodeId, resource.resourceId)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required ${scope} scope`);
    }
  }

  private validatePolicyInput(input: DockerAvailabilityPolicyInput): void {
    if (input.mode === 'replicated' && (input.desiredReplicaCount < 2 || input.desiredReplicaCount > 32)) {
      throw new AppError(400, 'INVALID_REPLICA_COUNT', 'Replicated mode requires 2 through 32 replicas');
    }
    if (input.mode === 'failover' && input.desiredReplicaCount !== 1) {
      throw new AppError(400, 'INVALID_REPLICA_COUNT', 'Failover mode requires exactly one serving placement');
    }
    const unique = new Set(input.selectedNodeIds);
    if (unique.size !== input.selectedNodeIds.length) {
      throw new AppError(400, 'DUPLICATE_SELECTED_NODE', 'Selected Docker nodes must be unique');
    }
    if (input.nodeSelectionMode === 'selected' && unique.size === 0) {
      throw new AppError(400, 'SELECTED_NODES_REQUIRED', 'Select at least one Docker node');
    }
  }

  private normalizePolicyInput(input: DockerAvailabilityPolicyInput) {
    return {
      mode: input.mode,
      desiredReplicaCount: input.desiredReplicaCount,
      nodeSelectionMode: input.nodeSelectionMode,
      selectedNodeIds:
        input.nodeSelectionMode === 'selected' ? [...new Set(input.selectedNodeIds)].sort() : ([] as string[]),
      rolloutPolicy: input.rolloutPolicy,
      offlineReplacementGraceSeconds: input.offlineReplacementGraceSeconds,
    };
  }

  private resourceColumns(resource: DockerAvailabilityResolvedResource) {
    const canonical = {
      originNodeId: resource.currentNodeId,
      displayName: resource.displayName,
      specFingerprint: resource.specFingerprint,
      portableSpec: resource.portableSpec,
      imageReference: resource.imageReference,
      composeRevisionId: resource.composeRevisionId,
      shouldRun: resource.running,
    };
    if (resource.kind === 'container') {
      const ref = resource.reference as Extract<DockerAvailabilityResource, { type: 'container' }>;
      return {
        ...canonical,
        resourceKind: 'container' as const,
        sourceNodeId: ref.nodeId,
        containerName: ref.containerName,
      };
    }
    if (resource.kind === 'deployment') {
      const ref = resource.reference as Extract<DockerAvailabilityResource, { type: 'deployment' }>;
      return { ...canonical, resourceKind: 'deployment' as const, deploymentId: ref.deploymentId };
    }
    const ref = resource.reference as Extract<DockerAvailabilityResource, { type: 'compose' }>;
    return { ...canonical, resourceKind: 'compose' as const, composeProjectId: ref.composeProjectId };
  }

  private policyInput(policy: PolicyRow, resource: DockerAvailabilityResolvedResource): DockerAvailabilityPolicyInput {
    return {
      resource: resource.reference,
      mode: policy.mode === 'replicated' ? 'replicated' : 'failover',
      desiredReplicaCount: policy.desiredReplicaCount,
      nodeSelectionMode: policy.nodeSelectionMode,
      selectedNodeIds: policy.selectedNodeIds,
      rolloutPolicy: policy.rolloutPolicy,
      offlineReplacementGraceSeconds: policy.offlineReplacementGraceSeconds,
    };
  }

  private async findPolicyByResolvedResource(
    resource: DockerAvailabilityResolvedResource,
    writer: Pick<DrizzleClient, 'select'> | DrizzleTransaction = this.db
  ): Promise<PolicyRow | null> {
    const where =
      resource.kind === 'container'
        ? and(
            eq(dockerAvailabilityPolicies.resourceKind, 'container'),
            eq(dockerAvailabilityPolicies.sourceNodeId, resource.currentNodeId),
            eq(dockerAvailabilityPolicies.containerName, resource.displayName)
          )
        : resource.kind === 'deployment'
          ? eq(dockerAvailabilityPolicies.deploymentId, resource.resourceId)
          : eq(dockerAvailabilityPolicies.composeProjectId, resource.resourceId);
    const [row] = await writer.select().from(dockerAvailabilityPolicies).where(where).limit(1);
    return row ?? null;
  }

  private async findPolicyByResourceReference(
    resource: DockerAvailabilityResource,
    writer: Pick<DrizzleClient, 'select'> | DrizzleTransaction = this.db
  ): Promise<PolicyRow | null> {
    return this.workloads.findPolicy(resource, writer);
  }

  private async requirePolicy(policyId: string, writer: Pick<DrizzleClient, 'select'> | DrizzleTransaction = this.db) {
    const [policy] = await writer
      .select()
      .from(dockerAvailabilityPolicies)
      .where(eq(dockerAvailabilityPolicies.id, policyId))
      .limit(1);
    if (!policy) throw new AppError(404, 'AVAILABILITY_POLICY_NOT_FOUND', 'Availability policy not found');
    return policy;
  }

  private async resolvePolicyResource(policy: PolicyRow): Promise<DockerAvailabilityResolvedResource> {
    if (policy.specFingerprint && Object.keys(policy.portableSpec).length > 0) {
      const reference: DockerAvailabilityResource =
        policy.resourceKind === 'container'
          ? { type: 'container', nodeId: policy.sourceNodeId!, containerName: policy.containerName! }
          : policy.resourceKind === 'deployment'
            ? { type: 'deployment', deploymentId: policy.deploymentId! }
            : { type: 'compose', composeProjectId: policy.composeProjectId! };
      return {
        kind: policy.resourceKind,
        reference,
        resourceId:
          policy.resourceKind === 'container'
            ? policy.containerName!
            : policy.resourceKind === 'deployment'
              ? policy.deploymentId!
              : policy.composeProjectId!,
        displayName: policy.displayName,
        currentNodeId: policy.originNodeId ?? policy.sourceNodeId ?? '',
        viewScope: policy.resourceKind === 'compose' ? 'docker:compose:view' : 'docker:containers:view',
        manageScope: policy.resourceKind === 'compose' ? 'docker:compose:manage' : 'docker:containers:manage',
        specFingerprint: policy.specFingerprint,
        portableSpec: policy.portableSpec,
        imageReference: policy.imageReference ?? undefined,
        sourceImageReference: policySourceImageReference(policy),
        composeRevisionId: policy.composeRevisionId ?? undefined,
        running: policy.shouldRun,
        authoritativeSnapshot: true,
      };
    }
    if (policy.resourceKind === 'container') {
      return this.requireAdapter('container').resolve({
        type: 'container',
        nodeId: policy.sourceNodeId!,
        containerName: policy.containerName!,
      });
    }
    if (policy.resourceKind === 'deployment') {
      return this.requireAdapter('deployment').resolve({ type: 'deployment', deploymentId: policy.deploymentId! });
    }
    return this.requireAdapter('compose').resolve({ type: 'compose', composeProjectId: policy.composeProjectId! });
  }

  private operationResourceOverride(
    operation: OperationRow,
    fallback: DockerAvailabilityResolvedResource
  ): DockerAvailabilityResolvedResource | null {
    const value = operation.requestedPolicy.resourceOverride;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const override = value as Record<string, unknown>;
    if (
      typeof override.specFingerprint !== 'string' ||
      !override.portableSpec ||
      typeof override.portableSpec !== 'object' ||
      Array.isArray(override.portableSpec)
    ) {
      throw new AppError(409, 'AVAILABILITY_ROLLBACK_RESOURCE_INVALID', 'Rollback resource metadata is invalid');
    }
    return {
      ...fallback,
      specFingerprint: override.specFingerprint,
      portableSpec: override.portableSpec as Record<string, unknown>,
      imageReference: typeof override.imageReference === 'string' ? override.imageReference : undefined,
      composeRevisionId: typeof override.composeRevisionId === 'string' ? override.composeRevisionId : undefined,
    };
  }

  private policyResourceReference(policy: PolicyRow): DockerAvailabilityResource {
    if (policy.resourceKind === 'container') {
      return {
        type: 'container',
        nodeId: policy.sourceNodeId!,
        containerName: policy.containerName!,
      };
    }
    if (policy.resourceKind === 'deployment') {
      return { type: 'deployment', deploymentId: policy.deploymentId! };
    }
    return { type: 'compose', composeProjectId: policy.composeProjectId! };
  }

  private requireAdapter(kind: string): DockerAvailabilityAdapter {
    const adapter = this.adapters.get(kind === 'compose' ? 'compose' : kind);
    if (!adapter) {
      throw new AppError(503, 'AVAILABILITY_ADAPTER_UNAVAILABLE', 'Availability support is not initialized');
    }
    return adapter;
  }

  private async policyView(policy: PolicyRow) {
    const [placements, latestOperation, sourceArtifacts] = await Promise.all([
      this.db
        .select()
        .from(dockerAvailabilityPlacements)
        .where(eq(dockerAvailabilityPlacements.policyId, policy.id))
        .orderBy(asc(dockerAvailabilityPlacements.createdAt)),
      this.db
        .select()
        .from(dockerAvailabilityOperations)
        .where(eq(dockerAvailabilityOperations.policyId, policy.id))
        .orderBy(
          sql`CASE WHEN ${dockerAvailabilityOperations.status} IN ('pending', 'running', 'waiting') AND ${dockerAvailabilityOperations.type} <> 'stale_cleanup' THEN 2 WHEN ${dockerAvailabilityOperations.status} IN ('pending', 'running', 'waiting', 'cleanup_pending') THEN 1 ELSE 0 END DESC`,
          desc(dockerAvailabilityOperations.createdAt)
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      policy.resourceKind === 'compose'
        ? Promise.resolve([])
        : this.db
            .select({ sourceImageReference: dockerBuildArtifacts.sourceImageReference })
            .from(dockerArtifactPins)
            .innerJoin(dockerBuildArtifacts, eq(dockerBuildArtifacts.id, dockerArtifactPins.artifactId))
            .where(
              and(eq(dockerArtifactPins.ownerKey, `availability:${policy.id}`), eq(dockerArtifactPins.kind, 'active'))
            )
            .orderBy(desc(dockerArtifactPins.createdAt))
            .limit(1),
    ]);
    const canonicalImageReference = String((policy.portableSpec as Record<string, unknown> | null)?.image ?? '').trim();
    const publicPortableImageReference = /^127\.0\.0\.1:5443\//i.test(canonicalImageReference)
      ? ''
      : canonicalImageReference;
    const sourceImageReference = await this.resolveCanonicalSourceImage(
      policy,
      String(
        policySourceImageReference(policy) ||
          publicPortableImageReference ||
          sourceArtifacts[0]?.sourceImageReference ||
          ''
      )
    );
    const { portableSpec: _portableSpec, ...publicPolicy } = policy;
    const fallbackImageReference = String(policy.imageReference ?? '').trim();
    const publicFallbackImageReference =
      fallbackImageReference &&
      !/^sha256:[0-9a-f]{64}$/i.test(fallbackImageReference) &&
      !/^127\.0\.0\.1:5443\//i.test(fallbackImageReference)
        ? fallbackImageReference
        : null;
    return {
      ...publicPolicy,
      sourceImageReference: sourceImageReference || publicPortableImageReference || publicFallbackImageReference,
      serviceCount: policyComposeServiceCount(policy),
      placements,
      latestOperation,
    };
  }

  private async resolveCanonicalSourceImage(policy: PolicyRow, candidate: string): Promise<string | null> {
    const normalized = candidate.trim();
    if (normalized && !/^sha256:[0-9a-f]{64}$/i.test(normalized) && !/^127\.0\.0\.1:5443\//i.test(normalized)) {
      return normalized;
    }
    if (policy.resourceKind === 'compose') return normalized || null;
    const existing = this.canonicalImageRepairs.get(policy.id);
    if (existing) return existing;
    const repair = (async () => {
      const nodeId = policy.sourceNodeId ?? policy.originNodeId;
      const artifactTag =
        nodeId && this.artifacts
          ? await this.artifacts.resolveCanonicalSourceImage(nodeId, normalized, policy.imageReference)
          : null;
      const tag = artifactTag ?? (await this.resolveDeploymentReleaseSourceImage(policy));
      if (!tag) return null;
      await this.db
        .update(dockerAvailabilityPolicies)
        .set({ portableSpec: { ...policy.portableSpec, sourceImageReference: tag }, updatedAt: new Date() })
        .where(eq(dockerAvailabilityPolicies.id, policy.id));
      return tag;
    })().finally(() => {
      this.canonicalImageRepairs.delete(policy.id);
    });
    this.canonicalImageRepairs.set(policy.id, repair);
    return repair;
  }

  private async resolveDeploymentReleaseSourceImage(policy: PolicyRow): Promise<string | null> {
    if (policy.resourceKind !== 'deployment' || !policy.deploymentId) return null;
    const releases = await this.db
      .select({ image: dockerDeploymentReleases.image })
      .from(dockerDeploymentReleases)
      .where(
        and(
          eq(dockerDeploymentReleases.deploymentId, policy.deploymentId),
          eq(dockerDeploymentReleases.status, 'succeeded'),
          isNotNull(dockerDeploymentReleases.image)
        )
      )
      .orderBy(desc(dockerDeploymentReleases.createdAt))
      .limit(20);
    return (
      releases
        .map((release) => String(release.image ?? '').trim())
        .find(
          (image) =>
            image.length > 0 &&
            !/^sha256:[0-9a-f]{64}$/i.test(image) &&
            !/^127\.0\.0\.1:5443\//i.test(image) &&
            !/(^|\/)gateway\/availability\//i.test(image)
        ) ?? null
    );
  }

  private async updateOperationPhase(
    operationId: string,
    phase: OperationRow['phase'],
    progress?: OperationRow['progress']
  ): Promise<void> {
    const leaseOwner = this.requireActiveLeaseOwner(operationId);
    const [updated] = await this.db
      .update(dockerAvailabilityOperations)
      .set({
        phase,
        ...(progress ? { progress } : {}),
        leaseHeartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + OPERATION_LEASE_MS),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dockerAvailabilityOperations.id, operationId),
          eq(dockerAvailabilityOperations.leaseOwner, leaseOwner),
          eq(dockerAvailabilityOperations.status, 'running')
        )
      )
      .returning({ id: dockerAvailabilityOperations.id, policyId: dockerAvailabilityOperations.policyId });
    if (!updated) {
      throw new AppError(
        409,
        'AVAILABILITY_OPERATION_LEASE_LOST',
        'Availability operation no longer owns its execution lease'
      );
    }
    this.events.publish('docker.availability.operation.changed', {
      policyId: updated.policyId,
      operationId,
      phase,
    });
  }

  private requireActiveLeaseOwner(operationId: string): string {
    const leaseOwner = this.activeLeases.get(operationId);
    if (!leaseOwner) throw new Error('Availability operation lease is unavailable');
    return leaseOwner;
  }

  private async refreshPolicyStatus(policyId: string, code: string, message: string): Promise<void> {
    const policy = await this.requirePolicy(policyId);
    const placements = await this.db
      .select()
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.policyId, policyId));
    const serving = placements.filter((placement) => placement.serving && placement.actualState === 'serving').length;
    const status: DockerAvailabilityPolicyStatus = policy.shouldRun
      ? serving > 0
        ? 'degraded'
        : 'unavailable'
      : 'failed';
    await this.db
      .update(dockerAvailabilityPolicies)
      .set({ status, lastErrorCode: code, lastErrorMessage: message, updatedAt: new Date() })
      .where(eq(dockerAvailabilityPolicies.id, policyId));
    this.publishPolicy(policyId, status);
  }

  private disableSurvivorIsValid(policy: PolicyRow, placement: PlacementRow): boolean {
    if (!this.nodeRegistry.getNode(placement.nodeId)) return false;
    if (!policy.shouldRun) {
      return !['unreachable', 'cleanup_pending'].includes(placement.actualState);
    }
    return (
      placement.actualState === 'serving' &&
      placement.serving &&
      placement.dependencyState === 'ready' &&
      placement.applicationHealth === 'healthy'
    );
  }

  private placementKeepScore(placement: PlacementRow, resource: DockerAvailabilityResolvedResource): number {
    let score = 0;
    if (placement.nodeId === resource.currentNodeId) score += 100;
    if (placement.serving) score += 50;
    if (placement.actualState === 'serving') score += 25;
    if (placement.applicationHealth === 'healthy') score += 10;
    return score;
  }

  private rolloutExceedsUnavailableBudget(
    resourceKind: DockerAvailabilityResolvedResource['kind'],
    placementServing: boolean,
    servingCount: number,
    desiredCount: number,
    maxUnavailable: number
  ): boolean {
    if (resourceKind === 'deployment' || !placementServing) return false;
    return servingCount - 1 < Math.max(0, desiredCount - maxUnavailable);
  }

  private normalizeError(error: unknown): { code: string; message: string; retryable: boolean } {
    if (error instanceof AppError) {
      const details = error.details as Record<string, unknown> | undefined;
      return {
        code: error.code,
        message: sanitizeAvailabilityErrorMessage(error.message),
        retryable: details?.retryable === true,
      };
    }
    // A relay restart can reject an in-flight RPC before our adapters wrap it.
    // Preserve the operation lease/retry path instead of terminally failing HA.
    if (error instanceof Error && 'code' in error && error.code === 14) {
      return {
        code: 'AVAILABILITY_TRANSPORT_UNAVAILABLE',
        message: sanitizeAvailabilityErrorMessage(error.message),
        retryable: true,
      };
    }
    return {
      code: 'AVAILABILITY_OPERATION_FAILED',
      message: sanitizeAvailabilityErrorMessage(error instanceof Error ? error.message : error),
      retryable: false,
    };
  }

  private async lockPolicy(tx: DrizzleTransaction, policyId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-availability-policy:${policyId}`}))`);
  }

  private async lockResource(tx: DrizzleTransaction, resource: DockerAvailabilityResolvedResource): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`docker-availability-resource:${resource.kind}:${resource.resourceId}`}))`
    );
  }

  private async recordMutation(action: string, policyId: string, userId: string, details: Record<string, unknown>) {
    await this.audit.log({
      userId,
      action: `docker.availability.${action}`,
      resourceType: 'docker_availability_policy',
      resourceId: policyId,
      details,
    });
    this.publishPolicy(policyId, action);
  }

  private publishPolicy(policyId: string, action: string, nodeId?: string): void {
    this.events.publish('docker.availability.changed', {
      policyId,
      action,
      ...(nodeId ? { nodeId } : {}),
    });
  }

  private kick(): void {
    queueMicrotask(() => {
      void this.processPendingOperations();
    });
  }
}
