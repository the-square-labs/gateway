import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpCircle,
  Box,
  Database,
  Expand,
  GitBranch,
  Globe,
  PanelLeft,
  PanelLeftClose,
  Search,
  Server,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AIButton } from "@/components/ai/AIButton";
import { confirmAILiteMode } from "@/components/ai/confirm-lite-mode";
import { AccountMenuContent } from "@/components/layout/AccountMenuContent";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRealtime } from "@/hooks/use-realtime";
import { visibleNavigationGroups } from "@/lib/app-navigation";
import {
  databaseRoute,
  dockerContainerRoute,
  dockerDeploymentRoute,
  nodeRoute,
  proxyHostRoute,
} from "@/lib/resource-routes";
import { isSidebarNavigationActive } from "@/lib/sidebar-navigation";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import { usePinnedDatabasesStore } from "@/stores/pinned-databases";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { usePinnedProxiesStore } from "@/stores/pinned-proxies";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import { useUpdateStore } from "@/stores/update";
import type { Node, ProxyHost } from "@/types";
import { AI_SCOPE, effectiveNodeStatus } from "@/types";

function getInitials(name: string | null): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export interface SidebarContentProps {
  onNavigate?: () => void;
  alwaysExpanded?: boolean;
  sidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
  isResizing?: boolean;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  hasNginxNodes?: boolean;
}

export function SidebarContent({
  onNavigate,
  alwaysExpanded = false,
  sidebarWidth = 260,
  onSidebarWidthChange,
  isResizing = false,
  onResizeStart,
  onResizeEnd,
  hasNginxNodes = true,
}: SidebarContentProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, hasScope, logout } = useAuthStore();
  const {
    sidebarOpen,
    toggleSidebar,
    setAIPanelOpen,
    setAILiteMode,
    setCommandPaletteOpen: openPalette,
  } = useUIStore();

  const aiEnabled = useAIStore((s) => s.isEnabled);
  const updateAvailable = useUpdateStore((s) => s.status?.updateAvailable ?? false);
  const showUpdateNotifications = useUIStore((s) => s.showUpdateNotifications);
  const showAILiteModeCTA = useUIStore((s) => s.showAILiteModeCTA);
  const sidebarPinnedIds = usePinnedNodesStore((s) => s.sidebarNodeIds);
  const pinnedRefreshTick = usePinnedNodesStore((s) => s.refreshTick);
  const [pinnedNodes, setPinnedNodes] = useState<Node[]>([]);
  const [statusPageEnabled, setStatusPageEnabled] = useState(false);
  const pkiEnabled = useSystemConfigStore((s) => s.config.features.pkiEnabled);
  const loggingEnabled = useSystemConfigStore((s) => s.config.features.loggingEnabled);
  const inferenceEnabled = useSystemConfigStore((s) => s.config.features.inferenceEnabled);

  const sidebarPinnedProxyIds = usePinnedProxiesStore((s) => s.sidebarProxyIds);
  const pinnedProxyRefreshTick = usePinnedProxiesStore((s) => s.refreshTick);
  const [pinnedProxies, setPinnedProxies] = useState<ProxyHost[]>([]);

  const sidebarPinnedContainerIds = usePinnedContainersStore((s) => s.sidebarContainerIds);
  const pinnedContainerMeta = usePinnedContainersStore((s) => s.containerMeta);
  const pinnedContainerRefreshTick = usePinnedContainersStore((s) => s.refreshTick);
  const dockerNodes = useDockerStore((s) => s.dockerNodes);
  const sidebarPinnedDatabaseIds = usePinnedDatabasesStore((s) => s.sidebarDatabaseIds);
  const pinnedDatabaseMeta = usePinnedDatabasesStore((s) => s.databaseMeta);
  const pinnedDatabaseRefreshTick = usePinnedDatabasesStore((s) => s.refreshTick);
  const canViewNodeDetails = useCallback(
    (nodeId: string) => hasScope("nodes:details") || hasScope(`nodes:details:${nodeId}`),
    [hasScope]
  );
  const canViewProxyDetails = useCallback(
    (proxyId: string) => hasScope("proxy:view") || hasScope(`proxy:view:${proxyId}`),
    [hasScope]
  );
  const canViewContainerDetails = useCallback(
    (nodeId: string, scopeResourceId?: string) =>
      hasScope("docker:containers:view") ||
      hasScope(`docker:containers:view:${nodeId}${scopeResourceId ? `/${scopeResourceId}` : ""}`),
    [hasScope]
  );
  const canViewDatabaseDetails = useCallback(
    (databaseId: string) => hasScope("databases:view") || hasScope(`databases:view:${databaseId}`),
    [hasScope]
  );

  const refetchStatusPageEnabled = useCallback(() => {
    if (!hasScope("status-page:view")) {
      setStatusPageEnabled(false);
      return;
    }
    api
      .getStatusPageSettings()
      .then((settings) => setStatusPageEnabled(settings.enabled))
      .catch(() => setStatusPageEnabled(false));
  }, [hasScope]);

  useEffect(() => {
    refetchStatusPageEnabled();
  }, [refetchStatusPageEnabled]);

  useRealtime("status-page.changed", () => {
    refetchStatusPageEnabled();
  });

  const refetchPinnedNodes = useCallback(() => {
    if (sidebarPinnedIds.length === 0) return;
    api
      .listNodes({ limit: 100 })
      .then((r) => {
        setPinnedNodes(
          r.data.filter((n) => sidebarPinnedIds.includes(n.id) && canViewNodeDetails(n.id))
        );
      })
      .catch(() => {});
  }, [canViewNodeDetails, sidebarPinnedIds]);

  useEffect(() => {
    if (sidebarPinnedIds.length === 0) {
      setPinnedNodes([]);
      return;
    }
    void pinnedRefreshTick;
    refetchPinnedNodes();
  }, [sidebarPinnedIds, pinnedRefreshTick, refetchPinnedNodes]);

  useEffect(() => {
    if (sidebarPinnedProxyIds.length === 0) {
      setPinnedProxies([]);
      return;
    }
    void pinnedProxyRefreshTick;
    api
      .listProxyHosts({ limit: 100 })
      .then((r) => {
        setPinnedProxies(
          (r.data ?? []).filter(
            (p) => sidebarPinnedProxyIds.includes(p.id) && canViewProxyDetails(p.id)
          )
        );
      })
      .catch(() => {});
  }, [canViewProxyDetails, sidebarPinnedProxyIds, pinnedProxyRefreshTick]);

  useEffect(() => {
    if (sidebarPinnedDatabaseIds.length === 0) return;
    void pinnedDatabaseRefreshTick;
    api
      .listDatabases({ limit: 200 })
      .then((r) => {
        const all = r.data ?? [];
        for (const db of all) {
          if (!sidebarPinnedDatabaseIds.includes(db.id)) continue;
          if (!canViewDatabaseDetails(db.id)) continue;
          const existing = pinnedDatabaseMeta[db.id];
          if (
            !existing ||
            existing.slug !== db.slug ||
            existing.name !== db.name ||
            existing.type !== db.type ||
            existing.healthStatus !== db.healthStatus
          ) {
            usePinnedDatabasesStore.getState().updateMeta(db.id, {
              slug: db.slug,
              name: db.name,
              type: db.type,
              healthStatus: db.healthStatus,
            });
          }
        }
      })
      .catch(() => {});
  }, [
    canViewDatabaseDetails,
    pinnedDatabaseMeta,
    pinnedDatabaseRefreshTick,
    sidebarPinnedDatabaseIds,
  ]);

  useEffect(() => {
    if (sidebarPinnedDatabaseIds.length === 0) return;
    let cancelled = false;
    for (const databaseId of sidebarPinnedDatabaseIds) {
      if (!canViewDatabaseDetails(databaseId)) continue;
      api
        .getDatabase(databaseId)
        .then((db) => {
          if (cancelled) return;
          const existing = pinnedDatabaseMeta[db.id];
          if (
            existing?.name === db.name &&
            existing.slug === db.slug &&
            existing.type === db.type &&
            existing.healthStatus === db.healthStatus
          ) {
            return;
          }
          usePinnedDatabasesStore.getState().updateMeta(db.id, {
            slug: db.slug,
            name: db.name,
            type: db.type,
            healthStatus: db.healthStatus,
          });
        })
        .catch((error) => {
          if (cancelled) return;
          if (error instanceof ApiRequestError && error.status === 404) {
            usePinnedDatabasesStore.getState().removePin(databaseId);
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [canViewDatabaseDetails, pinnedDatabaseMeta, sidebarPinnedDatabaseIds]);

  useEffect(() => {
    // Re-fetch pinned details when a matching realtime event increments the store tick.
    void pinnedContainerRefreshTick;
    if (sidebarPinnedContainerIds.length === 0) return;
    let cancelled = false;
    for (const containerId of sidebarPinnedContainerIds) {
      const meta = pinnedContainerMeta[containerId];
      if (!meta || !canViewContainerDetails(meta.nodeId, meta.scopeResourceId)) continue;
      const nodeSlug = dockerNodes.find((node) => node.id === meta.nodeId)?.slug || meta.nodeSlug;
      const request =
        meta.kind === "deployment"
          ? api.getDockerDeployment(meta.nodeId, containerId)
          : api.inspectContainer(meta.nodeId, containerId);
      request
        .then((value) => {
          if (cancelled) return;
          const current = usePinnedContainersStore.getState().containerMeta[containerId];
          if (!current) return;
          if (meta.kind === "deployment") {
            const deployment = value as Awaited<ReturnType<typeof api.getDockerDeployment>>;
            const nextNodeSlug = nodeSlug || current.nodeSlug;
            const nextState = deployment._transition ?? deployment.status;
            if (
              current.nodeSlug === nextNodeSlug &&
              current.name === deployment.name &&
              current.state === nextState &&
              current.kind === "deployment"
            ) {
              return;
            }
            usePinnedContainersStore.getState().updateMeta(containerId, {
              ...current,
              nodeSlug: nextNodeSlug,
              name: deployment.name,
              state: nextState,
              kind: "deployment",
            });
            return;
          }
          const inspect = value as Record<string, any>;
          const nextNodeSlug = nodeSlug || current.nodeSlug;
          const nextName = String(inspect.Name ?? inspect.name ?? current.name).replace(/^\//, "");
          const nextState =
            inspect._transition ?? inspect.State?.Status ?? inspect.state ?? current.state;
          if (
            current.nodeSlug === nextNodeSlug &&
            current.name === nextName &&
            current.state === nextState &&
            current.kind === "container"
          ) {
            return;
          }
          usePinnedContainersStore.getState().updateMeta(containerId, {
            ...current,
            nodeSlug: nextNodeSlug,
            name: nextName,
            state: nextState,
            kind: "container",
          });
        })
        .catch((error) => {
          if (cancelled) return;
          if (error instanceof ApiRequestError && error.status === 404) {
            usePinnedContainersStore.getState().removePin(containerId);
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [
    canViewContainerDetails,
    dockerNodes,
    pinnedContainerMeta,
    pinnedContainerRefreshTick,
    sidebarPinnedContainerIds,
  ]);

  useRealtime(sidebarPinnedIds.length > 0 ? "node.changed" : null, () => {
    usePinnedNodesStore.getState().invalidate();
  });
  useRealtime(sidebarPinnedProxyIds.length > 0 ? "proxy.host.changed" : null, () => {
    usePinnedProxiesStore.getState().invalidate();
  });
  useRealtime(sidebarPinnedDatabaseIds.length > 0 ? "database.changed" : null, () => {
    usePinnedDatabasesStore.getState().invalidate();
  });
  useRealtime(sidebarPinnedContainerIds.length > 0 ? "docker.container.changed" : null, () => {
    usePinnedContainersStore.getState().invalidate();
  });
  useRealtime(sidebarPinnedContainerIds.length > 0 ? "docker.deployment.changed" : null, () => {
    usePinnedContainersStore.getState().invalidate();
  });
  useRealtime(
    sidebarPinnedIds.length > 0 || sidebarPinnedContainerIds.length > 0
      ? "node.slug.changed"
      : null,
    (payload) => {
      const event = payload as { id?: string; slug?: string };
      if (!event.id || !event.slug) return;
      usePinnedNodesStore.getState().invalidate();
      const pinned = usePinnedContainersStore.getState();
      for (const [containerId, meta] of Object.entries(pinned.containerMeta)) {
        if (meta.nodeId === event.id && meta.nodeSlug !== event.slug) {
          pinned.updateMeta(containerId, { ...meta, nodeSlug: event.slug });
        }
      }
    }
  );

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      logout();
    }
    navigate("/login");
  };

  const isExpanded = alwaysExpanded || sidebarOpen;

  const canUseAI = hasScope(AI_SCOPE) && aiEnabled !== false;

  const handleTryLiteMode = useCallback(async () => {
    const confirmed = await confirmAILiteMode();
    if (!confirmed) return;
    setAILiteMode(true);
    setAIPanelOpen(false);
    navigate("/");
    onNavigate?.();
  }, [navigate, onNavigate, setAIPanelOpen, setAILiteMode]);

  const effectiveGroups = visibleNavigationGroups({
    scopes: user?.scopes ?? [],
    pkiEnabled,
    loggingEnabled,
    inferenceEnabled,
    statusPageEnabled,
    hasNginxNodes,
    hasDockerNodes: dockerNodes.length > 0,
  });

  const allNavItems = effectiveGroups.flatMap((g) => g.items);

  return (
    <div
      style={{ width: alwaysExpanded ? "100%" : isExpanded ? sidebarWidth : 48 }}
      className={cn(
        "relative flex h-full shrink-0 flex-col bg-sidebar-background overflow-visible",
        !alwaysExpanded && "border-r border-sidebar-border",
        !alwaysExpanded && !isResizing && "transition-[width] duration-200 ease-out"
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        {!isExpanded ? (
          <motion.div
            key="collapsed"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex h-full flex-col items-center py-3 gap-2"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleSidebar}>
                  <PanelLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Open sidebar</TooltipContent>
            </Tooltip>

            {allNavItems.map((item) => (
              <Tooltip key={item.href}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-8 w-8",
                      isSidebarNavigationActive(location.pathname, item.href) && "bg-sidebar-accent"
                    )}
                    onClick={() => navigate(item.href)}
                  >
                    <item.icon className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">{item.name}</TooltipContent>
              </Tooltip>
            ))}

            <div className="flex-1" />

            {hasScope(AI_SCOPE) && <AIButton iconOnly />}

            {canUseAI && showAILiteModeCTA && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 bg-sidebar-accent text-sidebar-accent-foreground/80 hover:bg-muted hover:text-sidebar-accent-foreground"
                    onClick={handleTryLiteMode}
                  >
                    <Expand className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Switch to lite mode</TooltipContent>
              </Tooltip>
            )}

            {updateAvailable && hasScope("admin:update") && showUpdateNotifications && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    style={{ backgroundColor: "rgb(234 179 8)", color: "#111" }}
                    onClick={() => navigate("/settings/gateway")}
                  >
                    <ArrowUpCircle className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Update available</TooltipContent>
              </Tooltip>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <Avatar className="h-6 w-6">
                    <AvatarImage src={user?.avatarUrl ?? undefined} />
                    <AvatarFallback className="text-xs">
                      {getInitials(user?.name ?? null)}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right" className="w-64">
                <AccountMenuContent onLogout={handleLogout} onNavigate={onNavigate} />
              </DropdownMenuContent>
            </DropdownMenu>
          </motion.div>
        ) : (
          <motion.div
            key="expanded"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex h-full w-full min-w-0 flex-col"
          >
            {!alwaysExpanded && onSidebarWidthChange && (
              <ResizeHandle
                side="left"
                onResize={onSidebarWidthChange}
                onResizeStart={onResizeStart}
                onResizeEnd={onResizeEnd}
                minWidth={200}
                maxWidth={480}
              />
            )}

            {/* Header */}
            <div
              className="flex items-center justify-between px-2"
              style={{ paddingTop: 10, paddingBottom: 10, paddingLeft: 10 }}
            >
              <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground/80 whitespace-nowrap pl-1">
                <img src="/android-chrome-192x192.png" alt="Gateway" className="h-5 w-5" />
                Gateway
              </span>

              <div className="flex items-center gap-0.5">
                {hasScope(AI_SCOPE) && <AIButton />}
                {alwaysExpanded ? (
                  <Button variant="ghost" size="icon" className="h-10 w-10" onClick={onNavigate}>
                    <X className="h-4 w-4" />
                  </Button>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-10 w-10 md:h-7 md:w-7"
                        onClick={toggleSidebar}
                      >
                        <PanelLeftClose className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Close sidebar</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>

            {/* Search */}
            <div className="relative border-y border-border">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search..."
                readOnly
                onClick={() => openPalette(true)}
                style={{ height: 44 }}
                className="pl-9 text-sm border-0 focus-visible:ring-0 focus-visible:outline-none cursor-pointer"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs tracking-widest text-muted-foreground hidden md:inline">
                ⌘K
              </span>
            </div>

            {/* Navigation */}
            <ScrollArea className="flex-1 overflow-hidden min-w-0">
              {effectiveGroups.map((group, groupIndex) => (
                <div key={group.label}>
                  {groupIndex > 0 && <Separator />}

                  {/* Pinned items — right after Dashboard */}
                  {groupIndex === 1 &&
                    (pinnedNodes.length > 0 ||
                      pinnedProxies.length > 0 ||
                      sidebarPinnedDatabaseIds.length > 0 ||
                      sidebarPinnedContainerIds.length > 0) && (
                      <>
                        <nav className="space-y-0.5 px-2 py-2">
                          <p className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                            Pinned Items
                          </p>
                          {pinnedProxies.map((proxy) => {
                            const isActive =
                              location.pathname === proxyHostRoute(proxy.slug) ||
                              location.pathname.startsWith(`${proxyHostRoute(proxy.slug)}/`);
                            const hs = (proxy as any).effectiveHealthStatus ?? proxy.healthStatus;
                            return (
                              <Link
                                key={proxy.id}
                                to={proxyHostRoute(proxy.slug)}
                                onClick={onNavigate}
                                className={cn(
                                  "flex items-center gap-3 px-3 py-2 text-sm transition-colors whitespace-nowrap overflow-hidden",
                                  isActive
                                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                                )}
                              >
                                <Globe className="h-4 w-4 shrink-0" />
                                <span className="truncate">{proxy.domainNames[0]}</span>
                                <span
                                  className={cn(
                                    "ml-auto h-2 w-2 rounded-full shrink-0",
                                    hs === "online"
                                      ? "bg-emerald-500"
                                      : hs === "offline" || hs === "degraded"
                                        ? "bg-red-400"
                                        : "bg-muted-foreground/40"
                                  )}
                                />
                              </Link>
                            );
                          })}
                          {pinnedNodes.map((node) => {
                            const isActive =
                              location.pathname === nodeRoute(node.slug) ||
                              location.pathname.startsWith(`${nodeRoute(node.slug)}/`);
                            const status = effectiveNodeStatus(node);
                            return (
                              <Link
                                key={node.id}
                                to={nodeRoute(node.slug)}
                                onClick={onNavigate}
                                className={cn(
                                  "flex items-center gap-3 px-3 py-2 text-sm transition-colors whitespace-nowrap overflow-hidden",
                                  isActive
                                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                                )}
                              >
                                <Server className="h-4 w-4 shrink-0" />
                                <span className="truncate">
                                  {node.displayName || node.hostname}
                                </span>
                                <span
                                  className={cn(
                                    "ml-auto h-2 w-2 rounded-full shrink-0",
                                    status === "online"
                                      ? "bg-emerald-500"
                                      : status === "degraded"
                                        ? "bg-yellow-500"
                                        : status === "offline" || status === "error"
                                          ? "bg-red-400"
                                          : "bg-yellow-500"
                                  )}
                                />
                              </Link>
                            );
                          })}
                          {sidebarPinnedDatabaseIds.map((databaseId) => {
                            const meta = pinnedDatabaseMeta[databaseId];
                            if (!meta?.slug || !canViewDatabaseDetails(databaseId)) return null;
                            const isActive =
                              location.pathname === databaseRoute(meta.slug) ||
                              location.pathname.startsWith(`${databaseRoute(meta.slug)}/`);
                            return (
                              <Link
                                key={databaseId}
                                to={databaseRoute(meta.slug, "overview")}
                                onClick={onNavigate}
                                className={cn(
                                  "flex items-center gap-3 px-3 py-2 text-sm transition-colors whitespace-nowrap overflow-hidden",
                                  isActive
                                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                                )}
                              >
                                <Database className="h-4 w-4 shrink-0" />
                                <span className="truncate">{meta.name}</span>
                                <span
                                  className={cn(
                                    "ml-auto h-2 w-2 rounded-full shrink-0",
                                    meta.healthStatus === "online"
                                      ? "bg-emerald-500"
                                      : meta.healthStatus === "degraded"
                                        ? "bg-yellow-500"
                                        : meta.healthStatus === "offline"
                                          ? "bg-red-400"
                                          : "bg-muted-foreground/40"
                                  )}
                                />
                              </Link>
                            );
                          })}
                          {sidebarPinnedContainerIds.map((cid) => {
                            const meta = pinnedContainerMeta[cid];
                            if (
                              !meta?.nodeSlug ||
                              !canViewContainerDetails(meta.nodeId, meta.scopeResourceId)
                            )
                              return null;
                            const isDeployment = meta.kind === "deployment";
                            const containerPath = isDeployment
                              ? dockerDeploymentRoute(meta.nodeSlug, meta.name)
                              : dockerContainerRoute(meta.nodeSlug, meta.name);
                            const isActive =
                              location.pathname === containerPath ||
                              location.pathname.startsWith(`${containerPath}/`);
                            const Icon = isDeployment ? GitBranch : Box;
                            return (
                              <Link
                                key={cid}
                                to={containerPath}
                                onClick={onNavigate}
                                className={cn(
                                  "flex items-center gap-3 px-3 py-2 text-sm transition-colors whitespace-nowrap overflow-hidden",
                                  isActive
                                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                                )}
                              >
                                <Icon className="h-4 w-4 shrink-0" />
                                <span className="truncate">{meta.name}</span>
                                <span
                                  className={cn(
                                    "ml-auto h-2 w-2 rounded-full shrink-0",
                                    meta.state === "running"
                                      ? "bg-emerald-500"
                                      : meta.state === "exited" || meta.state === "dead"
                                        ? "bg-red-400"
                                        : meta.state === "stopping" ||
                                            meta.state === "restarting" ||
                                            meta.state === "recreating" ||
                                            meta.state === "killing" ||
                                            meta.state === "updating" ||
                                            meta.state === "migrating"
                                          ? "bg-amber-400 animate-pulse"
                                          : "bg-muted-foreground/40"
                                  )}
                                />
                              </Link>
                            );
                          })}
                        </nav>
                        <Separator />
                      </>
                    )}
                  <nav className="space-y-0.5 px-2 py-2">
                    {groupIndex > 0 && (
                      <p className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {group.label}
                      </p>
                    )}
                    {group.items.map((item) => {
                      const isActive = isSidebarNavigationActive(location.pathname, item.href);
                      return (
                        <Link
                          key={item.href}
                          to={item.href}
                          onClick={onNavigate}
                          className={cn(
                            "flex items-center gap-3 px-3 py-2 text-sm transition-colors whitespace-nowrap overflow-hidden",
                            isActive
                              ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                              : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                          )}
                        >
                          <item.icon className="h-4 w-4 shrink-0" />
                          <span className="truncate">{item.name}</span>
                        </Link>
                      );
                    })}
                  </nav>
                </div>
              ))}
            </ScrollArea>

            <Separator />

            {canUseAI && showAILiteModeCTA && (
              <>
                <div className="px-2 py-2">
                  <button
                    type="button"
                    onClick={handleTryLiteMode}
                    className="flex w-full items-center gap-2 bg-sidebar-accent px-3 py-2 text-left text-sm font-medium text-sidebar-accent-foreground/80 transition-colors hover:bg-muted hover:text-sidebar-accent-foreground"
                  >
                    <Expand className="h-4 w-4 shrink-0" />
                    <span className="truncate">Switch to lite mode</span>
                  </button>
                </div>
                <Separator />
              </>
            )}

            {/* Update notification */}
            {updateAvailable && hasScope("admin:update") && showUpdateNotifications && (
              <>
                <div className="px-2 py-2">
                  <Link
                    to="/settings/gateway"
                    onClick={onNavigate}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium transition-colors"
                    style={{ backgroundColor: "rgb(234 179 8)", color: "#111" }}
                  >
                    <ArrowUpCircle className="h-4 w-4 shrink-0" />
                    <span className="truncate">Update available</span>
                  </Link>
                </div>
                <Separator />
              </>
            )}

            {/* Account at bottom */}
            <div className="p-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    className="flex h-auto w-full items-center justify-start gap-2 px-1 py-1.5"
                  >
                    <Avatar className="h-7 w-7 shrink-0">
                      <AvatarImage src={user?.avatarUrl ?? undefined} />
                      <AvatarFallback className="text-xs">
                        {getInitials(user?.name ?? null)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="truncate text-sm font-medium">{user?.name || "User"}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="w-64">
                  <AccountMenuContent onLogout={handleLogout} onNavigate={onNavigate} />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
