import { z } from 'zod';
import { PageTagNameSchema } from '../tokens/page-deploy-token.schemas.js';

export const PageDeploymentSourceMetadataSchema = z
  .object({
    provider: z.string().trim().max(64).optional(),
    repository: z.string().trim().max(512).optional(),
    commitSha: z.string().trim().max(128).optional(),
    ref: z.string().trim().max(255).optional(),
    mergeRequest: z.string().trim().max(255).optional(),
    actor: z.string().trim().max(255).optional(),
  })
  .strict()
  .default({});

export const CreatePageDeploymentSchema = z.object({
  projectId: z.string().uuid(),
  declaredSizeBytes: z.number().int().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  idempotencyKey: z.string().trim().min(1).max(255).optional(),
  tag: PageTagNameSchema.optional(),
  source: PageDeploymentSourceMetadataSchema,
});

export const PageDeploymentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreatePageDeploymentInput = z.infer<typeof CreatePageDeploymentSchema>;
export type PageDeploymentListQuery = z.infer<typeof PageDeploymentListQuerySchema>;
