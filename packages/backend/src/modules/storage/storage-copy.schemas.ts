import { z } from 'zod';

/** S3 bucket names only: never a path. Legacy AWS names with capitals or underscores stay accepted. */
export const StorageCopyBucketNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/, 'Bucket names use letters, digits, dots, hyphens and underscores')
  .refine((value) => !value.includes('..'), 'Bucket names cannot contain ".."');

export const StorageCopyLimitsSchema = z
  .object({
    timeoutSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 24 * 60 * 60)
      .optional(),
    cpuCores: z.number().int().min(1).max(16).optional(),
    memoryMb: z.number().int().min(256).max(65_536).optional(),
    transfers: z.number().int().min(1).max(32).optional(),
  })
  .strict();

export const StartStorageCopyJobSchema = z
  .object({
    sourceStorageId: z.string().uuid(),
    destinationStorageId: z.string().uuid(),
    buckets: z.union([
      z.literal('all'),
      z
        .array(StorageCopyBucketNameSchema)
        .min(1)
        .max(200)
        .transform((names) => [...new Set(names)]),
    ]),
    mode: z.enum(['copy', 'sync']).default('copy'),
    dryRun: z.boolean().default(false),
    createBuckets: z.boolean().optional(),
    allowLiveDestination: z.boolean().optional(),
    executorNodeId: z.string().uuid().optional(),
    limits: StorageCopyLimitsSchema.optional(),
  })
  .strict()
  .refine((value) => value.sourceStorageId !== value.destinationStorageId, {
    message: 'Source and destination must be different storage connections',
    path: ['destinationStorageId'],
  });

export const StorageCopyJobListQuerySchema = z.object({
  storageId: z.string().uuid().optional(),
  status: z.enum(['active', 'queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const StorageCopyJobIdSchema = z.object({ jobId: z.string().uuid() });
