import { container } from '@/container.js';
import type { DockerAvailabilityPartitionMode } from '@/db/schema/index.js';
import { AvailabilityLeaseService } from './lease/availability-lease.service.js';
import type { DockerAvailabilityLeaseView } from './lease/lease-types.js';

type PolicyLike = { id: string; partitionMode?: DockerAvailabilityPartitionMode };

function leaseService(): AvailabilityLeaseService | null {
  return container.isRegistered(AvailabilityLeaseService) ? container.resolve(AvailabilityLeaseService) : null;
}

/**
 * Adds the read-only data-plane lease state (mode and reason, holders per slot, voter margin) to a policy response.
 * Routes and the AI tool share it, so both surfaces expose the same fields.
 */
export async function withAvailabilityLease<T extends PolicyLike>(
  policy: T
): Promise<T & { partitionMode: DockerAvailabilityPartitionMode; lease: DockerAvailabilityLeaseView | null }> {
  const lease = await leaseService()?.getPolicyLease(policy.id);
  return { ...policy, partitionMode: policy.partitionMode ?? 'strict', lease: lease ?? null };
}

export async function withOptionalAvailabilityLease<T extends PolicyLike>(policy: T | null) {
  return policy ? withAvailabilityLease(policy) : null;
}

/** Preflight reports the current policy, when there is one, with its lease state too. */
export async function withPreflightAvailabilityLease<T extends { currentPolicy: PolicyLike | null }>(report: T) {
  return { ...report, currentPolicy: await withOptionalAvailabilityLease(report.currentPolicy) };
}

/**
 * Persists a requested partition mode after the Availability service accepted the enable or update, which already
 * authorized the policy mutation. A controller that stores the field itself makes this a no-op.
 */
export async function applyAvailabilityPartitionMode<T extends PolicyLike>(
  policy: T,
  requested: DockerAvailabilityPartitionMode | undefined
): Promise<T> {
  if (!requested || policy.partitionMode === requested) return policy;
  const service = leaseService();
  if (!service) return policy;
  await service.setPartitionMode(policy.id, requested);
  return { ...policy, partitionMode: requested };
}
