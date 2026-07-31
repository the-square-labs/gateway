import { z } from '@hono/zod-openapi';

export const DockerMigrationResourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('container'),
    containerName: z.string().trim().min(1).max(255),
  }),
  z.object({
    type: z.literal('deployment'),
    deploymentId: z.string().uuid(),
  }),
]);

export const DockerMigrationPreflightInputSchema = z.object({
  resource: DockerMigrationResourceSchema,
  sourceNodeId: z.string().uuid(),
  targetNodeId: z.string().uuid(),
  keepSource: z.boolean().default(false),
});

export const DockerMigrationCreateInputSchema = DockerMigrationPreflightInputSchema.extend({
  preflightFingerprint: z.string().min(16).max(128),
});

export const DockerMigrationIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  resource: z.string().optional(),
});

export const DockerMigrationArtifactPlanSchema = z.object({
  kind: z.enum(['image', 'volume']),
  sourceIdentity: z.string(),
  targetIdentity: z.string(),
  sizeBytes: z.number().int().nonnegative().nullable(),
});

export const DockerMigrationCapacitySchema = z.object({
  requiredBytes: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative().nullable(),
  marginBytes: z.number().int().nonnegative(),
  sufficient: z.boolean(),
});

export const DockerMigrationDeletionPlanItemSchema = z.object({
  type: z.enum(['container', 'deployment', 'volume']),
  name: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export const DockerMigrationPreflightSchema = z.object({
  fingerprint: z.string(),
  resourceType: z.enum(['container', 'deployment']),
  resourceName: z.string(),
  sourceResourceId: z.string(),
  scopeResourceId: z.string(),
  sourceNodeId: z.string().uuid(),
  targetNodeId: z.string().uuid(),
  targetNodeSlug: z.string(),
  keepSource: z.boolean(),
  sourceState: z.string(),
  blockers: z.array(DockerMigrationIssueSchema),
  warnings: z.array(DockerMigrationIssueSchema),
  plannedChanges: z.array(z.string()),
  capacity: DockerMigrationCapacitySchema,
  artifacts: z.array(DockerMigrationArtifactPlanSchema),
  deletionPlan: z.array(DockerMigrationDeletionPlanItemSchema),
  proxyHosts: z.array(
    z.object({
      id: z.string().uuid(),
      enabled: z.boolean(),
      maintenanceAlreadyEnabled: z.boolean(),
    })
  ),
  verificationPlan: z.array(z.string()),
  environmentKeyCount: z.number().int().nonnegative(),
  secretKeyCount: z.number().int().nonnegative(),
});

export const DockerMigrationStatusSchema = z.enum([
  'pending',
  'running',
  'waiting',
  'cancelling',
  'cancelled',
  'completed',
  'failed',
  'cleanup_pending',
  'needs_attention',
]);

export const DockerMigrationSchema = z.object({
  id: z.string().uuid(),
  resourceType: z.enum(['container', 'deployment']),
  resourceName: z.string(),
  deploymentId: z.string().uuid().nullable(),
  sourceNodeId: z.string().uuid(),
  targetNodeId: z.string().uuid(),
  targetNodeSlug: z.string().nullable(),
  targetResourceId: z.string().nullable(),
  keepSource: z.boolean(),
  sourceState: z.string(),
  status: DockerMigrationStatusSchema,
  phase: z.string(),
  progress: z.record(z.string(), z.unknown()),
  verification: z.record(z.string(), z.unknown()),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  cancellationRequestedAt: z.coerce.date().nullable(),
  cutoverAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  startedAt: z.coerce.date().nullable(),
  updatedAt: z.coerce.date(),
  completedAt: z.coerce.date().nullable(),
});

export const DockerMigrationListQuerySchema = z.object({
  status: DockerMigrationStatusSchema.optional(),
  nodeId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type DockerMigrationPreflightInput = z.infer<typeof DockerMigrationPreflightInputSchema>;
export type DockerMigrationCreateInput = z.infer<typeof DockerMigrationCreateInputSchema>;
export type DockerMigrationPreflight = z.infer<typeof DockerMigrationPreflightSchema>;
