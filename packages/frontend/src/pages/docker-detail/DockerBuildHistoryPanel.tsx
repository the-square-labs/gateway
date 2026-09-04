import { Hammer } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import type { DockerBuild } from "@/types";
import { DockerBuildDetailsDialog } from "./DockerBuildDetailsDialog";

interface DockerBuildHistoryPanelProps {
  builds: DockerBuild[];
  sourceBindingId?: string;
  loading?: boolean;
  inlineHistory?: boolean;
}

const ACTIVE_BUILD_STATUSES = new Set<DockerBuild["status"]>([
  "queued",
  "claimed",
  "checking_out",
  "building",
  "scanning",
  "pushing",
  "deploying",
]);

function compareBuildsNewestFirst(left: DockerBuild, right: DockerBuild): number {
  const createdAtOrder = right.createdAt.localeCompare(left.createdAt);
  return createdAtOrder || right.id.localeCompare(left.id);
}

function formatBuildTime(build: DockerBuild): string {
  if (!build.startedAt) return "—";
  const startedAt = Date.parse(build.startedAt);
  const endedAt = build.completedAt ? Date.parse(build.completedAt) : Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return "—";
  const seconds = Math.round((endedAt - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

export function DockerBuildHistoryPanel({
  builds,
  sourceBindingId,
  loading = false,
  inlineHistory = false,
}: DockerBuildHistoryPanelProps) {
  const [selected, setSelected] = useState<DockerBuild | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const [allBuilds, setAllBuilds] = useState<DockerBuild[]>([]);
  const [allLoading, setAllLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const headRequestId = useRef(0);
  const pageRequestId = useRef(0);
  const paginationInitialized = useRef(false);
  const loadingMore = useRef(false);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pointRequestIds = useRef(new Map<string, number>());
  const sourceGenerationRef = useRef({ sourceBindingId, generation: 0 });
  if (sourceGenerationRef.current.sourceBindingId !== sourceBindingId) {
    sourceGenerationRef.current = {
      sourceBindingId,
      generation: sourceGenerationRef.current.generation + 1,
    };
    pointRequestIds.current.clear();
  }
  const sourceBindingIdRef = useRef(sourceBindingId);
  sourceBindingIdRef.current = sourceBindingId;

  const loadHead = useCallback(
    async (reset: boolean) => {
      if (!sourceBindingId) return;
      const currentRequest = ++headRequestId.current;
      pageRequestId.current += 1;
      loadingMore.current = false;
      if (reset) {
        paginationInitialized.current = false;
        setNextCursor(null);
        setAllLoading(true);
      }
      try {
        const page = await api.listDockerBuildPage({ sourceBindingId, limit: 50 });
        if (currentRequest !== headRequestId.current) return;
        setAllBuilds((current) => {
          if (reset) return page.data;
          const refreshedIds = new Set(page.data.map((build) => build.id));
          return [...page.data, ...current.filter((build) => !refreshedIds.has(build.id))];
        });
        if (reset || !paginationInitialized.current) {
          paginationInitialized.current = true;
          setNextCursor(page.nextCursor);
        }
      } catch (error) {
        if (reset && currentRequest === headRequestId.current) {
          toast.error(error instanceof Error ? error.message : "Failed to load build history");
        }
      } finally {
        if (currentRequest === headRequestId.current) setAllLoading(false);
      }
    },
    [sourceBindingId]
  );

  const loadPage = useCallback(
    async (cursor: string) => {
      if (!sourceBindingId || loadingMore.current) return;
      const currentRequest = ++pageRequestId.current;
      loadingMore.current = true;
      setAllLoading(true);
      try {
        const page = await api.listDockerBuildPage({ sourceBindingId, cursor, limit: 50 });
        if (currentRequest !== pageRequestId.current) return;
        setAllBuilds((current) => {
          const existingIds = new Set(current.map((build) => build.id));
          return [...current, ...page.data.filter((build) => !existingIds.has(build.id))];
        });
        setNextCursor(page.nextCursor);
      } catch (error) {
        if (currentRequest === pageRequestId.current) {
          toast.error(error instanceof Error ? error.message : "Failed to load build history");
        }
      } finally {
        if (currentRequest === pageRequestId.current) {
          setAllLoading(false);
          loadingMore.current = false;
        }
      }
    },
    [sourceBindingId]
  );

  const refreshHead = useCallback(() => loadHead(false), [loadHead]);

  const refreshBuild = useCallback(
    async (buildId: string) => {
      const expectedSourceBindingId = sourceBindingId;
      if (!expectedSourceBindingId) return;
      const expectedSourceGeneration = sourceGenerationRef.current.generation;
      const requestId = (pointRequestIds.current.get(buildId) ?? 0) + 1;
      pointRequestIds.current.set(buildId, requestId);
      try {
        const build = await api.getDockerBuild(buildId);
        if (
          sourceBindingIdRef.current !== expectedSourceBindingId ||
          sourceGenerationRef.current.generation !== expectedSourceGeneration ||
          pointRequestIds.current.get(buildId) !== requestId ||
          build.sourceBindingId !== expectedSourceBindingId
        ) {
          return;
        }
        setAllBuilds((current) => {
          const existingIndex = current.findIndex((candidate) => candidate.id === build.id);
          const next =
            existingIndex === -1
              ? [...current, build]
              : current.map((candidate, index) => (index === existingIndex ? build : candidate));
          return next.sort(compareBuildsNewestFirst);
        });
      } catch {
        // The head refresh remains the fallback for deleted or no-longer-visible builds.
      }
    },
    [sourceBindingId]
  );

  const refreshTrackedActiveBuilds = useCallback(() => {
    for (const build of allBuilds) {
      if (ACTIVE_BUILD_STATUSES.has(build.status)) void refreshBuild(build.id);
    }
  }, [allBuilds, refreshBuild]);

  useEffect(
    () => () => {
      headRequestId.current += 1;
      pageRequestId.current += 1;
    },
    []
  );

  const historyActive = inlineHistory || allOpen;

  useEffect(() => {
    if (historyActive) void loadHead(true);
  }, [historyActive, loadHead]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = tableScrollRef.current;
    if (!historyActive || !sentinel || !root || !nextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingMore.current) {
          void loadPage(nextCursor);
        }
      },
      { root, rootMargin: "320px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [historyActive, loadPage, nextCursor]);

  useEffect(() => {
    if (!selected) return;
    const refreshed = (inlineHistory ? allBuilds : builds).find(
      (build) => build.id === selected.id
    );
    if (refreshed && refreshed !== selected) setSelected(refreshed);
  }, [allBuilds, builds, inlineHistory, selected]);

  useRealtime(
    historyActive && sourceBindingId ? "docker.build.changed" : null,
    (payload) => {
      const event = payload as { buildId?: string; sourceBindingId?: string } | undefined;
      if (event?.sourceBindingId === sourceBindingId) {
        const buildId = event?.buildId;
        if (buildId) void refreshBuild(buildId);
        void refreshHead();
      }
    },
    {
      onReconnect: () => {
        refreshTrackedActiveBuilds();
        void refreshHead();
      },
    }
  );
  useRealtime(
    historyActive && sourceBindingId ? "docker.build.artifact.changed" : null,
    (payload) => {
      const event = payload as { buildId?: string; sourceBindingId?: string } | undefined;
      if (event?.sourceBindingId === sourceBindingId) {
        const buildId = event?.buildId;
        if (buildId) void refreshBuild(buildId);
        void refreshHead();
      }
    }
  );

  const hasActiveHistoryBuilds = allBuilds.some((build) => ACTIVE_BUILD_STATUSES.has(build.status));
  useEffect(() => {
    if (!historyActive || !sourceBindingId) return;
    const interval = window.setInterval(
      () => {
        if (!document.hidden) {
          refreshTrackedActiveBuilds();
          void refreshHead();
        }
      },
      hasActiveHistoryBuilds ? 5_000 : 15_000
    );
    return () => window.clearInterval(interval);
  }, [
    hasActiveHistoryBuilds,
    historyActive,
    refreshHead,
    refreshTrackedActiveBuilds,
    sourceBindingId,
  ]);

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
    const detail = !build.artifact
      ? build.status === "scanning"
        ? "Security scan"
        : "Waiting for artifact"
      : build.artifact.policyDecision === "rejected"
        ? build.artifact.policyReason || "Artifact rejected"
        : build.status === "succeeded"
          ? "Deployment completed"
          : "Artifact approved";
    if (!build.artifact) {
      return (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="secondary" tabIndex={0}>
                Pending
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top">{detail}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }
    const blocked = build.artifact.policyDecision === "rejected";
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant={blocked ? "destructive" : "success"} tabIndex={0}>
              {blocked ? "Policy blocked" : build.status === "succeeded" ? "Deployed" : "Approved"}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-sm">
            {detail}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
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
    { key: "status", header: "Status", align: "center", width: "0.8fr", render: renderStatus },
    {
      key: "worker",
      header: "Build Worker",
      align: "center",
      width: "1.2fr",
      render: renderWorker,
    },
    {
      key: "artifact",
      header: "Result",
      align: "center",
      width: "1.35fr",
      render: renderResult,
    },
    {
      key: "time",
      header: "Time",
      align: "center",
      width: "0.7fr",
      render: formatBuildTime,
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
    headRequestId.current += 1;
    pageRequestId.current += 1;
    paginationInitialized.current = false;
    loadingMore.current = false;
    setAllBuilds([]);
    setNextCursor(null);
    setAllLoading(true);
    setAllOpen(true);
  };
  const closeAll = (nextOpen: boolean) => {
    setAllOpen(nextOpen);
    if (!nextOpen) {
      headRequestId.current += 1;
      pageRequestId.current += 1;
      loadingMore.current = false;
    }
  };
  const historyTable = (embedded: boolean) => (
    <DataTable
      columns={allColumns}
      data={allBuilds}
      keyFn={(build) => build.id}
      onRowClick={openDetails}
      loading={(inlineHistory ? loading || allLoading : allLoading) && allBuilds.length === 0}
      className={
        embedded
          ? "h-fit w-full max-h-full [&_[data-route-scroll-container]]:flex-1"
          : "max-h-[min(56dvh,36rem)]"
      }
      scrollRef={tableScrollRef}
      emptyMessage="No builds yet."
      embedded={embedded}
      footer={
        nextCursor ? (
          <div ref={sentinelRef} className="py-3 text-center text-xs text-muted-foreground">
            {allLoading ? "Loading more…" : "Scroll to load older builds"}
          </div>
        ) : null
      }
    />
  );
  return (
    <>
      {inlineHistory ? (
        <PanelShell
          icon={<Hammer className="h-4 w-4" />}
          title="Builds"
          description="Build history, security decisions, and deployment results."
          className="flex h-fit max-h-full min-h-0 flex-col"
          bodyClassName="flex min-h-0 flex-1 p-0"
        >
          {historyTable(true)}
        </PanelShell>
      ) : (
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
      )}

      <Dialog open={!inlineHistory && allOpen} onOpenChange={closeAll}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-h-[85dvh] sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Build history</DialogTitle>
            <DialogDescription>Scroll the table to load older builds.</DialogDescription>
          </DialogHeader>
          {allLoading && allBuilds.length === 0 ? (
            <LoadingSpinner className="min-h-48" label="Loading build history" />
          ) : (
            historyTable(false)
          )}
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
