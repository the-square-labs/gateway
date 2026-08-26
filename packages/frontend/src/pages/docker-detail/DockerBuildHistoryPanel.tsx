import { Hammer } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import type { DockerBuild } from "@/types";
import { DockerBuildDetailsDialog } from "./DockerBuildDetailsDialog";

interface DockerBuildHistoryPanelProps {
  builds: DockerBuild[];
  sourceBindingId?: string;
  loading?: boolean;
}

export function DockerBuildHistoryPanel({
  builds,
  sourceBindingId,
  loading = false,
}: DockerBuildHistoryPanelProps) {
  const [selected, setSelected] = useState<DockerBuild | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const [allBuilds, setAllBuilds] = useState<DockerBuild[]>([]);
  const [allLoading, setAllLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const requestId = useRef(0);
  const loadingMore = useRef(false);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadPage = useCallback(
    async (cursor: string | undefined, replace: boolean) => {
      if (!sourceBindingId || (!replace && loadingMore.current)) return;
      const currentRequest = ++requestId.current;
      if (replace) setNextCursor(null);
      else loadingMore.current = true;
      setAllLoading(true);
      try {
        const page = await api.listDockerBuildPage({ sourceBindingId, cursor, limit: 50 });
        if (currentRequest !== requestId.current) return;
        setAllBuilds((current) => (replace ? page.data : [...current, ...page.data]));
        setNextCursor(page.nextCursor);
      } catch (error) {
        if (currentRequest === requestId.current) {
          toast.error(error instanceof Error ? error.message : "Failed to load build history");
        }
      } finally {
        if (currentRequest === requestId.current) {
          setAllLoading(false);
          loadingMore.current = false;
        }
      }
    },
    [sourceBindingId]
  );

  useEffect(() => {
    if (allOpen) void loadPage(undefined, true);
  }, [allOpen, loadPage]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = tableScrollRef.current;
    if (!allOpen || !sentinel || !root || !nextCursor) return;
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
  }, [allOpen, loadPage, nextCursor]);

  useEffect(() => {
    if (!selected) return;
    const refreshed = builds.find((build) => build.id === selected.id);
    if (refreshed && refreshed !== selected) setSelected(refreshed);
  }, [builds, selected]);

  useRealtime(allOpen && sourceBindingId ? "docker.build.changed" : null, (payload) => {
    const event = payload as { sourceBindingId?: string } | undefined;
    if (event?.sourceBindingId === sourceBindingId) void loadPage(undefined, true);
  });
  useRealtime(allOpen && sourceBindingId ? "docker.build.artifact.changed" : null, (payload) => {
    const event = payload as { sourceBindingId?: string } | undefined;
    if (event?.sourceBindingId === sourceBindingId) void loadPage(undefined, true);
  });

  const renderStatus = (build: DockerBuild) => (
    <Badge
      variant={
        build.status === "succeeded"
          ? "success"
          : build.status === "failed"
            ? "destructive"
            : "secondary"
      }
    >
      {build.status.replaceAll("_", " ")}
    </Badge>
  );
  const renderWorker = (build: DockerBuild) => (
    <Badge variant="secondary" className="max-w-full truncate">
      {build.builderName ?? build.builderNodeId?.slice(0, 8) ?? "Waiting"}
    </Badge>
  );
  const renderResult = (build: DockerBuild) => {
    if (!build.artifact) {
      return (
        <span className="block min-w-0">
          <Badge variant="secondary">Pending</Badge>
          <span className="mt-1 block text-xs text-muted-foreground">
            {build.status === "scanning" ? "Security scan" : "Waiting for artifact"}
          </span>
        </span>
      );
    }
    const blocked = build.artifact.policyDecision === "rejected";
    return (
      <span className="block min-w-0">
        <Badge variant={blocked ? "destructive" : "success"}>
          {blocked ? "Policy blocked" : build.status === "succeeded" ? "Deployed" : "Approved"}
        </Badge>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {blocked
            ? build.artifact.policyReason || "Artifact rejected"
            : build.status === "succeeded"
              ? "Deployment completed"
              : "Artifact approved"}
        </span>
      </span>
    );
  };
  const renderArtifactSha = (build: DockerBuild) =>
    build.artifact ? (
      <span className="block truncate font-mono text-xs">
        {`${build.artifact.digest.slice(0, 19)}…`}
      </span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  const hasServiceBuilds = builds.some((build) => Boolean(build.serviceName));
  const renderService = (build: DockerBuild) => (
    <span className="block truncate font-medium">{build.serviceName ?? "—"}</span>
  );

  const recentColumns: SimpleTableColumn<DockerBuild>[] = [
    {
      id: "commit",
      header: "Commit",
      className: hasServiceBuilds ? "w-[16%]" : "w-[20%]",
      render: (build) => <span className="font-mono">{build.commitSha.slice(0, 10)}</span>,
    },
    ...(hasServiceBuilds
      ? [
          {
            id: "service",
            header: "Service",
            className: "w-[16%]",
            render: renderService,
          } satisfies SimpleTableColumn<DockerBuild>,
        ]
      : []),
    {
      id: "status",
      header: "Status",
      align: "right",
      className: hasServiceBuilds ? "w-[13%]" : "w-[15%]",
      render: renderStatus,
    },
    {
      id: "worker",
      header: "Build Worker",
      align: "right",
      className: hasServiceBuilds ? "w-[17%]" : "w-[20%]",
      render: renderWorker,
    },
    {
      id: "artifact",
      header: "Result",
      align: "right",
      className: hasServiceBuilds ? "w-[22%]" : "w-[25%]",
      render: renderResult,
    },
    {
      id: "artifactSha",
      header: "SHA",
      align: "right",
      className: hasServiceBuilds ? "w-[16%]" : "w-[20%]",
      render: renderArtifactSha,
    },
  ];
  const allColumns: DataTableColumn<DockerBuild>[] = [
    {
      key: "commit",
      header: "Commit",
      width: "0.75fr",
      render: (build) => (
        <span className="block truncate font-mono">{build.commitSha.slice(0, 10)}</span>
      ),
    },
    ...(hasServiceBuilds
      ? [
          {
            key: "service",
            header: "Service",
            width: "0.9fr",
            render: renderService,
          } satisfies DataTableColumn<DockerBuild>,
        ]
      : []),
    { key: "status", header: "Status", align: "right", width: "0.8fr", render: renderStatus },
    {
      key: "worker",
      header: "Build Worker",
      align: "right",
      width: "1.2fr",
      render: renderWorker,
    },
    {
      key: "artifact",
      header: "Result",
      align: "right",
      width: "1.35fr",
      render: renderResult,
    },
    {
      key: "artifactSha",
      header: "SHA",
      align: "right",
      width: "1.1fr",
      render: renderArtifactSha,
    },
  ];

  const openDetails = (build: DockerBuild) => {
    setSelected(build);
    setDetailsOpen(true);
  };
  const openAll = () => {
    requestId.current += 1;
    loadingMore.current = false;
    setAllBuilds([]);
    setNextCursor(null);
    setAllLoading(false);
    setAllOpen(true);
  };
  const closeAll = (nextOpen: boolean) => {
    setAllOpen(nextOpen);
    if (!nextOpen) {
      requestId.current += 1;
      loadingMore.current = false;
    }
  };
  return (
    <>
      <PanelShell
        icon={<Hammer className="h-4 w-4" />}
        title="Builds"
        description="The 5 most recent builds, security decisions, and deployment results."
        actions={
          <Button
            variant="ghost"
            className="h-auto p-0 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={openAll}
          >
            View all
          </Button>
        }
      >
        <SimpleTable
          columns={recentColumns}
          rows={builds.slice(0, 5)}
          getRowKey={(build) => build.id}
          loading={loading}
          emptyMessage="No builds yet. Queue the first build from the Source tab."
          tableClassName="table-fixed"
          onRowClick={openDetails}
        />
      </PanelShell>

      <Dialog open={allOpen} onOpenChange={closeAll}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-h-[85dvh] sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Build history</DialogTitle>
            <DialogDescription>Scroll the table to load older builds.</DialogDescription>
          </DialogHeader>
          <DataTable
            columns={allColumns}
            data={allBuilds}
            keyFn={(build) => build.id}
            onRowClick={openDetails}
            loading={allLoading && allBuilds.length === 0}
            className="max-h-[min(56dvh,36rem)]"
            scrollRef={tableScrollRef}
            emptyMessage="No builds yet."
            footer={
              nextCursor ? (
                <div ref={sentinelRef} className="py-3 text-center text-xs text-muted-foreground">
                  {allLoading ? "Loading more…" : "Scroll to load older builds"}
                </div>
              ) : null
            }
          />
        </DialogContent>
      </Dialog>

      <DockerBuildDetailsDialog
        open={detailsOpen}
        build={selected}
        onOpenChange={setDetailsOpen}
        onExited={() => setSelected(null)}
      />
    </>
  );
}
