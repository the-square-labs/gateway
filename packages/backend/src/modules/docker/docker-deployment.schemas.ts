import { z } from 'zod';
import { DockerGpuSelectionSchema, DockerRuntimeProfileSchema } from './docker.schemas.js';

export const DOCKER_DEPLOYMENT_ROUTES_MAX = 32;

export const DockerDeploymentNameSchema = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/, 'Invalid deployment name');

export const DockerDeploymentRouteSchema = z.object({
  hostPort: z.number().int().min(1).max(65535),
  containerPort: z.number().int().min(1).max(65535),
  isPrimary: z.boolean().default(false),
});

export const DockerDeploymentHealthSchema = z.object({
  path: z.string().min(1).max(500).default('/'),
  statusMin: z.number().int().min(100).max(599).default(200),
  statusMax: z.number().int().min(100).max(599).default(399),
  timeoutSeconds: z.number().int().min(1).max(60).default(5),
  intervalSeconds: z.number().int().min(1).max(60).default(5),
  successThreshold: z.number().int().min(1).max(20).default(2),
  startupGraceSeconds: z.number().int().min(0).max(600).default(5),
  deployTimeoutSeconds: z.number().int().min(5).max(3600).default(300),
});

export const DockerDeploymentDesiredConfigSchema = z.object({
  image: z.string().min(1),
  env: z.record(z.string()).optional(),
  mounts: z
    .array(
      z.object({
        hostPath: z.string().optional(),
        containerPath: z.string().min(1),
        name: z.string().optional(),
        readOnly: z.boolean().default(false),
      })
    )
    .optional(),
  command: z.array(z.string()).optional(),
  entrypoint: z.array(z.string()).optional(),
  workingDir: z.string().optional(),
  user: z.string().optional(),
  labels: z.record(z.string()).optional(),
  restartPolicy: z.enum(['no', 'always', 'unless-stopped', 'on-failure']).default('unless-stopped'),
  runtimeProfile: DockerRuntimeProfileSchema.default('default'),
  runtime: z.record(z.unknown()).optional(),
  gpu: DockerGpuSelectionSchema.optional(),
});

export const DockerDeploymentCreateSchema = z.object({
  name: DockerDeploymentNameSchema,
  image: z.string().min(1),
  registryId: z.string().uuid().optional(),
  routes: z.array(DockerDeploymentRouteSchema).min(1).max(DOCKER_DEPLOYMENT_ROUTES_MAX),
  health: DockerDeploymentHealthSchema.default({}),
  drainSeconds: z.number().int().min(0).max(3600).default(30),
  routerImage: z.string().min(1).default('nginx:alpine'),
  env: z.record(z.string()).optional(),
  mounts: DockerDeploymentDesiredConfigSchema.shape.mounts,
  command: z.array(z.string()).optional(),
  entrypoint: z.array(z.string()).optional(),
  workingDir: z.string().optional(),
  user: z.string().optional(),
  labels: z.record(z.string()).optional(),
  restartPolicy: DockerDeploymentDesiredConfigSchema.shape.restartPolicy,
  runtimeProfile: DockerRuntimeProfileSchema.default('default'),
  runtime: z.record(z.unknown()).optional(),
  gpu: DockerDeploymentDesiredConfigSchema.shape.gpu,
});

export const DockerDeploymentUpdateSchema = z.object({
  name: DockerDeploymentNameSchema.optional(),
  desiredConfig: DockerDeploymentDesiredConfigSchema.partial().optional(),
  routes: z.array(DockerDeploymentRouteSchema).min(1).max(DOCKER_DEPLOYMENT_ROUTES_MAX).optional(),
  health: DockerDeploymentHealthSchema.optional(),
  drainSeconds: z.number().int().min(0).max(3600).optional(),
});

export const DockerDeploymentDeploySchema = z.object({
  image: z.string().min(1).optional(),
  tag: z.string().min(1).optional(),
  registryId: z.string().uuid().optional(),
  env: z.record(z.string()).optional(),
});

export const DockerDeploymentSwitchSchema = z.object({
  slot: z.enum(['blue', 'green']),
  force: z.boolean().default(false),
});

export type DockerDeploymentCreateInput = z.infer<typeof DockerDeploymentCreateSchema>;
export type DockerDeploymentUpdateInput = z.infer<typeof DockerDeploymentUpdateSchema>;
export type DockerDeploymentDeployInput = z.infer<typeof DockerDeploymentDeploySchema>;
export type DockerDeploymentSwitchInput = z.infer<typeof DockerDeploymentSwitchSchema>;
