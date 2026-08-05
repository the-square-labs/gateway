import { Box, Database, GitBranch, Globe, Server } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { Separator } from "@/components/ui/separator";
import {
  databaseRoute,
  dockerContainerRoute,
  dockerDeploymentRoute,
  nodeRoute,
  proxyHostRoute,
} from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import { usePinnedDatabasesStore } from "@/stores/pinned-databases";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { usePinnedProxiesStore } from "@/stores/pinned-proxies";
import { useUIStore } from "@/stores/ui";
import { effectiveNodeStatus } from "@/types";

interface SidebarPinnedResourcesProps {
  onNavigate?: () => void;
  /** Lite mode has no SidebarContent to request the shared snapshot. */
  loadBootstrap?: boolean;
}

export function SidebarPinnedResources({
  onNavigate,
  loadBootstrap = false,
}: SidebarPinnedResourcesProps) {
  const location = useLocation();
  const { user, hasScope } = useAuthStore();
  const showUpdateNotifications = useUIStore((s) => s.showUpdateNotifications);
  const showSystemCertificatePreference = useUIStore((s) => s.showSystemCertificates);
  const showSystemCertificates =
    hasScope("admin:details:certificates") && showSystemCertificatePreference;
  const dashboardPinnedNodeIds = usePinnedNodesStore((s) => s.dashboardNodeIds);
  const sidebarPinnedNodeIds = usePinnedNodesStore((s) => s.sidebarNodeIds);
  const dashboardPinnedProxyIds = usePinnedProxiesStore((s) => s.dashboardProxyIds);
  const sidebarPinnedProxyIds = usePinnedProxiesStore((s) => s.sidebarProxyIds);
  const dashboardPinnedDatabaseIds = usePinnedDatabasesStore((s) => s.dashboardDatabaseIds);
  const sidebarPinnedDatabaseIds = usePinnedDatabasesStore((s) => s.sidebarDatabaseIds);
  const pinnedDatabaseMeta = usePinnedDatabasesStore((s) => s.databaseMeta);
  const dashboardPinnedContainerIds = usePinnedContainersStore((s) => s.dashboardContainerIds);
  const sidebarPinnedContainerIds = usePinnedContainersStore((s) => s.sidebarContainerIds);
  const pinnedContainerMeta = usePinnedContainersStore((s) => s.containerMeta);
  const dashboardBootstrap = useDashboardBootstrapStore((s) => s.snapshot);
  const loadDashboardBootstrap = useDashboardBootstrapStore((s) => s.load);
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
  const bootstrapKey = useMemo(
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
          nodeIds: sidebarPinnedNodeIds,
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
      sidebarPinnedContainerIds,
      sidebarPinnedDatabaseIds,
      sidebarPinnedNodeIds,
      sidebarPinnedProxyIds,
      user?.id,
      user?.scopes,
    ]
  );

  useEffect(() => {
    if (!loadBootstrap || !user?.id) return;
    const dockerResources = (ids: string[]) =>
      ids
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
        .filter((value): value is NonNullable<typeof value> => value !== null);
    void loadDashboardBootstrap(bootstrapKey, {
      showSystemCertificates,
      showUpdateNotifications,
      pins: {
        dashboard: {
          nodeIds: dashboardPinnedNodeIds,
          proxyHostIds: dashboardPinnedProxyIds,
          databaseIds: dashboardPinnedDatabaseIds,
          dockerResources: dockerResources(dashboardPinnedContainerIds),
        },
        sidebar: {
          nodeIds: sidebarPinnedNodeIds,
          proxyHostIds: sidebarPinnedProxyIds,
          databaseIds: sidebarPinnedDatabaseIds,
          dockerResources: dockerResources(sidebarPinnedContainerIds),
        },
      },
    });
  }, [
    bootstrapKey,
    dashboardPinnedContainerIds,
    dashboardPinnedDatabaseIds,
    dashboardPinnedNodeIds,
    dashboardPinnedProxyIds,
    loadBootstrap,
    loadDashboardBootstrap,
    pinnedContainerMeta,
    showSystemCertificates,
    showUpdateNotifications,
    sidebarPinnedContainerIds,
    sidebarPinnedDatabaseIds,
    sidebarPinnedNodeIds,
    sidebarPinnedProxyIds,
    user?.id,
  ]);

  useEffect(() => {
    for (const database of dashboardBootstrap?.pinned.sidebar.databases ?? []) {
      usePinnedDatabasesStore.getState().updateMeta(database.id, {
        slug: database.slug,
        name: database.name,
        type: database.type,
        healthStatus: database.healthStatus ?? undefined,
      });
    }
    for (const resource of dashboardBootstrap?.pinned.sidebar.dockerResources ?? []) {
      usePinnedContainersStore.getState().updateMeta(resource.id, resource);
    }
  }, [dashboardBootstrap]);

  const pinnedNodes = dashboardBootstrap?.pinned.sidebar.nodes ?? [];
  const pinnedProxies = dashboardBootstrap?.pinned.sidebar.proxies ?? [];
  const hasPinnedResources =
    pinnedNodes.length > 0 ||
    pinnedProxies.length > 0 ||
    sidebarPinnedDatabaseIds.length > 0 ||
    sidebarPinnedContainerIds.length > 0;

  if (!hasPinnedResources) return null;

  const linkClass = (active: boolean) =>
    cn(
      "flex items-center gap-3 overflow-hidden whitespace-nowrap px-3 py-2 text-sm transition-colors",
      active
        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
        : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    );
  const statusDot = (
    status: string | null | undefined,
    kind: "proxy" | "node" | "database" | "docker"
  ) => {
    const base = "ml-auto h-2 w-2 shrink-0";
    if (kind === "proxy") {
      return cn(
        base,
        status === "online"
          ? "bg-emerald-500"
          : status === "offline" || status === "degraded"
            ? "bg-red-400"
            : "bg-muted-foreground/40"
      );
    }
    if (kind === "node") {
      return cn(
        base,
        status === "online"
          ? "bg-emerald-500"
          : status === "degraded"
            ? "bg-warning"
            : status === "offline" || status === "error"
              ? "bg-red-400"
              : "bg-warning"
      );
    }
    if (kind === "database") {
      return cn(
        base,
        status === "online"
          ? "bg-emerald-500"
          : status === "degraded"
            ? "bg-warning"
            : status === "offline"
              ? "bg-red-400"
              : "bg-muted-foreground/40"
      );
    }
    return cn(
      base,
      status === "running"
        ? "bg-emerald-500"
        : status === "exited" || status === "dead"
          ? "bg-red-400"
          : status === "stopping" ||
              status === "restarting" ||
              status === "recreating" ||
              status === "killing" ||
              status === "updating" ||
              status === "migrating"
            ? "animate-pulse bg-warning"
            : "bg-muted-foreground/40"
    );
  };

  return (
    <>
      <nav className="space-y-0.5 px-2 py-2" aria-label="Pinned resources">
        <p className="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Pinned Items
        </p>
        {pinnedProxies.map((proxy) => {
          const path = proxyHostRoute(proxy.slug);
          const health = (proxy as any).effectiveHealthStatus ?? proxy.healthStatus;
          return (
            <Link
              key={proxy.id}
              to={path}
              onClick={onNavigate}
              className={linkClass(
                location.pathname === path || location.pathname.startsWith(`${path}/`)
              )}
            >
              <Globe className="h-4 w-4 shrink-0" />
              <span className="truncate">{proxy.domainNames[0]}</span>
              <span className={statusDot(health, "proxy")} />
            </Link>
          );
        })}
        {pinnedNodes.map((node) => {
          const path = nodeRoute(node.slug);
          return (
            <Link
              key={node.id}
              to={path}
              onClick={onNavigate}
              className={linkClass(
                location.pathname === path || location.pathname.startsWith(`${path}/`)
              )}
            >
              <Server className="h-4 w-4 shrink-0" />
              <span className="truncate">{node.displayName || node.hostname}</span>
              <span className={statusDot(effectiveNodeStatus(node), "node")} />
            </Link>
          );
        })}
        {sidebarPinnedDatabaseIds.map((databaseId) => {
          const meta = pinnedDatabaseMeta[databaseId];
          if (!meta?.slug || !canViewDatabaseDetails(databaseId)) return null;
          const path = databaseRoute(meta.slug);
          return (
            <Link
              key={databaseId}
              to={databaseRoute(meta.slug, "overview")}
              onClick={onNavigate}
              className={linkClass(
                location.pathname === path || location.pathname.startsWith(`${path}/`)
              )}
            >
              <Database className="h-4 w-4 shrink-0" />
              <span className="truncate">{meta.name}</span>
              <span className={statusDot(meta.healthStatus, "database")} />
            </Link>
          );
        })}
        {sidebarPinnedContainerIds.map((id) => {
          const meta = pinnedContainerMeta[id];
          if (!meta?.nodeSlug || !canViewContainerDetails(meta.nodeId, meta.scopeResourceId))
            return null;
          const deployment = meta.kind === "deployment";
          const path = deployment
            ? dockerDeploymentRoute(meta.nodeSlug, meta.name)
            : dockerContainerRoute(meta.nodeSlug, meta.name);
          const Icon = deployment ? GitBranch : Box;
          return (
            <Link
              key={id}
              to={path}
              onClick={onNavigate}
              className={linkClass(
                location.pathname === path || location.pathname.startsWith(`${path}/`)
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{meta.name}</span>
              <span className={statusDot(meta.state, "docker")} />
            </Link>
          );
        })}
      </nav>
      <Separator />
    </>
  );
}
