import { useEffect, useState } from "react";
import { DetailRow } from "@/components/common/DetailRow";
import { RelativeTime } from "@/components/common/RelativeTime";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/services/api";
import type { DockerAvailabilityLeaseMode, DockerAvailabilityPolicy, Node } from "@/types";

function nodeLabel(nodeId: string, nodes: Node[]) {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return node?.displayName || node?.hostname || node?.slug || nodeId.slice(0, 12);
}

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
 * closing) with its reason, the holder of each slot, and a warning when the voter reachability
 * margin is insufficient.
 */
export function AvailabilityLeaseSummaryRows({ policy }: { policy: DockerAvailabilityPolicy }) {
  const lease = policy.lease;
  const [nodes, setNodes] = useState<Node[]>([]);

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
    return () => {
      cancelled = true;
    };
  }, [lease]);

  if (!lease) return null;
  const holders = [...lease.holders].sort((a, b) => a.slot - b.slot);
  const insufficientMargin = lease.voterMargin !== null && lease.voterMargin.margin <= 0;

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
      {insufficientMargin && lease.voterMargin ? (
        <p className="border-b border-border px-4 py-3 text-sm text-warning-text">
          Voter reachability margin is insufficient: {lease.voterMargin.reachable} of{" "}
          {lease.voterMargin.required} required lease voters reachable; losing one more voter would
          break quorum.
        </p>
      ) : null}
    </>
  );
}
