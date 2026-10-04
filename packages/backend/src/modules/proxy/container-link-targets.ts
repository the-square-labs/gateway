/**
 * Container links are served on their target node by the same shared connector as proxy Secure Links: each one (or
 * each target placement of an Availability workload) is an ordinary `role: "target"` binding in the node's full
 * SyncProxySecureLinks set (C1). The container links service provides them; the proxy Secure Link sync sends them
 * with the node's other bindings and hands back what the daemon reported.
 */
export interface ContainerLinkTargetBinding {
  /** The container link id, or the target placement id of an Availability target. */
  linkId: string;
  generation: number;
  targetNetwork: string;
  targetContainer: string;
  targetPort: number;
  allowNetworkReselection: boolean;
  /**
   * A target placement of an Availability workload in lease mode: sent dormant and gated like a proxy Secure Link
   * member, so its node binds it only while the placement holds the data-plane lease (a standby gets no traffic).
   */
  dormant?: boolean;
  availabilityPolicyId?: string;
  availabilityCandidateId?: string;
}

export interface ContainerLinkTargetStatus {
  linkId: string;
  generation: number;
  port: number;
  targetNetwork?: string;
}

export interface ContainerLinkTargetProvider {
  /** Docker nodes that serve a container link as its target. */
  targetNodeIds(): Promise<string[]>;
  targetBindings(nodeId: string): Promise<ContainerLinkTargetBinding[]>;
  /**
   * The daemon picked another network for a binding without one: record it under the next generation. False when
   * the binding changed meanwhile (the sync then starts over).
   */
  recordTargetNetwork(linkId: string, generation: number, nextGeneration: number, network: string): Promise<boolean>;
  /** What the daemon serves now, and the bindings it could not resolve (a stopped or missing target). */
  recordTargetStatuses(
    nodeId: string,
    statuses: ContainerLinkTargetStatus[],
    unavailable: ReadonlyMap<string, string>
  ): Promise<void>;
}
