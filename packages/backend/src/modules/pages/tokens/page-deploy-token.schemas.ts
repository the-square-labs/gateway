import { z } from 'zod';

/**
 * Any existing Tag name (63 characters, one DNS label). A new Tag must also
 * leave room for its `<12-char project hash>-` preview prefix: at most 50
 * characters, enforced where Tags are created (upload begin and Tag moves),
 * since only there it is known whether the Tag already exists.
 */
export const PAGE_NEW_TAG_NAME_MAX_LENGTH = 50;

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
