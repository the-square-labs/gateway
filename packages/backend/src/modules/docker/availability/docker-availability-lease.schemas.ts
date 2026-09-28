import { z } from '@hono/zod-openapi';

const UUID = z.string().uuid();

/**
 * strict never runs two copies of a slot, even under a partition; available keeps serving on a reachable candidate
 * and accepts that two copies can run at once (D11).
 */
export const DockerAvailabilityPartitionModeSchema = z.enum(['strict', 'available']);

/** A19: the lease witness, a relay instance id or a Docker node id; null picks one automatically. */
export const DockerAvailabilityWitnessSchema = UUID.nullable();

export const DockerAvailabilityLeaseModeSchema = z.enum(['legacy', 'bootstrapping', 'lease', 'closing']);

/** Why a candidate node is excluded from holding and standby provisioning (D3). */
export const DockerAvailabilityLeaseExclusionReasonSchema = z.enum([
  'offline',
  'watchdog_missing',
  'daemon_outdated',
  'identity_pending',
]);

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
      relayIds: z.array(UUID).optional(),
      /** Since when lease mode has been impossible; a lease-mode policy starts closing once this is 2 minutes old. */
      since: z.string().datetime().optional(),
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
  surgeSlots: z.number().int().min(0).max(32),
  strictPending: z.boolean(),
  copiesStoppedAt: z.coerce.date().nullable(),
  /** D3: candidates left out of holding and standby provisioning right now; never a reason to leave lease mode. */
  excludedNodes: z.array(
    z.object({
      nodeId: UUID,
      reason: DockerAvailabilityLeaseExclusionReasonSchema,
    })
  ),
  /** Graceful close, while closing: the holders that keep their copy running, and whether each confirmed it. */
  retainedHolders: z.array(
    z.object({ slot: z.number().int().min(0).max(31), holderNodeId: UUID, confirmed: z.boolean() })
  ),
  voters: z.array(UUID),
  witness: z
    .object({
      memberId: UUID.nullable(),
      kind: z.enum(['relay', 'docker']).nullable(),
      auto: z.boolean(),
      minRttMs: z.number().nonnegative().nullable(),
      warning: z.enum(['witness_near_candidate', 'no_eligible_witness', 'configured_witness_unavailable']).nullable(),
    })
    .nullable(),
  witnesses: z.array(
    z.object({
      memberId: UUID,
      kind: z.enum(['relay', 'docker']),
      auto: z.boolean(),
      minRttMs: z.number().nonnegative().nullable(),
    })
  ),
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
