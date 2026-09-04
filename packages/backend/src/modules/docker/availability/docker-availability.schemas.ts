import { z } from '@hono/zod-openapi';

const UUID = z.string().uuid();

const uniqueUuidArray = z.array(UUID).refine((values) => new Set(values).size === values.length, {
  message: 'Selected Docker nodes must be unique',
});

export const DockerAvailabilityResourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('container'),
    nodeId: UUID,
    containerName: z.string().trim().min(1).max(255),
  }),
  z.object({
    type: z.literal('deployment'),
    deploymentId: UUID,
  }),
  z.object({
    type: z.literal('compose'),
    composeProjectId: UUID,
  }),
]);

export const DockerAvailabilityModeSchema = z.enum(['single', 'replicated', 'failover']);
export const DockerAvailabilityPolicyModeSchema = z.enum(['replicated', 'failover']);
export const DockerAvailabilityNodeSelectionModeSchema = z.enum(['all_compatible', 'selected']);

export const DockerAvailabilityRolloutPolicySchema = z.object({
  maxUnavailable: z.number().int().min(0).max(32),
  maxSurge: z.number().int().min(0).max(32),
  drainSeconds: z.number().int().min(0).max(3600),
});

const DockerAvailabilityRolloutPolicyInputSchema = DockerAvailabilityRolloutPolicySchema.extend({
  maxUnavailable: z.number().int().min(0).max(32).default(0),
  maxSurge: z.number().int().min(0).max(32).default(1),
  drainSeconds: z.number().int().min(0).max(3600).default(30),
}).default({ maxUnavailable: 0, maxSurge: 1, drainSeconds: 30 });

const DockerAvailabilityPolicyValuesSchema = z.object({
  mode: DockerAvailabilityPolicyModeSchema,
  desiredReplicaCount: z.number().int().min(1).max(32),
  nodeSelectionMode: DockerAvailabilityNodeSelectionModeSchema,
  selectedNodeIds: uniqueUuidArray.default([]),
  rolloutPolicy: DockerAvailabilityRolloutPolicyInputSchema,
  offlineReplacementGraceSeconds: z.number().int().min(0).max(3600).default(15),
});

export const DockerAvailabilityPolicyInputSchema = z
  .object({
    resource: DockerAvailabilityResourceSchema,
  })
  .merge(DockerAvailabilityPolicyValuesSchema)
  .superRefine((value, context) => {
    if (value.mode === 'replicated' && (value.desiredReplicaCount < 2 || value.desiredReplicaCount > 32)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['desiredReplicaCount'],
        message: 'Replicated mode requires 2 through 32 replicas',
      });
    }
    if (value.mode === 'failover' && value.desiredReplicaCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['desiredReplicaCount'],
        message: 'Failover mode requires exactly one serving placement',
      });
    }
    if (value.nodeSelectionMode === 'selected' && value.selectedNodeIds.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedNodeIds'],
        message: 'Selected node mode requires at least one Docker node',
      });
    }
    if (value.nodeSelectionMode === 'all_compatible' && value.selectedNodeIds.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedNodeIds'],
        message: 'Selected node IDs must be empty when using all-compatible node selection',
      });
    }
  });

export const DockerAvailabilityPolicyUpdateSchema = z
  .object({
    mode: DockerAvailabilityPolicyModeSchema.optional(),
    desiredReplicaCount: z.number().int().min(1).max(32).optional(),
    nodeSelectionMode: DockerAvailabilityNodeSelectionModeSchema.optional(),
    selectedNodeIds: uniqueUuidArray.optional(),
    rolloutPolicy: DockerAvailabilityRolloutPolicySchema.optional(),
    offlineReplacementGraceSeconds: z.number().int().min(0).max(3600).optional(),
  })
  .superRefine((value, context) => {
    if (value.mode === 'replicated' && value.desiredReplicaCount === 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['desiredReplicaCount'],
        message: 'Replicated mode requires 2 through 32 replicas',
      });
    }
    if (value.mode === 'failover' && value.desiredReplicaCount !== undefined && value.desiredReplicaCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['desiredReplicaCount'],
        message: 'Failover mode requires exactly one serving placement',
      });
    }
    if (value.nodeSelectionMode === 'selected' && value.selectedNodeIds?.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedNodeIds'],
        message: 'Selected node mode requires at least one Docker node',
      });
    }
    if (value.nodeSelectionMode === 'all_compatible' && (value.selectedNodeIds?.length ?? 0) > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedNodeIds'],
        message: 'Selected node IDs must be empty when using all-compatible node selection',
      });
    }
  });

export const DockerAvailabilityDisableInputSchema = z.object({
  survivingPlacementId: UUID,
  confirmation: z.string().trim().min(1).max(255),
});

export const DockerAvailabilityPolicyIdSchema = UUID;
export const DockerAvailabilityOperationIdSchema = UUID;

export const DockerAvailabilityByResourceQuerySchema = z
  .object({
    type: z.enum(['container', 'deployment', 'compose']),
    nodeId: UUID.optional(),
    containerName: z.string().trim().min(1).max(255).optional(),
    deploymentId: UUID.optional(),
    composeProjectId: UUID.optional(),
  })
  .superRefine((value, context) => {
    if (value.type === 'container') {
      if (!value.nodeId) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['nodeId'], message: 'Container nodeId is required' });
      }
      if (!value.containerName) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['containerName'],
          message: 'Container containerName is required',
        });
      }
    }
    if (value.type === 'deployment' && !value.deploymentId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deploymentId'],
        message: 'Deployment deploymentId is required',
      });
    }
    if (value.type === 'compose' && !value.composeProjectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['composeProjectId'],
        message: 'Compose composeProjectId is required',
      });
    }
  });

export type DockerAvailabilityResource = z.infer<typeof DockerAvailabilityResourceSchema>;
export type DockerAvailabilityPolicyInput = z.infer<typeof DockerAvailabilityPolicyInputSchema>;
export type DockerAvailabilityPolicyUpdate = z.infer<typeof DockerAvailabilityPolicyUpdateSchema>;
export type DockerAvailabilityDisableInput = z.infer<typeof DockerAvailabilityDisableInputSchema>;
export type DockerAvailabilityByResourceQuery = z.infer<typeof DockerAvailabilityByResourceQuerySchema>;

export function dockerAvailabilityResourceFromQuery(
  query: DockerAvailabilityByResourceQuery
): DockerAvailabilityResource {
  if (query.type === 'container' && query.nodeId && query.containerName) {
    return { type: 'container', nodeId: query.nodeId, containerName: query.containerName };
  }
  if (query.type === 'deployment' && query.deploymentId) {
    return { type: 'deployment', deploymentId: query.deploymentId };
  }
  if (query.type === 'compose' && query.composeProjectId) {
    return { type: 'compose', composeProjectId: query.composeProjectId };
  }
  throw new Error('Invalid Docker Availability resource query');
}

export const DockerAvailabilityPolicyStatusSchema = z.enum([
  'single',
  'enabling',
  'healthy',
  'degraded',
  'unavailable',
  'scaling',
  'rolling_out',
  'disabling',
  'failed',
]);

export const DockerAvailabilityPlacementDesiredStateSchema = z.enum([
  'serving',
  'standby',
  'draining',
  'stopped',
  'removed',
]);

export const DockerAvailabilityPlacementActualStateSchema = z.enum([
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
  'removed',
]);

export const DockerAvailabilityDependencyStateSchema = z.enum(['pending', 'ready', 'degraded', 'failed']);
export const DockerAvailabilityHealthStateSchema = z.enum(['unknown', 'starting', 'healthy', 'unhealthy']);

export const DockerAvailabilityOperationTypeSchema = z.enum([
  'enable',
  'scale',
  'rollout',
  'heal',
  'disable',
  'stale_cleanup',
]);

export const DockerAvailabilityOperationStatusSchema = z.enum([
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cleanup_pending',
  'cancelled',
]);

export const DockerAvailabilityOperationPhaseSchema = z.enum([
  'queued',
  'locking',
  'validating',
  'selecting_nodes',
  'preparing_images',
  'preparing_dependencies',
  'starting',
  'checking_health',
  'activating_routes',
  'draining',
  'stopping',
  'cleaning_up',
  'finalizing',
  'done',
]);

const nullableDate = z.coerce.date().nullable();
const nullableUuid = UUID.nullable();

export const DockerAvailabilityOperationProgressSchema = z.object({
  message: z.string().optional(),
  completedPlacementIds: z.array(UUID).optional(),
  activePlacementId: UUID.optional(),
  totalPlacements: z.number().int().nonnegative().optional(),
  completedPlacements: z.number().int().nonnegative().optional(),
});

export const DockerAvailabilityOperationSchema = z.object({
  id: UUID,
  policyId: UUID,
  type: DockerAvailabilityOperationTypeSchema,
  status: DockerAvailabilityOperationStatusSchema,
  phase: DockerAvailabilityOperationPhaseSchema,
  targetGeneration: z.number().int().min(1),
  idempotencyKey: z.string(),
  requestedPolicy: z.record(z.string(), z.unknown()),
  progress: DockerAvailabilityOperationProgressSchema,
  leaseOwner: z.string().nullable(),
  leaseHeartbeatAt: nullableDate,
  leaseExpiresAt: nullableDate,
  retryOfOperationId: nullableUuid,
  retryAttempts: z.number().int().nonnegative(),
  nextAttemptAt: nullableDate,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdById: nullableUuid,
  createdAt: z.coerce.date(),
  startedAt: nullableDate,
  updatedAt: z.coerce.date(),
  completedAt: nullableDate,
});

export const DockerAvailabilityOperationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const DockerAvailabilityPlacementSchema = z.object({
  id: UUID,
  policyId: UUID,
  nodeId: UUID,
  generation: z.number().int().min(1),
  desiredState: DockerAvailabilityPlacementDesiredStateSchema,
  actualState: DockerAvailabilityPlacementActualStateSchema,
  serving: z.boolean(),
  specFingerprint: z.string(),
  imageReference: z.string().nullable(),
  composeRevisionId: nullableUuid,
  runtimeIdentity: z.record(z.string(), z.unknown()),
  dependencyState: DockerAvailabilityDependencyStateSchema,
  applicationHealth: DockerAvailabilityHealthStateSchema,
  lastObservedAt: nullableDate,
  unavailableSince: nullableDate,
  operationId: nullableUuid,
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const DockerAvailabilityPolicySchema = z.object({
  id: UUID,
  resourceKind: z.enum(['container', 'deployment', 'compose']),
  originNodeId: nullableUuid,
  sourceNodeId: nullableUuid,
  containerName: z.string().nullable(),
  deploymentId: nullableUuid,
  composeProjectId: nullableUuid,
  displayName: z.string(),
  specFingerprint: z.string(),
  imageReference: z.string().nullable(),
  composeRevisionId: nullableUuid,
  shouldRun: z.boolean(),
  mode: DockerAvailabilityModeSchema,
  desiredReplicaCount: z.number().int().min(1).max(32),
  nodeSelectionMode: DockerAvailabilityNodeSelectionModeSchema,
  selectedNodeIds: z.array(UUID),
  desiredGeneration: z.number().int().min(1),
  rolloutPolicy: DockerAvailabilityRolloutPolicySchema,
  offlineReplacementGraceSeconds: z.number().int().min(0).max(3600),
  status: DockerAvailabilityPolicyStatusSchema,
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  createdById: nullableUuid,
  updatedById: nullableUuid,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  placements: z.array(DockerAvailabilityPlacementSchema),
  latestOperation: DockerAvailabilityOperationSchema.nullable(),
});

export const DockerAvailabilityProposedPolicySchema = z.object({
  mode: DockerAvailabilityPolicyModeSchema,
  desiredReplicaCount: z.number().int().min(1).max(32),
  nodeSelectionMode: DockerAvailabilityNodeSelectionModeSchema,
  selectedNodeIds: z.array(UUID),
  rolloutPolicy: DockerAvailabilityRolloutPolicySchema,
  offlineReplacementGraceSeconds: z.number().int().min(0).max(3600),
});

export const DockerAvailabilityIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  nodeId: UUID.optional(),
  resource: z.string().optional(),
});

export const DockerAvailabilityCandidateNodeSchema = z.object({
  id: UUID,
  slug: z.string(),
  hostname: z.string(),
  compatible: z.boolean(),
  reasonCode: z.string().optional(),
});

export const DockerAvailabilityPreflightSchema = z.object({
  eligible: z.boolean(),
  resource: DockerAvailabilityResourceSchema,
  proposedPolicy: DockerAvailabilityProposedPolicySchema,
  blockers: z.array(DockerAvailabilityIssueSchema),
  warnings: z.array(DockerAvailabilityIssueSchema),
  candidateNodes: z.array(DockerAvailabilityCandidateNodeSchema),
  currentPolicy: DockerAvailabilityPolicySchema.nullable(),
});
