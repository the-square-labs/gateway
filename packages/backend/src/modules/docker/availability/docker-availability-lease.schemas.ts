import { z } from '@hono/zod-openapi';

const UUID = z.string().uuid();

/**
 * strict never runs two copies of a slot, even under a partition; available keeps serving on a reachable candidate
 * and accepts that two copies can run at once (D11).
 */
export const DockerAvailabilityPartitionModeSchema = z.enum(['strict', 'available']);

export const DockerAvailabilityLeaseModeSchema = z.enum(['legacy', 'bootstrapping', 'lease', 'closing']);

const DockerAvailabilityLeaseBallotSchema = z.object({
  round: z.string(),
  incarnation: z.string(),
  proposerId: z.string(),
});

/** Read-only data-plane lease state of a policy (D9, D10). */
export const DockerAvailabilityLeaseSchema = z.object({
  mode: DockerAvailabilityLeaseModeSchema,
  reason: z
    .object({
      code: z.string(),
      message: z.string(),
      nodeIds: z.array(UUID).optional(),
    })
    .nullable(),
  manifestVersion: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  publishedPartitionMode: DockerAvailabilityPartitionModeSchema.nullable(),
  holders: z.array(
    z.object({
      slot: z.number().int().min(0).max(31),
      holderNodeId: UUID.nullable(),
      placementId: UUID.nullable(),
      ballot: DockerAvailabilityLeaseBallotSchema.nullable(),
      observedAt: z.coerce.date(),
      holderSince: z.coerce.date().nullable(),
      source: z.enum(['daemon', 'acceptor', 'relay']),
    })
  ),
  bootstrap: z.array(z.object({ slot: z.number().int().min(0).max(31), holderNodeId: UUID })),
  strictPending: z.boolean(),
  copiesStoppedAt: z.coerce.date().nullable(),
  voterMargin: z
    .object({
      epoch: z.number().int().nonnegative(),
      joint: z.boolean(),
      voters: z.number().int().nonnegative(),
      reachable: z.number().int().nonnegative(),
      required: z.number().int().nonnegative(),
      margin: z.number().int(),
    })
    .nullable(),
});
