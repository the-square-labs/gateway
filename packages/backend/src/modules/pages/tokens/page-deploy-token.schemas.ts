import { z } from 'zod';

export const PageTagNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Tag must be a lowercase DNS label')
  .refine((value) => value !== 'latest', '`latest` is reserved');

export const PageTagPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9*](?:[a-z0-9*-]*[a-z0-9*])?$/, 'Tag pattern must use lowercase DNS-label characters and *');

export const CreatePageDeployTokenSchema = z.object({
  name: z.string().trim().min(1).max(255),
  allowedTagPatterns: z.array(PageTagPatternSchema).max(20).default([]),
  allowUserTag: z.boolean().default(true),
  expiresAt: z.string().datetime().optional().nullable(),
});

export type CreatePageDeployTokenInput = z.infer<typeof CreatePageDeployTokenSchema>;
