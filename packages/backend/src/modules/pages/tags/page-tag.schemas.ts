import { z } from 'zod';
import { PageTagNameSchema } from '../tokens/page-deploy-token.schemas.js';

export const PageTagParamSchema = z.object({
  projectId: z.string().uuid(),
  tag: PageTagNameSchema,
});

export const MovePageTagSchema = z.object({
  deploymentId: z.string().uuid(),
});

export type MovePageTagInput = z.infer<typeof MovePageTagSchema>;
