import type {
  AvailabilityLeaseWitness,
  DockerAvailabilityLeaseBallot,
  DockerAvailabilityLeaseMode,
  DockerAvailabilityLeaseObservationSource,
  DockerAvailabilityLeaseReason,
  DockerAvailabilityPartitionMode,
} from '@/db/schema/index.js';
import type { LeaseModeChange } from './lease-policies.js';
import type { LeaseHolderChangeNotice } from './lease-reports.js';
import type { LeaseVoterMargin, LeaseWitnessWarning } from './lease-voters.js';

/** A lease mode transition of one policy, delivered to the Availability controller. */
export type DockerAvailabilityLeaseModeChange = LeaseModeChange;

/** A change of lease holder of one key, delivered to the Availability controller after it was persisted. */
export type DockerAvailabilityLeaseHolderChange = LeaseHolderChangeNotice;

/**
 * The paid Availability controller (edition contract). Until it reports lease support every policy stays on the
 * legacy backend-driven path. Callbacks run after the host persisted the change; a failure is logged and the
 * controller sees the persisted state on its next reconcile.
 */
export interface DockerAvailabilityLeaseController {
  leaseModeSupported(): boolean;
  leaseModeChanged(change: DockerAvailabilityLeaseModeChange): Promise<void>;
  leaseHolderChanged(change: DockerAvailabilityLeaseHolderChange): Promise<void>;
}

export interface DockerAvailabilityLeaseHolderView {
  slot: number;
  /** Docker node id of the holder; null while the key is free. */
  holderNodeId: string | null;
  placementId: string | null;
  ballot: DockerAvailabilityLeaseBallot | null;
  observedAt: Date;
  holderSince: Date | null;
  source: DockerAvailabilityLeaseObservationSource;
}

/** Read-only lease state of a policy for the API, the UI and the controller. */
export interface DockerAvailabilityLeaseView {
  mode: DockerAvailabilityLeaseMode;
  reason: DockerAvailabilityLeaseReason | null;
  manifestVersion: number;
  epoch: number;
  /** Partition mode the published manifest carries; differs from the policy while a change propagates. */
  publishedPartitionMode: DockerAvailabilityPartitionMode | null;
  holders: DockerAvailabilityLeaseHolderView[];
  /** Slots reserved for their current serving placement until it acquires (A5). */
  bootstrap: Array<{ slot: number; holderNodeId: string }>;
  /** D9: temporary extra lease slots of a replicated rollout; the manifest publishes desired + surgeSlots slots. */
  surgeSlots: number;
  /** A7: a switch from available to strict is in progress; strict is not active yet. */
  strictPending: boolean;
  /**
   * When the reserved holders first held with no other copy running. Bootstrap and a strict switch complete once the
   * relay gate window (24 s) passed since then (A16); null while other copies may still run.
   */
  copiesStoppedAt: Date | null;
  /** Per-policy voter reachability margin over its quorum sets (A18). */
  voterMargin: LeaseVoterMargin | null;
  /** Voters of the newest quorum set: candidate hosts in rank order, then witnesses (A18). */
  voters: string[];
  /** The (first) witness and the witness warning (A19); memberId null when none is needed or none is eligible. */
  witness: DockerAvailabilityLeaseWitnessView | null;
  witnesses: AvailabilityLeaseWitness[];
}

export interface DockerAvailabilityLeaseWitnessView {
  memberId: string | null;
  kind: 'relay' | 'docker' | null;
  /** Chosen automatically, or configured on the policy. */
  auto: boolean;
  /** Smallest round trip from any candidate, when every candidate measured it. */
  minRttMs: number | null;
  warning: LeaseWitnessWarning | null;
}

export interface DockerAvailabilityLeaseHandoffInput {
  slot: number;
  /** Docker node id of the successor candidate. */
  successorNodeId: string;
  successorGeneration: number;
  operationId?: string | null;
  timeoutMs?: number;
}
