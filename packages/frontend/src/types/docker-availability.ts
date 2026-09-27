export type DockerAvailabilityResource =
  | { type: "container"; nodeId: string; containerName: string }
  | { type: "deployment"; deploymentId: string }
  | { type: "compose"; composeProjectId: string };

export type DockerAvailabilityMode = "single" | "replicated" | "failover";
export type DockerAvailabilityPolicyMode = Exclude<DockerAvailabilityMode, "single">;
export type DockerAvailabilityNodeSelectionMode = "all_compatible" | "selected";
/** strict never runs two copies of a slot, even under a partition; available keeps serving on a reachable
 * candidate and accepts that two copies can run at once. */
export type DockerAvailabilityPartitionMode = "strict" | "available";

export interface DockerAvailabilityPolicyInput {
  resource: DockerAvailabilityResource;
  mode: DockerAvailabilityPolicyMode;
  desiredReplicaCount: number;
  nodeSelectionMode: DockerAvailabilityNodeSelectionMode;
  selectedNodeIds: string[];
  rolloutPolicy: { maxUnavailable: number; maxSurge: number; drainSeconds: number };
  offlineReplacementGraceSeconds: number;
  /** Serve from the first available nodes of nodePriority and move back to them when they return. */
  priorityMode: boolean;
  /** Ordered node IDs: the first is the primary, the rest are backups in order. */
  nodePriority: string[];
  failbackDelaySeconds: number;
  partitionMode: DockerAvailabilityPartitionMode;
}

export type DockerAvailabilityLeaseMode = "legacy" | "bootstrapping" | "lease" | "closing";

export interface DockerAvailabilityLeaseReason {
  code: string;
  message: string;
  nodeIds?: string[];
}

export interface DockerAvailabilityLeaseBallot {
  round: string;
  incarnation: string;
  proposerId: string;
}

export interface DockerAvailabilityLeaseHolder {
  slot: number;
  holderNodeId: string | null;
  placementId: string | null;
  ballot: DockerAvailabilityLeaseBallot | null;
  observedAt: string;
  holderSince: string | null;
  source: "daemon" | "acceptor" | "relay";
}

export interface DockerAvailabilityLeaseVoterMargin {
  epoch: number;
  joint: boolean;
  voters: number;
  reachable: number;
  required: number;
  margin: number;
}

/** Read-only data-plane lease state of a policy. Null when the policy is not lease-capable. */
export interface DockerAvailabilityLease {
  mode: DockerAvailabilityLeaseMode;
  reason: DockerAvailabilityLeaseReason | null;
  manifestVersion: number;
  epoch: number;
  publishedPartitionMode: DockerAvailabilityPartitionMode | null;
  holders: DockerAvailabilityLeaseHolder[];
  bootstrap: Array<{ slot: number; holderNodeId: string }>;
  strictPending: boolean;
  copiesStoppedAt: string | null;
  voterMargin: DockerAvailabilityLeaseVoterMargin | null;
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
}

export interface DockerAvailabilityPlacement {
  id: string;
  policyId: string;
  nodeId: string;
  generation: number;
  desiredState: "serving" | "standby" | "draining" | "stopped" | "removed";
  actualState:
    | "pending"
    | "preparing_image"
    | "preparing_dependencies"
    | "starting"
    | "checking_health"
    | "ready"
    | "serving"
    | "draining"
    | "stopped"
    | "unreachable"
    | "stale"
    | "failed"
    | "cleanup_pending"
    | "removed";
  serving: boolean;
  specFingerprint: string;
  imageReference: string | null;
  composeRevisionId: string | null;
  runtimeIdentity: Record<string, unknown>;
  dependencyState: "pending" | "ready" | "degraded" | "failed";
  applicationHealth: "unknown" | "starting" | "healthy" | "unhealthy";
  lastObservedAt: string | null;
  unavailableSince: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DockerAvailabilityOperation {
  id: string;
  policyId: string;
  type:
    | "enable"
    | "scale"
    | "rollout"
    | "heal"
    | "disable"
    | "stale_cleanup"
    | "failback"
    | "start"
    | "stop"
    | "restart";
  status:
    | "pending"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "cleanup_pending"
    | "cancelled";
  phase: string;
  targetGeneration: number;
  progress: {
    message?: string;
    activePlacementId?: string;
    completedPlacementIds?: string[];
    totalPlacements?: number;
    completedPlacements?: number;
  };
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt?: string | null;
  nextAttemptAt?: string | null;
  retryAttempts?: number;
  updatedAt: string;
  completedAt: string | null;
}

export interface DockerAvailabilityOperationPage {
  data: DockerAvailabilityOperation[];
  nextPage: number | null;
}

export interface DockerAvailabilityPolicy {
  id: string;
  resourceKind: "container" | "deployment" | "compose";
  originNodeId: string | null;
  sourceNodeId: string | null;
  containerName: string | null;
  deploymentId: string | null;
  composeProjectId: string | null;
  displayName: string;
  specFingerprint: string;
  imageReference: string | null;
  sourceImageReference?: string | null;
  serviceCount?: number;
  composeRevisionId: string | null;
  shouldRun: boolean;
  mode: DockerAvailabilityMode;
  desiredReplicaCount: number;
  nodeSelectionMode: DockerAvailabilityNodeSelectionMode;
  selectedNodeIds: string[];
  desiredGeneration: number;
  rolloutPolicy: { maxUnavailable: number; maxSurge: number; drainSeconds: number };
  offlineReplacementGraceSeconds: number;
  priorityMode: boolean;
  nodePriority: string[];
  failbackDelaySeconds: number;
  partitionMode: DockerAvailabilityPartitionMode;
  status:
    | "single"
    | "enabling"
    | "healthy"
    | "degraded"
    | "unavailable"
    | "scaling"
    | "rolling_out"
    | "disabling"
    | "failed";
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  placements: DockerAvailabilityPlacement[];
  latestOperation: DockerAvailabilityOperation | null;
  lease: DockerAvailabilityLease | null;
}

export interface DockerAvailabilityPreflight {
  eligible: boolean;
  resource: DockerAvailabilityResource;
  proposedPolicy: Omit<DockerAvailabilityPolicyInput, "resource">;
  blockers: DockerAvailabilityIssue[];
  warnings: DockerAvailabilityIssue[];
  candidateNodes: DockerAvailabilityCandidateNode[];
  currentPolicy: DockerAvailabilityPolicy | null;
}
