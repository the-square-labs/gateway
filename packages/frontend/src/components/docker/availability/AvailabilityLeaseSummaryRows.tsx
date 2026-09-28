import { useEffect, useState } from "react";
import { DetailRow } from "@/components/common/DetailRow";
import { RelativeTime } from "@/components/common/RelativeTime";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/services/api";
import type {
  DashboardRelayInstance,
  DockerAvailabilityLeaseExclusionReason,
  DockerAvailabilityLeaseMode,
  DockerAvailabilityLeaseWitness,
  DockerAvailabilityPolicy,
  Node,
} from "@/types";

function nodeLabel(nodeId: string, nodes: Node[]) {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return node?.displayName || node?.hostname || node?.slug || nodeId.slice(0, 12);
}

function witnessLabel(
  memberId: string,
  kind: DockerAvailabilityLeaseWitness["kind"],
  nodes: Node[],
  relayInstances: DashboardRelayInstance[]
) {
  if (kind === "relay") {
    const instance = relayInstances.find((candidate) => candidate.id === memberId);
    return instance?.displayName || memberId.slice(0, 12);
  }
  return nodeLabel(memberId, nodes);
}

const witnessWarningMessage: Record<
  NonNullable<DockerAvailabilityLeaseWitness["warning"]>,
  string
> = {
  witness_near_candidate:
    "witness is likely on the same site as a candidate (<2 ms); a site outage can take two votes",
  no_eligible_witness: "no eligible witness; autonomous failover needs a majority of candidates",
  configured_witness_unavailable:
    "the configured witness cannot vote right now; an automatic witness is used instead",
};

const exclusionLabel: Record<DockerAvailabilityLeaseExclusionReason, string> = {
  offline: "offline",
  watchdog_missing: "lease watchdog not running",
  daemon_outdated: "daemon outdated",
  identity_pending: "no lease identity yet",
};

/** Lease mode leaves this long after it became impossible (the backend's 2-minute hysteresis). */
const LEASE_EXIT_AFTER_MS = 2 * 60_000;

function modeLabel(mode: DockerAvailabilityLeaseMode) {
  if (mode === "lease") return "Lease";
  if (mode === "legacy") return "Legacy";
  return mode.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function modeVariant(mode: DockerAvailabilityLeaseMode) {
  if (mode === "lease") return "success" as const;
  if (mode === "bootstrapping" || mode === "closing") return "warning" as const;
  return "secondary" as const;
}

/**
 * Availability summary rows for the data-plane lease: the mode (lease, legacy, bootstrapping or
 * closing) with its reason, the holder of each slot, when lease mode is about to end, the nodes
 * left out of holding and standbys, a warning when the voter reachability margin is insufficient,
 * and the resolved witness with its own siting warning.
 */
export function AvailabilityLeaseSummaryRows({ policy }: { policy: DockerAvailabilityPolicy }) {
  const lease = policy.lease;
  const [nodes, setNodes] = useState<Node[]>([]);
  const [relayInstances, setRelayInstances] = useState<DashboardRelayInstance[]>([]);

  useEffect(() => {
    if (!lease) return;
    let cancelled = false;
    void api
      .listNodes({ type: "docker", limit: 100 })
      .then((result) => {
        if (!cancelled) setNodes(result.data);
      })
      .catch(() => {
        // Names fall back to node IDs.
      });
    void api
      .getRelayStatus()
      .then((status) => {
        if (!cancelled) setRelayInstances(status?.instances ?? []);
      })
      .catch(() => {
        // Names fall back to the member ID.
      });
    return () => {
      cancelled = true;
    };
  }, [lease]);

  if (!lease) return null;
  const holders = [...lease.holders].sort((a, b) => a.slot - b.slot);
  const insufficientMargin = lease.voterMargin !== null && lease.voterMargin.margin <= 0;
  const excludedNodes = lease.excludedNodes ?? [];
  const witnessMemberId = lease.witness?.memberId ?? null;
  const leaving =
    (lease.mode === "lease" || lease.mode === "bootstrapping") && lease.reason?.since
      ? new Date(Date.parse(lease.reason.since) + LEASE_EXIT_AFTER_MS)
      : null;

  return (
    <>
      <DetailRow
        label="Lease mode"
        value={
          lease.reason ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge size="inline" variant={modeVariant(lease.mode)} tabIndex={0}>
                    {modeLabel(lease.mode)}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-sm break-words">
                  {lease.reason.message}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <Badge size="inline" variant={modeVariant(lease.mode)}>
              {modeLabel(lease.mode)}
            </Badge>
          )
        }
      />
      {holders.map((holder) => (
        <DetailRow
          key={holder.slot}
          label={holders.length > 1 ? `Slot ${holder.slot} holder` : "Holder"}
          value={
            holder.holderNodeId ? (
              <span className="inline-flex min-w-0 flex-wrap items-center justify-end gap-2">
                <span className="truncate">{nodeLabel(holder.holderNodeId, nodes)}</span>
                {holder.holderSince ? (
                  <span className="text-xs text-muted-foreground">
                    since <RelativeTime value={holder.holderSince} />
                  </span>
                ) : null}
              </span>
            ) : (
              "—"
            )
          }
        />
      ))}
      {leaving && lease.reason ? (
        <p className="border-b border-border px-4 py-3 text-sm text-warning-text">
          Data-plane failover is impossible right now: {lease.reason.message}. The policy goes back
          to backend failover at {leaving.toLocaleTimeString()} unless this is fixed before.
        </p>
      ) : null}
      {excludedNodes.length > 0 ? (
        <DetailRow
          label="Excluded nodes"
          value={
            <span className="inline-flex min-w-0 flex-col items-end gap-1">
              {excludedNodes.map((entry) => (
                <span key={entry.nodeId} className="inline-flex min-w-0 items-center gap-2">
                  <span className="truncate">{nodeLabel(entry.nodeId, nodes)}</span>
                  <span className="text-xs text-muted-foreground">
                    {exclusionLabel[entry.reason] ?? entry.reason}
                  </span>
                </span>
              ))}
            </span>
          }
        />
      ) : null}
      {insufficientMargin && lease.voterMargin ? (
        <p className="border-b border-border px-4 py-3 text-sm text-warning-text">
          Voter reachability margin is insufficient: {lease.voterMargin.reachable} of{" "}
          {lease.voterMargin.required} required lease voters reachable; losing one more voter would
          break quorum.
        </p>
      ) : null}
      {lease.witness && witnessMemberId ? (
        <DetailRow
          label="Witness"
          value={
            <span className="inline-flex min-w-0 flex-wrap items-center justify-end gap-2">
              <span className="truncate">
                {witnessLabel(witnessMemberId, lease.witness.kind, nodes, relayInstances)}
              </span>
              <span className="text-xs text-muted-foreground">
                {lease.witness.auto ? "auto" : "manual"}
                {lease.witness.minRttMs !== null ? ` · ${lease.witness.minRttMs} ms` : ""}
              </span>
            </span>
          }
        />
      ) : null}
      {lease.witness?.warning && witnessWarningMessage[lease.witness.warning] ? (
        <p className="border-b border-border px-4 py-3 text-sm text-warning-text">
          {witnessWarningMessage[lease.witness.warning]}
        </p>
      ) : null}
    </>
  );
}
