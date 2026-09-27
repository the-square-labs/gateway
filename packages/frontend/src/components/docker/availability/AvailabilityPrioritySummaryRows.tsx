import { useEffect, useState } from "react";
import { DetailRow } from "@/components/common/DetailRow";
import { Badge } from "@/components/ui/badge";
import { api } from "@/services/api";
import type { DockerAvailabilityPolicy, Node } from "@/types";
import { availabilityPriorityState } from "./availability-priority";

function nodeLabel(nodeId: string, nodes: Node[]) {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return node?.displayName || node?.hostname || node?.slug || nodeId.slice(0, 12);
}

/** Availability summary rows for priority mode: the primary node and whether a backup serves now. */
export function AvailabilityPrioritySummaryRows({ policy }: { policy: DockerAvailabilityPolicy }) {
  const state = availabilityPriorityState(policy);
  const [nodes, setNodes] = useState<Node[]>([]);
  const active = state !== null;

  useEffect(() => {
    if (!active) return;
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
  }, [active]);

  if (!state) return null;
  return (
    <>
      <DetailRow
        label="Primary"
        value={state.primaryNodeId ? nodeLabel(state.primaryNodeId, nodes) : "—"}
      />
      <DetailRow
        label="Serving from"
        value={
          <span className="inline-flex min-w-0 flex-wrap items-center justify-end gap-2">
            <span className="truncate">
              {state.serving.length > 0
                ? state.serving
                    .map((entry) => `${entry.role} · ${nodeLabel(entry.nodeId, nodes)}`)
                    .join(", ")
                : "—"}
            </span>
            {state.serving.length > 0 ? (
              <Badge size="inline" variant={state.onBackup ? "warning" : "success"}>
                {state.onBackup
                  ? "On backup"
                  : policy.mode === "replicated"
                    ? "On preferred nodes"
                    : "On primary"}
              </Badge>
            ) : null}
          </span>
        }
      />
    </>
  );
}
