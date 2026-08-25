import { z } from 'zod';
import {
  DOCKER_DEPLOYMENT_ROUTES_MAX,
  DockerDeploymentHealthSchema,
  DockerDeploymentNameSchema,
  DockerDeploymentRouteSchema,
} from './docker-deployment.schemas.js';

const RelativeBuildPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'Build paths must stay inside the repository',
  });

export const DockerBuildCommitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/i, 'Invalid commit SHA');
export const DockerBuildPlatformSchema = z.string().regex(/^linux\/(amd64|arm64)(\/v[1-4])?$/);

export const DockerSourceTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('container'),
    nodeId: z.string().uuid(),
    containerName: z.string().min(1).max(255),
  }),
  z.object({
    kind: z.literal('deployment'),
    deploymentId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('compose_project'),
    composeProjectId: z.string().uuid(),
  }),
]);

export const DockerSourceBindingConfigSchema = z.object({
  connectorId: z.string().uuid(),
  projectId: z.string().uuid(),
  branch: z.string().trim().min(1).max(500),
  dockerfilePath: RelativeBuildPathSchema.default('Dockerfile'),
  contextPath: RelativeBuildPathSchema.default('.'),
  composeFilePath: RelativeBuildPathSchema.optional(),
  composeVariables: z.record(z.string().max(65_536)).default({}),
  composeSecretKeys: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
    .max(256)
    .default([]),
  autoBuild: z.boolean().default(true),
  autoDeploy: z.boolean().default(true),
  buildArgs: z.record(z.string().max(16_384)).default({}),
  buildSecretNames: z.array(z.string().min(1).max(255)).max(128).default([]),
  policy: z
    .object({
      vulnerabilityThreshold: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional(),
    })
    .passthrough()
    .default({}),
});

export const DockerBuildSecretNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, 'Invalid Build Secret name');

export const DockerBuildSecretValueSchema = z.object({
  value: z.string().min(1).max(65_536),
});

export const DockerSourceBindingUpsertSchema = DockerSourceBindingConfigSchema.extend({
  target: DockerSourceTargetSchema,
}).superRefine((value, ctx) => {
  if (value.target.kind === 'compose_project' && !value.composeFilePath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['composeFilePath'],
      message: 'Compose file path is required for a Compose project source',
    });
  }
  if (value.target.kind !== 'compose_project' && value.composeFilePath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['composeFilePath'],
      message: 'Compose file path is only valid for a Compose project source',
    });
  }
});

export const DockerSourceResourceCreateSchema = z.object({
  source: DockerSourceBindingConfigSchema,
  resource: z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('container'),
        name: z.string().trim().min(1).max(255),
        restartPolicy: z.enum(['no', 'always', 'unless-stopped', 'on-failure']).default('no'),
        runtimeProfile: z.enum(['default', 'secure']).default('default'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('deployment'),
        name: DockerDeploymentNameSchema,
        routes: z.array(DockerDeploymentRouteSchema).min(1).max(DOCKER_DEPLOYMENT_ROUTES_MAX),
        health: DockerDeploymentHealthSchema.default({}),
        drainSeconds: z.number().int().min(0).max(3600).default(30),
        routerImage: z.string().min(1).default('nginx:alpine'),
        restartPolicy: z.enum(['no', 'always', 'unless-stopped', 'on-failure']).default('unless-stopped'),
        runtimeProfile: z.enum(['default', 'secure']).default('default'),
      })
      .strict(),
  ]),
});

export const DockerBuildCreateSchema = z.object({
  commitSha: DockerBuildCommitShaSchema.optional(),
  force: z.boolean().default(false),
});

export const DockerBuildListQuerySchema = z.object({
  sourceBindingId: z.string().uuid().optional(),
  builderNodeId: z.string().uuid().optional(),
  status: z
    .enum([
      'queued',
      'claimed',
      'checking_out',
      'building',
      'scanning',
      'pushing',
      'deploying',
      'succeeded',
      'failed',
      'cancelled',
      'superseded',
    ])
    .optional(),
  provider: z.enum(['gitlab', 'github', 'git']).optional(),
  branch: z.string().max(500).optional(),
  search: z.string().max(500).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const DockerBuildLogQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(-1).default(-1),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const DockerInternalRegistrySettingsSchema = z
  .object({
    externalAccessEnabled: z.boolean(),
    externalHostname: z.string().trim().min(1).max(253).optional(),
    externalNginxNodeId: z.string().uuid().optional(),
    externalCertificateId: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.externalAccessEnabled) return;
    for (const [field, present] of [
      ['externalHostname', Boolean(value.externalHostname)],
      ['externalNginxNodeId', Boolean(value.externalNginxNodeId)],
      ['externalCertificateId', Boolean(value.externalCertificateId)],
    ] as const) {
      if (!present)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'Required for external access' });
    }
  });

export type DockerSourceBindingUpsertInput = z.infer<typeof DockerSourceBindingUpsertSchema>;
export type DockerSourceTarget = z.infer<typeof DockerSourceTargetSchema>;
export type DockerBuildCreateInput = z.infer<typeof DockerBuildCreateSchema>;
export type DockerBuildListQuery = z.infer<typeof DockerBuildListQuerySchema>;
export type DockerInternalRegistrySettingsInput = z.infer<typeof DockerInternalRegistrySettingsSchema>;
