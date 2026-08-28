import { GitBranch, Pin, RefreshCw, RotateCcw, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SearchFilterBar } from "@/components/common/SearchFilterBar";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { api } from "@/services/api";
import { useDockerStore } from "@/stores/docker";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import type { DockerBuild, DockerBuildStatus } from "@/types";
import { DockerBuildDetailsDialog } from "./docker-detail/DockerBuildDetailsDialog";

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

const ACTIVE = new Set<DockerBuildStatus>([
  "queued",
  "claimed",
  "checking_out",
  "building",
  "scanning",
  "pushing",
  "deploying",
]);
function shortSha(value: string) {
  return value.slice(0, 8);
}

function buildDuration(build: DockerBuild) {
  const start = Date.parse(build.startedAt ?? build.queuedAt);
  const elapsedSeconds = Number(build.progress.elapsedSeconds);
  const end = build.completedAt
    ? Date.parse(build.completedAt)
    : Number.isFinite(elapsedSeconds)
      ? start + elapsedSeconds * 1000
      : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export interface DockerBuildsProps {
  embedded?: boolean;
}

export function DockerBuilds({ embedded = false }: DockerBuildsProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<DockerBuild[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [provider, setProvider] = useState("all");
  const [resource, setResource] = useState("all");
  const [builder, setBuilder] = useState("all");
  const [branch, setBranch] = useState("all");
  const [selected, setSelected] = useState<DockerBuild | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pinBuild, setPinBuild] = useState<DockerBuild | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const displayedPinBuild = useRetainedDialogValue(pinBuild, pinOpen);
  const requestId = useRef(0);
  const pollRequestId = useRef(0);
  const loadingMore = useRef(false);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const dockerNodes = useDockerStore((state) => state.dockerNodes);
  const { isPinnedDashboard, isPinnedSidebar, toggleDashboard, toggleSidebar } =
    usePinnedContainersStore();

  useEffect(() => {
    const buildId = searchParams.get("build");
    if (!buildId || detailsOpen) return;
    let cancelled = false;
    void api
      .getDockerBuild(buildId)
      .then((build) => {
        if (cancelled) return;
        setSelected(build);
        setDetailsOpen(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSearchParams(
          (current) => {
            const next = new URLSearchParams(current);
            next.delete("build");
            return next;
          },
          { replace: true }
        );
      });
    return () => {
      cancelled = true;
    };
  }, [detailsOpen, searchParams, setSearchParams]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [search]);

  const buildPageOptions = useCallback(
    (cursor?: string) => ({
      limit: 50,
      cursor,
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(status !== "all" ? { status: status as DockerBuildStatus } : {}),
      ...(provider !== "all" ? { provider: provider as "gitlab" | "github" | "git" } : {}),
      ...(resource !== "all" ? { sourceBindingId: resource } : {}),
      ...(builder !== "all" ? { builderNodeId: builder } : {}),
      ...(branch !== "all" ? { branch } : {}),
    }),
    [branch, builder, debouncedSearch, provider, resource, status]
  );

  const loadPage = useCallback(
    async (cursor: string | undefined, replace: boolean) => {
      if (!replace && loadingMore.current) return;
      const currentRequest = ++requestId.current;
      if (replace) setNextCursor(null);
      else loadingMore.current = true;
      setLoading(true);
      try {
        const page = await api.listDockerBuildPage(buildPageOptions(cursor));
        if (currentRequest !== requestId.current) return;
        setRows((current) => (replace ? page.data : [...current, ...page.data]));
        setNextCursor(page.nextCursor);
      } catch (error) {
        if (currentRequest === requestId.current) {
          toast.error(error instanceof Error ? error.message : "Failed to load builds");
        }
      } finally {
        if (currentRequest === requestId.current) {
          setLoading(false);
          loadingMore.current = false;
        }
      }
    },
    [buildPageOptions]
  );

  const refreshHead = useCallback(async () => {
    const currentRequest = ++pollRequestId.current;
    try {
      const page = await api.listDockerBuildPage(buildPageOptions());
      if (currentRequest !== pollRequestId.current) return;
      setRows((current) => {
        const refreshedIds = new Set(page.data.map((build) => build.id));
        return [
          ...page.data,
          ...current.filter((build) => !refreshedIds.has(build.id) && !ACTIVE.has(build.status)),
        ];
      });
    } catch {
      // Polling failures stay silent and preserve the current table.
    }
  }, [buildPageOptions]);

  useEffect(() => {
    void loadPage(undefined, true);
    return () => {
      pollRequestId.current += 1;
    };
  }, [loadPage]);

  const hasActiveBuilds = rows.some((build) => ACTIVE.has(build.status));
  useRealtime("docker.build.changed", () => void refreshHead(), {
    onReconnect: () => void refreshHead(),
  });
  useRealtime("docker.build.artifact.changed", () => void refreshHead());

  useEffect(() => {
    const interval = window.setInterval(
      () => {
        if (!document.hidden) void refreshHead();
      },
      hasActiveBuilds ? 5_000 : 15_000
    );
    return () => window.clearInterval(interval);
  }, [hasActiveBuilds, refreshHead]);

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

  useEffect(() => {
    if (!selected) return;
    const refreshed = rows.find((build) => build.id === selected.id);
    if (refreshed && refreshed !== selected) setSelected(refreshed);
  }, [rows, selected]);

  const optionBuilds = rows;
  const resourceOptions = useMemo(
    () =>
      [
        ...new Map(
          optionBuilds.map((build) => [build.sourceBindingId, build.target.name])
        ).entries(),
      ].sort((left, right) => left[1].localeCompare(right[1])),
    [optionBuilds]
  );
  const builderOptions = useMemo(
    () =>
      [
        ...new Map(
          optionBuilds.flatMap((build) =>
            build.builderNodeId
              ? [[build.builderNodeId, build.builderName || build.builderNodeId] as const]
              : []
          )
        ).entries(),
      ].sort((left, right) => left[1].localeCompare(right[1])),
    [optionBuilds]
  );
  const branchOptions = useMemo(
    () =>
      [...new Set(optionBuilds.map((build) => build.ref.replace("refs/heads/", "")))].sort(
        (left, right) => left.localeCompare(right)
      ),
    [optionBuilds]
  );

  const act = useCallback(
    async (build: DockerBuild, action: "cancel" | "retry") => {
      try {
        if (action === "cancel") await api.cancelDockerBuild(build.id);
        else await api.retryDockerBuild(build.id);
        await loadPage(undefined, true);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Failed to ${action} build`);
      }
    },
    [loadPage]
  );

  const columns = useMemo<DataTableColumn<DockerBuild>[]>(
    () => [
      {
        key: "source",
        header: "Source / resource",
        width: "minmax(16rem,1.4fr)",
        render: (build) => (
          <span className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
              <GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block truncate font-medium">{build.repositoryFullPath}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {build.target.kind === "container"
                  ? build.target.name
                  : build.target.kind === "deployment"
                    ? `Deployment ${build.target.name}`
                    : build.target.kind === "compose_project"
                      ? `Compose ${build.target.name}${build.serviceName ? ` · ${build.serviceName}` : ""}`
                      : `Pages ${build.target.name}`}
              </span>
            </span>
          </span>
        ),
      },
      {
        key: "commit",
        header: "Commit / ref",
        width: "8.5rem",
        render: (build) => (
          <span className="block min-w-0">
            <Badge variant="outline" className="font-mono">
              {shortSha(build.commitSha)}
            </Badge>
            <span className="mt-1 block truncate text-xs text-muted-foreground">
              {build.ref.replace("refs/heads/", "")}
            </span>
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        align: "right",
        width: "9rem",
        render: (build) => (
          <Badge variant={STATUS_VARIANT[build.status]}>{build.status.replaceAll("_", " ")}</Badge>
        ),
      },
      {
        key: "result",
        header: "Result",
        align: "right",
        width: "minmax(12rem,1fr)",
        render: (build) => {
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
                {blocked
                  ? "Policy blocked"
                  : build.status === "succeeded"
                    ? "Deployed"
                    : "Approved"}
              </Badge>
              <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                {blocked
                  ? build.artifact.policyReason || "Artifact rejected"
                  : build.status === "succeeded"
                    ? "Deployment completed"
                    : "Artifact approved"}
              </span>
            </span>
          );
        },
      },
      {
        key: "artifactSha",
        header: "SHA",
        align: "right",
        width: "12rem",
        render: (build) =>
          build.artifact ? (
            <span className="font-mono text-xs">{`${build.artifact.digest.slice(0, 19)}…`}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        key: "time",
        header: "Duration / created",
        align: "right",
        width: "11rem",
        render: (build) => (
          <span className="block">
            <span className="block">{buildDuration(build)}</span>
            <span className="block text-xs text-muted-foreground">
              {new Date(build.createdAt).toLocaleString()}
            </span>
          </span>
        ),
      },
      {
        key: "actions",
        header: "",
        align: "right",
        width: "4rem",
        render: (build) => (
          <span className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
            {build.target.kind !== "pages_project" && (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Pin build"
                onClick={() => {
                  setPinBuild(build);
                  setPinOpen(true);
                }}
              >
                <Pin className="h-4 w-4" />
              </Button>
            )}
            {ACTIVE.has(build.status) && (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Cancel build"
                onClick={() => void act(build, "cancel")}
              >
                <Square className="h-4 w-4" />
              </Button>
            )}
            {["failed", "cancelled", "superseded"].includes(build.status) && (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Retry build"
                onClick={() => void act(build, "retry")}
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
            )}
          </span>
        ),
      },
    ],
    [act]
  );

  return (
    <div className={embedded ? "flex min-h-0 flex-1 flex-col gap-3" : "space-y-3"}>
      <div className="flex items-center justify-between gap-3">
        <span />
        <ResponsiveHeaderActions actions={[]}>
          <Button
            variant="outline"
            onClick={() => void loadPage(undefined, true)}
            disabled={loading}
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </ResponsiveHeaderActions>
      </div>
      <SearchFilterBar
        search={search}
        onSearchChange={setSearch}
        hasActiveFilters={Boolean(
          search ||
            status !== "all" ||
            provider !== "all" ||
            resource !== "all" ||
            builder !== "all" ||
            branch !== "all"
        )}
        onReset={() => {
          setSearch("");
          setStatus("all");
          setProvider("all");
          setResource("all");
          setBuilder("all");
          setBranch("all");
        }}
        inlineFilters
        placeholder="Search repository, resource, branch, or SHA"
        filters={
          <>
            <div className="w-40">
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger aria-label="Build status" className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value="all">All statuses</SelectItem>
                  {Object.keys(STATUS_VARIANT).map((value) => (
                    <SelectItem key={value} value={value}>
                      {value.replaceAll("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-36">
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger aria-label="Git provider" className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All providers</SelectItem>
                  <SelectItem value="gitlab">GitLab</SelectItem>
                  <SelectItem value="github">GitHub</SelectItem>
                  <SelectItem value="git">Generic Git</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-44">
              <Select value={resource} onValueChange={setResource}>
                <SelectTrigger aria-label="Build resource" className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value="all">All resources</SelectItem>
                  {resourceOptions.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-40">
              <Select value={builder} onValueChange={setBuilder}>
                <SelectTrigger aria-label="Build worker" className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value="all">All workers</SelectItem>
                  {builderOptions.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-36">
              <Select value={branch} onValueChange={setBranch}>
                <SelectTrigger aria-label="Build branch" className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value="all">All branches</SelectItem>
                  {branchOptions.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        }
      />
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
        minWidth="80rem"
        className={embedded ? "shrink" : undefined}
        scrollRef={tableScrollRef}
        emptyMessage="No builds match the current filters."
        footer={
          nextCursor ? (
            <div ref={sentinelRef} className="py-3 text-center text-xs text-muted-foreground">
              {loading ? "Loading more…" : "Scroll to load older builds"}
            </div>
          ) : null
        }
      />

      <DockerBuildDetailsDialog
        open={detailsOpen}
        build={selected}
        onOpenChange={(open) => {
          setDetailsOpen(open);
          if (!open && searchParams.has("build")) {
            setSearchParams(
              (current) => {
                const next = new URLSearchParams(current);
                next.delete("build");
                return next;
              },
              { replace: true }
            );
          }
        }}
        onExited={() => setSelected(null)}
      />
      <Dialog
        open={pinOpen}
        onOpenChange={(open) => {
          setPinOpen(open);
          if (!open) setPinBuild(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pin build</DialogTitle>
            <DialogDescription>
              Keep{" "}
              {displayedPinBuild
                ? `${displayedPinBuild.target.name} · ${shortSha(displayedPinBuild.commitSha)}`
                : "build"}{" "}
              visible.
            </DialogDescription>
          </DialogHeader>
          {displayedPinBuild &&
            (() => {
              if (displayedPinBuild.target.kind === "pages_project") return null;
              const scopeBase =
                displayedPinBuild.target.kind === "compose_project"
                  ? ("docker:compose:view" as const)
                  : ("docker:containers:view" as const);
              const scopeResourceId =
                displayedPinBuild.target.kind === "container"
                  ? displayedPinBuild.target.containerName
                  : displayedPinBuild.target.kind === "deployment"
                    ? displayedPinBuild.target.deploymentId
                    : displayedPinBuild.target.composeProjectId;
              const nodeSlug =
                dockerNodes.find((node) => node.id === displayedPinBuild.target.nodeId)?.slug ??
                displayedPinBuild.target.nodeId;
              const meta = {
                nodeId: displayedPinBuild.target.nodeId,
                nodeSlug,
                name: `${displayedPinBuild.target.name} · ${shortSha(displayedPinBuild.commitSha)}`,
                state: displayedPinBuild.status,
                kind: "build" as const,
                scopeBase,
                scopeResourceId,
              };
              return (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium">Add to dashboard</p>
                      <p className="text-xs text-muted-foreground">Show current build status</p>
                    </div>
                    <Switch
                      checked={isPinnedDashboard(displayedPinBuild.id)}
                      onChange={() => {
                        toggleDashboard(displayedPinBuild.id, meta);
                        usePinnedContainersStore.getState().invalidate();
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium">Add to sidebar</p>
                      <p className="text-xs text-muted-foreground">Quick access to build details</p>
                    </div>
                    <Switch
                      checked={isPinnedSidebar(displayedPinBuild.id)}
                      onChange={() => {
                        toggleSidebar(displayedPinBuild.id, meta);
                        usePinnedContainersStore.getState().invalidate();
                      }}
                    />
                  </div>
                </div>
              );
            })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
