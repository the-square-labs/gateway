import {
  Boxes,
  FolderPlus,
  Import,
  Loader2,
  Play,
  RefreshCw,
  Square,
  UploadCloud,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PageTransition } from "@/components/common/PageTransition";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { DockerFolderedResourceList } from "@/components/docker/DockerFolderedResourceList";
import { ExternalComposeBadge } from "@/components/docker/ExternalComposeBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RefreshButton } from "@/components/ui/refresh-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TruncateStart } from "@/components/ui/truncate-start";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { createClientUuid } from "@/lib/client-id";
import { canAdoptComposeProject, hasComposeProjectScope } from "@/lib/compose-access";
import { loadVisibleDockerNodes } from "@/lib/docker-node-access";
import { nodeBadgeClassName } from "@/lib/node-appearance";
import { dockerComposeProjectRoute } from "@/lib/resource-routes";
import { createReturnNavigationState } from "@/lib/return-navigation";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import type { DockerComposeOperationAction, DockerComposeProjectSummary, Node } from "@/types";
import { ComposeProjectEditor } from "./compose/ComposeProjectEditor";

type ComposeProjectTransition = {
  action: DockerComposeOperationAction;
  label: "starting" | "stopping" | "applying";
  operationId: string | null;
  startedAt: number;
};

const ACTIVE_OPERATION_STATUSES = new Set(["pending", "running", "cancelling"]);

function statusVariant(
  status: DockerComposeProjectSummary["status"] | ComposeProjectTransition["label"]
) {
  if (status === "running") return "success" as const;
  if (status === "failed" || status === "missing") return "destructive" as const;
  if (status === "degraded" || status === "applying" || status === "validating")
    return "warning" as const;
  return "secondary" as const;
}

export function DockerComposeProjects({
  embedded,
  fixedNodeId,
  onCreateRef,
  onCreateFolderRef,
  onRefreshRef,
  initialCreateOpen,
}: {
  embedded?: boolean;
  fixedNodeId?: string;
  onCreateRef?: (fn: () => void) => void;
  onCreateFolderRef?: (fn: () => void) => void;
  onRefreshRef?: (fn: () => void) => void;
  initialCreateOpen?: boolean;
} = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasScope, hasScopedAccess, user } = useAuthStore();
  const projects = useDockerStore((state) => state.composeProjects);
  const fetchProjects = useDockerStore((state) => state.fetchComposeProjects);
  const loading = useDockerStore((state) => state.loading.compose);
  const selectedNodeId = useDockerStore((state) => state.selectedNodeId);
  const setSelectedNode = useDockerStore((state) => state.setSelectedNode);
  const storeNodes = useDockerStore((state) => state.dockerNodes);
  const nodesLoaded = useDockerStore((state) => state.dockerNodesLoaded);
  const setDockerNodes = useDockerStore((state) => state.setDockerNodes);
  const [localNodes, setLocalNodes] = useState<Node[]>([]);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(initialCreateOpen ?? false);
  const [adoptEditorProject, setAdoptEditorProject] = useState<DockerComposeProjectSummary | null>(
    null
  );
  const [projectTransitions, setProjectTransitions] = useState<
    Record<string, ComposeProjectTransition>
  >({});
  const createFolderRef = useRef<(() => void) | null>(null);
  const visibleNodeId = fixedNodeId ?? selectedNodeId;
  const canManageFolders = !fixedNodeId && hasScope("docker:containers:folders:manage");
  const canCreate = hasScopedAccess("docker:compose:create");

  const openCreate = useCallback(() => {
    if (!requireLicenseFeature("compose-applications", "Compose projects")) return;
    setCreateOpen(true);
  }, []);

  useEffect(() => onCreateRef?.(openCreate), [onCreateRef, openCreate]);
  useEffect(
    () => onRefreshRef?.(() => void fetchProjects(fixedNodeId)),
    [fetchProjects, fixedNodeId, onRefreshRef]
  );
  useEffect(() => {
    if (fixedNodeId) {
      setSelectedNode(fixedNodeId);
      return;
    }
    if (embedded && nodesLoaded) return;
    loadVisibleDockerNodes(
      user?.scopes ?? [],
      ["docker:compose:view"],
      hasScopedAccess("nodes:details")
    )
      .then((nodes) => {
        setLocalNodes(nodes);
        setDockerNodes(nodes);
      })
      .catch(() => toast.error("Failed to load Docker nodes"));
  }, [
    embedded,
    fixedNodeId,
    hasScopedAccess,
    nodesLoaded,
    setDockerNodes,
    setSelectedNode,
    user?.scopes,
  ]);
  useEffect(() => {
    void fetchProjects(fixedNodeId);
    const interval = window.setInterval(() => void fetchProjects(fixedNodeId), 30_000);
    return () => window.clearInterval(interval);
  }, [fetchProjects, fixedNodeId]);
  useRealtime("docker.compose.changed", (payload) => {
    const event = payload as { nodeId?: string } | undefined;
    if (visibleNodeId && event?.nodeId && event.nodeId !== visibleNodeId) return;
    void fetchProjects(fixedNodeId);
  });

  const hasActiveTransitions = Object.keys(projectTransitions).length > 0;

  useEffect(() => {
    if (!hasActiveTransitions) return;
    void fetchProjects(fixedNodeId);
    const interval = window.setInterval(() => void fetchProjects(fixedNodeId), 1_000);
    return () => window.clearInterval(interval);
  }, [fetchProjects, fixedNodeId, hasActiveTransitions]);

  useEffect(() => {
    setProjectTransitions((current) => {
      let changed = false;
      const next = { ...current };
      for (const [projectId, transition] of Object.entries(current)) {
        const project = projects.find((candidate) => candidate.id === projectId);
        const operation = project?.lastOperation;
        const terminalOperation =
          transition.operationId &&
          operation?.id === transition.operationId &&
          !ACTIVE_OPERATION_STATUSES.has(operation.status);
        const expired = Date.now() - transition.startedAt > 5 * 60_000;
        if (terminalOperation || expired) {
          delete next[projectId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [projects]);

  const runAction = useCallback(
    async (project: DockerComposeProjectSummary, action: DockerComposeOperationAction) => {
      if (!requireLicenseFeature("compose-applications", "Compose lifecycle")) return;
      if (
        action === "stop" &&
        !(await confirm({
          title: `Stop ${project.name}`,
          description:
            "Stop all containers in this Compose project? The project remains managed and can be started again.",
          confirmLabel: "Stop",
          variant: "destructive",
        }))
      ) {
        return;
      }
      const label = action === "start" ? "starting" : action === "stop" ? "stopping" : "applying";
      setProjectTransitions((current) => ({
        ...current,
        [project.id]: {
          action,
          label,
          operationId: null,
          startedAt: Date.now(),
        },
      }));
      try {
        const operation = await api.startDockerComposeOperation(
          project.nodeId,
          project.id,
          action,
          {
            idempotencyKey: createClientUuid(),
          }
        );
        setProjectTransitions((current) =>
          current[project.id]
            ? {
                ...current,
                [project.id]: { ...current[project.id], operationId: operation.id },
              }
            : current
        );
        toast.success(
          action === "pull_apply" ? "Pull & Apply started" : `Compose ${action} started`
        );
        void fetchProjects(fixedNodeId);
      } catch (error) {
        setProjectTransitions((current) => {
          const next = { ...current };
          delete next[project.id];
          return next;
        });
        if (!handleLicenseApiError(error, "Compose lifecycle"))
          toast.error(error instanceof Error ? error.message : "Compose operation failed");
      }
    },
    [fetchProjects, fixedNodeId]
  );

  const adoptProject = useCallback(async (project: DockerComposeProjectSummary) => {
    if (!requireLicenseFeature("compose-applications", "Compose adoption")) return;
    const accepted = await confirm({
      title: `Adopt ${project.name}`,
      description:
        "Bring this external Compose project under Gateway lifecycle and immutable revision management?",
      confirmLabel: "Adopt project",
    });
    if (!accepted) return;

    setAdoptEditorProject(project);
  }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return projects
      .filter((project) => !visibleNodeId || project.nodeId === visibleNodeId)
      .filter(
        (project) =>
          !query ||
          `${project.name} ${project._nodeName ?? ""} ${project.status}`
            .toLowerCase()
            .includes(query)
      );
  }, [projects, search, visibleNodeId]);
  const retainedAdoptEditorProject = useRetainedDialogValue(
    adoptEditorProject,
    !!adoptEditorProject
  );

  const columns = useMemo<ResourceListColumn<DockerComposeProjectSummary>[]>(
    () => [
      {
        id: "name",
        label: "Project",
        width: "minmax(0, 1.4fr)",
        renderCell: (project) => (
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Boxes className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <TruncateStart text={project.name} className="min-w-0 text-sm font-medium" />
                {project.managementState === "external" && <ExternalComposeBadge />}
              </div>
            </div>
          </div>
        ),
      },
      ...(!fixedNodeId
        ? [
            {
              id: "node",
              label: "Node",
              width: "minmax(0, 1fr)",
              renderCell: (project: DockerComposeProjectSummary) => (
                <Badge variant="secondary" className={nodeBadgeClassName(project._nodeColor)}>
                  <span className="truncate">{project._nodeName || project.nodeId}</span>
                </Badge>
              ),
            } satisfies ResourceListColumn<DockerComposeProjectSummary>,
          ]
        : []),
      {
        id: "status",
        label: "Status",
        width: "8rem",
        renderCell: (project) => {
          const transition = projectTransitions[project.id];
          const status = transition?.label ?? (project.drifted ? "drift" : project.status);
          return (
            <Badge
              variant={transition || project.drifted ? "warning" : statusVariant(project.status)}
              className="gap-1"
            >
              {transition && <Loader2 className="h-3 w-3 animate-spin" />}
              {status}
            </Badge>
          );
        },
      },
      {
        id: "services",
        label: "Services",
        width: "7rem",
        renderCell: (project) => (
          <Badge
            variant={project.runningServiceCount === project.serviceCount ? "secondary" : "warning"}
          >
            {project.runningServiceCount}/{project.serviceCount}
          </Badge>
        ),
      },
      {
        id: "actions",
        label: "Actions",
        width: "7rem",
        align: "right",
        renderCell: (project) => (
          // Keep all lifecycle controls inert until the matching async operation is terminal.
          <div
            className="flex items-center justify-end gap-1"
            onClick={(event) => event.stopPropagation()}
          >
            {project.managementState === "external"
              ? canAdoptComposeProject(user?.scopes ?? [], project.nodeId, project.id) && (
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Adopt into Gateway"
                    aria-label={`Adopt ${project.name} into Gateway`}
                    onClick={() => void adoptProject(project)}
                  >
                    <Import className="h-3.5 w-3.5" />
                  </Button>
                )
              : hasComposeProjectScope(
                  user?.scopes ?? [],
                  "docker:compose:manage",
                  project.nodeId,
                  project.id
                ) && (
                  <>
                    {project.status === "running" ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Stop"
                        disabled={Boolean(projectTransitions[project.id])}
                        onClick={() => void runAction(project, "stop")}
                      >
                        <Square className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Start"
                        disabled={Boolean(projectTransitions[project.id])}
                        onClick={() => void runAction(project, "start")}
                      >
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Pull & Apply"
                      disabled={Boolean(projectTransitions[project.id])}
                      onClick={() => void runAction(project, "pull_apply")}
                    >
                      <UploadCloud className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
          </div>
        ),
      },
    ],
    [adoptProject, fixedNodeId, projectTransitions, runAction, user?.scopes]
  );

  const nodes = embedded ? storeNodes : localNodes.length ? localNodes : storeNodes;
  const content = (
    <>
      {!embedded && (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold">Compose Projects</h1>
            <p className="text-sm text-muted-foreground">
              Discover and manage single-node Docker Compose projects
            </p>
          </div>
          <ResponsiveHeaderActions
            actions={[
              {
                label: "Refresh",
                icon: <RefreshCw className="h-4 w-4" />,
                onClick: () => void fetchProjects(fixedNodeId),
                disabled: loading,
              },
              ...(canManageFolders
                ? [
                    {
                      label: "New Folder",
                      icon: <FolderPlus className="h-4 w-4" />,
                      onClick: () => createFolderRef.current?.(),
                    },
                  ]
                : []),
              ...(canCreate ? [{ label: "New Project", onClick: openCreate }] : []),
            ]}
          >
            <RefreshButton onClick={() => void fetchProjects(fixedNodeId)} disabled={loading} />
            {canManageFolders && (
              <Button variant="outline" onClick={() => createFolderRef.current?.()}>
                <FolderPlus className="mr-1 h-4 w-4" />
                New Folder
              </Button>
            )}
            {canCreate && <Button onClick={openCreate}>New Project</Button>}
          </ResponsiveHeaderActions>
        </div>
      )}
      <DockerFolderedResourceList
        resourceType="compose"
        resources={filtered}
        columns={columns}
        search={{
          search,
          onSearchChange: setSearch,
          placeholder: "Search Compose projects...",
          hasActiveFilters: search !== "" || !!selectedNodeId,
          onReset: () => {
            setSearch("");
            if (!fixedNodeId) setSelectedNode(null);
          },
          filters: fixedNodeId ? undefined : (
            <Select
              value={selectedNodeId ?? "__all__"}
              onValueChange={(value) => setSelectedNode(value === "__all__" ? null : value)}
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder="All nodes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All nodes</SelectItem>
                {nodes.map((node) => (
                  <SelectItem key={node.id} value={node.id}>
                    {node.displayName || node.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ),
        }}
        loading={loading || (!fixedNodeId && !nodesLoaded && nodes.length === 0)}
        loadingLabel="Loading Compose projects..."
        emptyState={
          <EmptyState
            message="No Compose projects found."
            hasActiveFilters={search !== ""}
            onReset={() => setSearch("")}
            actionLabel={canCreate ? "Create a project" : undefined}
            onAction={canCreate ? openCreate : undefined}
          />
        }
        minWidth={fixedNodeId ? "720px" : "980px"}
        fixedNodeId={fixedNodeId}
        canManageFolders={canManageFolders}
        getResourceKey={(project) => project.id}
        getResourceLabel={(project) => project.name}
        onItemClick={(project) =>
          navigate(dockerComposeProjectRoute(project.id), {
            state: createReturnNavigationState(location),
          })
        }
        onRefresh={() => fetchProjects(fixedNodeId)}
        onCreateFolderRef={(fn) => {
          createFolderRef.current = fn;
          onCreateFolderRef?.(fn);
        }}
      />
    </>
  );
  const createDialog = (
    <Dialog open={createOpen} onOpenChange={setCreateOpen}>
      <DialogContent clipOverflow className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New Compose Project</DialogTitle>
          <DialogDescription>
            Deploy a single-file, image-only Compose project to a Docker node.
          </DialogDescription>
        </DialogHeader>
        <ComposeProjectEditor defaultNodeId={fixedNodeId} onClose={() => setCreateOpen(false)} />
      </DialogContent>
    </Dialog>
  );
  const adoptDialog = (
    <Dialog
      open={!!adoptEditorProject}
      onOpenChange={(open) => !open && setAdoptEditorProject(null)}
    >
      <DialogContent clipOverflow className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Adopt Compose project</DialogTitle>
          <DialogDescription>
            Review the configuration before adopting the project.
          </DialogDescription>
        </DialogHeader>
        {retainedAdoptEditorProject && (
          <ComposeProjectEditor
            projectIdOverride={retainedAdoptEditorProject.id}
            adoptionOverride
            onClose={() => setAdoptEditorProject(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );

  return embedded ? (
    <>
      {content}
      {createDialog}
      {adoptDialog}
    </>
  ) : (
    <PageTransition>
      <div className="min-h-full space-y-4 p-6">{content}</div>
      {createDialog}
      {adoptDialog}
    </PageTransition>
  );
}
