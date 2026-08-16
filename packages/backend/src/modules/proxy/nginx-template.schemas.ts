import { z } from 'zod';

const TemplateVariableDefSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z_]\w*$/, 'Must be a valid variable name'),
  type: z.enum(['string', 'number', 'boolean']),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().max(500).optional(),
});

export const CreateNginxTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  type: z.enum(['proxy', 'redirect', '404']),
  content: z.string().min(1).max(100000),
  variables: z.array(TemplateVariableDefSchema).default([]),
});

export const UpdateNginxTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional().nullable(),
  content: z.string().min(1).max(100000).optional(),
  variables: z.array(TemplateVariableDefSchema).optional(),
});

export const PreviewNginxTemplateSchema = z.object({
  content: z.string().min(1).max(100000),
  hostId: z.string().uuid().optional(),
  templateId: z.string().uuid().optional(),
});

export type CreateNginxTemplateInput = z.infer<typeof CreateNginxTemplateSchema>;
export type UpdateNginxTemplateInput = z.infer<typeof UpdateNginxTemplateSchema>;
export type PreviewNginxTemplateInput = z.infer<typeof PreviewNginxTemplateSchema>;
