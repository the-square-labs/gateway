import {
  Archive,
  Copy,
  Pin,
  Play,
  RotateCcw,
  Skull,
  Square,
  Trash2,
  Truck,
  Type,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import {
  HeaderOverflowMenu,
  ResponsiveHeaderActions,
} from "@/components/common/ResponsiveHeaderActions";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { DockerMigrationDialog } from "@/components/docker/DockerMigrationDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HealthBars } from "@/components/ui/health-bars";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { useUrlTab } from "@/hooks/use-url-tab";
import { formatDisplayImageRef, resolveContainerImageReference } from "@/lib/docker-image-ref";
import {
  isDockerMigrationOwnedByTab,
  resolveMigrationTarget,
} from "@/lib/docker-migration-navigation";
import { dockerContainerRoute } from "@/lib/resource-routes";
import { getReturnNavigationTarget, preserveReturnNavigationState } from "@/lib/return-navigation";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import type { DockerHealthCheck, DockerMigration } from "@/types";
import { ConfigTab } from "./docker-detail/ConfigTab";
import { ConsoleTab } from "./docker-detail/ConsoleTab";
import { EnvironmentTab } from "./docker-detail/EnvironmentTab";
import { FilesTab } from "./docker-detail/FilesTab";
import {
  containerArchiveCapabilities,
  containerDisplayName,
  containerLifecycleActions,
  type InspectData,
  STATUS_BADGE,
} from "./docker-detail/helpers";
import { LogsTab } from "./docker-detail/LogsTab";
import {
  buildContainerMutationSnapshot,
  shouldSettleMutationTransition,
  useContainerMutationTransition,
} from "./docker-detail/mutation-transition";
import { OverviewTab } from "./docker-detail/OverviewTab";
import { SettingsTab } from "./docker-detail/SettingsTab";
import { StatsTab } from "./docker-detail/StatsTab";
import { useContainerDetailRealtime } from "./docker-detail/useContainerDetailRealtime";

export {
  buildContainerMutationSnapshot,
  shouldSettleMutationTransition,
} from "./docker-detail/mutation-transition";

// ── Main Page ────────────────────────────────────────────────────

export function DockerContainerDetail({
  resolvedNodeId,
  resolvedNodeSlug,
  resolvedContainerId,
  resolvedContainerName,
  resolvedContainer,
  pageContextToken,
}: {
  resolvedNodeId?: string;
  resolvedNodeSlug?: string;
  resolvedContainerId?: string;
  resolvedContainerName?: string;
  resolvedContainer?: InspectData;
  pageContextToken?: number | null;
} = {}) {
  const params = useParams<{
    nodeId?: string;
    nodeSlug?: string;
    containerId?: string;
    containerName?: string;
    tab?: string;
  }>();
  const nodeId = resolvedNodeId ?? params.nodeId;
  const nodeSlug = resolvedNodeSlug ?? params.nodeSlug ?? params.nodeId ?? "";
  const routeContainerName =
    resolvedContainerName ?? params.containerName ?? params.containerId ?? "";
  const [containerId, setContainerId] = useState(resolvedContainerId ?? params.containerId);
  const navigate = useStableNavigate();
  const location = useLocation();
  const backTarget = getReturnNavigationTarget(location.state, "/docker");
  const [container, setContainer] = useState<InspectData | null>(resolvedContainer ?? null);
  const containerRef = useRef<InspectData | null>(resolvedContainer ?? null);
  const scopeResourceId = String(
    container?.scopeResourceId ?? resolvedContainer?.scopeResourceId ?? ""
  );
  const { hasScope, isLoading: authLoading } = useAuthStore();
  const hasContainerScope = (baseScope: string) =>
    !!nodeId &&
    (scopeResourceId
      ? hasScope(`${baseScope}:${nodeId}/${scopeResourceId}`)
      : hasScope(baseScope) || hasScope(`${baseScope}:${nodeId}`));
  const canManage = hasContainerScope("docker:containers:manage");
  const canEdit = hasContainerScope("docker:containers:edit");
  const canCreate =
    hasScope("docker:containers:create") ||
    !!(nodeId && hasScope(`docker:containers:create:${nodeId}`));
  const canDelete = hasContainerScope("docker:containers:delete");
  const canMigrate = hasContainerScope("docker:containers:migrate");
  const canViewContainer = hasContainerScope("docker:containers:view");
  const canUseConsole = hasContainerScope("docker:containers:console");
  const canUseFiles = hasContainerScope("docker:containers:files");
  const canUseEnvironment = hasContainerScope("docker:containers:environment");
  const canUseSecrets = hasContainerScope("docker:containers:secrets");
  const archiveCapabilities = containerArchiveCapabilities({
    export: hasContainerScope("docker:containers:export"),
    files: canUseFiles,
    environment: canUseEnvironment,
    secrets: canUseSecrets,
  });
  const invalidate = useDockerStore((s) => s.invalidate);
  const setSelectedNode = useDockerStore((s) => s.setSelectedNode);
  const previousNodeIdRef = useRef(useDockerStore.getState().selectedNodeId);

  // Temporarily scope store-backed invalidation to this node while the detail page is mounted,
  // then restore the previous list filter on unmount.
  useEffect(() => {
    if (nodeId) {
      setSelectedNode(nodeId);
    }

    return () => {
      setSelectedNode(previousNodeIdRef.current);
    };
  }, [nodeId, setSelectedNode]);
  const [healthCheck, setHealthCheck] = useState<DockerHealthCheck | null>(null);

  const [activeTab, setActiveTab] = useUrlTab(
    ["overview", "logs", "console", "files", "stats", "environment", "settings", "config"],
    "overview",
    (tab) => dockerContainerRoute(nodeSlug, routeContainerName, tab)
  );
  const [isLoading, setIsLoading] = useState(!resolvedContainer);
  const [actionLoading, setActionLoading] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [restoredMigration, setRestoredMigration] = useState<DockerMigration | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveImageMode, setArchiveImageMode] = useState<"portable" | "registry">("portable");
  const [archiveWritableLayer, setArchiveWritableLayer] = useState(false);
  const [archiveIncludeSecrets, setArchiveIncludeSecrets] = useState(false);
  const [archiveExporting, setArchiveExporting] = useState(false);
  const [archiveDevPreview, setArchiveDevPreview] = useState(false);

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    const gatewayDev = (window.gatewayDev ??= {});
    const openGwcaExportModal = () => {
      setArchiveDevPreview(true);
      setArchiveImageMode("portable");
      setArchiveWritableLayer(true);
      setArchiveIncludeSecrets(true);
      setArchiveOpen(true);
    };
    gatewayDev.openGwcaExportModal = openGwcaExportModal;
    return () => {
      if (gatewayDev.openGwcaExportModal === openGwcaExportModal) {
        delete gatewayDev.openGwcaExportModal;
      }
    };
  }, []);

  useEffect(() => {
    setContainerId(resolvedContainerId ?? params.containerId);
    if (resolvedContainer) {
      containerRef.current = resolvedContainer;
      setContainer(resolvedContainer);
      setIsLoading(false);
    }
  }, [params.containerId, resolvedContainer, resolvedContainerId]);

  // Pin
  const [pinOpen, setPinOpen] = useState(false);
  const { isPinnedDashboard, isPinnedSidebar, toggleDashboard, toggleSidebar, updateMeta } =
    usePinnedContainersStore();
  const navigationMigration = (location.state as { dockerMigration?: DockerMigration } | null)
    ?.dockerMigration;
  const migrationHandoff =
    restoredMigration ??
    (navigationMigration?.resourceType === "container" &&
    navigationMigration.targetNodeId === nodeId &&
    navigationMigration.resourceName === routeContainerName
      ? navigationMigration
      : null);
  const handleMigrationCutover = useCallback(
    (migration: DockerMigration) => {
      if (!migration.targetNodeSlug) return;
      if (containerId && migration.targetResourceId) {
        const pins = usePinnedContainersStore.getState();
        pins.migrateId(containerId, migration.targetResourceId);
        pins.updateMeta(migration.targetResourceId, {
          nodeId: migration.targetNodeId,
          nodeSlug: migration.targetNodeSlug,
          name: migration.resourceName,
          state: containerRef.current?.State?.Status,
          scopeResourceId,
        });
      }
      navigate(dockerContainerRoute(migration.targetNodeSlug, migration.resourceName, activeTab), {
        replace: true,
        state: {
          ...preserveReturnNavigationState(location.state),
          ...(isDockerMigrationOwnedByTab(migration.id) ? { dockerMigration: migration } : {}),
        },
      });
    },
    [activeTab, containerId, location.state, navigate, scopeResourceId]
  );

  useEffect(() => {
    const incoming = navigationMigration;
    if (
      !incoming ||
      incoming.id === restoredMigration?.id ||
      incoming.resourceType !== "container" ||
      incoming.targetNodeId !== nodeId ||
      incoming.resourceName !== routeContainerName
    ) {
      return;
    }
    setRestoredMigration(incoming);
    setMigrationOpen(true);
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: preserveReturnNavigationState(location.state),
    });
  }, [location, navigate, navigationMigration, nodeId, restoredMigration?.id, routeContainerName]);

  const handleMigrationOpenChange = useCallback((nextOpen: boolean) => {
    setMigrationOpen(nextOpen);
    if (!nextOpen) setRestoredMigration(null);
  }, []);
  const navigatePreservingContext = useCallback(
    (to: string, options?: { replace?: boolean }) =>
      navigate(to, { ...options, state: location.state }),
    [location.state, navigate]
  );
  const visibleTabs = useMemo(
    () => [
      "overview",
      ...(canViewContainer ? ["logs"] : []),
      ...(canUseConsole ? ["console"] : []),
      ...(canUseFiles ? ["files"] : []),
      ...(canViewContainer ? ["stats"] : []),
      ...(canUseEnvironment || canUseSecrets ? ["environment"] : []),
      ...(canEdit ? ["settings"] : []),
      ...(canViewContainer ? ["config"] : []),
    ],
    [canEdit, canUseConsole, canUseEnvironment, canUseFiles, canUseSecrets, canViewContainer]
  );
  const backendTransition = container?._transition as string | undefined;
  const { effectiveTransition, beginMutationTransition, clearMutationTransition } =
    useContainerMutationTransition(backendTransition);

  const fetchContainer = useCallback(
    async (silent = false, noCache = false) => {
      if (!nodeId || !containerId) return;
      if (!silent) setIsLoading(true);
      try {
        const data = await resolveMigrationTarget(!!migrationHandoff?.cutoverAt, () =>
          api.inspectContainer(nodeId, containerId, noCache)
        );
        setContainer(data);
        if ((data as any)?._transition) {
          clearMutationTransition();
        }
        // Keep pinned meta in sync
        if (usePinnedContainersStore.getState().isPinnedSidebar(containerId)) {
          const cName =
            String((data as any)?.Name ?? "").replace(/^\//, "") || containerId.slice(0, 12);
          const cState = (data as any)?._transition ?? (data as any)?.State?.Status ?? "unknown";
          updateMeta(containerId, {
            nodeId,
            nodeSlug,
            name: cName,
            state: cState,
            scopeResourceId: String((data as any)?.scopeResourceId ?? ""),
          });
        }
      } catch (err) {
        if (!migrationHandoff && err instanceof ApiRequestError && err.status === 404) {
          usePinnedContainersStore.getState().removePin(containerId);
        }
        if (!silent) {
          toast.error("Failed to load container");
          if (!migrationHandoff) navigate(backTarget);
        }
      } finally {
        if (!silent) setIsLoading(false);
      }
    },
    [
      backTarget,
      clearMutationTransition,
      nodeId,
      nodeSlug,
      containerId,
      migrationHandoff,
      navigate,
      updateMeta,
    ]
  );

  useEffect(() => {
    const targetId = migrationHandoff?.targetResourceId;
    if (targetId && targetId !== containerId) setContainerId(targetId);
  }, [containerId, migrationHandoff?.targetResourceId]);

  useEffect(() => {
    if (!resolvedContainer || migrationHandoff?.targetResourceId) {
      void fetchContainer(true, Boolean(migrationHandoff?.targetResourceId));
    }
    // Safety-net poll — realtime channel handles fast updates, this just
    // catches anything that slipped through (e.g. between reconnects).
    const interval = setInterval(() => void fetchContainer(true, true), 30000);
    return () => clearInterval(interval);
  }, [fetchContainer, migrationHandoff?.targetResourceId, resolvedContainer]);

  const refreshContainer = useCallback(() => fetchContainer(true, true), [fetchContainer]);

  useEffect(() => {
    containerRef.current = container;
  }, [container]);

  const refreshAfterMutation = useCallback(async () => {
    if (!nodeId || !containerId) return;

    const before = containerRef.current;
    const previousSignature = buildContainerMutationSnapshot(before);

    const attempts = [0, 250, 750, 1500, 2500, 3500];
    for (const delayMs of attempts) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      try {
        const next = await api.inspectContainer(nodeId, containerId, true);
        setContainer(next);
        containerRef.current = next;
        if (shouldSettleMutationTransition(previousSignature, next)) {
          clearMutationTransition();
          return;
        }
      } catch {
        // Realtime/delete handlers already deal with hard failures; keep polling briefly.
      }
    }
  }, [clearMutationTransition, containerId, nodeId]);

  // Realtime: refetch on any container.changed event for this container's name.
  // Also handle the recreate ID migration for every open tab.
  const containerName = ((container?.Name ?? "") as string).replace(/^\//, "");

  const fetchHealthCheck = useCallback(async () => {
    if (!nodeId || !containerName) return;

    try {
      const next = await api.getContainerHealthCheck(nodeId, containerName);
      setHealthCheck(next);
    } catch {
      setHealthCheck(null);
    }
  }, [containerName, nodeId]);

  useEffect(() => {
    void fetchHealthCheck();
  }, [fetchHealthCheck]);
  useContainerDetailRealtime({
    nodeId,
    nodeSlug,
    containerId,
    routeContainerName,
    activeTab,
    navigate: navigatePreservingContext,
    refreshContainer,
    transition: backendTransition,
    clearMutationTransition,
    onContainerIdChange: setContainerId,
    onMigrationCutover: handleMigrationCutover,
    pageContextToken,
  });

  useRealtime("docker.snapshot.changed", (payload) => {
    const event = payload as { nodeId?: string; kind?: string; key?: string };
    if (event.kind !== "container-detail" || event.nodeId !== nodeId) return;
    if (
      event.key &&
      event.key !== containerId &&
      event.key !== containerName &&
      event.key !== routeContainerName
    ) {
      return;
    }
    // The snapshot is already fresh when this event is published. Forcing
    // another backend refresh here would publish the same event again and
    // create an unbounded request/event feedback loop.
    void fetchContainer(true);
  });

  useRealtime("docker.health.changed", (payload) => {
    const ev = payload as {
      nodeId?: string;
      target?: string;
      containerName?: string;
    };
    if (ev.nodeId !== nodeId || ev.target !== "container" || ev.containerName !== containerName) {
      return;
    }

    void fetchHealthCheck();
  });

  useEffect(() => {
    if (authLoading) return;
    if (!visibleTabs.includes(activeTab)) {
      setActiveTab("overview");
    }
  }, [activeTab, authLoading, setActiveTab, visibleTabs]);

  // ── Action helpers ──
  const doAction = async (fn: () => Promise<void>, successMsg: string) => {
    setActionLoading(true);
    try {
      await fn();
      toast.success(successMsg);
      invalidate("containers", "tasks");
      fetchContainer();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(false);
    }
  };

  const handleRemove = async () => {
    const ok = await confirm({
      title: "Remove Container",
      description: `Remove "${containerDisplayName(container?.Name ?? "")}"? This cannot be undone.`,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    setActionLoading(true);
    try {
      await api.removeContainer(nodeId!, containerId!, false);
      usePinnedContainersStore.getState().removePin(containerId!);
      toast.success("Container removed");
      invalidate("containers", "tasks");
      navigate(backTarget);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
      setActionLoading(false);
    }
  };

  const handleDuplicate = async () => {
    const dName = `${containerDisplayName(container?.Name ?? "")}-copy`;
    setActionLoading(true);
    try {
      const result = await api.duplicateContainer(nodeId!, containerId!, dName);
      toast.success("Container duplicated");
      await invalidate("containers");
      if ((result as any)?.id ?? (result as any)?.Id) {
        const currentNodeSlug =
          useDockerStore.getState().dockerNodes.find((node) => node.id === nodeId)?.slug ||
          nodeSlug;
        navigate(dockerContainerRoute(currentNodeSlug, dName), {
          replace: true,
          state: location.state,
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to duplicate");
    } finally {
      setActionLoading(false);
    }
  };

  const handleArchiveExport = async () => {
    if (archiveDevPreview) {
      toast.info("GWCA export development preview", {
        description: "No archive was downloaded.",
      });
      return;
    }
    setArchiveExporting(true);
    const toastId = toast.loading("Exporting container archive...", {
      description: "Preparing archive",
      duration: Infinity,
      dismissible: false,
    });
    try {
      const archive = await api.downloadContainerArchive(
        nodeId!,
        containerId!,
        archiveWritableLayer,
        archiveImageMode,
        archiveCapabilities.canIncludeSecrets && archiveIncludeSecrets,
        ({ loaded, total }) => {
          const description =
            total > 0
              ? `${Math.min(100, Math.round((loaded / total) * 100))}% (${formatBytes(loaded)} / ${formatBytes(total)})`
              : loaded > 0
                ? `${formatBytes(loaded)} downloaded`
                : "Preparing archive";
          toast.loading("Exporting container archive...", {
            id: toastId,
            description,
            duration: Infinity,
            dismissible: false,
          });
        }
      );

      const link = document.createElement("a");
      const downloadUrl = URL.createObjectURL(archive);
      link.href = downloadUrl;
      link.download = `${containerDisplayName(container?.Name ?? "container")}.gwca`;
      link.click();
      URL.revokeObjectURL(downloadUrl);
      setArchiveOpen(false);
      toast.success("Container archive downloaded", {
        id: toastId,
        duration: 5000,
        dismissible: true,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to export archive", {
        id: toastId,
        description: null,
        duration: 8000,
        dismissible: true,
      });
    } finally {
      setArchiveExporting(false);
    }
  };

  const openRename = () => {
    setRenameValue(containerDisplayName(container?.Name ?? ""));
    setRenameOpen(true);
  };

  const handleRename = async () => {
    if (!renameValue.trim()) return;
    const nextName = renameValue.trim();
    setActionLoading(true);
    try {
      await api.renameContainer(nodeId!, containerId!, nextName);
      toast.success("Container renamed");
      setRenameOpen(false);
      invalidate("containers");
      const currentNodeSlug =
        useDockerStore.getState().dockerNodes.find((node) => node.id === nodeId)?.slug || nodeSlug;
      navigate(dockerContainerRoute(currentNodeSlug, nextName, activeTab), {
        replace: true,
        state: location.state,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename");
    } finally {
      setActionLoading(false);
    }
  };

  const name = containerDisplayName(container?.Name ?? "");
  const baseState = container?.State?.Status ?? (container?.State?.Running ? "running" : "stopped");
  const state = effectiveTransition ?? baseState;
  const lifecycleActions = containerLifecycleActions(baseState);
  const image = container ? resolveContainerImageReference(container) : "";
  const unavailable = container?.availability === "unavailable";
  const actionDisabled = actionLoading || !!effectiveTransition || unavailable;
  const labels = (container?.Config?.Labels ?? container?.Labels ?? {}) as Record<string, string>;
  const composeManaged = Boolean(labels["com.docker.compose.project"]);
  const deploymentManaged = labels["wiolett.gateway.deployment.managed"] === "true";
  const gpuMapped =
    container?.gpuAttachment?.mode === "managed" || container?.gpuAttachment?.mode === "external";
  const gpuPortabilityReason =
    "GPU-attached containers cannot be migrated or exported in this version";
  const migrationDisabledReason = gpuMapped
    ? gpuPortabilityReason
    : composeManaged
      ? "Docker Compose resources cannot be migrated"
      : deploymentManaged
        ? "Migrate this container through its Gateway deployment"
        : actionDisabled
          ? "Container is unavailable or changing state"
          : undefined;
  const currentTransition = effectiveTransition;
  const currentBaseState = baseState;

  // Auto-navigate to overview and close popouts when container stops or enters transition
  useEffect(() => {
    if (isLoading || !container) return;
    const needsRunning = unavailable
      ? new Set(["logs", "console", "files", "stats", "environment", "settings"])
      : new Set(["console", "files", "stats"]);
    const shouldDisable = unavailable || currentBaseState !== "running" || !!currentTransition;
    if (!shouldDisable) return;

    if (needsRunning.has(activeTab)) {
      setActiveTab("overview");
    }

    if (containerId) {
      try {
        const consoleChannel = new BroadcastChannel(`docker-console:${containerId}`);
        consoleChannel.postMessage({ type: "request-close" });
        consoleChannel.close();
      } catch {}
      try {
        const logsChannel = new BroadcastChannel(`docker-logs:${containerId}`);
        logsChannel.postMessage({ type: "request-close" });
        logsChannel.close();
      } catch {}
    }
  }, [
    activeTab,
    container,
    containerId,
    currentBaseState,
    currentTransition,
    isLoading,
    setActiveTab,
    unavailable,
  ]);

  if (isLoading) return <DetailPageSkeleton label="Loading container" tabs={6} />;
  if (!container)
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Container not found
      </div>
    );

  const headerActions = [
    {
      label: "Pin",
      icon: <Pin className="h-4 w-4" />,
      onClick: () => setPinOpen(true),
      disabled: actionDisabled,
    },
    ...(canMigrate
      ? [
          {
            label: "Migrate",
            icon: <Truck className="h-4 w-4" />,
            onClick: () => setMigrationOpen(true),
            disabled: Boolean(migrationDisabledReason),
            disabledReason: migrationDisabledReason,
          },
        ]
      : []),
    ...(lifecycleActions.canStart && canManage
      ? [
          {
            label: "Start",
            icon: <Play className="h-4 w-4" />,
            onClick: () =>
              doAction(() => api.startContainer(nodeId!, containerId!), "Container started"),
            disabled: actionDisabled,
          },
        ]
      : []),
    ...(lifecycleActions.canStop && canManage
      ? [
          {
            label: "Stop",
            icon: <Square className="h-4 w-4" />,
            onClick: () =>
              doAction(() => api.stopContainer(nodeId!, containerId!), "Container stopping"),
            disabled: actionDisabled,
          },
          ...(lifecycleActions.canRestart
            ? [
                {
                  label: "Restart",
                  icon: <RotateCcw className="h-4 w-4" />,
                  onClick: () =>
                    doAction(
                      () => api.restartContainer(nodeId!, containerId!),
                      "Container restarting"
                    ),
                  disabled: actionDisabled,
                },
              ]
            : []),
        ]
      : []),
    ...(canEdit
      ? [
          {
            label: "Rename",
            icon: <Type className="h-4 w-4" />,
            onClick: openRename,
            disabled: actionDisabled,
            separatorBefore: true,
          },
        ]
      : []),
    ...(canCreate
      ? [
          {
            label: "Duplicate",
            icon: <Copy className="h-4 w-4" />,
            onClick: handleDuplicate,
            disabled: actionDisabled,
          },
        ]
      : []),
    ...(archiveCapabilities.canExport
      ? [
          {
            label: "Export archive",
            icon: <Archive className="h-4 w-4" />,
            onClick: () => {
              setArchiveDevPreview(false);
              setArchiveOpen(true);
            },
            disabled: actionDisabled || gpuMapped,
            disabledReason: gpuMapped ? gpuPortabilityReason : undefined,
          },
        ]
      : []),
    ...(lifecycleActions.canKill && canManage
      ? [
          {
            label: "Kill",
            icon: <Skull className="h-4 w-4" />,
            onClick: () =>
              doAction(() => api.killContainer(nodeId!, containerId!), "Container killed"),
            disabled: actionDisabled,
            destructive: true,
            separatorBefore: true,
          },
        ]
      : []),
    ...(canDelete
      ? [
          {
            label: "Remove",
            icon: <Trash2 className="h-4 w-4" />,
            onClick: handleRemove,
            disabled: actionDisabled,
            destructive: true,
            separatorBefore: !lifecycleActions.canKill || !canManage,
          },
        ]
      : []),
  ];
  const overflowActions = headerActions.filter(
    (action) => !["Pin", "Start", "Stop", "Restart"].includes(action.label)
  );

  const isTerminalTab = activeTab === "console" || activeTab === "logs";
  const isStopped = baseState !== "running";
  const isTabDisabled = (tab: string) => {
    if (
      unavailable &&
      new Set(["logs", "console", "files", "stats", "environment", "settings"]).has(tab)
    ) {
      return true;
    }
    const needsRunning = new Set(["console", "files", "stats"]);
    if (tab === "environment" || tab === "settings") {
      return !!effectiveTransition;
    }
    return needsRunning.has(tab) && (!!effectiveTransition || isStopped);
  };

  return (
    <PageTransition>
      <div
        className={`h-full p-6 flex flex-col gap-4 ${
          isTerminalTab ? "overflow-hidden" : "overflow-y-auto"
        }`}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <PageBackButton onClick={() => navigate(backTarget)} />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-2xl font-bold">{name}</h1>
                <Badge
                  variant={unavailable ? "secondary" : (STATUS_BADGE[state] ?? "secondary")}
                  size="inline"
                  className="shrink-0"
                >
                  {unavailable ? "Unavailable" : state}
                </Badge>
              </div>
              <p className="break-all text-sm text-muted-foreground">
                {formatDisplayImageRef(image)} &middot;{" "}
                {(container.Id ?? containerId ?? "").slice(0, 12)}
              </p>
            </div>
          </div>

          <ResponsiveHeaderActions actions={headerActions}>
            <Button
              variant="outline"
              size="icon"
              disabled={actionDisabled}
              onClick={() => setPinOpen(true)}
            >
              <Pin className="h-4 w-4" />
            </Button>
            {lifecycleActions.canStart && canManage && (
              <Button
                variant="outline"
                size="default"
                disabled={actionDisabled}
                onClick={() =>
                  doAction(() => api.startContainer(nodeId!, containerId!), "Container started")
                }
              >
                <Play className="h-3.5 w-3.5" />
                Start
              </Button>
            )}
            {lifecycleActions.canStop && canManage && (
              <>
                <Button
                  variant="outline"
                  size="default"
                  disabled={actionDisabled}
                  onClick={() =>
                    doAction(() => api.stopContainer(nodeId!, containerId!), "Container stopping")
                  }
                >
                  <Square className="h-3.5 w-3.5" />
                  Stop
                </Button>
                {lifecycleActions.canRestart && (
                  <Button
                    variant="outline"
                    size="default"
                    disabled={actionDisabled}
                    onClick={() =>
                      doAction(
                        () => api.restartContainer(nodeId!, containerId!),
                        "Container restarting"
                      )
                    }
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Restart
                  </Button>
                )}
              </>
            )}
            <HeaderOverflowMenu
              actions={overflowActions}
              disabled={actionDisabled}
              ariaLabel="More container actions"
            />
          </ResponsiveHeaderActions>
        </div>

        {healthCheck?.enabled && (
          <HealthBars
            history={healthCheck.healthHistory}
            currentStatus={healthCheck.healthStatus}
          />
        )}

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex flex-col flex-1 min-h-0"
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            {canViewContainer && (
              <TabsTrigger value="logs" disabled={isTabDisabled("logs")}>
                Logs
              </TabsTrigger>
            )}
            {canUseConsole && (
              <TabsTrigger value="console" disabled={isTabDisabled("console")}>
                Console
              </TabsTrigger>
            )}
            {canUseFiles && (
              <TabsTrigger value="files" disabled={isTabDisabled("files")}>
                Files
              </TabsTrigger>
            )}
            {canViewContainer && (
              <TabsTrigger value="stats" disabled={isTabDisabled("stats")}>
                Monitoring
              </TabsTrigger>
            )}
            {(canUseEnvironment || canUseSecrets) && (
              <TabsTrigger value="environment" disabled={isTabDisabled("environment")}>
                Environment
              </TabsTrigger>
            )}
            {canEdit && (
              <TabsTrigger value="settings" disabled={isTabDisabled("settings")}>
                Settings
              </TabsTrigger>
            )}
            {canViewContainer && <TabsTrigger value="config">Config</TabsTrigger>}
          </TabsList>
          <TabsContent value="overview" className="pb-0">
            <OverviewTab nodeId={nodeId!} containerId={containerId!} data={container} />
          </TabsContent>
          {canViewContainer && !unavailable && (
            <TabsContent value="logs" className="flex flex-col flex-1 min-h-0 pb-0">
              <LogsTab
                nodeId={nodeId!}
                containerId={containerId!}
                containerState={state}
                inspectData={container}
              />
            </TabsContent>
          )}
          {canUseConsole && !unavailable && (
            <TabsContent value="console" className="flex flex-col flex-1 min-h-0">
              <ConsoleTab
                nodeId={nodeId!}
                containerId={containerId!}
                scopeResourceId={scopeResourceId}
              />
            </TabsContent>
          )}
          {canUseFiles && !unavailable && (
            <TabsContent value="files" className="pb-0">
              <FilesTab
                nodeId={nodeId!}
                containerId={containerId!}
                scopeResourceId={scopeResourceId}
              />
            </TabsContent>
          )}
          {canViewContainer && !unavailable && (
            <TabsContent value="stats" className="pb-0">
              <StatsTab nodeId={nodeId!} containerId={containerId!} data={container} />
            </TabsContent>
          )}
          {(canUseEnvironment || canUseSecrets) && !unavailable && (
            <TabsContent value="environment" className="flex flex-col flex-1 min-h-0 pb-0">
              <EnvironmentTab
                nodeId={nodeId!}
                containerId={containerId!}
                containerName={name}
                scopeResourceId={scopeResourceId}
                containerState={state}
                disabled={!!effectiveTransition}
                onMutationStart={beginMutationTransition}
                onMutationEnd={clearMutationTransition}
                onRecreating={refreshAfterMutation}
              />
            </TabsContent>
          )}
          {canEdit && !unavailable && (
            <TabsContent value="settings" className="pb-0">
              <SettingsTab
                nodeId={nodeId!}
                containerId={containerId!}
                scopeResourceId={scopeResourceId}
                data={container}
                onMutationStart={beginMutationTransition}
                onMutationEnd={clearMutationTransition}
                onRecreating={refreshAfterMutation}
                onRefresh={refreshAfterMutation}
                onHealthCheckSaved={setHealthCheck}
                transition={effectiveTransition}
              />
            </TabsContent>
          )}
          {canViewContainer && (
            <TabsContent value="config" className="flex flex-col flex-1 min-h-0 pb-0">
              <ConfigTab data={container} />
            </TabsContent>
          )}
        </Tabs>
      </div>
      {/* Pin Dialog */}
      <DockerMigrationDialog
        open={migrationOpen}
        onOpenChange={handleMigrationOpenChange}
        onCutover={handleMigrationCutover}
        initialMigration={restoredMigration}
        resource={{
          type: "container",
          nodeId: nodeId!,
          containerName: name,
          displayName: name,
          sourceState: baseState,
        }}
      />
      <Dialog open={pinOpen} onOpenChange={setPinOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pin Container</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Add to dashboard</p>
                <p className="text-xs text-muted-foreground">
                  Show compact status on the dashboard
                </p>
              </div>
              <Switch
                checked={isPinnedDashboard(containerId!)}
                disabled={!!effectiveTransition}
                onChange={() => {
                  toggleDashboard(containerId!, {
                    nodeId: nodeId!,
                    nodeSlug,
                    name,
                    state: baseState,
                    scopeResourceId,
                  });
                  usePinnedContainersStore.getState().invalidate();
                }}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Add to sidebar</p>
                <p className="text-xs text-muted-foreground">Quick access link in the sidebar</p>
              </div>
              <Switch
                checked={isPinnedSidebar(containerId!)}
                disabled={!!effectiveTransition}
                onChange={() => {
                  toggleSidebar(containerId!, {
                    nodeId: nodeId!,
                    nodeSlug,
                    name,
                    state: baseState,
                    scopeResourceId,
                  });
                  usePinnedContainersStore.getState().invalidate();
                }}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={archiveOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && archiveExporting) return;
          setArchiveOpen(nextOpen);
          if (!nextOpen) {
            setArchiveIncludeSecrets(false);
            setArchiveDevPreview(false);
          }
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          hideCloseButton={archiveExporting}
          onEscapeKeyDown={(event) => {
            if (archiveExporting) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (archiveExporting) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Export container archive</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              Container settings, environment values, and volume declarations are included. Volume
              contents are not included.
            </p>
            <div className="space-y-1.5">
              <p className="font-medium">Image mode</p>
              <Select
                value={archiveImageMode}
                disabled={archiveExporting}
                onValueChange={(value) => {
                  const mode = value as "portable" | "registry";
                  setArchiveImageMode(mode);
                  if (mode === "registry") setArchiveWritableLayer(false);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="portable">Portable · include Docker image</SelectItem>
                  <SelectItem value="registry">Registry-backed · configuration only</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {archiveImageMode === "portable"
                  ? "The archive is self-contained and can be imported without registry access."
                  : "The target node must already have or be able to pull the exact image digest."}
              </p>
            </div>
            <PanelShell>
              <SettingsControlRow
                title="Include writable layer"
                description="Captures current container filesystem changes without pausing it. Concurrent writes may produce an application-inconsistent snapshot."
                controlsClassName="sm:min-w-0"
              >
                <Switch
                  checked={archiveWritableLayer}
                  onChange={setArchiveWritableLayer}
                  disabled={archiveExporting || archiveImageMode === "registry"}
                  ariaLabel="Include writable container layer"
                />
              </SettingsControlRow>
              {(archiveCapabilities.canIncludeSecrets || archiveDevPreview) && (
                <SettingsControlRow
                  title="Include secrets"
                  description="Stores decrypted secret values in the archive. Treat the downloaded file as sensitive."
                  controlsClassName="sm:min-w-0"
                >
                  <Switch
                    checked={archiveIncludeSecrets}
                    onChange={setArchiveIncludeSecrets}
                    disabled={archiveExporting}
                    ariaLabel="Include container secrets"
                  />
                </SettingsControlRow>
              )}
            </PanelShell>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setArchiveOpen(false)}
              disabled={archiveExporting}
            >
              Cancel
            </Button>
            <Button onClick={() => void handleArchiveExport()} disabled={archiveExporting}>
              {archiveExporting ? "Exporting..." : "Download .gwca"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Rename Dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename Container</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            disabled={!!effectiveTransition}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="New container name"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleRename}
              disabled={actionLoading || !!effectiveTransition || !renameValue.trim()}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
