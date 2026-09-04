import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { useDockerStore } from "@/stores/docker";
import type { DockerAvailabilityPolicy, DockerComposeOperation } from "@/types";

export function isAvailabilityReplacing(policy?: DockerAvailabilityPolicy | null): boolean {
  if (!policy || policy.mode === "single") return false;
  const operation = policy.latestOperation;
  return (
    Boolean(
      operation &&
        operation.type !== "stale_cleanup" &&
        ["pending", "running", "waiting", "cleanup_pending"].includes(operation.status)
    ) || ["enabling", "scaling", "rolling_out", "disabling"].includes(policy.status)
  );
}

export function AvailabilityProgress({
  policy,
  fallbackOperation,
}: {
  policy?: DockerAvailabilityPolicy | null;
  fallbackOperation?: DockerComposeOperation | null;
}) {
  const [now, setNow] = useState(Date.now);
  const nodes = useDockerStore((state) => state.dockerNodes);
  const active = isAvailabilityReplacing(policy);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!active && !fallbackOperation) return null;
  const operation = active ? policy?.latestOperation : null;
  const placement = (policy?.placements ?? []).find(
    (item) => item.id === operation?.progress?.activePlacementId
  );
  const node = nodes.find((item) => item.id === placement?.nodeId);
  const nodeName = node?.displayName || node?.hostname || node?.slug;
  const elapsed = operation
    ? Math.max(0, Math.floor((now - Date.parse(operation.startedAt ?? operation.createdAt)) / 1000))
    : 0;
  const phase = operation?.phase.replaceAll("_", " ") ?? "queued";
  const retryIn = operation?.nextAttemptAt
    ? Math.max(0, Math.ceil((Date.parse(operation.nextAttemptAt) - now) / 1000))
    : null;
  const description = active
    ? [
        operation?.status === "waiting" ? "Waiting" : null,
        operation?.progress.message || phase,
        nodeName,
        operation?.progress.totalPlacements != null
          ? `${operation.progress.completedPlacements ?? 0}/${operation.progress.totalPlacements} placements ready`
          : null,
        `${elapsed}s elapsed`,
        retryIn != null ? `retry in ${retryIn}s` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : fallbackOperation?.progress?.replaceAll("_", " ") || "Operation in progress";
  return (
    <PanelShell
      className="shrink-0 border-primary/20 bg-primary/5"
      header={
        <div className="flex flex-wrap items-center gap-2 p-3 text-sm">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          <span className="font-medium">
            {operation?.type === "start"
              ? "Starting workload"
              : operation?.type === "stop"
                ? "Stopping workload"
                : operation?.type === "restart"
                  ? "Restarting workload"
                  : fallbackOperation?.action.replaceAll("_", " ") || "Replacing workload"}
          </span>
          <span className="text-muted-foreground">{description}</span>
        </div>
      }
      role="status"
    >
      {operation?.status === "waiting" && operation.errorMessage ? (
        <p className="px-4 py-3 text-sm text-warning">{operation.errorMessage}</p>
      ) : null}
    </PanelShell>
  );
}
