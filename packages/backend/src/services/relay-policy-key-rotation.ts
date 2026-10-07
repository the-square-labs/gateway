import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('RelayPolicySigningKeyService');
/** A pending key older than this that may not be promoted is logged (hourly) with the relays it waits for. */
const PENDING_STALL_WARNING_MS = 2 * 60 * 60 * 1000;
const PENDING_STALL_REPORT_MS = 60 * 60 * 1000;

export type RotationCandidate = { kind: string; state: string; health: { policySigningKeyIds?: string[] } | null };

/**
 * Relays that must hold a pending key before it may sign. A remote relay counts while it
 * serves or is coming up. The local relay always counts, whatever its state: it pins its
 * trust on first use and learns a new key only from a snapshot signed by the old one, so
 * promoting without it would leave the local relay depending on a retained old key.
 */
export function rotationParticipants<T extends RotationCandidate>(instances: T[]): T[] {
  return instances.filter(
    (instance) => instance.kind === 'local' || ['synchronizing', 'ready', 'draining'].includes(instance.state)
  );
}

/**
 * Rotation waits for relays to report the pending key, the local relay always (see mayPromote): one that never does
 * (down, old build, lost control stream) froze rotation without a trace. Named in a warning once the key is 2 h old.
 */
export class PolicyKeyRotationStallLog {
  private lastReportAt = 0;

  report(
    instances: Array<RotationCandidate & { id: string; nodeId: string | null }>,
    pending: { keyId: string; createdAt: Date },
    now: Date
  ): void {
    const pendingMs = now.getTime() - pending.createdAt.getTime();
    if (pendingMs < PENDING_STALL_WARNING_MS || now.getTime() - this.lastReportAt < PENDING_STALL_REPORT_MS) return;
    this.lastReportAt = now.getTime();
    logger.warn('Relay policy key rotation waits for relays that have not reported the pending key', {
      pendingKeyId: pending.keyId,
      pendingHours: Math.floor(pendingMs / (60 * 60 * 1000)),
      relays: rotationParticipants(instances)
        .filter(({ health }) => !health?.policySigningKeyIds?.includes(pending.keyId))
        .map(({ id, nodeId, kind, state }) => ({ id, nodeId, kind, state })),
    });
  }
}
