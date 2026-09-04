import type {
  DockerAvailabilityMode,
  DockerAvailabilityNodeSelectionMode,
  DockerAvailabilityOperationPhase,
  DockerAvailabilityOperationType,
  DockerAvailabilityResourceKind,
  DockerAvailabilityRolloutPolicy,
} from '@/db/schema/index.js';

export type DockerAvailabilityResource =
  | { type: 'container'; nodeId: string; containerName: string }
  | { type: 'deployment'; deploymentId: string }
  | { type: 'compose'; composeProjectId: string };

export interface DockerAvailabilityPolicyInput {
  resource: DockerAvailabilityResource;
  mode: Exclude<DockerAvailabilityMode, 'single'>;
  desiredReplicaCount: number;
  nodeSelectionMode: DockerAvailabilityNodeSelectionMode;
  selectedNodeIds: string[];
  rolloutPolicy: DockerAvailabilityRolloutPolicy;
  offlineReplacementGraceSeconds: number;
}

export interface DockerAvailabilityPolicyUpdateInput {
  mode?: Exclude<DockerAvailabilityMode, 'single'>;
  desiredReplicaCount?: number;
  nodeSelectionMode?: DockerAvailabilityNodeSelectionMode;
  selectedNodeIds?: string[];
  rolloutPolicy?: DockerAvailabilityRolloutPolicy;
  offlineReplacementGraceSeconds?: number;
}

export interface DockerAvailabilityIssue {
  code: string;
  message: string;
  nodeId?: string;
  resource?: string;
}

export interface DockerAvailabilityCandidateNode {
  id: string;
  slug: string;
  hostname: string;
  compatible: boolean;
  reasonCode?: string;
  rank: number;
}

export interface DockerAvailabilityResolvedResource {
  kind: DockerAvailabilityResourceKind;
  reference: DockerAvailabilityResource;
  resourceId: string;
  displayName: string;
  currentNodeId: string;
  viewScope: 'docker:containers:view' | 'docker:compose:view';
  manageScope: 'docker:containers:manage' | 'docker:compose:manage';
  specFingerprint: string;
  portableSpec: Record<string, unknown>;
  imageReference?: string;
  sourceImageReference?: string;
  composeRevisionId?: string;
  running: boolean;
  authoritativeSnapshot?: boolean;
}

export interface DockerAvailabilityAdapterPreflight {
  blockers: DockerAvailabilityIssue[];
  warnings: DockerAvailabilityIssue[];
}

export interface DockerAvailabilityPlacementResult {
  acknowledgedGeneration: number;
  actualState: 'ready' | 'serving' | 'stopped' | 'failed' | 'cleanup_pending';
  serving: boolean;
  dependencyState: 'pending' | 'ready' | 'degraded' | 'failed';
  applicationHealth: 'unknown' | 'starting' | 'healthy' | 'unhealthy';
  runtimeIdentity?: Record<string, unknown>;
  imageReference?: string;
  composeRevisionId?: string;
}

export interface DockerAvailabilityAdapterContext {
  policyId: string;
  placementId: string;
  operationId: string;
  leaseOwner?: string;
  nodeId: string;
  generation: number;
  idempotencyKey: string;
  recovering?: boolean;
  targetActiveSlot?: 'blue' | 'green';
  reportProgress?: (phase: DockerAvailabilityOperationPhase, message: string) => Promise<void>;
  resource: DockerAvailabilityResolvedResource;
}

export interface DockerAvailabilityAdapter {
  readonly kind: DockerAvailabilityResourceKind;
  resolve(resource: DockerAvailabilityResource): Promise<DockerAvailabilityResolvedResource>;
  preflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    scopes: string[]
  ): Promise<DockerAvailabilityAdapterPreflight>;
  ensurePlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult>;
  refreshPlacementDependencies(
    context: DockerAvailabilityAdapterContext,
    result: DockerAvailabilityPlacementResult
  ): Promise<void>;
  inspectPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult | null>;
  startPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult>;
  stopPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult>;
  drainPlacement(context: DockerAvailabilityAdapterContext, drainSeconds: number): Promise<void>;
  removePlacement(context: DockerAvailabilityAdapterContext): Promise<void>;
  adoptPlacementAsSingle(context: DockerAvailabilityAdapterContext): Promise<void>;
  deactivatePlacement(context: DockerAvailabilityAdapterContext): Promise<void>;
  deactivatePlacementDependencies(context: DockerAvailabilityAdapterContext): Promise<void>;
  finalizePlacementAsSingle(context: DockerAvailabilityAdapterContext): Promise<void>;
}

export interface DockerAvailabilityQueuedOperation {
  policyId: string;
  type: DockerAvailabilityOperationType;
  targetGeneration: number;
  requestedPolicy?: Record<string, unknown>;
  userId?: string | null;
  idempotencyKey: string;
}
