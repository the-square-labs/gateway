import type {
  DockerAvailabilityLeaseBallot,
  DockerAvailabilityLeaseMode,
  DockerAvailabilityLeaseObservationSource,
  DockerAvailabilityLeaseReason,
  DockerAvailabilityPartitionMode,
} from '@/db/schema/index.js';
import type { LeaseModeChange } from './lease-policies.js';
import type { LeaseHolderChangeNotice } from './lease-reports.js';
import type { LeaseVoterMargin } from './lease-voters.js';

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
  voterMargin: LeaseVoterMargin | null;
}

export interface DockerAvailabilityLeaseHandoffInput {
  slot: number;
  /** Docker node id of the successor candidate. */
  successorNodeId: string;
  successorGeneration: number;
  operationId?: string | null;
  timeoutMs?: number;
}
