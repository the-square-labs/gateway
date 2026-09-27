import type { DockerAvailabilityLeaseReason } from '@/db/schema/index.js';

export interface LeaseGatingInput {
  /** The paid controller runs the lease-mode branch (edition contract). */
  controllerSupportsLease: boolean;
  /** The controller holds this policy on the legacy path. */
  legacyRequested?: boolean;
  policyMode: 'single' | 'replicated' | 'failover';
  /** A policy key can sign lease manifests. */
  signingReady: boolean;
  /** Candidate docker node ids and whether each is capable (capability, identity key, fresh watchdog). */
  candidates: Array<{ nodeId: string; capable: boolean }>;
  /** Ingress nginx node ids of the policy's routes and whether each is capable. */
  ingress: Array<{ nodeId: string; capable: boolean }>;
}

export type LeaseGatingResult = { eligible: true } | { eligible: false; reason: DockerAvailabilityLeaseReason };

/**
 * D10: a policy runs in lease mode only when all its candidates and all ingress nginx nodes of its routes are capable.
 * Its voters (A18) are the candidates' hosts plus witnesses chosen among capable members, so every voter is capable.
 * Anything else keeps today's backend-driven failover, with the reason exposed.
 */
export function evaluateLeaseGating(input: LeaseGatingInput): LeaseGatingResult {
  if (!input.controllerSupportsLease) {
    return {
      eligible: false,
      reason: {
        code: 'controller_unsupported',
        message: 'This Gateway edition runs Availability failover from the backend only',
      },
    };
  }
  if (input.legacyRequested) {
    return {
      eligible: false,
      reason: { code: 'legacy_requested', message: 'The Availability controller runs this policy on the backend path' },
    };
  }
  if (input.policyMode === 'single') {
    return { eligible: false, reason: { code: 'availability_disabled', message: 'Availability is not enabled' } };
  }
  const incapableCandidates = input.candidates.filter((candidate) => !candidate.capable).map(({ nodeId }) => nodeId);
  if (input.candidates.length === 0) {
    return {
      eligible: false,
      reason: { code: 'no_candidates', message: 'The policy has no candidate placements yet' },
    };
  }
  if (incapableCandidates.length > 0) {
    return {
      eligible: false,
      reason: {
        code: 'candidates_not_capable',
        message:
          'Some Docker nodes of this workload run a daemon without data-plane failover or without a running lease watchdog; update them',
        nodeIds: incapableCandidates.sort(),
      },
    };
  }
  const incapableIngress = input.ingress.filter((node) => !node.capable).map(({ nodeId }) => nodeId);
  if (incapableIngress.length > 0) {
    return {
      eligible: false,
      reason: {
        code: 'ingress_not_capable',
        message: 'Some Nginx nodes that route to this workload run a daemon without data-plane failover; update them',
        nodeIds: [...new Set(incapableIngress)].sort(),
      },
    };
  }
  if (!input.signingReady) {
    return {
      eligible: false,
      reason: {
        code: 'signing_key_pending',
        message: 'No relay policy signing key can sign lease manifests yet',
      },
    };
  }
  return { eligible: true };
}

/** D7: standbys are fixed at min(2, candidates - slots); a created-but-not-started standby costs only disk. */
export function availabilityStandbyCount(candidateNodes: number, slots: number): number {
  return Math.max(0, Math.min(2, candidateNodes - slots));
}
