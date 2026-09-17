import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type DockerAvailabilityPolicyStatus,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
} from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { DockerEnvironmentService } from '@/modules/docker/docker-environment.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { encodeComposeServiceTarget } from '../compose/compose-managed-bindings.js';
import type {
  DockerAvailabilityAdapter,
  DockerAvailabilityIssue,
  DockerAvailabilityPolicyInput,
  DockerAvailabilityPolicyUpdateInput,
  DockerAvailabilityResource,
} from './docker-availability.types.js';
import type { DockerAvailabilityArtifactService } from './docker-availability-artifact.service.js';
import { DockerWorkloadResolverService } from './docker-workload-resolver.service.js';
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
export interface DockerAvailabilityRuntimeAccessIdentity {
  nodeId: string;
  resourceId: string;
}
export class DockerAvailabilityService {
  private readonly workloads: DockerWorkloadResolverService;
  constructor(
    private readonly db: DrizzleClient,
    _nodeRegistry: NodeRegistryService,
    _licensePolicy: LicensePolicyService,
    _audit: AuditService,
    _events: EventBusService,
    _artifacts?: DockerAvailabilityArtifactService,
    _environment?: DockerEnvironmentService,
    workloadResolver?: DockerWorkloadResolverService
  ) {
    this.workloads = workloadResolver ?? new DockerWorkloadResolverService(db);
  }
  registerAdapter(_adapter: DockerAvailabilityAdapter): void {}
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
  start(): void {}
  stop(): void {}
  async preflight(
    _input: DockerAvailabilityPolicyInput,
    _scopes: string[]
  ): Promise<{
    eligible: boolean;
    resource: DockerAvailabilityResource;
    proposedPolicy: {
      mode: 'replicated' | 'failover';
      desiredReplicaCount: number;
      nodeSelectionMode: import('@/db/schema/index.js').DockerAvailabilityNodeSelectionMode;
      selectedNodeIds: string[];
      rolloutPolicy: import('@/db/schema/index.js').DockerAvailabilityRolloutPolicy;
      offlineReplacementGraceSeconds: number;
    };
    blockers: DockerAvailabilityIssue[];
    warnings: DockerAvailabilityIssue[];
    candidateNodes: {
      id: string;
      slug: string;
      hostname: string;
      compatible: boolean;
      reasonCode?: string;
    }[];
    currentPolicy: {
      sourceImageReference: string | null;
      serviceCount: number | undefined;
      placements: {
        id: string;
        policyId: string;
        nodeId: string;
        generation: number;
        desiredState: import('@/db/schema/index.js').DockerAvailabilityPlacementDesiredState;
        actualState: import('@/db/schema/index.js').DockerAvailabilityPlacementActualState;
        serving: boolean;
        specFingerprint: string;
        imageReference: string | null;
        composeRevisionId: string | null;
        runtimeIdentity: Record<string, unknown>;
        dependencyState: import('@/db/schema/index.js').DockerAvailabilityDependencyState;
        applicationHealth: import('@/db/schema/index.js').DockerAvailabilityHealthState;
        lastObservedAt: Date | null;
        unavailableSince: Date | null;
        operationId: string | null;
        lastErrorCode: string | null;
        lastErrorMessage: string | null;
        createdAt: Date;
        updatedAt: Date;
      }[];
      latestOperation: {
        id: string;
        policyId: string;
        type: import('@/db/schema/index.js').DockerAvailabilityOperationType;
        status: import('@/db/schema/index.js').DockerAvailabilityOperationStatus;
        phase: import('@/db/schema/index.js').DockerAvailabilityOperationPhase;
        targetGeneration: number;
        idempotencyKey: string;
        requestedPolicy: Record<string, unknown>;
        progress: import('@/db/schema/index.js').DockerAvailabilityOperationProgress;
        leaseOwner: string | null;
        leaseHeartbeatAt: Date | null;
        leaseExpiresAt: Date | null;
        retryAttempts: number;
        nextAttemptAt: Date | null;
        retryOfOperationId: string | null;
        errorCode: string | null;
        errorMessage: string | null;
        createdById: string | null;
        createdAt: Date;
        startedAt: Date | null;
        updatedAt: Date;
        completedAt: Date | null;
      };
      id: string;
      resourceKind: import('@/db/schema/index.js').DockerAvailabilityResourceKind;
      displayName: string;
      status: DockerAvailabilityPolicyStatus;
      mode: import('@/db/schema/index.js').DockerAvailabilityMode;
      createdAt: Date;
      updatedAt: Date;
      createdById: string | null;
      originNodeId: string | null;
      sourceNodeId: string | null;
      containerName: string | null;
      updatedById: string | null;
      deploymentId: string | null;
      composeProjectId: string | null;
      specFingerprint: string;
      imageReference: string | null;
      composeRevisionId: string | null;
      shouldRun: boolean;
      desiredReplicaCount: number;
      nodeSelectionMode: import('@/db/schema/index.js').DockerAvailabilityNodeSelectionMode;
      selectedNodeIds: string[];
      desiredGeneration: number;
      rolloutPolicy: import('@/db/schema/index.js').DockerAvailabilityRolloutPolicy;
      offlineReplacementGraceSeconds: number;
      lastErrorCode: string | null;
      lastErrorMessage: string | null;
    } | null;
  }> {
    return commercialModuleUnavailable();
  }
  async enable(
    _input: DockerAvailabilityPolicyInput,
    _userId: string,
    _scopes: string[]
  ): Promise<{
    sourceImageReference: string | null;
    serviceCount: number | undefined;
    placements: {
      id: string;
      policyId: string;
      nodeId: string;
      generation: number;
      desiredState: import('@/db/schema/index.js').DockerAvailabilityPlacementDesiredState;
      actualState: import('@/db/schema/index.js').DockerAvailabilityPlacementActualState;
      serving: boolean;
      specFingerprint: string;
      imageReference: string | null;
      composeRevisionId: string | null;
      runtimeIdentity: Record<string, unknown>;
      dependencyState: import('@/db/schema/index.js').DockerAvailabilityDependencyState;
      applicationHealth: import('@/db/schema/index.js').DockerAvailabilityHealthState;
      lastObservedAt: Date | null;
      unavailableSince: Date | null;
      operationId: string | null;
      lastErrorCode: string | null;
      lastErrorMessage: string | null;
      createdAt: Date;
      updatedAt: Date;
    }[];
    latestOperation: {
      id: string;
      policyId: string;
      type: import('@/db/schema/index.js').DockerAvailabilityOperationType;
      status: import('@/db/schema/index.js').DockerAvailabilityOperationStatus;
      phase: import('@/db/schema/index.js').DockerAvailabilityOperationPhase;
      targetGeneration: number;
      idempotencyKey: string;
      requestedPolicy: Record<string, unknown>;
      progress: import('@/db/schema/index.js').DockerAvailabilityOperationProgress;
      leaseOwner: string | null;
      leaseHeartbeatAt: Date | null;
      leaseExpiresAt: Date | null;
      retryAttempts: number;
      nextAttemptAt: Date | null;
      retryOfOperationId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      createdById: string | null;
      createdAt: Date;
      startedAt: Date | null;
      updatedAt: Date;
      completedAt: Date | null;
    };
    id: string;
    resourceKind: import('@/db/schema/index.js').DockerAvailabilityResourceKind;
    displayName: string;
    status: DockerAvailabilityPolicyStatus;
    mode: import('@/db/schema/index.js').DockerAvailabilityMode;
    createdAt: Date;
    updatedAt: Date;
    createdById: string | null;
    originNodeId: string | null;
    sourceNodeId: string | null;
    containerName: string | null;
    updatedById: string | null;
    deploymentId: string | null;
    composeProjectId: string | null;
    specFingerprint: string;
    imageReference: string | null;
    composeRevisionId: string | null;
    shouldRun: boolean;
    desiredReplicaCount: number;
    nodeSelectionMode: import('@/db/schema/index.js').DockerAvailabilityNodeSelectionMode;
    selectedNodeIds: string[];
    desiredGeneration: number;
    rolloutPolicy: import('@/db/schema/index.js').DockerAvailabilityRolloutPolicy;
    offlineReplacementGraceSeconds: number;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async getByResource(
    _resourceRef: DockerAvailabilityResource,
    _scopes: string[]
  ): Promise<{
    sourceImageReference: string | null;
    serviceCount: number | undefined;
    placements: {
      id: string;
      policyId: string;
      nodeId: string;
      generation: number;
      desiredState: import('@/db/schema/index.js').DockerAvailabilityPlacementDesiredState;
      actualState: import('@/db/schema/index.js').DockerAvailabilityPlacementActualState;
      serving: boolean;
      specFingerprint: string;
      imageReference: string | null;
      composeRevisionId: string | null;
      runtimeIdentity: Record<string, unknown>;
      dependencyState: import('@/db/schema/index.js').DockerAvailabilityDependencyState;
      applicationHealth: import('@/db/schema/index.js').DockerAvailabilityHealthState;
      lastObservedAt: Date | null;
      unavailableSince: Date | null;
      operationId: string | null;
      lastErrorCode: string | null;
      lastErrorMessage: string | null;
      createdAt: Date;
      updatedAt: Date;
    }[];
    latestOperation: {
      id: string;
      policyId: string;
      type: import('@/db/schema/index.js').DockerAvailabilityOperationType;
      status: import('@/db/schema/index.js').DockerAvailabilityOperationStatus;
      phase: import('@/db/schema/index.js').DockerAvailabilityOperationPhase;
      targetGeneration: number;
      idempotencyKey: string;
      requestedPolicy: Record<string, unknown>;
      progress: import('@/db/schema/index.js').DockerAvailabilityOperationProgress;
      leaseOwner: string | null;
      leaseHeartbeatAt: Date | null;
      leaseExpiresAt: Date | null;
      retryAttempts: number;
      nextAttemptAt: Date | null;
      retryOfOperationId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      createdById: string | null;
      createdAt: Date;
      startedAt: Date | null;
      updatedAt: Date;
      completedAt: Date | null;
    };
    id: string;
    resourceKind: import('@/db/schema/index.js').DockerAvailabilityResourceKind;
    displayName: string;
    status: DockerAvailabilityPolicyStatus;
    mode: import('@/db/schema/index.js').DockerAvailabilityMode;
    createdAt: Date;
    updatedAt: Date;
    createdById: string | null;
    originNodeId: string | null;
    sourceNodeId: string | null;
    containerName: string | null;
    updatedById: string | null;
    deploymentId: string | null;
    composeProjectId: string | null;
    specFingerprint: string;
    imageReference: string | null;
    composeRevisionId: string | null;
    shouldRun: boolean;
    desiredReplicaCount: number;
    nodeSelectionMode: import('@/db/schema/index.js').DockerAvailabilityNodeSelectionMode;
    selectedNodeIds: string[];
    desiredGeneration: number;
    rolloutPolicy: import('@/db/schema/index.js').DockerAvailabilityRolloutPolicy;
    offlineReplacementGraceSeconds: number;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
  } | null> {
    return null;
  }
  async resolveManagedDatabaseBindingPolicyId(
    _target: DockerAvailabilityManagedDatabaseTarget
  ): Promise<string | null> {
    return null;
  }
  async queueDependencyRollout(_policyId: string, _userId: string | null): Promise<string | null> {
    return commercialModuleUnavailable();
  }
  async removeManagedDatabaseBinding(_policyId: string, _userId: string | null): Promise<void> {
    return commercialModuleUnavailable();
  }
  async updateContainerConfiguration(
    _nodeId: string,
    _containerName: string,
    _patch: Record<string, unknown>,
    _userId: string | null,
    _options?: {
      waitForCompletion?: boolean;
      forceRollout?: boolean;
    }
  ): Promise<boolean> {
    return false;
  }
  async updateContainerEnvironment(
    _nodeId: string,
    _containerName: string,
    _env: Record<string, string> | undefined,
    _removeEnv: string[] | undefined,
    _userId: string
  ): Promise<boolean> {
    return false;
  }
  async getContainerEnvironment(_nodeId: string, _containerName: string): Promise<string[] | null> {
    return null;
  }
  async getContainerConfiguration(
    _nodeId: string,
    _containerName: string
  ): Promise<{
    image: string;
    runtimeProfile?: string;
    shouldRun: boolean;
    nodeId: string;
    containerName: string;
  } | null> {
    return null;
  }
  async deployDeployment(
    _deploymentId: string,
    _input: {
      image?: string;
      tag?: string;
      env?: Record<string, string>;
      desiredConfig?: Record<string, any>;
    },
    _targetActiveSlot: 'blue' | 'green',
    _userId: string | null,
    _source: string,
    _releaseId?: string
  ): Promise<{
    desiredConfig: any;
    shouldRun: boolean;
    activeSlot: 'blue' | 'green';
  }> {
    return commercialModuleUnavailable();
  }
  async setContainerRunning(
    _nodeId: string,
    _containerName: string,
    _running: boolean,
    _userId: string,
    _restart?: boolean
  ): Promise<boolean> {
    return false;
  }
  async isContainerManaged(_nodeId: string, _containerName: string): Promise<boolean> {
    return false;
  }
  async isDeploymentManaged(_deploymentId: string): Promise<boolean> {
    return false;
  }
  async updateDeploymentConfiguration(
    _deploymentId: string,
    _snapshot: {
      name: string;
      desiredConfig: Record<string, any>;
      health: Record<string, any>;
      routes: Array<Record<string, any>>;
      drainSeconds: number;
    },
    _userId: string | null,
    _reason?: string
  ): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async setDeploymentRunning(
    _deploymentId: string,
    _running: boolean,
    _userId: string | null,
    _restart?: boolean
  ): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async switchDeploymentSlot(
    _deploymentId: string,
    _targetActiveSlot: 'blue' | 'green',
    _userId: string | null
  ): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async isComposeManaged(_projectId: string): Promise<boolean> {
    return false;
  }
  async containerRemoved(_nodeId: string, _containerName: string): Promise<void> {}
  async removeComposeManaged(_projectId: string, _userId: string | null): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async applyComposeRevision(_projectId: string, _revisionId: string, _userId: string | null): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async setComposeRunning(
    _projectId: string,
    _running: boolean,
    _userId: string | null,
    _restart?: boolean
  ): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async get(
    _policyId: string,
    _scopes: string[]
  ): Promise<{
    sourceImageReference: string | null;
    serviceCount: number | undefined;
    placements: {
      id: string;
      policyId: string;
      nodeId: string;
      generation: number;
      desiredState: import('@/db/schema/index.js').DockerAvailabilityPlacementDesiredState;
      actualState: import('@/db/schema/index.js').DockerAvailabilityPlacementActualState;
      serving: boolean;
      specFingerprint: string;
      imageReference: string | null;
      composeRevisionId: string | null;
      runtimeIdentity: Record<string, unknown>;
      dependencyState: import('@/db/schema/index.js').DockerAvailabilityDependencyState;
      applicationHealth: import('@/db/schema/index.js').DockerAvailabilityHealthState;
      lastObservedAt: Date | null;
      unavailableSince: Date | null;
      operationId: string | null;
      lastErrorCode: string | null;
      lastErrorMessage: string | null;
      createdAt: Date;
      updatedAt: Date;
    }[];
    latestOperation: {
      id: string;
      policyId: string;
      type: import('@/db/schema/index.js').DockerAvailabilityOperationType;
      status: import('@/db/schema/index.js').DockerAvailabilityOperationStatus;
      phase: import('@/db/schema/index.js').DockerAvailabilityOperationPhase;
      targetGeneration: number;
      idempotencyKey: string;
      requestedPolicy: Record<string, unknown>;
      progress: import('@/db/schema/index.js').DockerAvailabilityOperationProgress;
      leaseOwner: string | null;
      leaseHeartbeatAt: Date | null;
      leaseExpiresAt: Date | null;
      retryAttempts: number;
      nextAttemptAt: Date | null;
      retryOfOperationId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      createdById: string | null;
      createdAt: Date;
      startedAt: Date | null;
      updatedAt: Date;
      completedAt: Date | null;
    };
    id: string;
    resourceKind: import('@/db/schema/index.js').DockerAvailabilityResourceKind;
    displayName: string;
    status: DockerAvailabilityPolicyStatus;
    mode: import('@/db/schema/index.js').DockerAvailabilityMode;
    createdAt: Date;
    updatedAt: Date;
    createdById: string | null;
    originNodeId: string | null;
    sourceNodeId: string | null;
    containerName: string | null;
    updatedById: string | null;
    deploymentId: string | null;
    composeProjectId: string | null;
    specFingerprint: string;
    imageReference: string | null;
    composeRevisionId: string | null;
    shouldRun: boolean;
    desiredReplicaCount: number;
    nodeSelectionMode: import('@/db/schema/index.js').DockerAvailabilityNodeSelectionMode;
    selectedNodeIds: string[];
    desiredGeneration: number;
    rolloutPolicy: import('@/db/schema/index.js').DockerAvailabilityRolloutPolicy;
    offlineReplacementGraceSeconds: number;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async listContainerSurfaceStates(
    _nodeId: string,
    _resources: Array<{
      name: string;
      deploymentId?: string | null;
    }>
  ): Promise<Record<string, DockerAvailabilityLogicalState>> {
    return {};
  }
  async listComposeSurfaceStates(_projectIds: string[]): Promise<Record<string, DockerAvailabilityLogicalState>> {
    return {};
  }
  async listOperations(
    _policyId: string,
    _scopes: string[]
  ): Promise<
    {
      id: string;
      policyId: string;
      type: import('@/db/schema/index.js').DockerAvailabilityOperationType;
      status: import('@/db/schema/index.js').DockerAvailabilityOperationStatus;
      phase: import('@/db/schema/index.js').DockerAvailabilityOperationPhase;
      targetGeneration: number;
      idempotencyKey: string;
      requestedPolicy: Record<string, unknown>;
      progress: import('@/db/schema/index.js').DockerAvailabilityOperationProgress;
      leaseOwner: string | null;
      leaseHeartbeatAt: Date | null;
      leaseExpiresAt: Date | null;
      retryAttempts: number;
      nextAttemptAt: Date | null;
      retryOfOperationId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      createdById: string | null;
      createdAt: Date;
      startedAt: Date | null;
      updatedAt: Date;
      completedAt: Date | null;
    }[]
  > {
    return [];
  }
  async listOperationsPage(
    _policyId: string,
    _scopes: string[],
    _page: number,
    _limit: number
  ): Promise<{
    data: {
      id: string;
      policyId: string;
      type: import('@/db/schema/index.js').DockerAvailabilityOperationType;
      status: import('@/db/schema/index.js').DockerAvailabilityOperationStatus;
      phase: import('@/db/schema/index.js').DockerAvailabilityOperationPhase;
      targetGeneration: number;
      idempotencyKey: string;
      requestedPolicy: Record<string, unknown>;
      progress: import('@/db/schema/index.js').DockerAvailabilityOperationProgress;
      leaseOwner: string | null;
      leaseHeartbeatAt: Date | null;
      leaseExpiresAt: Date | null;
      retryAttempts: number;
      nextAttemptAt: Date | null;
      retryOfOperationId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      createdById: string | null;
      createdAt: Date;
      startedAt: Date | null;
      updatedAt: Date;
      completedAt: Date | null;
    }[];
    nextPage: number | null;
  }> {
    return { data: [], nextPage: null };
  }
  async update(
    _policyId: string,
    _input: DockerAvailabilityPolicyUpdateInput,
    _userId: string,
    _scopes: string[]
  ): Promise<{
    sourceImageReference: string | null;
    serviceCount: number | undefined;
    placements: {
      id: string;
      policyId: string;
      nodeId: string;
      generation: number;
      desiredState: import('@/db/schema/index.js').DockerAvailabilityPlacementDesiredState;
      actualState: import('@/db/schema/index.js').DockerAvailabilityPlacementActualState;
      serving: boolean;
      specFingerprint: string;
      imageReference: string | null;
      composeRevisionId: string | null;
      runtimeIdentity: Record<string, unknown>;
      dependencyState: import('@/db/schema/index.js').DockerAvailabilityDependencyState;
      applicationHealth: import('@/db/schema/index.js').DockerAvailabilityHealthState;
      lastObservedAt: Date | null;
      unavailableSince: Date | null;
      operationId: string | null;
      lastErrorCode: string | null;
      lastErrorMessage: string | null;
      createdAt: Date;
      updatedAt: Date;
    }[];
    latestOperation: {
      id: string;
      policyId: string;
      type: import('@/db/schema/index.js').DockerAvailabilityOperationType;
      status: import('@/db/schema/index.js').DockerAvailabilityOperationStatus;
      phase: import('@/db/schema/index.js').DockerAvailabilityOperationPhase;
      targetGeneration: number;
      idempotencyKey: string;
      requestedPolicy: Record<string, unknown>;
      progress: import('@/db/schema/index.js').DockerAvailabilityOperationProgress;
      leaseOwner: string | null;
      leaseHeartbeatAt: Date | null;
      leaseExpiresAt: Date | null;
      retryAttempts: number;
      nextAttemptAt: Date | null;
      retryOfOperationId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      createdById: string | null;
      createdAt: Date;
      startedAt: Date | null;
      updatedAt: Date;
      completedAt: Date | null;
    };
    id: string;
    resourceKind: import('@/db/schema/index.js').DockerAvailabilityResourceKind;
    displayName: string;
    status: DockerAvailabilityPolicyStatus;
    mode: import('@/db/schema/index.js').DockerAvailabilityMode;
    createdAt: Date;
    updatedAt: Date;
    createdById: string | null;
    originNodeId: string | null;
    sourceNodeId: string | null;
    containerName: string | null;
    updatedById: string | null;
    deploymentId: string | null;
    composeProjectId: string | null;
    specFingerprint: string;
    imageReference: string | null;
    composeRevisionId: string | null;
    shouldRun: boolean;
    desiredReplicaCount: number;
    nodeSelectionMode: import('@/db/schema/index.js').DockerAvailabilityNodeSelectionMode;
    selectedNodeIds: string[];
    desiredGeneration: number;
    rolloutPolicy: import('@/db/schema/index.js').DockerAvailabilityRolloutPolicy;
    offlineReplacementGraceSeconds: number;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async disable(
    _policyId: string,
    _input: DockerAvailabilityDisableInput,
    _userId: string,
    _scopes: string[]
  ): Promise<{
    sourceImageReference: string | null;
    serviceCount: number | undefined;
    placements: {
      id: string;
      policyId: string;
      nodeId: string;
      generation: number;
      desiredState: import('@/db/schema/index.js').DockerAvailabilityPlacementDesiredState;
      actualState: import('@/db/schema/index.js').DockerAvailabilityPlacementActualState;
      serving: boolean;
      specFingerprint: string;
      imageReference: string | null;
      composeRevisionId: string | null;
      runtimeIdentity: Record<string, unknown>;
      dependencyState: import('@/db/schema/index.js').DockerAvailabilityDependencyState;
      applicationHealth: import('@/db/schema/index.js').DockerAvailabilityHealthState;
      lastObservedAt: Date | null;
      unavailableSince: Date | null;
      operationId: string | null;
      lastErrorCode: string | null;
      lastErrorMessage: string | null;
      createdAt: Date;
      updatedAt: Date;
    }[];
    latestOperation: {
      id: string;
      policyId: string;
      type: import('@/db/schema/index.js').DockerAvailabilityOperationType;
      status: import('@/db/schema/index.js').DockerAvailabilityOperationStatus;
      phase: import('@/db/schema/index.js').DockerAvailabilityOperationPhase;
      targetGeneration: number;
      idempotencyKey: string;
      requestedPolicy: Record<string, unknown>;
      progress: import('@/db/schema/index.js').DockerAvailabilityOperationProgress;
      leaseOwner: string | null;
      leaseHeartbeatAt: Date | null;
      leaseExpiresAt: Date | null;
      retryAttempts: number;
      nextAttemptAt: Date | null;
      retryOfOperationId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      createdById: string | null;
      createdAt: Date;
      startedAt: Date | null;
      updatedAt: Date;
      completedAt: Date | null;
    };
    id: string;
    resourceKind: import('@/db/schema/index.js').DockerAvailabilityResourceKind;
    displayName: string;
    status: DockerAvailabilityPolicyStatus;
    mode: import('@/db/schema/index.js').DockerAvailabilityMode;
    createdAt: Date;
    updatedAt: Date;
    createdById: string | null;
    originNodeId: string | null;
    sourceNodeId: string | null;
    containerName: string | null;
    updatedById: string | null;
    deploymentId: string | null;
    composeProjectId: string | null;
    specFingerprint: string;
    imageReference: string | null;
    composeRevisionId: string | null;
    shouldRun: boolean;
    desiredReplicaCount: number;
    nodeSelectionMode: import('@/db/schema/index.js').DockerAvailabilityNodeSelectionMode;
    selectedNodeIds: string[];
    desiredGeneration: number;
    rolloutPolicy: import('@/db/schema/index.js').DockerAvailabilityRolloutPolicy;
    offlineReplacementGraceSeconds: number;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async retryOperation(
    _policyId: string,
    _operationId: string,
    _userId: string,
    _scopes: string[]
  ): Promise<{
    id: string;
    type: import('@/db/schema/index.js').DockerAvailabilityOperationType;
    status: import('@/db/schema/index.js').DockerAvailabilityOperationStatus;
    createdAt: Date;
    updatedAt: Date;
    createdById: string | null;
    policyId: string;
    phase: import('@/db/schema/index.js').DockerAvailabilityOperationPhase;
    targetGeneration: number;
    idempotencyKey: string;
    requestedPolicy: Record<string, unknown>;
    progress: import('@/db/schema/index.js').DockerAvailabilityOperationProgress;
    leaseOwner: string | null;
    leaseHeartbeatAt: Date | null;
    leaseExpiresAt: Date | null;
    retryAttempts: number;
    nextAttemptAt: Date | null;
    retryOfOperationId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  async recoverInterruptedOperations(): Promise<void> {}
  async processPendingOperations(): Promise<void> {}
  async reconcileNode(_nodeId: string): Promise<void> {}
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
}
