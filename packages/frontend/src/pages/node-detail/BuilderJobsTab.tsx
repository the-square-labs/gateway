import { GitBranch, Hammer } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import type { DockerBuild, DockerBuildStatus } from "@/types";
import {
  ACTIVE_DOCKER_BUILD_STATUSES,
  DockerBuildDetailsDialog,
} from "../docker-detail/DockerBuildDetailsDialog";

const STATUS_VARIANT: Record<
  DockerBuildStatus,
  "default" | "secondary" | "destructive" | "success" | "warning"
> = {
  queued: "secondary",
  claimed: "secondary",
  checking_out: "default",
  building: "default",
  scanning: "default",
  pushing: "default",
  deploying: "warning",
  succeeded: "success",
  failed: "destructive",
  cancelled: "secondary",
  superseded: "secondary",
};

function duration(build: DockerBuild): string {
  const start = Date.parse(build.startedAt ?? build.queuedAt);
  const end = build.completedAt ? Date.parse(build.completedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function targetLabel(build: DockerBuild): string {
  if (build.target.kind === "container") return build.target.name;
  if (build.target.kind === "deployment") return `Deployment ${build.target.name}`;
  if (build.target.kind === "compose_project") {
    return `Compose ${build.target.name}${build.serviceName ? ` · ${build.serviceName}` : ""}`;
  }
  return `Pages ${build.target.name}`;
}

export function BuilderJobsTab({ nodeId }: { nodeId: string }) {
  const [rows, setRows] = useState<DockerBuild[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<DockerBuild | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const requestId = useRef(0);
  const refreshRequestId = useRef(0);
  const loadingMore = useRef(false);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadPage = useCallback(
    async (cursor: string | undefined, replace: boolean) => {
      if (!replace && loadingMore.current) return;
      const currentRequest = ++requestId.current;
      if (replace) setNextCursor(null);
      else loadingMore.current = true;
      setLoading(true);
      try {
        const page = await api.listDockerBuildPage({ builderNodeId: nodeId, cursor, limit: 50 });
        if (currentRequest !== requestId.current) return;
        setRows((current) => (replace ? page.data : [...current, ...page.data]));
        setNextCursor(page.nextCursor);
      } catch (error) {
        if (currentRequest === requestId.current) {
          toast.error(error instanceof Error ? error.message : "Failed to load Build Worker jobs");
        }
      } finally {
        if (currentRequest === requestId.current) {
          setLoading(false);
          loadingMore.current = false;
        }
      }
    },
    [nodeId]
  );

  const refreshHead = useCallback(async () => {
    const currentRequest = ++refreshRequestId.current;
    try {
      const page = await api.listDockerBuildPage({ builderNodeId: nodeId, limit: 50 });
      if (currentRequest !== refreshRequestId.current) return;
      setRows((current) => {
        const refreshedIds = new Set(page.data.map((build) => build.id));
        return [
          ...page.data,
          ...current.filter(
            (build) =>
              !refreshedIds.has(build.id) && !ACTIVE_DOCKER_BUILD_STATUSES.has(build.status)
          ),
        ];
      });
      setNextCursor(page.nextCursor);
    } catch {
      // Realtime and fallback polling keep the current table stable on transient errors.
    }
  }, [nodeId]);

  useEffect(() => {
    void loadPage(undefined, true);
    return () => {
      requestId.current += 1;
      refreshRequestId.current += 1;
    };
  }, [loadPage]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = tableScrollRef.current;
    if (!sentinel || !root || !nextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingMore.current) {
          void loadPage(nextCursor, false);
        }
      },
      { root, rootMargin: "320px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadPage, nextCursor]);

  useRealtime("docker.build.changed", (payload) => {
    const event = payload as { builderNodeId?: string } | undefined;
    if (!event?.builderNodeId || event.builderNodeId === nodeId) void refreshHead();
  });
  useRealtime("docker.build.artifact.changed", (payload) => {
    const event = payload as { builderNodeId?: string } | undefined;
    if (!event?.builderNodeId || event.builderNodeId === nodeId) void refreshHead();
  });

  const hasActiveJobs = rows.some((build) => ACTIVE_DOCKER_BUILD_STATUSES.has(build.status));
  useEffect(() => {
    const interval = window.setInterval(() => void refreshHead(), hasActiveJobs ? 5_000 : 15_000);
    return () => window.clearInterval(interval);
  }, [hasActiveJobs, refreshHead]);

  useEffect(() => {
    if (!selected) return;
    const refreshed = rows.find((build) => build.id === selected.id);
    if (refreshed && refreshed !== selected) setSelected(refreshed);
  }, [rows, selected]);

  const columns = useMemo<DataTableColumn<DockerBuild>[]>(
    () => [
      {
        key: "source",
        header: "Source / resource",
        width: "minmax(15rem,1.4fr)",
        render: (build) => (
          <span className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center bg-muted">
              <GitBranch className="h-4 w-4 text-muted-foreground" />
            </span>
            <span className="min-w-0">
              <span className="block truncate font-medium">{build.repositoryFullPath}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {targetLabel(build)}
              </span>
            </span>
          </span>
        ),
      },
      {
        key: "commit",
        header: "Commit / ref",
        width: "9rem",
        render: (build) => (
          <span className="block min-w-0">
            <span className="block font-mono text-xs">{build.commitSha.slice(0, 10)}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {build.ref.replace("refs/heads/", "")}
            </span>
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        align: "right",
        width: "8.5rem",
        render: (build) => (
          <Badge variant={STATUS_VARIANT[build.status]}>{build.status.replaceAll("_", " ")}</Badge>
        ),
      },
      {
        key: "attempt",
        header: "Attempt",
        align: "right",
        width: "6rem",
        render: (build) => `${build.attempt}/${build.maxAttempts}`,
      },
      {
        key: "time",
        header: "Duration / created",
        align: "right",
        width: "11rem",
        render: (build) => (
          <span className="block">
            <span className="block">{duration(build)}</span>
            <span className="block text-xs text-muted-foreground">
              {new Date(build.createdAt).toLocaleString()}
            </span>
          </span>
        ),
      },
    ],
    []
  );

  return (
    <div className="flex min-h-0 max-h-full flex-1 flex-col">
      <PanelShell
        icon={<Hammer className="h-4 w-4" />}
        title="Build jobs"
        description="All builds assigned to this Build Worker. Scroll to load older jobs."
        className="flex h-fit max-h-full min-h-0 flex-col"
        bodyClassName="flex min-h-0 flex-1 p-0"
      >
        <DataTable
          columns={columns}
          data={rows}
          keyFn={(build) => build.id}
          onRowClick={(build) => {
            setSelected(build);
            setDetailsOpen(true);
          }}
          loading={loading && rows.length === 0}
          horizontalScroll
          minWidth="58rem"
          embedded
          fixedRowHeight={49}
          className="h-fit w-full max-h-full [&_[data-route-scroll-container]]:flex-1"
          scrollRef={tableScrollRef}
          emptyMessage="No jobs have been assigned to this Build Worker."
          footer={
            nextCursor ? (
              <div ref={sentinelRef} className="py-3 text-center text-xs text-muted-foreground">
                {loading ? "Loading more…" : "Scroll to load older jobs"}
              </div>
            ) : null
          }
        />
      </PanelShell>

      <DockerBuildDetailsDialog
        open={detailsOpen}
        build={selected}
        onOpenChange={setDetailsOpen}
        onExited={() => setSelected(null)}
      />
    </div>
  );
}
