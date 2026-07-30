import { Loader2, Menu } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DOCKER_VIEW_NODE_SCOPES, loadVisibleDockerNodes } from "@/lib/docker-node-access";
import { hasScopeBase, scopeMatches } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import { useDockerStore } from "@/stores/docker";
import { useResolvedPageContext } from "@/stores/resolved-page-context";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import { useUpdateStore } from "@/stores/update";
import { AI_SCOPE, isNodeIncompatible, type User } from "@/types";
import { SidebarContent } from "./SidebarContent";

const SIDEBAR_WIDTH_KEY = "gateway-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 260;
let dashboardBootstrapKey: string | null = null;
let dashboardBootstrapPromise: Promise<{ hasNginxNodes: boolean }> | null = null;
let dashboardBootstrapResult: { hasNginxNodes: boolean } | null = null;

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

  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [hasNginxNodes, setHasNginxNodes] = useState(true); // default true to avoid flash
  const bootstrapCancelledRef = useRef(false);
  const loadSystemConfig = useSystemConfigStore((state) => state.load);
  const systemConfigLoaded = useSystemConfigStore((state) => state.loaded);
  const [systemConfigReady, setSystemConfigReady] = useState(systemConfigLoaded);

  useEffect(() => {
    if (systemConfigLoaded) setSystemConfigReady(true);
  }, [systemConfigLoaded]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const refresh = () => {
      if (document.visibilityState !== "hidden") void loadSystemConfig().catch(() => {});
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [isAuthenticated, loadSystemConfig]);

  useEffect(() => {
    if (isAuthenticated) return;
    dashboardBootstrapKey = null;
    dashboardBootstrapPromise = null;
    dashboardBootstrapResult = null;
  }, [isAuthenticated]);

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
    bootstrapCancelledRef.current = false;

    const runGlobalBootstrap = (user: User) => {
      const bootstrapKey = `${user.id}:${user.scopes.join("|")}`;
      if (dashboardBootstrapKey === bootstrapKey && dashboardBootstrapResult) {
        setHasNginxNodes(dashboardBootstrapResult.hasNginxNodes);
        return;
      }
      if (dashboardBootstrapKey === bootstrapKey && dashboardBootstrapPromise) {
        dashboardBootstrapPromise
          .then((result) => {
            if (!bootstrapCancelledRef.current) setHasNginxNodes(result.hasNginxNodes);
          })
          .catch(() => {});
        return;
      }

      dashboardBootstrapKey = bootstrapKey;
      dashboardBootstrapResult = null;

      dashboardBootstrapPromise = (async () => {
        let hasNginxNodes = true;
        const canListAllNodes =
          scopeMatches(user.scopes, "nodes:details") ||
          user.scopes.includes("nodes:folders:manage");
        const canListScopedNodes = hasScopeBase(user.scopes, "nodes:details");
        const canListDockerNodes = [
          "docker:containers:view",
          "docker:images:view",
          "docker:volumes:view",
          "docker:networks:view",
        ].some((scope) => hasScopeBase(user.scopes, scope));

        // Preload visible node types for sidebar visibility.
        if (canListAllNodes || canListScopedNodes) {
          try {
            const r = await api.listNodes({ limit: 100 });
            const nginxNds = r.data.filter((n) => n.type === "nginx" && !isNodeIncompatible(n));
            hasNginxNodes = nginxNds.length > 0;
          } catch {
            // Keep the default permissive sidebar state if node preload fails.
          }
        }

        // Docker route access is filtered independently from nodes:details.
        if (canListDockerNodes) {
          try {
            useDockerStore
              .getState()
              .setDockerNodes(
                await loadVisibleDockerNodes(
                  user.scopes,
                  DOCKER_VIEW_NODE_SCOPES,
                  canListAllNodes || canListScopedNodes
                )
              );
          } catch {
            // Docker pages can retry their own scoped node preload.
          }
        }

        await Promise.all([
          user.scopes?.includes("admin:update")
            ? useUpdateStore.getState().fetchStatus()
            : Promise.resolve(),
          user.scopes?.includes(AI_SCOPE)
            ? api
                .getAIStatus()
                .then((status) => useAIStore.getState().setProviderStatus(status))
                .catch(() => {})
            : Promise.resolve(),
        ]);

        return { hasNginxNodes };
      })();

      dashboardBootstrapPromise
        .then((result) => {
          if (dashboardBootstrapKey !== bootstrapKey) return;
          dashboardBootstrapResult = result;
          if (!bootstrapCancelledRef.current) setHasNginxNodes(result.hasNginxNodes);
        })
        .catch(() => {})
        .finally(() => {
          if (dashboardBootstrapKey === bootstrapKey) dashboardBootstrapPromise = null;
        });
    };

    const checkAuth = async () => {
      try {
        const existingUser = currentUser ?? useAuthStore.getState().user;
        const user = existingUser ?? (await api.getCurrentUser());
        if (bootstrapCancelledRef.current) return;
        if (user.isBlocked) {
          setUser(user);
          setLoading(false);
          navigate("/blocked");
          return;
        }
        if (!useSystemConfigStore.getState().loaded) {
          try {
            await loadSystemConfig();
          } catch {
            // Continue with feature defaults, but never leave the primary loader stuck.
          }
        }
        if (bootstrapCancelledRef.current) return;
        setSystemConfigReady(true);
        if (!existingUser) setUser(user);
        runGlobalBootstrap(user);
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) {
          dashboardBootstrapKey = null;
          logout();
          navigate("/login");
        }
      } finally {
        if (!bootstrapCancelledRef.current) setLoading(false);
      }
    };

    checkAuth();

    return () => {
      bootstrapCancelledRef.current = true;
    };
  }, [currentUser, loadSystemConfig, logout, navigate, setLoading, setUser]);

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
        const routes: Record<string, string> = {
          "1": "/",
          "2": "/proxy-hosts",
          "3": "/domains",
          "4": "/nginx-templates",
          "5": "/ssl-certificates",
          ...(features.pkiEnabled ? { "6": "/cas", "7": "/certificates" } : {}),
          "8": "/templates",
          "9": "/nodes",
          "0": "/access-lists",
        };
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
  }, [commandPaletteOpen, setCommandPaletteOpen, navigate]);

  if (isLoading || !systemConfigReady) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
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
                className="h-11 w-11"
                onClick={() => setMobileMenuOpen(true)}
              >
                <Menu className="h-5 w-5" />
              </Button>
              <span className="ml-2 flex items-center gap-1.5 text-sm font-semibold">
                <img src="/android-chrome-192x192.png" alt="Gateway" className="h-5 w-5" />
                Gateway
              </span>
              {useAuthStore.getState().hasScope(AI_SCOPE) && <AIButton />}
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
      <div className="flex h-screen bg-background dashboard-scrollbar">
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
