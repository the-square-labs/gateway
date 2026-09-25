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

/** Longest optional Deployment lifetime: one year. */
export const PAGE_DEPLOYMENT_MAX_EXPIRY_HOURS = 24 * 365;

/**
 * Optional Deployment expiry: an absolute ISO 8601 time or a lifetime in hours,
 * never both. Maintenance deletes an expired Deployment with its previews and
 * files; a Deployment without an expiry is never expired.
 */
export const PageDeploymentExpiryFields = {
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
  expiresInHours: z.number().int().min(1).max(PAGE_DEPLOYMENT_MAX_EXPIRY_HOURS).optional(),
};

/** `tar.gz` (default) or one `html` file that becomes index.html of a generated archive. */
export const PageArtifactFormatSchema = z.enum(['tar.gz', 'html']);

export const CreatePageDeploymentSchema = z.object({
  projectId: z.string().uuid(),
  declaredSizeBytes: z.number().int().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  idempotencyKey: z.string().trim().min(1).max(255).optional(),
  tag: PageTagNameSchema.optional(),
  source: PageDeploymentSourceMetadataSchema,
  /** Omitted: detected from content (gzip magic bytes for an archive, otherwise HTML). */
  format: PageArtifactFormatSchema.optional(),
  ...PageDeploymentExpiryFields,
});

export const FinalizePageUploadSchema = z.object({
  ...PageDeploymentExpiryFields,
});

export const PageDeploymentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Deployments whose files retention already removed; they can no longer be previewed, published or restored. */
  includeDeleted: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((value) => value === true || value === 'true'),
});

export type CreatePageDeploymentInput = z.infer<typeof CreatePageDeploymentSchema>;
export type FinalizePageUploadInput = z.infer<typeof FinalizePageUploadSchema>;
export type PageArtifactFormat = z.infer<typeof PageArtifactFormatSchema>;
export type PageDeploymentListQuery = z.infer<typeof PageDeploymentListQuerySchema>;
