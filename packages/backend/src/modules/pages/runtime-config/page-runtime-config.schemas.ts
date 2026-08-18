import { z } from 'zod';

export const PAGE_RUNTIME_CONFIG_MAX_BYTES = 64 * 1024;

export const SavePageRuntimeConfigSchema = z.object({
  source: z.string().min(1),
  expectedGeneration: z.number().int().min(0),
});

export const ResetPageRuntimeConfigSchema = z.object({
  expectedGeneration: z.number().int().min(0),
});

export const PageRuntimeConfigTagParamSchema = z.object({
  projectId: z.string().uuid(),
  tagId: z.string().uuid(),
});

export type SavePageRuntimeConfigInput = z.infer<typeof SavePageRuntimeConfigSchema>;
