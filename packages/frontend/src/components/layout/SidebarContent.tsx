import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpCircle, Expand, PanelLeft, PanelLeftClose, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useInferenceSelfUsage } from "@/hooks/use-inference-self-usage";
import { useRealtime } from "@/hooks/use-realtime";
import { visibleNavigationGroups } from "@/lib/app-navigation";
import { hasLowInferenceUsage } from "@/lib/inference-self-usage";
import { isSidebarNavigationActive } from "@/lib/sidebar-navigation";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { useDockerStore } from "@/stores/docker";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import { usePinnedDatabasesStore } from "@/stores/pinned-databases";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { usePinnedProxiesStore } from "@/stores/pinned-proxies";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import { useUpdateStore } from "@/stores/update";
import { AI_SCOPE } from "@/types";
import { SidebarPinnedResources } from "./SidebarPinnedResources";

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
  const showSystemCertificatePreference = useUIStore((s) => s.showSystemCertificates);
  const showSystemCertificates =
    hasScope("admin:details:certificates") && showSystemCertificatePreference;
  const showAILiteModeCTA = useUIStore((s) => s.showAILiteModeCTA);
  const sidebarPinnedIds = usePinnedNodesStore((s) => s.sidebarNodeIds);
  const [statusPageEnabled, setStatusPageEnabled] = useState(false);
  const pkiEnabled = useSystemConfigStore((s) => s.config.features.pkiEnabled);
  const loggingEnabled = useSystemConfigStore((s) => s.config.features.loggingEnabled);
  const inferenceEnabled = useSystemConfigStore((s) => s.config.features.inferenceEnabled);
  const canViewInferenceUsage = inferenceEnabled && hasScope("inference:use");
  const { usage: inferenceUsage } = useInferenceSelfUsage(canViewInferenceUsage);

  const sidebarPinnedProxyIds = usePinnedProxiesStore((s) => s.sidebarProxyIds);

  const sidebarPinnedContainerIds = usePinnedContainersStore((s) => s.sidebarContainerIds);
  const pinnedContainerMeta = usePinnedContainersStore((s) => s.containerMeta);
  const dockerNodes = useDockerStore((s) => s.dockerNodes);
  const sidebarPinnedDatabaseIds = usePinnedDatabasesStore((s) => s.sidebarDatabaseIds);
  const dashboardPinnedNodeIds = usePinnedNodesStore((s) => s.dashboardNodeIds);
  const dashboardPinnedProxyIds = usePinnedProxiesStore((s) => s.dashboardProxyIds);
  const dashboardPinnedContainerIds = usePinnedContainersStore((s) => s.dashboardContainerIds);
  const dashboardPinnedDatabaseIds = usePinnedDatabasesStore((s) => s.dashboardDatabaseIds);
  const dashboardBootstrap = useDashboardBootstrapStore((s) => s.snapshot);
  const loadDashboardBootstrap = useDashboardBootstrapStore((s) => s.load);
  const dashboardBootstrapKey = useMemo(
    () =>
      JSON.stringify({
        userId: user?.id ?? null,
        scopes: [...(user?.scopes ?? [])].sort(),
        showSystemCertificates,
        showUpdateNotifications,
        dashboard: {
          nodeIds: dashboardPinnedNodeIds,
          proxyHostIds: dashboardPinnedProxyIds,
          databaseIds: dashboardPinnedDatabaseIds,
          dockerIds: dashboardPinnedContainerIds,
        },
        sidebar: {
          nodeIds: sidebarPinnedIds,
          proxyHostIds: sidebarPinnedProxyIds,
          databaseIds: sidebarPinnedDatabaseIds,
          dockerIds: sidebarPinnedContainerIds,
        },
      }),
    [
      dashboardPinnedContainerIds,
      dashboardPinnedDatabaseIds,
      dashboardPinnedNodeIds,
      dashboardPinnedProxyIds,
      showSystemCertificates,
      showUpdateNotifications,
      sidebarPinnedDatabaseIds,
      sidebarPinnedIds,
      sidebarPinnedProxyIds,
      sidebarPinnedContainerIds,
      user?.id,
      user?.scopes,
    ]
  );

  useEffect(() => {
    if (!user?.id) return;
    void loadDashboardBootstrap(dashboardBootstrapKey, {
      showSystemCertificates,
      showUpdateNotifications,
      pins: {
        dashboard: {
          nodeIds: dashboardPinnedNodeIds,
          proxyHostIds: dashboardPinnedProxyIds,
          databaseIds: dashboardPinnedDatabaseIds,
          dockerResources: dashboardPinnedContainerIds
            .map((id) => {
              const meta = pinnedContainerMeta[id];
              return meta
                ? {
                    id,
                    nodeId: meta.nodeId,
                    kind: meta.kind ?? "container",
                    scopeResourceId: meta.scopeResourceId,
                  }
                : null;
            })
            .filter((value): value is NonNullable<typeof value> => value !== null),
        },
        sidebar: {
          nodeIds: sidebarPinnedIds,
          proxyHostIds: sidebarPinnedProxyIds,
          databaseIds: sidebarPinnedDatabaseIds,
          dockerResources: sidebarPinnedContainerIds
            .map((id) => {
              const meta = pinnedContainerMeta[id];
              return meta
                ? {
                    id,
                    nodeId: meta.nodeId,
                    kind: meta.kind ?? "container",
                    scopeResourceId: meta.scopeResourceId,
                  }
                : null;
            })
            .filter((value): value is NonNullable<typeof value> => value !== null),
        },
      },
    });
  }, [
    dashboardBootstrapKey,
    dashboardPinnedContainerIds,
    dashboardPinnedDatabaseIds,
    dashboardPinnedNodeIds,
    dashboardPinnedProxyIds,
    loadDashboardBootstrap,
    pinnedContainerMeta,
    showSystemCertificates,
    showUpdateNotifications,
    sidebarPinnedDatabaseIds,
    sidebarPinnedIds,
    sidebarPinnedProxyIds,
    sidebarPinnedContainerIds,
    user?.id,
  ]);

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
    hasLowInferenceUsage: hasLowInferenceUsage(inferenceUsage),
    statusPageEnabled,
    hasNginxNodes,
    hasDockerNodes: dockerNodes.length > 0,
  });

  const allNavItems = effectiveGroups.flatMap((g) => g.items);
  const dashboardAttention = dashboardBootstrap?.attention.severity ?? null;

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
                    <span className="relative flex">
                      <item.icon className="h-4 w-4" />
                      {item.id === "dashboard" && dashboardAttention && (
                        <span
                          aria-label={
                            dashboardAttention === "warning"
                              ? "Dashboard requires attention"
                              : "Dashboard has setup information"
                          }
                          className={cn(
                            "absolute -right-2 -top-2 h-2 w-2",
                            dashboardAttention === "warning"
                              ? "bg-warning"
                              : "bg-[color:var(--color-link)]"
                          )}
                        />
                      )}
                    </span>
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
                    className="h-8 w-8 bg-warning text-black hover:bg-warning/90"
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
                  {groupIndex === 1 && <SidebarPinnedResources onNavigate={onNavigate} />}
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
                          {item.id === "dashboard" && dashboardAttention && (
                            <span
                              aria-label={
                                dashboardAttention === "warning"
                                  ? "Dashboard requires attention"
                                  : "Dashboard has setup information"
                              }
                              className={cn(
                                "ml-auto h-2 w-2 shrink-0",
                                dashboardAttention === "warning"
                                  ? "bg-warning"
                                  : "bg-[color:var(--color-link)]"
                              )}
                            />
                          )}
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
                    className="flex w-full items-center gap-2 bg-warning px-3 py-2 text-left text-sm font-medium text-black transition-colors hover:bg-warning/90"
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
