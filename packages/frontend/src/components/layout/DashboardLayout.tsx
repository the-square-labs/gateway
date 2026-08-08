import { Menu } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { AIButton } from "@/components/ai/AIButton";
import { AILitePanel } from "@/components/ai/AILitePanel";
import { AILiteSidebar } from "@/components/ai/AILiteSidebar";
import { AISidePanel } from "@/components/ai/AISidePanel";
import { CommandPalette } from "@/components/common/CommandPalette";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { PageTransition } from "@/components/common/PageTransition";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { keyboardNavigationRoutes, visibleNavigationGroups } from "@/lib/app-navigation";
import { hasLowInferenceUsage } from "@/lib/inference-self-usage";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { useDockerStore } from "@/stores/docker";
import { useResolvedPageContext } from "@/stores/resolved-page-context";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import { useUpdateStore } from "@/stores/update";
import { AI_SCOPE } from "@/types";
import { SidebarContent } from "./SidebarContent";

const SIDEBAR_WIDTH_KEY = "gateway-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 260;

/**
 * Authentication has already determined the user before this renders. Keep a
 * stable application frame while the permission-filtered shell projection is
 * warming instead of replacing the entire UI with a spinner.
 */
function ApplicationShellSkeleton({
  scopes,
  pathname,
}: {
  scopes: readonly string[];
  pathname: string;
}) {
  const navigationGroups = visibleNavigationGroups({
    scopes,
    // Feature values are not available until the typed shell resolves. These
    // are deliberately optimistic only for skeleton geometry; actual links
    // still render solely from the server-provided feature projection.
    pkiEnabled: true,
    siemEnabled: true,
    loggingEnabled: true,
    inferenceEnabled: true,
    statusPageEnabled: true,
    hasNginxNodes: true,
    hasCloudflareIntegration: true,
    hasDockerNodes: true,
  });
  const isSettings = pathname.startsWith("/settings");
  const isProfile = pathname.startsWith("/profile");
  const isDetail = /\/(?:nodes|proxy-hosts|certificates|cas|databases|docker)\/[^/]+/.test(
    pathname
  );

  return (
    <div
      className="flex h-screen overflow-hidden bg-background"
      aria-busy="true"
      aria-label="Loading application"
    >
      <aside className="hidden h-full w-[260px] shrink-0 border-r border-sidebar-border bg-sidebar-background md:block">
        <div className="border-b border-sidebar-border px-4 py-5">
          <Skeleton className="h-6 w-32" />
        </div>
        <div className="space-y-3 px-3 py-4">
          {navigationGroups.map((group) => (
            <div key={group.id} className="space-y-1">
              <Skeleton className="mx-2 h-3 w-16" />
              {group.items.map((item, index) => (
                <div key={item.id} className="flex items-center gap-3 px-2 py-2">
                  <Skeleton className="h-4 w-4 shrink-0" />
                  <Skeleton className={index === 0 ? "h-4 w-24" : "h-4 w-32"} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden p-6">
        <div className="mb-4 flex h-8 items-center md:hidden">
          <Skeleton className="h-10 w-10" />
          <Skeleton className="ml-3 h-5 w-28" />
        </div>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-3 h-4 w-72" />
        {isSettings || isProfile ? (
          <>
            <div className="mt-6 flex gap-2 border-b border-border pb-3">
              {Array.from({ length: isSettings ? 4 : 3 }, (_, index) => (
                <Skeleton key={index} className="h-8 w-28" />
              ))}
            </div>
            <div className="mt-4 space-y-4">
              {Array.from({ length: 2 }, (_, index) => (
                <div key={index} className="min-h-40 border border-border bg-card p-5">
                  <Skeleton className="h-5 w-36" />
                  <Skeleton className="mt-3 h-4 w-64" />
                  <div className="mt-6 space-y-3">
                    {[0, 1, 2].map((row) => (
                      <Skeleton key={row} className="h-9 w-full" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : isDetail ? (
          <>
            <div className="mt-6 flex gap-2 border-b border-border pb-3">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-8 w-24" />
              ))}
            </div>
            <div className="mt-4 min-h-72 border border-border bg-card p-5">
              <Skeleton className="h-5 w-40" />
              <div className="mt-6 space-y-4">
                {[0, 1, 2, 3].map((row) => (
                  <Skeleton key={row} className="h-12 w-full" />
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="min-h-32 border border-border bg-card p-5">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="mt-5 h-8 w-16" />
                  <Skeleton className="mt-4 h-3 w-28" />
                </div>
              ))}
            </div>
            <div className="mt-6 grid gap-6 xl:grid-cols-2">
              {Array.from({ length: 2 }, (_, index) => (
                <div key={index} className="min-h-64 border border-border bg-card p-5">
                  <Skeleton className="h-5 w-32" />
                  <div className="mt-6 space-y-4">
                    {[0, 1, 2].map((row) => (
                      <Skeleton key={row} className="h-12 w-full" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function readSidebarWidth(): number {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored) {
      const parsed = Number(stored);
      if (parsed >= 200 && parsed <= 480) return parsed;
    }
  } catch {
    // ignore
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

export function DashboardLayout() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading, setUser, setLoading, logout } = useAuthStore();
  const currentUser = useAuthStore((state) => state.user);
  const {
    isMobile,
    setIsMobile,
    mobileMenuOpen,
    setMobileMenuOpen,
    commandPaletteOpen,
    setCommandPaletteOpen,
    aiLiteMode,
  } = useUIStore();
  const aiEnabled = useAIStore((state) => state.isEnabled);
  const dashboardInferenceUsage = useDashboardBootstrapStore(
    (state) => state.snapshot?.inferenceUsage ?? null
  );
  const dashboardHasLowInferenceUsage = hasLowInferenceUsage(dashboardInferenceUsage);

  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [isResizing, setIsResizing] = useState(false);
  const setSystemConfig = useSystemConfigStore((state) => state.setConfig);
  const systemConfigLoaded = useSystemConfigStore((state) => state.loaded);
  const [systemConfigReady, setSystemConfigReady] = useState(systemConfigLoaded);
  const uiBootstrap = useUIBootstrapStore((state) => state.snapshot);
  const loadUIBootstrap = useUIBootstrapStore((state) => state.load);
  const invalidateUIBootstrap = useUIBootstrapStore((state) => state.invalidate);
  const clearUIBootstrap = useUIBootstrapStore((state) => state.clear);
  const hasNginxNodes = uiBootstrap?.navigation.hasNginxNodes ?? true;

  useEffect(() => {
    if (systemConfigLoaded) setSystemConfigReady(true);
  }, [systemConfigLoaded]);

  // Project each refreshed shell atomically into the existing feature stores.
  // The layout must subscribe to the store as well as await the first load so
  // realtime invalidations update navigation without a full page reload.
  useEffect(() => {
    if (!uiBootstrap) return;
    setSystemConfig(uiBootstrap.systemConfig);
    useDockerStore.getState().setDockerNodes(uiBootstrap.navigation.dockerNodes);
    if (uiBootstrap.update) useUpdateStore.setState({ status: uiBootstrap.update });
    if (uiBootstrap.aiStatus) useAIStore.getState().setProviderStatus(uiBootstrap.aiStatus);
    setSystemConfigReady(true);
  }, [setSystemConfig, uiBootstrap]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const refresh = () => {
      if (document.visibilityState !== "hidden") invalidateUIBootstrap();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [invalidateUIBootstrap, isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) return;
    clearUIBootstrap();
  }, [clearUIBootstrap, isAuthenticated]);

  const handleSidebarResize = useCallback((width: number) => {
    setSidebarWidth(width);
  }, []);

  const handleResizeStart = useCallback(() => {
    setIsResizing(true);
  }, []);

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
    setSidebarWidth((w) => {
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
      } catch {
        // ignore
      }
      return w;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    const checkAuth = async () => {
      try {
        const existingUser = currentUser ?? useAuthStore.getState().user;
        const user = existingUser ?? (await api.getCurrentUser());
        if (cancelled) return;
        if (user.isBlocked) {
          setUser(user);
          setLoading(false);
          navigate("/blocked");
          return;
        }
        if (!existingUser) setUser(user);
        // Scopes are now known. The shell can render permission-safe skeleton
        // geometry while its read model fills in, rather than retaining the
        // anonymous loading state for a database/cache request.
        setLoading(false);
        const shell = await loadUIBootstrap(`${user.id}:${[...user.scopes].sort().join("|")}`);
        if (cancelled) return;
        if (!shell) {
          // A failed optional shell refresh must not strand an authenticated
          // user on a permanent skeleton. Default config is conservative and
          // the next focus/realtime invalidation retries the projection.
          setSystemConfigReady(true);
        }
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) {
          logout();
          navigate("/login");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void checkAuth();
    return () => {
      cancelled = true;
    };
  }, [currentUser, loadUIBootstrap, logout, navigate, setLoading, setUser]);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, [setIsMobile]);

  // Track recent pages for command palette
  const location = useLocation();
  const resolvedPageStatus = useResolvedPageContext((s) => s.status);
  const resolvedPageRouteKey = useResolvedPageContext((s) => s.routeKey);
  const resolvedPageResource = useResolvedPageContext((s) => s.resource);
  useEffect(() => {
    const path = location.pathname;
    if (path === "/" || path === "/login" || path === "/callback" || path === "/blocked") return;

    const resolvedDetailPath =
      /^\/(?:nodes|databases|proxy-hosts)\/[^/]+/.test(path) ||
      /^\/logging\/(?:environments|schemas)\/[^/]+/.test(path) ||
      /^\/docker\/(?:containers|deployments|volumes)\/[^/]+\/[^/]+/.test(path);
    if (resolvedDetailPath) {
      const ownsRoute =
        resolvedPageStatus === "ready" &&
        resolvedPageRouteKey &&
        (path === resolvedPageRouteKey || path.startsWith(`${resolvedPageRouteKey}/`));
      if (!ownsRoute || !resolvedPageResource) return;

      const segments = path.split("/");
      const decode = (value: string | undefined) => {
        if (!value) return "";
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      };
      const tab = resolvedPageResource.resourceType.startsWith("docker-")
        ? decode(segments[5])
        : resolvedPageResource.resourceType.startsWith("logging-")
          ? decode(segments[4])
          : decode(segments[3]);
      const identity = resolvedPageResource.resourceType.startsWith("docker-")
        ? decode(segments[4])
        : resolvedPageResource.resourceType.startsWith("logging-")
          ? decode(segments[3])
          : decode(segments[2]);
      const prefix =
        resolvedPageResource.resourceType === "node"
          ? "Node"
          : resolvedPageResource.resourceType === "database"
            ? "Database"
            : resolvedPageResource.resourceType === "proxy-host"
              ? "Proxy"
              : resolvedPageResource.resourceType === "logging-environment"
                ? "Log environment"
                : resolvedPageResource.resourceType === "logging-schema"
                  ? "Log schema"
                  : resolvedPageResource.resourceType === "docker-container"
                    ? "Container"
                    : resolvedPageResource.resourceType === "docker-deployment"
                      ? "Deployment"
                      : "Volume";
      const formattedTab = tab
        ? ` / ${tab.charAt(0).toUpperCase() + tab.slice(1).replace(/-/g, " ")}`
        : "";
      const resourceKey = [
        resolvedPageResource.resourceType,
        resolvedPageResource.nodeId,
        resolvedPageResource.resourceId,
      ]
        .filter(Boolean)
        .join(":");
      useUIStore
        .getState()
        .addRecentPage(
          path,
          `${prefix}: ${resolvedPageResource.label || identity}${formattedTab}`,
          undefined,
          resourceKey
        );
      return;
    }

    // Build a human-readable label for ID-based and section routes.
    const label = (() => {
      // CA detail: /cas/:id
      const caMatch = path.match(/^\/cas\/([0-9a-f-]{36})/);
      if (caMatch) {
        const ca = useCAStore.getState().cas?.find((c) => c.id === caMatch[1]);
        return ca ? `CA: ${ca.commonName}` : `CA: ${caMatch[1].slice(0, 8)}`;
      }
      // Nginx template detail: /nginx-templates/:id
      const templateMatch = path.match(/^\/nginx-templates\/([0-9a-f-]{36})/);
      if (templateMatch) {
        api
          .getNginxTemplate(templateMatch[1])
          .then((template) => {
            const resolvedLabel = `Template: ${template.name}`;
            useUIStore.getState().addRecentPage(path, resolvedLabel);
          })
          .catch(() => {});
        return `Template: ${templateMatch[1].slice(0, 8)}`;
      }
      // Generic: prettify path segments
      const segments = path.split("/").filter(Boolean);
      return segments
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(" / ")
        .replace(/-/g, " ");
    })();

    useUIStore.getState().addRecentPage(path, label);
  }, [location.pathname, resolvedPageResource, resolvedPageRouteKey, resolvedPageStatus]);

  // Keyboard shortcuts
  useEffect(() => {
    // Double-Shift detection
    let lastShiftUp = 0;
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const now = Date.now();
        if (now - lastShiftUp < 280) {
          lastShiftUp = 0;
          setCommandPaletteOpen(true);
        } else {
          lastShiftUp = now;
        }
      }
    };
    window.addEventListener("keyup", handleKeyUp);

    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      }
      if (mod && e.key === "j") {
        e.preventDefault();
        useUIStore.getState().toggleSidebar();
      }
      if (mod && e.key === "i") {
        e.preventDefault();
        const { hasScope: checkScope } = useAuthStore.getState();
        const aiEnabled = useAIStore.getState().isEnabled;
        if (checkScope(AI_SCOPE) && aiEnabled !== false) {
          const ui = useUIStore.getState();
          if (ui.aiLiteMode) {
            ui.setAILiteMode(false);
          } else {
            ui.toggleAIPanel();
          }
        }
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        navigate("/settings");
      }
      // Ctrl+H = new proxy host, Ctrl+S = new SSL cert, Ctrl+R = new root CA
      if (e.ctrlKey && !e.metaKey && !e.altKey) {
        const features = useSystemConfigStore.getState().config.features;
        switch (e.key) {
          case "h":
            e.preventDefault();
            navigate("/proxy-hosts/new");
            break;
          case "s":
            e.preventDefault();
            navigate("/ssl-certificates");
            useUIStore.getState().openModal("createSSLCert");
            break;
          case "r":
            e.preventDefault();
            if (!features.pkiEnabled) break;
            navigate("/cas");
            useUIStore.getState().openModal("createCA");
            break;
        }
      }
      // Cmd+number navigation
      if (mod && !e.altKey && !e.shiftKey) {
        const features = useSystemConfigStore.getState().config.features;
        const auth = useAuthStore.getState();
        const routes = keyboardNavigationRoutes({
          scopes: auth.user?.scopes ?? [],
          pkiEnabled: features.pkiEnabled,
          siemEnabled: features.siemEnabled,
          loggingEnabled: features.loggingEnabled,
          inferenceEnabled: features.inferenceEnabled,
          hasLowInferenceUsage: dashboardHasLowInferenceUsage,
          hasDockerNodes:
            useDockerStore.getState().dockerNodes.length > 0 ||
            [
              "docker:containers:view",
              "docker:images:view",
              "docker:volumes:view",
              "docker:networks:view",
            ].some((scope) => useAuthStore.getState().hasScopedAccess(scope)),
        });
        if (e.key in routes) {
          e.preventDefault();
          navigate(routes[e.key]);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [commandPaletteOpen, dashboardHasLowInferenceUsage, setCommandPaletteOpen, navigate]);

  if (isLoading || !systemConfigReady) {
    return (
      <ApplicationShellSkeleton scopes={currentUser?.scopes ?? []} pathname={location.pathname} />
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  if (isMobile) {
    return (
      <TooltipProvider>
        <div className="flex h-screen flex-col bg-background">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-2">
            <div className="flex items-center">
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10"
                onClick={() => setMobileMenuOpen(true)}
              >
                <Menu className="h-5 w-5" />
              </Button>
              <span className="ml-2 flex items-center gap-1.5 text-sm font-semibold">
                <img src="/android-chrome-192x192.png" alt="Gateway" className="h-5 w-5" />
                Gateway
              </span>
              {useAuthStore.getState().hasScope(AI_SCOPE) && (
                <div className="ml-2">
                  <AIButton />
                </div>
              )}
            </div>
          </header>

          <div className="flex-1 overflow-hidden">
            <Outlet />
          </div>

          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetContent side="left" className="w-full p-0" hideCloseButton>
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <SidebarContent
                onNavigate={() => setMobileMenuOpen(false)}
                alwaysExpanded
                hasNginxNodes={hasNginxNodes}
              />
            </SheetContent>
          </Sheet>

          <AISidePanel isMobile />
          <Toaster position="bottom-center" />
          <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
          <ConfirmDialog />
        </div>
      </TooltipProvider>
    );
  }

  const canUseAI = !!currentUser?.scopes?.includes(AI_SCOPE) && aiEnabled !== false;
  const useLiteMode = aiLiteMode && canUseAI;

  if (useLiteMode) {
    const isAIHome = location.pathname === "/";

    return (
      <TooltipProvider>
        <div className="flex h-screen bg-background dashboard-scrollbar">
          <AILiteSidebar
            sidebarWidth={sidebarWidth}
            onSidebarWidthChange={handleSidebarResize}
            isResizing={isResizing}
            onResizeStart={handleResizeStart}
            onResizeEnd={handleResizeEnd}
          />
          <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            {isAIHome ? (
              <PageTransition>
                <AILitePanel />
              </PageTransition>
            ) : (
              <Outlet />
            )}
          </main>
          <Toaster position="bottom-right" />
          <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
          <ConfirmDialog />
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-screen min-w-0 overflow-hidden bg-background dashboard-scrollbar">
        <SidebarContent
          sidebarWidth={sidebarWidth}
          onSidebarWidthChange={handleSidebarResize}
          isResizing={isResizing}
          onResizeStart={handleResizeStart}
          onResizeEnd={handleResizeEnd}
          hasNginxNodes={hasNginxNodes}
        />
        <main className="h-full flex-1 overflow-hidden">
          <Outlet />
        </main>
        <AISidePanel />
        <Toaster position="bottom-right" />
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
        <ConfirmDialog />
      </div>
    </TooltipProvider>
  );
}
