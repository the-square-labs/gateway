import {
  Activity,
  Code2,
  EllipsisVertical,
  Folder,
  LayoutDashboard,
  ListTodo,
  Pin,
  Play,
  RotateCcw,
  ScrollText,
  Settings,
  Skull,
  SlidersHorizontal,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  Truck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { DockerMigrationDialog } from "@/components/docker/DockerMigrationDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HealthBars } from "@/components/ui/health-bars";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { useUrlTab } from "@/hooks/use-url-tab";
import {
  isDockerMigrationOwnedByTab,
  resolveMigrationTarget,
} from "@/lib/docker-migration-navigation";
import { dockerDeploymentRoute } from "@/lib/resource-routes";
import { getReturnNavigationTarget, preserveReturnNavigationState } from "@/lib/return-navigation";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import type {
  DockerDeployment,
  DockerDeploymentSlot,
  DockerMigration,
  DockerWebhook,
} from "@/types";
import {
  DeploymentConfig,
  DeploymentOverview,
  DeploymentSlots,
  statusVariant,
} from "./docker-deployment-detail/DeploymentPanels";
import { DeploymentSettings } from "./docker-deployment-detail/DeploymentSettings";
import { ConsoleTab } from "./docker-detail/ConsoleTab";
import { EnvironmentTab } from "./docker-detail/EnvironmentTab";
import { FilesTab } from "./docker-detail/FilesTab";
import type { InspectData } from "./docker-detail/helpers";
import { LogsTab } from "./docker-detail/LogsTab";
import { StatsTab } from "./docker-detail/StatsTab";

const MIGRATION_RELOCATION_GRACE_MS = 2_000;

function getActiveSlot(deployment: DockerDeployment | null): DockerDeploymentSlot | null {
  if (!deployment) return null;
  return deployment.slots.find((slot) => slot.slot === deployment.activeSlot) ?? null;
}

function isTransitionStatus(status?: string | null) {
  return (
    status === "creating" ||
    status === "deploying" ||
    status === "switching" ||
    status === "starting" ||
    status === "stopping" ||
    status === "restarting" ||
    status === "killing" ||
    status === "removing" ||
    status === "rolling_back"
  );
}

function transitionForAction(name: string) {
  if (name.startsWith("switch-")) return "switching";
  if (name.startsWith("stop-")) return "stopping";
  const transitionByAction: Record<string, string> = {
    deploy: "deploying",
    switch: "switching",
    rollback: "rolling_back",
    start: "starting",
    stop: "stopping",
    restart: "restarting",
    kill: "killing",
    remove: "removing",
  };
  return transitionByAction[name];
}

export function DockerDeploymentDetail({
  resolvedNodeId,
  resolvedNodeSlug,
  resolvedDeploymentId,
  resolvedDeploymentName,
}: {
  resolvedNodeId?: string;
  resolvedNodeSlug?: string;
  resolvedDeploymentId?: string;
  resolvedDeploymentName?: string;
} = {}) {
  const params = useParams<{
    nodeId?: string;
    nodeSlug?: string;
    deploymentId?: string;
    deploymentName?: string;
  }>();
  const nodeId = resolvedNodeId ?? params.nodeId ?? "";
  const nodeSlug = resolvedNodeSlug ?? params.nodeSlug ?? params.nodeId ?? "";
  const deploymentId = resolvedDeploymentId ?? params.deploymentId ?? "";
  const routeDeploymentName =
    resolvedDeploymentName ?? params.deploymentName ?? params.deploymentId ?? "";
  const navigate = useStableNavigate();
  const location = useLocation();
  const backTarget = getReturnNavigationTarget(location.state, "/docker");
  const { hasScope } = useAuthStore();
  const hasDeploymentScope = (baseScope: string) =>
    !!nodeId && !!deploymentId && hasScope(`${baseScope}:${nodeId}/${deploymentId}`);
  const canManage = hasDeploymentScope("docker:containers:manage");
  const canDelete = hasDeploymentScope("docker:containers:delete");
  const canMigrate = hasDeploymentScope("docker:containers:migrate");
  const canEdit = hasDeploymentScope("docker:containers:edit");
  const canManageWebhooks = hasDeploymentScope("docker:containers:webhooks");
  const canViewContainer = hasDeploymentScope("docker:containers:view");
  const canUseConsole = hasDeploymentScope("docker:containers:console");
  const canUseFiles = hasDeploymentScope("docker:containers:files");
  const canUseEnvironment = hasDeploymentScope("docker:containers:environment");
  const canEditMounts = hasDeploymentScope("docker:containers:mounts");

  const [deployment, setDeployment] = useState<DockerDeployment | null>(null);
  const [activeInspect, setActiveInspect] = useState<InspectData | null>(null);
  const [webhook, setWebhook] = useState<DockerWebhook | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [restoredMigration, setRestoredMigration] = useState<DockerMigration | null>(null);
  const { isPinnedSidebar, toggleSidebar, updateMeta } = usePinnedContainersStore();

  const [activeTab, setActiveTab] = useUrlTab(
    ["overview", "logs", "console", "files", "stats", "environment", "slots", "settings", "config"],
    "overview",
    (tab) => dockerDeploymentRoute(nodeSlug, routeDeploymentName, tab)
  );

  const navigationMigration = (location.state as { dockerMigration?: DockerMigration } | null)
    ?.dockerMigration;
  const migrationHandoff =
    restoredMigration ??
    (navigationMigration?.resourceType === "deployment" &&
    navigationMigration.targetNodeId === nodeId &&
    navigationMigration.deploymentId === deploymentId
      ? navigationMigration
      : null);

  const deploymentRef = useRef<DockerDeployment | null>(null);
  const cutoverSeen = useRef(false);
  const removalFallback = useRef<number | null>(null);
  if (migrationHandoff?.cutoverAt) cutoverSeen.current = true;
  const clearRemovalFallback = useCallback(() => {
    if (removalFallback.current === null) return;
    window.clearTimeout(removalFallback.current);
    removalFallback.current = null;
  }, []);
  const scheduleRemovalFallback = useCallback(
    (reason: "removed" | "failed") => {
      if (cutoverSeen.current || removalFallback.current !== null) return;
      removalFallback.current = window.setTimeout(() => {
        removalFallback.current = null;
        if (cutoverSeen.current) return;
        if (reason === "removed") toast.info("Deployment was removed");
        else toast.error("Failed to load deployment");
        navigate(backTarget);
      }, MIGRATION_RELOCATION_GRACE_MS);
    },
    [backTarget, navigate]
  );

  useEffect(() => () => clearRemovalFallback(), [clearRemovalFallback]);

  const handleMigrationCutover = useCallback(
    (migration: DockerMigration) => {
      if (!migration.targetNodeSlug) return;
      cutoverSeen.current = true;
      clearRemovalFallback();
      const pins = usePinnedContainersStore.getState();
      if (pins.isPinnedSidebar(deploymentId)) {
        pins.updateMeta(deploymentId, {
          nodeId: migration.targetNodeId,
          nodeSlug: migration.targetNodeSlug,
          name: migration.resourceName,
          state: deployment?.status,
          kind: "deployment",
          scopeResourceId: deploymentId,
        });
      }
      navigate(dockerDeploymentRoute(migration.targetNodeSlug, migration.resourceName, activeTab), {
        replace: true,
        state: {
          ...preserveReturnNavigationState(location.state),
          ...(isDockerMigrationOwnedByTab(migration.id) ? { dockerMigration: migration } : {}),
        },
      });
    },
    [activeTab, clearRemovalFallback, deployment?.status, deploymentId, location.state, navigate]
  );

  useEffect(() => {
    const incoming = navigationMigration;
    if (
      !incoming ||
      incoming.id === restoredMigration?.id ||
      incoming.resourceType !== "deployment" ||
      incoming.targetNodeId !== nodeId ||
      incoming.deploymentId !== deploymentId
    ) {
      return;
    }
    setRestoredMigration(incoming);
    setMigrationOpen(true);
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: preserveReturnNavigationState(location.state),
    });
  }, [deploymentId, location, navigate, navigationMigration, nodeId, restoredMigration?.id]);

  const handleMigrationOpenChange = useCallback((nextOpen: boolean) => {
    setMigrationOpen(nextOpen);
    if (!nextOpen) setRestoredMigration(null);
  }, []);

  const load = useCallback(async () => {
    if (!nodeId || !deploymentId) return;
    setLoading(true);
    try {
      const next = await resolveMigrationTarget(!!migrationHandoff?.cutoverAt, () =>
        api.getDockerDeployment(nodeId, deploymentId)
      );
      deploymentRef.current = next;
      setDeployment(next);
      setWebhook(next.webhook ?? null);
      if (usePinnedContainersStore.getState().isPinnedSidebar(deploymentId)) {
        updateMeta(deploymentId, {
          nodeId,
          nodeSlug,
          name: next.name,
          state: next._transition ?? next.status,
          kind: "deployment",
          scopeResourceId: deploymentId,
        });
      }

      const slot = getActiveSlot(next);
      if (slot?.containerId) {
        const inspect = await api
          .inspectContainer(nodeId, slot.containerId, true)
          .catch(() => null);
        setActiveInspect(inspect);
      } else {
        setActiveInspect(null);
      }
    } catch (err) {
      if (migrationHandoff) toast.error("Failed to load deployment");
      else if (deploymentRef.current) scheduleRemovalFallback("failed");
      else {
        toast.error(err instanceof Error ? err.message : "Failed to load deployment");
        navigate(backTarget);
      }
    } finally {
      setLoading(false);
    }
  }, [
    deploymentId,
    migrationHandoff,
    backTarget,
    navigate,
    nodeId,
    nodeSlug,
    scheduleRemovalFallback,
    updateMeta,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("docker.migration.changed", (payload) => {
    const event = payload as DockerMigration;
    if (
      !event.cutoverAt ||
      event.resourceType !== "deployment" ||
      event.sourceNodeId !== nodeId ||
      event.deploymentId !== deploymentId
    ) {
      return;
    }
    handleMigrationCutover(event);
  });

  useRealtime("docker.deployment.changed", (payload) => {
    const event = payload as {
      nodeId?: string;
      deploymentId?: string;
      action?: string;
      transition?: string;
      oldName?: string;
      name?: string;
    };
    if (event.nodeId !== nodeId || event.deploymentId !== deploymentId) return;

    if (event.oldName === routeDeploymentName && event.name) {
      navigate(dockerDeploymentRoute(nodeSlug, event.name, activeTab), {
        replace: true,
        state: location.state,
      });
      return;
    }

    if (event.action === "transitioning" && event.transition) {
      setDeployment((current) =>
        current ? { ...current, _transition: event.transition } : current
      );
      return;
    }

    if (event.action === "deleted" || event.action === "removed") {
      scheduleRemovalFallback("removed");
      return;
    }

    void load();
  });

  useRealtime("node.slug.changed", (payload) => {
    const event = payload as { id?: string; oldSlug?: string; slug?: string };
    if (event.id !== nodeId || event.oldSlug !== nodeSlug || !event.slug) return;
    navigate(dockerDeploymentRoute(event.slug, routeDeploymentName, activeTab), {
      replace: true,
      state: location.state,
    });
  });

  useRealtime("docker.container.changed", (payload) => {
    const event = payload as {
      nodeId?: string;
      deploymentId?: string;
      action?: string;
      transition?: string;
    };
    if (event.nodeId !== nodeId || event.deploymentId !== deploymentId) return;
    if (event.action === "deployment") return;

    if (event.action === "transitioning" && event.transition) {
      setDeployment((current) =>
        current ? { ...current, _transition: event.transition } : current
      );
      return;
    }

    void load();
  });

  useRealtime("docker.health.changed", (payload) => {
    const event = payload as {
      nodeId?: string;
      deploymentId?: string;
      target?: string;
    };
    if (
      event.nodeId !== nodeId ||
      event.target !== "deployment" ||
      event.deploymentId !== deploymentId
    ) {
      return;
    }

    void load();
  });

  useRealtime("docker.snapshot.changed", (payload) => {
    const event = payload as { nodeId?: string; kind?: string };
    if (event.nodeId !== nodeId || event.kind !== "containers") return;
    void load();
  });

  const primaryRoute = useMemo(
    () => deployment?.routes.find((route) => route.isPrimary) ?? deployment?.routes[0] ?? null,
    [deployment]
  );
  const active = getActiveSlot(deployment);
  const activeContainerId = active?.containerId ?? "";
  const activeBaseState =
    activeInspect?.State?.Status ?? (activeInspect?.State?.Running ? "running" : active?.status);
  const activeState = activeBaseState ?? "unknown";
  const serviceTransition = deployment?._transition;
  const unavailable = deployment?.availability === "unavailable";
  const serviceBusy = !!serviceTransition || isTransitionStatus(deployment?.status);
  const serviceState =
    serviceTransition ??
    (deployment?.status === "ready"
      ? activeState === "unknown"
        ? "running"
        : activeState
      : (deployment?.status ?? activeState));
  const isRunning = activeState === "running";
  const isStopped = deployment?.status === "stopped" || !isRunning;
  const isTerminalTab = activeTab === "logs" || activeTab === "console";
  const serviceEnv = useMemo(() => {
    return deployment?.desiredConfig.env ?? {};
  }, [deployment?.desiredConfig.env]);
  const drainingSlot = useMemo(
    () =>
      deployment?.slots.find(
        (slot) => slot.slot !== deployment.activeSlot && slot.status === "draining"
      ),
    [deployment]
  );

  const visibleTabs = useMemo(
    () => [
      "overview",
      ...(canViewContainer ? ["logs"] : []),
      ...(canUseConsole ? ["console"] : []),
      ...(canUseFiles ? ["files"] : []),
      ...(canViewContainer ? ["stats"] : []),
      ...(canUseEnvironment ? ["environment"] : []),
      "slots",
      ...(canEdit ? ["settings"] : []),
      "config",
    ],
    [canEdit, canUseConsole, canUseEnvironment, canUseFiles, canViewContainer]
  );

  const isTabDisabled = useCallback(
    (tabName: string) => {
      if (
        unavailable &&
        ["logs", "console", "files", "stats", "environment", "settings"].includes(tabName)
      ) {
        return true;
      }
      if (!activeContainerId) return ["logs", "console", "files", "stats"].includes(tabName);
      return ["console", "files", "stats"].includes(tabName) && (!isRunning || serviceBusy);
    },
    [activeContainerId, isRunning, serviceBusy, unavailable]
  );

  useEffect(() => {
    if (!visibleTabs.includes(activeTab) || isTabDisabled(activeTab)) {
      setActiveTab("overview");
    }
  }, [activeTab, isTabDisabled, setActiveTab, visibleTabs]);

  const runAction = async (name: string, fn: () => Promise<void>) => {
    setAction(name);
    const transition = transitionForAction(name);
    if (transition) {
      setDeployment((current) => (current ? { ...current, _transition: transition } : current));
    }
    try {
      await fn();
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Deployment action failed");
      await load().catch(() => {
        if (transition) {
          setDeployment((current) =>
            current?._transition === transition ? { ...current, _transition: undefined } : current
          );
        }
      });
    } finally {
      setAction(null);
    }
  };

  const saveServiceEnv = useCallback(
    async (env: Record<string, string>) => {
      const next = await api.updateDockerDeployment(nodeId, deploymentId, {
        desiredConfig: { env },
      });
      setDeployment(next);
      setWebhook(next.webhook ?? null);
    },
    [deploymentId, nodeId]
  );

  const removeDeployment = async () => {
    if (!deployment) return;
    const ok = await confirm({
      title: "Remove Deployment",
      description: `Remove "${deployment.name}"? This will remove the router, slot containers, and deployment network.`,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    await runAction("remove", async () => {
      await api.deleteDockerDeployment(nodeId, deployment.id);
      usePinnedContainersStore.getState().removePin(deployment.id);
      toast.success("Deployment removed");
      navigate(backTarget);
    });
  };

  if (loading && !deployment) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">Loading...</div>
    );
  }

  if (!deployment) return null;

  const actionDisabled = !!action || serviceBusy || unavailable;
  const migrationDisabledReason = actionDisabled
    ? "Deployment is unavailable or changing state"
    : undefined;
  const headerActions = [
    {
      label: "Pin",
      icon: <Pin className="h-4 w-4" />,
      onClick: () => setPinOpen(true),
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
    ...(isStopped && canManage
      ? [
          {
            label: "Start",
            icon: <Play className="h-4 w-4" />,
            onClick: () =>
              runAction("start", async () => {
                await api.startDockerDeployment(nodeId, deployment.id);
                toast.success("Deployment started");
              }),
            disabled: actionDisabled,
          },
        ]
      : []),
    ...(!isStopped && canManage
      ? [
          {
            label: "Stop",
            icon: <Square className="h-4 w-4" />,
            onClick: () =>
              runAction("stop", async () => {
                await api.stopDockerDeployment(nodeId, deployment.id);
                toast.success("Deployment stopped");
              }),
            disabled: actionDisabled,
          },
          {
            label: "Restart",
            icon: <RotateCcw className="h-4 w-4" />,
            onClick: () =>
              runAction("restart", async () => {
                await api.restartDockerDeployment(nodeId, deployment.id);
                toast.success("Deployment restarted");
              }),
            disabled: actionDisabled,
          },
        ]
      : []),
    ...(canManage
      ? [
          {
            label: "Rollback",
            icon: <RotateCcw className="h-4 w-4" />,
            onClick: () =>
              runAction("rollback", async () => {
                await api.rollbackDockerDeployment(nodeId, deployment.id);
                toast.success("Rollback started");
              }),
            disabled: actionDisabled,
            separatorBefore: true,
          },
        ]
      : []),
    ...(!isStopped && canManage && drainingSlot?.containerId
      ? [
          {
            label: "Stop draining slot",
            icon: <Square className="h-4 w-4" />,
            onClick: () =>
              runAction(`stop-${drainingSlot.slot}`, async () => {
                await api.stopDockerDeploymentSlot(nodeId, deployment.id, drainingSlot.slot);
                toast.success("Draining slot stopped");
              }),
            disabled: actionDisabled,
          },
        ]
      : []),
    ...(!isStopped && canManage
      ? [
          {
            label: "Kill",
            icon: <Skull className="h-4 w-4" />,
            onClick: () =>
              runAction("kill", async () => {
                await api.killDockerDeployment(nodeId, deployment.id);
                toast.success("Deployment killed");
              }),
            disabled: actionDisabled,
            destructive: true,
            separatorBefore: !drainingSlot?.containerId,
          },
        ]
      : []),
    ...(canDelete
      ? [
          {
            label: "Remove",
            icon: <Trash2 className="h-4 w-4" />,
            onClick: removeDeployment,
            disabled: actionDisabled,
            destructive: true,
            separatorBefore: isStopped || !canManage,
          },
        ]
      : []),
  ];

  return (
    <PageTransition>
      <div
        className={`h-full p-6 flex flex-col gap-4 ${
          isTerminalTab ? "overflow-hidden" : "overflow-y-auto"
        }`}
      >
        <div className="flex shrink-0 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <PageBackButton onClick={() => navigate(backTarget)} />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-2xl font-bold">{deployment.name}</h1>
                {unavailable ? (
                  <Badge variant="secondary" size="inline" className="shrink-0">
                    Unavailable
                  </Badge>
                ) : (
                  <>
                    <Badge variant={statusVariant(serviceState)} size="inline" className="shrink-0">
                      {serviceState}
                    </Badge>
                    <Badge variant="outline" size="inline" className="shrink-0">
                      blue/green
                    </Badge>
                  </>
                )}
              </div>
              <p className="break-all text-sm text-muted-foreground">
                {active?.image ?? deployment.desiredConfig.image} &middot; active{" "}
                {deployment.activeSlot}
              </p>
            </div>
          </div>

          <ResponsiveHeaderActions actions={headerActions}>
            <Button variant="outline" size="icon" onClick={() => setPinOpen(true)}>
              <Pin className="h-4 w-4" />
            </Button>
            {isStopped && canManage && (
              <Button
                variant="outline"
                disabled={actionDisabled}
                onClick={() =>
                  runAction("start", async () => {
                    await api.startDockerDeployment(nodeId, deployment.id);
                    toast.success("Deployment started");
                  })
                }
              >
                <Play className="h-3.5 w-3.5" />
                Start
              </Button>
            )}
            {!isStopped && canManage && (
              <>
                <Button
                  variant="outline"
                  disabled={actionDisabled}
                  onClick={() =>
                    runAction("stop", async () => {
                      await api.stopDockerDeployment(nodeId, deployment.id);
                      toast.success("Deployment stopped");
                    })
                  }
                >
                  <Square className="h-3.5 w-3.5" />
                  Stop
                </Button>
                <Button
                  variant="outline"
                  disabled={actionDisabled}
                  onClick={() =>
                    runAction("restart", async () => {
                      await api.restartDockerDeployment(nodeId, deployment.id);
                      toast.success("Deployment restarted");
                    })
                  }
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Restart
                </Button>
              </>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" disabled={actionDisabled}>
                  <EllipsisVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canMigrate && (
                  <DropdownMenuItem
                    disabled={Boolean(migrationDisabledReason)}
                    title={migrationDisabledReason}
                    onClick={() => setMigrationOpen(true)}
                  >
                    <Truck className="mr-2 h-3.5 w-3.5" />
                    Migrate
                  </DropdownMenuItem>
                )}
                {canManage && (
                  <DropdownMenuItem
                    onClick={() =>
                      runAction("rollback", async () => {
                        await api.rollbackDockerDeployment(nodeId, deployment.id);
                        toast.success("Rollback started");
                      })
                    }
                  >
                    <RotateCcw className="h-3.5 w-3.5 mr-2" />
                    Rollback
                  </DropdownMenuItem>
                )}
                {!isStopped && canManage && (
                  <>
                    <DropdownMenuSeparator />
                    {drainingSlot?.containerId && (
                      <DropdownMenuItem
                        onClick={() =>
                          runAction(`stop-${drainingSlot.slot}`, async () => {
                            await api.stopDockerDeploymentSlot(
                              nodeId,
                              deployment.id,
                              drainingSlot.slot
                            );
                            toast.success("Draining slot stopped");
                          })
                        }
                      >
                        <Square className="h-3.5 w-3.5 mr-2" />
                        Stop draining slot
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      onClick={() =>
                        runAction("kill", async () => {
                          await api.killDockerDeployment(nodeId, deployment.id);
                          toast.success("Deployment killed");
                        })
                      }
                      className="text-destructive"
                    >
                      <Skull className="h-3.5 w-3.5 mr-2" />
                      Kill
                    </DropdownMenuItem>
                  </>
                )}
                {canDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={removeDeployment} className="text-destructive">
                      <Trash2 className="h-3.5 w-3.5 mr-2" />
                      Remove
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </ResponsiveHeaderActions>
        </div>

        {deployment.healthCheck?.enabled && (
          <HealthBars
            history={deployment.healthCheck.healthHistory}
            currentStatus={deployment.healthCheck.healthStatus}
          />
        )}

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex flex-col flex-1 min-h-0"
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="overview" className="gap-1.5">
              <LayoutDashboard className="h-3.5 w-3.5" />
              Overview
            </TabsTrigger>
            {canViewContainer && (
              <TabsTrigger value="logs" disabled={isTabDisabled("logs")} className="gap-1.5">
                <ScrollText className="h-3.5 w-3.5" />
                Logs
              </TabsTrigger>
            )}
            {canUseConsole && (
              <TabsTrigger value="console" disabled={isTabDisabled("console")} className="gap-1.5">
                <TerminalIcon className="h-3.5 w-3.5" />
                Console
              </TabsTrigger>
            )}
            {canUseFiles && (
              <TabsTrigger value="files" disabled={isTabDisabled("files")} className="gap-1.5">
                <Folder className="h-3.5 w-3.5" />
                Files
              </TabsTrigger>
            )}
            {canViewContainer && (
              <TabsTrigger value="stats" disabled={isTabDisabled("stats")} className="gap-1.5">
                <Activity className="h-3.5 w-3.5" />
                Monitoring
              </TabsTrigger>
            )}
            {canUseEnvironment && (
              <TabsTrigger value="environment" className="gap-1.5">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Environment
              </TabsTrigger>
            )}
            <TabsTrigger value="slots" className="gap-1.5">
              <ListTodo className="h-3.5 w-3.5" />
              Slots
            </TabsTrigger>
            {canEdit && (
              <TabsTrigger value="settings" className="gap-1.5">
                <Settings className="h-3.5 w-3.5" />
                Settings
              </TabsTrigger>
            )}
            <TabsTrigger value="config" className="gap-1.5">
              <Code2 className="h-3.5 w-3.5" />
              Config
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="pb-0">
            <DeploymentOverview
              deployment={deployment}
              active={active}
              serviceState={serviceState}
              activeState={activeState}
              primaryRoute={primaryRoute}
            />
          </TabsContent>
          {canViewContainer && activeContainerId && !unavailable && (
            <TabsContent value="logs" className="flex flex-col flex-1 min-h-0 pb-0">
              <LogsTab
                nodeId={nodeId}
                containerId={activeContainerId}
                containerState={activeState}
                inspectData={activeInspect ?? undefined}
              />
            </TabsContent>
          )}
          {canUseConsole && activeContainerId && !unavailable && (
            <TabsContent value="console" className="flex flex-col flex-1 min-h-0">
              <ConsoleTab
                nodeId={nodeId}
                containerId={activeContainerId}
                scopeResourceId={deploymentId}
              />
            </TabsContent>
          )}
          {canUseFiles && activeContainerId && !unavailable && (
            <TabsContent value="files" className="pb-0">
              <FilesTab
                nodeId={nodeId}
                containerId={activeContainerId}
                scopeResourceId={deploymentId}
              />
            </TabsContent>
          )}
          {canViewContainer && activeContainerId && activeInspect && !unavailable && (
            <TabsContent value="stats" className="pb-0">
              <StatsTab nodeId={nodeId} containerId={activeContainerId} data={activeInspect} />
            </TabsContent>
          )}
          {canUseEnvironment && !unavailable && (
            <TabsContent value="environment" className="pb-0">
              <EnvironmentTab
                nodeId={nodeId}
                containerId={deployment.id}
                scopeResourceId={deploymentId}
                containerState={activeState}
                serviceEnv={serviceEnv}
                onSaveServiceEnv={saveServiceEnv}
              />
            </TabsContent>
          )}
          <TabsContent value="slots" className="pb-0">
            <DeploymentSlots
              deployment={deployment}
              nodeId={nodeId}
              action={action}
              serviceBusy={serviceBusy || unavailable}
              runAction={runAction}
              canManage={canManage && !unavailable}
            />
          </TabsContent>
          {canEdit && !unavailable && (
            <TabsContent value="settings" className="pb-0">
              <DeploymentSettings
                deployment={deployment}
                nodeId={nodeId}
                action={action}
                webhook={webhook}
                setWebhook={setWebhook}
                onHealthCheckSaved={(healthCheck) =>
                  setDeployment((current) => (current ? { ...current, healthCheck } : current))
                }
                canEditMounts={canEditMounts}
                canManageWebhooks={canManageWebhooks}
                runAction={runAction}
              />
            </TabsContent>
          )}
          <TabsContent value="config" className="flex flex-col flex-1 min-h-0 pb-0">
            <DeploymentConfig deployment={deployment} />
          </TabsContent>
        </Tabs>
      </div>
      <Dialog open={pinOpen} onOpenChange={setPinOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pin Deployment</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Add to sidebar</p>
                <p className="text-xs text-muted-foreground">Quick access link in the sidebar</p>
              </div>
              <Switch
                checked={isPinnedSidebar(deployment.id)}
                onChange={() => {
                  toggleSidebar(deployment.id, {
                    nodeId,
                    nodeSlug,
                    name: deployment.name,
                    state: deployment._transition ?? deployment.status,
                    kind: "deployment",
                    scopeResourceId: deployment.id,
                  });
                  usePinnedContainersStore.getState().invalidate();
                }}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <DockerMigrationDialog
        open={migrationOpen}
        onOpenChange={handleMigrationOpenChange}
        onCutover={handleMigrationCutover}
        initialMigration={restoredMigration}
        resource={{
          type: "deployment",
          nodeId,
          deploymentId: deployment.id,
          displayName: deployment.name,
          sourceState: isStopped ? "stopped" : "running",
        }}
      />
    </PageTransition>
  );
}
