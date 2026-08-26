import { z } from '@hono/zod-openapi';

export const COMPOSE_YAML_MAX_BYTES = 1024 * 1024;

export const ComposeProjectNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Compose project names must use lowercase letters, numbers, underscores, or dashes');

export const ComposeYamlInputSchema = z.object({
  projectName: ComposeProjectNameSchema,
  yaml: z.string().min(1).max(COMPOSE_YAML_MAX_BYTES),
  variables: z.record(z.string(), z.string()).default({}),
  secretKeys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
});

export const ComposeCreateInputSchema = ComposeYamlInputSchema;
export const ComposeRevisionCreateInputSchema = ComposeYamlInputSchema.omit({ projectName: true });
export const ComposeAdoptInputSchema = ComposeRevisionCreateInputSchema;

export const ComposeOperationActionSchema = z.enum([
  'apply',
  'pull_apply',
  'start',
  'stop',
  'restart',
  'down',
  'delete_volumes',
  'cancel',
]);

export const ComposeOperationInputSchema = z.object({
  revisionId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(8).max(200),
  removeOrphans: z.boolean().default(false),
  volumeNames: z.array(z.string().min(1).max(255)).max(100).default([]),
});

export const ComposeOperationListQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const ComposeSecretCreateSchema = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  value: z.string(),
});

export const ComposeSecretUpdateSchema = z.object({ value: z.string() });

export type ComposeYamlInput = z.infer<typeof ComposeYamlInputSchema>;
export type ComposeCreateInput = z.infer<typeof ComposeCreateInputSchema>;
export type ComposeRevisionCreateInput = z.infer<typeof ComposeRevisionCreateInputSchema>;
export type ComposeOperationAction = z.infer<typeof ComposeOperationActionSchema>;
export type ComposeOperationInput = z.infer<typeof ComposeOperationInputSchema>;
export type ComposeOperationListQuery = z.infer<typeof ComposeOperationListQuerySchema>;
