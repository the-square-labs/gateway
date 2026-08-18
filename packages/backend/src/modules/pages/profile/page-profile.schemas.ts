import { z } from 'zod';

export const PageLabelTemplateSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .superRefine((value, context) => {
    if (value.includes('.')) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Template cannot contain dots' });
    if ((value.match(/\{hash\}/g) ?? []).length !== 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Template must contain {hash} exactly once' });
    }
    if ((value.match(/\{project\}/g) ?? []).length > 1 || /\{(?!hash\}|project\})/.test(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Template supports only {hash} and {project}' });
    }
    const sample = value.replace('{hash}', 'abcdefghijklmnop').replace('{project}', 'project');
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(sample)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Rendered template must be a lowercase DNS label' });
    }
  });

export const UpdatePageProfileSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    domainId: z.string().uuid(),
    nodeId: z.string().uuid().optional(),
    certificateId: z.string().uuid(),
    labelTemplate: PageLabelTemplateSchema.default('{hash}'),
    acknowledgeSameRegistrableDomain: z.boolean().default(false),
  }),
]);

export type UpdatePageProfileInput = z.infer<typeof UpdatePageProfileSchema>;
