import {
  Activity,
  Boxes,
  ChevronDown,
  Code2,
  EllipsisVertical,
  ExternalLink,
  FilePenLine,
  FolderOpen,
  GitBranch,
  Hammer,
  HardDrive,
  History,
  KeyRound,
  LayoutDashboard,
  Loader2,
  Network,
  Pin,
  Play,
  RefreshCw,
  ScrollText,
  Square,
  Terminal,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { DetailRow } from "@/components/common/DetailRow";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import {
  type ResponsiveHeaderAction,
  ResponsiveHeaderActions,
} from "@/components/common/ResponsiveHeaderActions";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { ExternalComposeBadge } from "@/components/docker/ExternalComposeBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatCard } from "@/components/ui/stat-card";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRealtime } from "@/hooks/use-realtime";
import { useUrlTab } from "@/hooks/use-url-tab";
import { createClientUuid } from "@/lib/client-id";
import { canAdoptComposeProject, hasComposeProjectScope } from "@/lib/compose-access";
import {
  dockerComposeProjectRoute,
  dockerComposeRootRoute,
  dockerContainerRoute,
} from "@/lib/resource-routes";
import { getReturnNavigationTarget } from "@/lib/return-navigation";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import type {
  DockerComposeOperation,
  DockerComposeOperationAction,
  DockerComposeProject,
  DockerComposeRevision,
  NodeDetail,
} from "@/types";
import { ComposeProjectEditor } from "./compose/ComposeProjectEditor";
import { ComposeVariablesTab } from "./compose/ComposeVariablesTab";
import { DockerResourceGitTabs } from "./docker-detail/DockerResourceGitTabs";
import { LogsTab, type LogsTabSource } from "./docker-detail/LogsTab";
import { StatsTab } from "./docker-detail/StatsTab";

const ACTIVE_STATUSES = new Set(["pending", "running", "cancelling"]);

function formatCompactRelativeTime(value: string) {
  const elapsedMs = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(days / 365)}y ago`;
}

type ComposeService = DockerComposeProject["services"][number];

function projectStatusVariant(status: DockerComposeProject["status"]) {
  if (status === "running") return "success" as const;
  if (status === "failed" || status === "missing") return "destructive" as const;
  if (
    status === "degraded" ||
    status === "applying" ||
    status === "validating" ||
    status === "deleting"
  ) {
    return "warning" as const;
  }
  return "secondary" as const;
}

function operationStatusVariant(status: DockerComposeOperation["status"]) {
  if (status === "succeeded") return "success" as const;
  if (status === "failed") return "destructive" as const;
  if (status === "running") return "warning" as const;
  return "secondary" as const;
}

function formatDuration(startedAt: string | null, completedAt: string | null) {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function operationIcon(action: DockerComposeOperationAction) {
  if (action === "pull_apply" || action === "apply") return UploadCloud;
  if (action === "start") return Play;
  if (action === "stop" || action === "down") return Square;
  if (action === "delete_volumes") return Trash2;
  return RefreshCw;
}

type ServiceProcesses = Record<string, { titles: string[]; rows: string[][] }>;

const PROCESS_COLUMN_WIDTHS: Record<string, string> = {
  PID: "88px",
  USER: "140px",
  "%CPU": "88px",
  "%MEM": "88px",
  VSZ: "100px",
  RSS: "100px",
  TT: "72px",
  STAT: "88px",
  STARTED: "140px",
  TIME: "120px",
};

function processColumnStyle(title: string, index: number, titles: string[]) {
  const flexibleIndex = titles.findIndex((item) => item.toUpperCase() === "COMMAND");
  if (index === (flexibleIndex >= 0 ? flexibleIndex : titles.length - 1)) return undefined;
  return { width: PROCESS_COLUMN_WIDTHS[title.toUpperCase()] ?? "120px" };
}

function ComposeProcessesTable({
  services,
  processes,
}: {
  services: ComposeService[];
  processes: ServiceProcesses;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const titles = services.map((service) => processes[service.name]?.titles).find(Boolean) ?? [
    "Command",
    "CPU",
    "Memory",
  ];
  const visibleServices = services.filter(
    (service) => (processes[service.name]?.rows.length ?? 0) > 0
  );
  if (visibleServices.length === 0) return null;

  return (
    <PanelShell
      title="Processes"
      description="Top processes grouped by Compose service."
      bodyClassName="overflow-x-auto"
    >
      <table className="w-full min-w-[1120px] table-fixed">
        <colgroup>
          {titles.map((title, columnIndex) => (
            <col key={title} style={processColumnStyle(title, columnIndex, titles)} />
          ))}
        </colgroup>
        <thead className="bg-muted">
          <tr className="border-b border-border text-left">
            {titles.map((title) => (
              <th
                key={title}
                className="px-4 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                {title}
              </th>
            ))}
          </tr>
        </thead>
        {visibleServices.map((service, serviceIndex) => {
          const rows = processes[service.name]?.rows ?? [];
          const isExpanded = expanded[service.name] ?? true;
          const isLastService = serviceIndex === visibleServices.length - 1;
          return (
            <tbody key={service.name}>
              <tr className="bg-muted/60">
                <td colSpan={titles.length} className="p-0">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground transition-colors hover:bg-muted/80"
                    aria-expanded={isExpanded}
                    onClick={() =>
                      setExpanded((current) => ({
                        ...current,
                        [service.name]: !isExpanded,
                      }))
                    }
                  >
                    <span>{service.name}</span>
                    <ChevronDown
                      className={`h-4 w-4 transition-transform duration-200 motion-reduce:transition-none ${
                        isExpanded ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                </td>
              </tr>
              <tr className={isLastService ? undefined : "border-b border-border"}>
                <td colSpan={titles.length} className="p-0">
                  <div
                    aria-hidden={!isExpanded}
                    inert={isExpanded ? undefined : true}
                    className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
                      isExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                    }`}
                  >
                    <div
                      className={`min-h-0 overflow-hidden ${
                        isExpanded ? "border-t border-border" : ""
                      }`}
                    >
                      <table className="w-full table-fixed">
                        <colgroup>
                          {titles.map((title, columnIndex) => (
                            <col
                              key={title}
                              style={processColumnStyle(title, columnIndex, titles)}
                            />
                          ))}
                        </colgroup>
                        <tbody>
                          {rows.map((row, rowIndex) => (
                            <tr
                              key={`${service.name}-${rowIndex}`}
                              className="border-b border-border last:border-b-0"
                            >
                              {titles.map((title, columnIndex) => (
                                <td
                                  key={`${title}-${columnIndex}`}
                                  className="px-4 py-2 font-mono text-xs"
                                >
                                  {row[columnIndex] ?? "—"}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </td>
              </tr>
            </tbody>
          );
        })}
      </table>
    </PanelShell>
  );
}

export function DockerComposeProjectDetail() {
  const { projectId = "" } = useParams<{ projectId: string; tab?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { hasScopedAccess, user } = useAuthStore();
  const [project, setProject] = useState<DockerComposeProject | null>(null);
  const [node, setNode] = useState<NodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<DockerComposeOperationAction | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectedServiceName, setSelectedServiceName] = useState<string | null>(null);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityDetailsOpen, setActivityDetailsOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [selectedOperation, setSelectedOperation] = useState<DockerComposeOperation | null>(null);
  const [latestOperation, setLatestOperation] = useState<DockerComposeOperation | null>(null);
  const [recentActivity, setRecentActivity] = useState<DockerComposeOperation[]>([]);
  const [recentActivityLoading, setRecentActivityLoading] = useState(false);
  const [activityOperations, setActivityOperations] = useState<DockerComposeOperation[]>([]);
  const [activityNextCursor, setActivityNextCursor] = useState<string | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityLoadingMore, setActivityLoadingMore] = useState(false);
  const [activityRefreshVersion, setActivityRefreshVersion] = useState(0);
  const activityScrollRef = useRef<HTMLDivElement>(null);
  const activitySentinelRef = useRef<HTMLDivElement>(null);
  const { isPinnedDashboard, isPinnedSidebar, toggleDashboard, toggleSidebar } =
    usePinnedContainersStore();
  const [serviceProcesses, setServiceProcesses] = useState<ServiceProcesses>({});
  const [activeTab, setActiveTab] = useUrlTab(
    [
      "overview",
      "services",
      "source",
      "builds",
      "monitoring",
      "configuration",
      "variables",
      "logs",
    ],
    "overview",
    (tab) => dockerComposeProjectRoute(projectId, tab)
  );
  const backTarget = getReturnNavigationTarget(location.state, dockerComposeRootRoute());

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const summaries = await api.listDockerComposeProjects();
      const summary = summaries.find((candidate) => candidate.id === projectId);
      if (!summary) throw new Error("Compose project not found");
      const [detail, nodeDetail] = await Promise.all([
        api.getDockerComposeProject(summary.nodeId, projectId),
        api.getNode(summary.nodeId),
      ]);
      setProject(detail);
      setNode(nodeDetail);
      setLatestOperation(summary.lastOperation ?? null);
      setSelectedServiceName((current) => current ?? detail.services[0]?.name ?? null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load Compose project");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (activeTab !== "monitoring" || !project || project.status === "stopped") return;
    let cancelled = false;
    const loadProcesses = async () => {
      const snapshots = await Promise.all(
        project.services
          .filter((service) => service.state === "running" && service.containerIds[0])
          .map(async (service) => {
            const containerId = service.containerIds[0];
            if (!containerId) return [service.name, { titles: [], rows: [] }] as const;
            try {
              const result = await api.getContainerTop(project.nodeId, containerId);
              return [
                service.name,
                { titles: result.Titles ?? [], rows: result.Processes ?? [] },
              ] as const;
            } catch {
              return [service.name, { titles: [], rows: [] }] as const;
            }
          })
      );
      if (!cancelled) setServiceProcesses(Object.fromEntries(snapshots));
    };
    void loadProcesses();
    const interval = window.setInterval(() => void loadProcesses(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeTab, project]);
  useRealtime("docker.compose.changed", (payload) => {
    const event = payload as { projectId?: string } | undefined;
    if (event?.projectId && event.projectId !== projectId) return;
    void load();
    setActivityRefreshVersion((current) => current + 1);
  });

  const currentOperation = useMemo(
    () => (latestOperation && ACTIVE_STATUSES.has(latestOperation.status) ? latestOperation : null),
    [latestOperation]
  );

  const loadRecentActivity = useCallback(async () => {
    if (!project) return;
    setRecentActivityLoading(true);
    try {
      const result = await api.listDockerComposeOperations(project.nodeId, project.id, {
        limit: 6,
      });
      setRecentActivity(result.data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load Compose activity");
    } finally {
      setRecentActivityLoading(false);
    }
  }, [project]);

  const loadActivity = useCallback(
    async (cursor?: string) => {
      if (!project) return;
      if (cursor) setActivityLoadingMore(true);
      else setActivityLoading(true);
      try {
        const result = await api.listDockerComposeOperations(project.nodeId, project.id, {
          cursor,
          limit: 50,
        });
        setActivityOperations((current) => {
          if (!cursor) return result.data;
          const existing = new Set(current.map((operation) => operation.id));
          return [...current, ...result.data.filter((operation) => !existing.has(operation.id))];
        });
        setActivityNextCursor(result.nextCursor);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to load Compose activity");
      } finally {
        if (cursor) setActivityLoadingMore(false);
        else setActivityLoading(false);
      }
    },
    [project]
  );

  useEffect(() => {
    if (!project) return;
    void activityRefreshVersion;
    void loadRecentActivity();
  }, [activityRefreshVersion, loadRecentActivity, project]);

  useEffect(() => {
    if (!activityOpen || !project) return;
    void activityRefreshVersion;
    setActivityOperations([]);
    setActivityNextCursor(null);
    void loadActivity();
  }, [activityOpen, activityRefreshVersion, loadActivity, project]);

  useEffect(() => {
    const sentinel = activitySentinelRef.current;
    const root = activityScrollRef.current;
    if (!activityOpen || !sentinel || !root || !activityNextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !activityLoading && !activityLoadingMore) {
          void loadActivity(activityNextCursor);
        }
      },
      { root, rootMargin: "320px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activityLoading, activityLoadingMore, activityNextCursor, activityOpen, loadActivity]);

  useEffect(() => {
    if (project?.desiredState === "stopped" && activeTab === "monitoring") {
      setActiveTab("overview");
    }
  }, [activeTab, project?.desiredState, setActiveTab]);

  const canManage =
    !!project &&
    hasComposeProjectScope(user?.scopes ?? [], "docker:compose:manage", project.nodeId, project.id);
  const canAdopt =
    !!project && canAdoptComposeProject(user?.scopes ?? [], project.nodeId, project.id);
  const canDelete =
    !!project &&
    hasComposeProjectScope(user?.scopes ?? [], "docker:compose:delete", project.nodeId, project.id);
  const canUseConsole = hasScopedAccess("docker:containers:console");
  const canReadFiles = hasScopedAccess("docker:containers:files:read");

  const runAction = async (nextAction: DockerComposeOperationAction, revisionId?: string) => {
    if (!project || !requireLicenseFeature("compose-applications", "Compose lifecycle")) return;
    if (
      nextAction === "down" &&
      !(await confirm({
        title: "Bring project down",
        description:
          "Stop and remove project containers and non-external networks? Named volumes are preserved.",
        confirmLabel: "Down",
      }))
    ) {
      return;
    }
    setAction(nextAction);
    try {
      await api.startDockerComposeOperation(project.nodeId, project.id, nextAction, {
        revisionId,
        idempotencyKey: createClientUuid(),
      });
      toast.success(
        nextAction === "pull_apply" ? "Pull & Apply started" : `Compose ${nextAction} started`
      );
      await load();
    } catch (error) {
      if (!handleLicenseApiError(error, "Compose lifecycle")) {
        toast.error(error instanceof Error ? error.message : "Compose operation failed");
      }
    } finally {
      setAction(null);
    }
  };

  const deleteProject = async () => {
    if (
      !project ||
      !(await confirm({
        title: "Delete Compose project",
        description:
          "Permanently remove this project, its containers, non-external networks, project-owned volumes, revisions, and secrets? External resources are not deleted.",
        confirmLabel: "Delete everything",
      }))
    ) {
      return;
    }
    setDeleting(true);
    try {
      await api.deleteDockerComposeProject(project.nodeId, project.id);
      toast.success("Compose project and runtime resources deleted");
      navigate(dockerComposeRootRoute(), { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete Compose project");
    } finally {
      setDeleting(false);
    }
  };

  const deleteRevision = async (revision: DockerComposeRevision) => {
    if (
      !project ||
      revision.id === project.activeRevisionId ||
      !(await confirm({
        title: `Delete revision ${revision.revisionNumber}`,
        description:
          "Delete this inactive immutable revision? Existing operation history remains, but this configuration can no longer be reapplied.",
        confirmLabel: "Delete revision",
      }))
    ) {
      return;
    }
    try {
      await api.deleteDockerComposeRevision(project.nodeId, project.id, revision.id);
      toast.success(`Revision ${revision.revisionNumber} deleted`);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete revision");
    }
  };

  if (loading) return <DetailPageSkeleton label="Loading Compose project" tabs={8} />;
  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Compose project not found
      </div>
    );
  }

  const selectedService =
    project.services.find((service) => service.name === selectedServiceName) ?? project.services[0];
  const monitoredServices = project.services.filter(
    (service) => service.state === "running" && Boolean(service.containerIds[0])
  );
  const inactiveRevisions = (project.revisions ?? []).filter(
    (revision) => revision.id !== project.activeRevisionId
  );
  const pinAction: ResponsiveHeaderAction = {
    label: "Pin",
    icon: <Pin className="h-4 w-4" />,
    onClick: () => setPinOpen(true),
  };
  const headerActions: ResponsiveHeaderAction[] =
    project.managementState === "external"
      ? canAdopt
        ? [
            pinAction,
            {
              label: "Adopt into Gateway",
              icon: <UploadCloud className="h-4 w-4" />,
              onClick: async () => {
                if (
                  await confirm({
                    title: `Adopt ${project.name}`,
                    description:
                      "Bring this external Compose project under Gateway lifecycle and immutable revision management?",
                    confirmLabel: "Adopt project",
                  })
                )
                  setAdoptOpen(true);
              },
            },
          ]
        : [pinAction]
      : [
          pinAction,
          { label: "Refresh", icon: <RefreshCw className="h-4 w-4" />, onClick: () => void load() },
          ...(canManage
            ? [
                {
                  label: project.status === "running" ? "Stop" : "Start",
                  icon:
                    project.status === "running" ? (
                      <Square className="h-4 w-4" />
                    ) : (
                      <Play className="h-4 w-4" />
                    ),
                  onClick: () => void runAction(project.status === "running" ? "stop" : "start"),
                  disabled: !!currentOperation || !!action || project.status === "deleting",
                },
                {
                  label: "Pull & Apply",
                  icon: <UploadCloud className="h-4 w-4" />,
                  onClick: () => void runAction("pull_apply"),
                  disabled: !!currentOperation || !!action || project.status === "deleting",
                },
                {
                  label: "Change revision",
                  icon: <History className="h-4 w-4" />,
                  onClick: () => setRevisionsOpen(true),
                  disabled:
                    !!currentOperation ||
                    project.status === "deleting" ||
                    inactiveRevisions.length === 0,
                  disabledReason: currentOperation
                    ? "Wait for the active operation to finish"
                    : inactiveRevisions.length === 0
                      ? "No previous revisions"
                      : undefined,
                  alwaysOverflow: true,
                },
                ...(currentOperation
                  ? [
                      {
                        label: "Cancel operation",
                        onClick: () => void runAction("cancel"),
                        destructive: true,
                      },
                    ]
                  : []),
              ]
            : []),
          ...(canDelete
            ? [
                {
                  label: "Delete project",
                  icon: <Trash2 className="h-4 w-4" />,
                  onClick: () => void deleteProject(),
                  disabled: !!currentOperation || deleting || project.status === "deleting",
                  disabledReason: currentOperation
                    ? "Wait for the active operation to finish"
                    : deleting || project.status === "deleting"
                      ? "Deleting project runtime resources"
                      : undefined,
                  destructive: true,
                  separatorBefore: true,
                },
              ]
            : []),
        ];

  const openContainerTarget = async (service: ComposeService, tab?: string) => {
    const containerId = service.containerIds[0];
    if (!containerId) return;
    setSelectedServiceName(service.name);
    if (node?.slug) {
      try {
        const container = await api.inspectContainer(project.nodeId, containerId, true);
        const canonicalName = String(container.Name ?? container.name ?? "").replace(/^\/+/, "");
        if (!canonicalName) throw new Error("Container identity is missing");
        navigate(dockerContainerRoute(node.slug, canonicalName, tab), {
          state: { returnTo: location.pathname },
        });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to open the service container"
        );
      }
    }
  };

  const serviceColumns: DataTableColumn<ComposeService>[] = [
    {
      key: "service",
      header: "Service",
      width: "minmax(180px, 1fr)",
      render: (service) => (
        <span className="inline-flex items-center gap-2 font-medium">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
            <Boxes className="h-4 w-4 text-muted-foreground" />
          </span>
          {service.name}
        </span>
      ),
    },
    {
      key: "image",
      header: "Image",
      width: "minmax(260px, 1.6fr)",
      truncate: true,
      render: (service) => <span className="font-mono text-xs">{service.image || "—"}</span>,
    },
    {
      key: "state",
      header: "State",
      width: "110px",
      render: (service) => (
        <Badge variant={service.state === "running" ? "success" : "secondary"}>
          {service.state}
        </Badge>
      ),
    },
    {
      key: "health",
      header: "Health",
      width: "110px",
      render: (service) => (
        <Badge variant={service.health === "healthy" ? "success" : "secondary"}>
          {service.health}
        </Badge>
      ),
    },
    {
      key: "containers",
      header: "Containers",
      width: "110px",
      align: "right",
      render: (service) => <Badge variant="secondary">{service.containerIds.length}</Badge>,
    },
    {
      key: "actions",
      header: "Actions",
      width: "110px",
      align: "right",
      render: (service) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              disabled={service.containerIds.length === 0}
              aria-label={`Actions for ${service.name}`}
              title={`Actions for ${service.name}`}
              onClick={(event) => event.stopPropagation()}
            >
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuItem onSelect={() => void openContainerTarget(service)}>
              <ExternalLink className="mr-2 h-4 w-4" />
              Container details
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void openContainerTarget(service, "logs")}>
              <ScrollText className="mr-2 h-4 w-4" />
              Logs
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void openContainerTarget(service, "stats")}>
              <Activity className="mr-2 h-4 w-4" />
              Monitoring
            </DropdownMenuItem>
            {(canUseConsole || canReadFiles) && <DropdownMenuSeparator />}
            {canUseConsole && (
              <DropdownMenuItem onSelect={() => void openContainerTarget(service, "console")}>
                <Terminal className="mr-2 h-4 w-4" />
                Console
              </DropdownMenuItem>
            )}
            {canReadFiles && (
              <DropdownMenuItem onSelect={() => void openContainerTarget(service, "files")}>
                <FolderOpen className="mr-2 h-4 w-4" />
                Files
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const revisionColumns: DataTableColumn<DockerComposeRevision>[] = [
    {
      key: "revision",
      header: "Revision",
      width: "110px",
      render: (revision) => (
        <span className="flex items-center gap-2 font-medium">
          <History className="h-4 w-4 text-muted-foreground" />#{revision.revisionNumber}
        </span>
      ),
    },
    {
      key: "digest",
      header: "Digest",
      width: "minmax(190px, 1fr)",
      truncate: true,
      render: (revision) => <code className="text-xs">{revision.configDigest}</code>,
    },
    {
      key: "created",
      header: "Created",
      width: "110px",
      render: (revision) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-default text-muted-foreground" tabIndex={0}>
              {formatCompactRelativeTime(revision.createdAt)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            {new Date(revision.createdAt).toLocaleString()}
          </TooltipContent>
        </Tooltip>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      width: "80px",
      align: "right",
      render: (revision) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" onClick={(event) => event.stopPropagation()}>
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuItem
              disabled={!!currentOperation || revision.id === project.activeRevisionId}
              onSelect={() => void runAction("pull_apply", revision.id)}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Reapply
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              disabled={revision.id === project.activeRevisionId}
              onSelect={() => void deleteRevision(revision)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete revision
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const recentActivityColumns: SimpleTableColumn<DockerComposeOperation>[] = [
    {
      id: "type",
      header: "Type",
      render: (operation) => {
        const Icon = operationIcon(operation.action);
        return (
          <span className="inline-flex items-center gap-2 font-medium">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </span>
            {operation.action.replaceAll("_", " ")}
          </span>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      render: (operation) => (
        <Badge variant={operationStatusVariant(operation.status)}>{operation.status}</Badge>
      ),
    },
    {
      id: "progress",
      header: "Progress / error",
      cellClassName: "max-w-0 truncate",
      render: (operation) => (
        <span
          className={operation.error ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}
        >
          {operation.error || operation.progress || "—"}
        </span>
      ),
    },
    {
      id: "started",
      header: "Started",
      render: (operation) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-default text-muted-foreground" tabIndex={0}>
              {formatCompactRelativeTime(operation.createdAt)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            {new Date(operation.createdAt).toLocaleString()}
          </TooltipContent>
        </Tooltip>
      ),
    },
    {
      id: "duration",
      header: "Duration",
      align: "right",
      cellClassName: "text-muted-foreground",
      render: (operation) => formatDuration(operation.startedAt, operation.completedAt),
    },
  ];

  const activityColumns: DataTableColumn<DockerComposeOperation>[] = [
    {
      key: "type",
      header: "Type",
      width: "minmax(220px, 1.2fr)",
      render: (operation) => {
        const Icon = operationIcon(operation.action);
        return (
          <span className="inline-flex items-center gap-2 font-medium">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </span>
            {operation.action.replaceAll("_", " ")}
          </span>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      width: "130px",
      render: (operation) => (
        <Badge variant={operationStatusVariant(operation.status)}>{operation.status}</Badge>
      ),
    },
    {
      key: "progress",
      header: "Progress / error",
      width: "minmax(240px, 1.5fr)",
      truncate: true,
      render: (operation) => (
        <span
          className={operation.error ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}
        >
          {operation.error || operation.progress || "—"}
        </span>
      ),
    },
    {
      key: "started",
      header: "Started",
      width: "190px",
      render: (operation) => (
        <span className="text-muted-foreground">
          {new Date(operation.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: "duration",
      header: "Duration",
      width: "100px",
      align: "right",
      render: (operation) => (
        <span className="text-muted-foreground">
          {formatDuration(operation.startedAt, operation.completedAt)}
        </span>
      ),
    },
  ];

  const activityTableHeight = activityOperations.length
    ? 49 + activityOperations.length * 49 + (activityNextCursor ? 44 : 0)
    : undefined;

  const openActivity = () => {
    setActivityOperations([]);
    setActivityNextCursor(null);
    setActivityLoading(false);
    setActivityLoadingMore(false);
    setActivityOpen(true);
  };

  const logsSource: LogsTabSource = {
    channelId: `compose:${project.nodeId}:${project.name}`,
    title: "Compose logs",
    description: selectedService
      ? `Aggregated project output. Selected service: ${selectedService.name}.`
      : "Aggregated stdout and stderr output from project services.",
    state: project.status,
    downloadFileName: `compose-${project.name}-logs.txt`,
    createWebSocket: (tail) => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(
        `${proto}//${window.location.host}/api/docker/nodes/${project.nodeId}/compose/${encodeURIComponent(project.name)}/logs/stream?tail=${tail}`
      );
    },
    getLogs: async () => [],
    popoutUrl: `/docker/compose-logs/${project.nodeId}/${encodeURIComponent(project.name)}`,
  };

  const usesInternalScroll = new Set(["services", "configuration", "logs"]).has(activeTab);

  return (
    <PageTransition>
      <div
        className={`flex h-full flex-col gap-4 p-6 ${
          usesInternalScroll ? "overflow-hidden" : "overflow-y-auto"
        }`}
      >
        <div className="flex shrink-0 items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <PageBackButton onClick={() => navigate(backTarget)} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-2xl font-bold">{project.name}</h1>
                {project.managementState === "external" && <ExternalComposeBadge />}
                <Badge variant={project.drifted ? "warning" : projectStatusVariant(project.status)}>
                  {project.drifted ? "Drift" : project.status}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {node?.displayName || node?.hostname || project.nodeId} · {project.serviceCount}{" "}
                services
              </p>
            </div>
          </div>
          <ResponsiveHeaderActions actions={headerActions}>
            {headerActions.map((headerAction) => (
              <Button
                key={headerAction.label}
                variant={headerAction.label === "Pull & Apply" ? "default" : "outline"}
                size={headerAction.label === "Pin" ? "icon" : "default"}
                disabled={headerAction.disabled}
                title={headerAction.disabled ? headerAction.disabledReason : undefined}
                onClick={headerAction.onClick}
              >
                {headerAction.icon}
                {headerAction.label === "Pin" ? null : headerAction.label}
              </Button>
            ))}
          </ResponsiveHeaderActions>
        </div>

        {project.availability === "unavailable" && (
          <div className="flex shrink-0 gap-2 border border-warning/30 bg-warning/10 p-3 text-sm">
            <Activity className="mt-0.5 h-4 w-4" />
            The node snapshot is unavailable. Last known Compose metadata is shown.
          </div>
        )}
        {currentOperation && (
          <div className="flex shrink-0 items-center gap-2 border border-primary/20 bg-primary/5 p-3 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="font-medium">{currentOperation.action.replaceAll("_", " ")}</span>
            <span className="text-muted-foreground">
              {currentOperation.progress || "Operation in progress"}
            </span>
          </div>
        )}

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="overview" className="gap-1.5">
              <LayoutDashboard className="h-3.5 w-3.5" /> Overview
            </TabsTrigger>
            <TabsTrigger value="services" className="gap-1.5">
              <Boxes className="h-3.5 w-3.5" /> Services
            </TabsTrigger>
            <TabsTrigger value="source" className="gap-1.5">
              <GitBranch className="h-3.5 w-3.5" /> Source
            </TabsTrigger>
            <TabsTrigger value="builds" className="gap-1.5">
              <Hammer className="h-3.5 w-3.5" /> Builds
            </TabsTrigger>
            <TabsTrigger
              value="monitoring"
              className="gap-1.5"
              disabled={project.desiredState === "stopped"}
            >
              <Activity className="h-3.5 w-3.5" /> Monitoring
            </TabsTrigger>
            <TabsTrigger value="configuration" className="gap-1.5">
              <Code2 className="h-3.5 w-3.5" /> Configuration
            </TabsTrigger>
            <TabsTrigger value="variables" className="gap-1.5">
              <KeyRound className="h-3.5 w-3.5" /> Variables
            </TabsTrigger>
            <TabsTrigger value="logs" className="gap-1.5">
              <ScrollText className="h-3.5 w-3.5" /> Logs
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="pb-6">
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  label="Services"
                  value={`${project.runningServiceCount}/${project.serviceCount}`}
                  icon={Boxes}
                  subtitle="running"
                />
                <StatCard
                  label="Healthy"
                  value={`${project.healthyServiceCount}/${project.serviceCount}`}
                  icon={Activity}
                  subtitle="service health"
                />
                <StatCard
                  label="Volumes"
                  value={String(project.volumeNames.length)}
                  icon={HardDrive}
                  subtitle="named project volumes"
                />
                <StatCard
                  label="Networks"
                  value={String(project.networkNames.length)}
                  icon={Network}
                  subtitle="project and external"
                />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <PanelShell
                  title="Project"
                  icon={<Boxes className="h-4 w-4" />}
                  description="Identity, node placement and management boundary."
                  bodyClassName="divide-y divide-border"
                >
                  <DetailRow
                    label="Project ID"
                    value={<code className="text-xs">{project.id}</code>}
                  />
                  <DetailRow
                    label="Node"
                    value={node?.displayName || node?.hostname || project.nodeId}
                  />
                  <DetailRow label="Management" value={project.managementState} />
                  <DetailRow label="Desired state" value={project.desiredState} />
                  <DetailRow label="Availability" value={project.availability} />
                </PanelShell>
                <PanelShell
                  title="Runtime"
                  icon={<Activity className="h-4 w-4" />}
                  description="Current node-observed state and drift status."
                  bodyClassName="divide-y divide-border"
                >
                  <DetailRow
                    label="Active revision"
                    value={
                      project.activeRevision ? `#${project.activeRevision.revisionNumber}` : "—"
                    }
                  />
                  <DetailRow
                    label="Last seen"
                    value={project.lastSeenAt ? new Date(project.lastSeenAt).toLocaleString() : "—"}
                  />
                  <DetailRow label="Volumes" value={project.volumeNames.join(", ") || "—"} />
                  <DetailRow label="Networks" value={project.networkNames.join(", ") || "—"} />
                  <DetailRow
                    label="Drift"
                    value={
                      <Badge variant={project.drifted ? "warning" : "success"}>
                        {project.drifted ? "Detected" : "None"}
                      </Badge>
                    }
                  />
                </PanelShell>
              </div>
              <PanelShell
                title="Recent activity"
                icon={<History className="h-4 w-4" />}
                description="The six latest Compose lifecycle operations."
                actions={
                  <Button
                    variant="ghost"
                    className="h-auto p-0 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
                    onClick={openActivity}
                  >
                    View all
                  </Button>
                }
              >
                <SimpleTable
                  columns={recentActivityColumns}
                  rows={recentActivity}
                  getRowKey={(operation) => operation.id}
                  loading={recentActivityLoading}
                  loadingMessage="Loading activity..."
                  emptyMessage="No operations yet."
                  tableClassName="min-w-[800px] table-fixed"
                  onRowClick={(operation) => {
                    setSelectedOperation(operation);
                    setActivityDetailsOpen(true);
                  }}
                />
              </PanelShell>
            </div>
          </TabsContent>

          <TabsContent value="services" className="flex min-h-0 flex-1 flex-col pb-0">
            <PanelShell
              title="Services"
              description="Observed services and owned containers. Use a new revision to remove a service; direct container mutations are disabled."
              className="flex h-fit max-h-full min-h-0 flex-col"
              bodyClassName="flex min-h-0 flex-1 p-0"
            >
              <DataTable
                columns={serviceColumns}
                data={project.services}
                keyFn={(service) => service.name}
                onRowClick={(service) => void openContainerTarget(service)}
                emptyMessage="No runtime services observed."
                horizontalScroll
                minWidth="900px"
                embedded
                className="h-fit w-full max-h-full [&_[data-route-scroll-container]]:flex-1"
              />
            </PanelShell>
          </TabsContent>

          <TabsContent value="source" className="pb-6">
            <DockerResourceGitTabs
              target={{
                kind: "compose_project",
                nodeId: project.nodeId,
                composeProjectId: project.id,
              }}
              view="source"
              composeVariables={project.activeRevision?.variables ?? {}}
              composeSecretKeys={project.activeRevision?.secretKeys ?? []}
            />
          </TabsContent>

          <TabsContent value="builds" className="pb-0">
            <DockerResourceGitTabs
              target={{
                kind: "compose_project",
                nodeId: project.nodeId,
                composeProjectId: project.id,
              }}
              view="builds"
            />
          </TabsContent>

          <TabsContent value="monitoring" className="pb-0">
            <div className="space-y-4 pb-6">
              {monitoredServices.map((service) => {
                const containerId = service.containerIds[0]!;
                return (
                  <section key={service.name}>
                    <div className="mb-2">
                      <h3 className="text-sm font-semibold text-muted-foreground">
                        {service.name}
                      </h3>
                      <p className="font-mono text-xs text-muted-foreground">{service.image}</p>
                    </div>
                    <StatsTab
                      nodeId={project.nodeId}
                      containerId={containerId}
                      showProcesses={false}
                      data={{
                        State: {
                          Running: true,
                          Status: "running",
                        },
                      }}
                    />
                  </section>
                );
              })}
              <ComposeProcessesTable services={monitoredServices} processes={serviceProcesses} />
            </div>
          </TabsContent>

          <TabsContent value="configuration" className="flex min-h-0 flex-1 flex-col pb-0">
            <PanelShell
              title="Active immutable configuration"
              description="Gateway-stored Compose YAML for the active revision. Editing creates a new immutable revision."
              actions={
                project.managementState === "managed" && canManage ? (
                  <Button onClick={() => setRevisionOpen(true)}>
                    <FilePenLine className="mr-1 h-4 w-4" /> New revision
                  </Button>
                ) : null
              }
              className="flex min-h-0 flex-1 flex-col"
              bodyClassName="flex min-h-0 flex-1 p-0"
            >
              {project.activeRevision ? (
                <CodeEditor
                  value={project.activeRevision.sourceYaml}
                  onChange={() => {}}
                  readOnly
                  language="yaml"
                  minHeight="0"
                  height="100%"
                  bordered={false}
                />
              ) : (
                <p className="p-4 text-sm text-muted-foreground">
                  No Gateway-managed configuration. Adopt the external project by supplying complete
                  YAML.
                </p>
              )}
            </PanelShell>
          </TabsContent>

          <TabsContent value="variables" className="pb-0">
            <ComposeVariablesTab project={project} canManage={canManage} onApplied={load} />
          </TabsContent>

          <TabsContent value="logs" className="flex min-h-0 flex-1 flex-col pb-0">
            <LogsTab source={logsSource} />
          </TabsContent>
        </Tabs>
      </div>
      <Dialog open={adoptOpen} onOpenChange={setAdoptOpen}>
        <DialogContent clipOverflow className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Adopt Compose project</DialogTitle>
            <DialogDescription>
              Review the complete configuration before adopting {project.name}.
            </DialogDescription>
          </DialogHeader>
          <ComposeProjectEditor
            projectIdOverride={project.id}
            adoptionOverride
            onClose={() => {
              setAdoptOpen(false);
              void load();
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={revisionOpen} onOpenChange={setRevisionOpen}>
        <DialogContent clipOverflow className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>New revision for {project.name}</DialogTitle>
            <DialogDescription>
              Edit the Compose YAML. Applying creates a new immutable revision.
            </DialogDescription>
          </DialogHeader>
          <ComposeProjectEditor
            projectIdOverride={project.id}
            compactRevision
            onClose={() => {
              setRevisionOpen(false);
              void load();
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={revisionsOpen} onOpenChange={setRevisionsOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Change revision</DialogTitle>
            <DialogDescription>
              Reapply an immutable revision or remove an inactive revision.
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-hidden border border-border">
            <DataTable
              columns={revisionColumns}
              data={inactiveRevisions}
              keyFn={(revision) => revision.id}
              emptyMessage="No revisions."
              horizontalScroll
              minWidth="520px"
              embedded
            />
          </div>
          {project.managementState === "managed" && canManage && (
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  setRevisionsOpen(false);
                  setRevisionOpen(true);
                }}
              >
                <FilePenLine className="mr-1 h-4 w-4" /> New revision
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={activityOpen} onOpenChange={setActivityOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-h-[92dvh] sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Compose activity</DialogTitle>
            <DialogDescription>
              Lifecycle operation history. Scroll the table to load older operations.
            </DialogDescription>
          </DialogHeader>
          <div
            className="max-h-[min(70dvh,44rem)] overflow-hidden"
            style={activityTableHeight ? { height: activityTableHeight } : undefined}
          >
            <DataTable
              columns={activityColumns}
              data={activityOperations}
              keyFn={(operation) => operation.id}
              loading={activityLoading && activityOperations.length === 0}
              emptyMessage="No operations yet."
              horizontalScroll
              minWidth="900px"
              className="h-full w-full"
              scrollRef={activityScrollRef}
              footer={
                activityNextCursor ? (
                  <div
                    ref={activitySentinelRef}
                    className="p-3 text-center text-xs text-muted-foreground"
                  >
                    {activityLoadingMore
                      ? "Loading older activity..."
                      : "Scroll to load older activity"}
                  </div>
                ) : null
              }
              onRowClick={(operation) => {
                setSelectedOperation(operation);
                setActivityDetailsOpen(true);
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={activityDetailsOpen} onOpenChange={setActivityDetailsOpen}>
        <DialogContent
          className="sm:max-w-xl"
          onAnimationEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.currentTarget.dataset.state === "closed"
            ) {
              setSelectedOperation(null);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Activity details</DialogTitle>
            <DialogDescription>
              Compose lifecycle operation and immutable revision reference.
            </DialogDescription>
          </DialogHeader>
          {selectedOperation && (
            <div className="divide-y divide-border border border-border">
              <DetailRow label="Action" value={selectedOperation.action.replaceAll("_", " ")} />
              <DetailRow
                label="Status"
                value={
                  <Badge variant={operationStatusVariant(selectedOperation.status)}>
                    {selectedOperation.status}
                  </Badge>
                }
              />
              <DetailRow
                label="Operation ID"
                value={<code className="text-xs">{selectedOperation.id}</code>}
              />
              <DetailRow
                label="Revision"
                value={
                  selectedOperation.revisionId ? (
                    <code className="text-xs">{selectedOperation.revisionId}</code>
                  ) : (
                    "—"
                  )
                }
              />
              <DetailRow label="Progress" value={selectedOperation.progress || "—"} />
              <DetailRow
                label="Error"
                value={
                  selectedOperation.error ? (
                    <span className="whitespace-pre-wrap break-words text-left text-sm text-red-600 dark:text-red-400">
                      {selectedOperation.error}
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={pinOpen} onOpenChange={setPinOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pin Compose project</DialogTitle>
            <DialogDescription>Choose where {project.name} should stay visible.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Add to dashboard</p>
                <p className="text-xs text-muted-foreground">Show compact lifecycle status</p>
              </div>
              <Switch
                checked={isPinnedDashboard(project.id)}
                onChange={() => {
                  toggleDashboard(project.id, {
                    nodeId: project.nodeId,
                    nodeSlug: node?.slug ?? project.nodeId,
                    name: project.name,
                    state: project.status,
                    kind: "compose",
                    scopeBase: "docker:compose:view",
                    scopeResourceId: project.id,
                  });
                  usePinnedContainersStore.getState().invalidate();
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Add to sidebar</p>
                <p className="text-xs text-muted-foreground">Quick access from navigation</p>
              </div>
              <Switch
                checked={isPinnedSidebar(project.id)}
                onChange={() => {
                  toggleSidebar(project.id, {
                    nodeId: project.nodeId,
                    nodeSlug: node?.slug ?? project.nodeId,
                    name: project.name,
                    state: project.status,
                    kind: "compose",
                    scopeBase: "docker:compose:view",
                    scopeResourceId: project.id,
                  });
                  usePinnedContainersStore.getState().invalidate();
                }}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
