import {
  Activity,
  Award,
  Bell,
  Bot,
  Box,
  Clock,
  Database,
  FileText,
  FolderOpen,
  Globe,
  Globe2,
  HardDrive,
  Image,
  KeyRound,
  Layers,
  ListTodo,
  Lock,
  LogOut,
  Monitor,
  Moon,
  MousePointerClick,
  Network,
  PanelLeft,
  Plus,
  ScrollText,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
  Terminal,
  UserRound,
  Users,
  Webhook,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useInferenceQuotaSnapshot } from "@/components/ai/InferenceQuotaStatus";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { type AppNavigationItemId, visibleNavigationGroups } from "@/lib/app-navigation";
import {
  databaseRoute,
  dockerContainerRoute,
  dockerDeploymentRoute,
  dockerVolumeRoute,
  loggingEnvironmentRoute,
  loggingSchemaRoute,
  nodeRoute,
  proxyHostRoute,
} from "@/lib/resource-routes";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useCommandPalettePageActions } from "@/stores/command-palette-page-actions";
import { useResolvedPageContext } from "@/stores/resolved-page-context";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import type { DockerContainer, Node, ResourceSearchResult, ResourceSearchType } from "@/types";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PaletteEntry {
  id: string;
  label: string;
  detail?: string;
  keywords?: readonly string[];
  contexts?: readonly string[];
  icon: React.ElementType;
  iconNode?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  action: () => void;
}

interface DeepLinkDefinition {
  id: string;
  label: string;
  href: string;
  icon: React.ElementType;
  parentId: AppNavigationItemId;
  keywords?: readonly string[];
  visible?: boolean;
}

const RESOURCE_LABELS: Record<ResourceSearchType, string> = {
  node: "Node",
  proxy_host: "Proxy host",
  proxy_template: "Nginx template",
  ssl_certificate: "SSL certificate",
  domain: "Domain",
  access_list: "Access list",
  ca: "Certificate authority",
  pki_certificate: "Certificate",
  pki_template: "Certificate template",
  docker_container: "Container",
  docker_deployment: "Deployment",
  docker_image: "Docker image",
  docker_volume: "Docker volume",
  docker_network: "Docker network",
  docker_registry: "Docker registry",
  database: "Database",
  logging_environment: "Logging environment",
  logging_schema: "Logging schema",
  status_page_service: "Status page service",
  status_page_incident: "Status page incident",
  notification_rule: "Alert rule",
  notification_webhook: "Notification webhook",
};

const RESOURCE_ICONS: Record<ResourceSearchType, React.ElementType> = {
  node: Server,
  proxy_host: Globe,
  proxy_template: Award,
  ssl_certificate: Lock,
  domain: Globe2,
  access_list: ShieldAlert,
  ca: ShieldCheck,
  pki_certificate: FileText,
  pki_template: Award,
  docker_container: Box,
  docker_deployment: Layers,
  docker_image: Image,
  docker_volume: HardDrive,
  docker_network: Network,
  docker_registry: KeyRound,
  database: Database,
  logging_environment: ScrollText,
  logging_schema: FileText,
  status_page_service: Activity,
  status_page_incident: Activity,
  notification_rule: Bell,
  notification_webhook: Webhook,
};

function fuzzyMatch(text: string, query: string): number {
  if (!query) return 1;
  const words = query.split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  let score = 0;
  for (const word of words) {
    const index = lower.indexOf(word);
    if (index === -1) return 0;
    score +=
      index === 0 ||
      lower[index - 1] === " " ||
      lower[index - 1] === "-" ||
      lower[index - 1] === "/"
        ? 2
        : 1;
  }
  return score;
}

function entryScore(entry: PaletteEntry, query: string): number {
  return fuzzyMatch(
    [entry.label, entry.detail, ...(entry.keywords ?? [])].filter(Boolean).join(" "),
    query
  );
}

function summaryString(result: ResourceSearchResult, key: string): string | undefined {
  const value = result.summary[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resourceHref(result: ResourceSearchResult): string {
  switch (result.type) {
    case "node":
      return nodeRoute(summaryString(result, "slug") ?? result.id);
    case "proxy_host":
      return summaryString(result, "slug")
        ? proxyHostRoute(summaryString(result, "slug")!)
        : "/proxy-hosts";
    case "proxy_template":
      return `/nginx-templates/${encodeURIComponent(result.id)}`;
    case "ssl_certificate":
      return "/ssl-certificates";
    case "domain":
      return "/domains";
    case "access_list":
      return "/access-lists";
    case "ca":
      return `/cas/${encodeURIComponent(result.id)}`;
    case "pki_certificate":
      return `/certificates/${encodeURIComponent(result.id)}`;
    case "pki_template":
      return "/templates/pki";
    case "docker_container":
      return result.nodeSlug
        ? dockerContainerRoute(result.nodeSlug, result.name)
        : "/docker/containers";
    case "docker_deployment":
      return result.nodeSlug
        ? dockerDeploymentRoute(result.nodeSlug, result.name)
        : "/docker/deployments";
    case "docker_image":
      return "/docker/images";
    case "docker_volume":
      return result.nodeSlug ? dockerVolumeRoute(result.nodeSlug, result.name) : "/docker/volumes";
    case "docker_network":
      return "/docker/networks";
    case "docker_registry":
      return "/settings/gateway";
    case "database":
      return databaseRoute(summaryString(result, "slug") ?? result.id);
    case "logging_environment":
      return loggingEnvironmentRoute(summaryString(result, "slug") ?? result.id);
    case "logging_schema":
      return loggingSchemaRoute(summaryString(result, "slug") ?? result.id);
    case "status_page_service":
      return "/status-page/services";
    case "status_page_incident":
      return "/status-page/incidents";
    case "notification_rule":
      return "/notifications/alerts";
    case "notification_webhook":
      return "/notifications/webhooks";
  }
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useState("");
  const [nodes, setNodes] = useState<Node[]>([]);
  const [commandContainers, setCommandContainers] = useState<DockerContainer[]>([]);
  const [commandEntitiesPending, setCommandEntitiesPending] = useState(false);
  const [statusPageEnabled, setStatusPageEnabled] = useState(false);
  const [resourceResults, setResourceResults] = useState<ResourceSearchResult[]>([]);
  const [resourceSearchPending, setResourceSearchPending] = useState(false);
  const resourceSearchSequence = useRef(0);

  const { user, hasScope, hasAnyScope, hasScopedAccess, logout } = useAuthStore();
  const { setTheme, theme, toggleSidebar } = useUIStore();
  const pkiEnabled = useSystemConfigStore((state) => state.config.features.pkiEnabled);
  const loggingEnabled = useSystemConfigStore((state) => state.config.features.loggingEnabled);
  const inferenceEnabled = useSystemConfigStore((state) => state.config.features.inferenceEnabled);
  const recentPages = useUIStore((state) => state.recentPages);
  const commandActionUsage = useUIStore((state) => state.commandActionUsage);
  const recordCommandActionUsage = useUIStore((state) => state.recordCommandActionUsage);
  const pageActionRegistrations = useCommandPalettePageActions((state) => state.registrations);
  const resolvedPageStatus = useResolvedPageContext((state) => state.status);
  const resolvedPageRouteKey = useResolvedPageContext((state) => state.routeKey);
  const resolvedPageResource = useResolvedPageContext((state) => state.resource);
  const gatewayInferenceMode = useAIStore(
    (state) => state.providerStatus?.providerType === "gateway_inference"
  );
  const inferenceStreaming = useAIStore((state) => state.isStreaming);
  const aiEnabled = useAIStore((state) => state.isEnabled);
  const canViewInferenceUsage = hasScope("inference:usage:view:self");
  const inferenceQuota = useInferenceQuotaSnapshot(gatewayInferenceMode && canViewInferenceUsage);
  const isCommandMode = search.startsWith(">");
  const commandQuery = isCommandMode ? search.slice(1).trim().toLowerCase() : "";
  const searchQuery = isCommandMode ? "" : search.toLowerCase().trim();
  const aiScopeOk = hasScope("feat:ai:use");
  const routeSection = location.pathname.split("/").filter(Boolean)[0] ?? "dashboard";
  const activePageResource =
    resolvedPageStatus === "ready" &&
    resolvedPageRouteKey &&
    (location.pathname === resolvedPageRouteKey ||
      location.pathname.startsWith(`${resolvedPageRouteKey}/`))
      ? resolvedPageResource
      : null;
  const quickActionContext = activePageResource?.resourceType ?? routeSection;
  const currentPageActions = useMemo<PaletteEntry[]>(
    () =>
      Object.values(pageActionRegistrations)
        .filter(
          ({ routeKey }) =>
            location.pathname === routeKey || location.pathname.startsWith(`${routeKey}/`)
        )
        .flatMap(({ actions }) => actions)
        .filter(
          (action, index, actions) =>
            actions.findIndex((candidate) => candidate.id === action.id) === index
        )
        .map((action) => ({
          ...action,
          icon: MousePointerClick,
          iconNode: action.icon,
        })),
    [location.pathname, pageActionRegistrations]
  );

  useEffect(() => {
    if (!open) return;
    if (
      hasScopedAccess("nodes:details") ||
      hasScopedAccess("nodes:console") ||
      hasScopedAccess("nodes:files:read")
    ) {
      void api
        .listNodes({ limit: 100 })
        .then((response) => setNodes(response.data ?? []))
        .catch(() => setNodes([]));
    }
    if (hasScope("status-page:view")) {
      void api
        .getStatusPageSettings()
        .then((settings) => setStatusPageEnabled(settings.enabled))
        .catch(() => setStatusPageEnabled(false));
    } else {
      setStatusPageEnabled(false);
    }
  }, [hasScope, hasScopedAccess, open]);

  useEffect(() => {
    if (!open || !isCommandMode) return;
    if (!hasScopedAccess("docker:containers:view")) {
      setCommandContainers([]);
      setCommandEntitiesPending(false);
      return;
    }

    let cancelled = false;
    setCommandEntitiesPending(true);
    void api
      .listDockerContainerSnapshots()
      .then((items) => {
        if (!cancelled) setCommandContainers(items);
      })
      .catch(() => {
        if (!cancelled) setCommandContainers([]);
      })
      .finally(() => {
        if (!cancelled) setCommandEntitiesPending(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hasScopedAccess, isCommandMode, open]);

  useEffect(() => {
    if (!open || !gatewayInferenceMode || !canViewInferenceUsage || inferenceStreaming) return;
    void api.getInferenceSelfUsage().catch(() => {
      // The command palette remains usable when quota visibility is temporarily unavailable.
    });
  }, [canViewInferenceUsage, gatewayInferenceMode, inferenceStreaming, open]);

  useEffect(() => {
    const sequence = ++resourceSearchSequence.current;
    if (!open) return;
    if (isCommandMode || searchQuery.length < 2) {
      setResourceResults([]);
      setResourceSearchPending(false);
      return;
    }

    setResourceSearchPending(true);
    const timeout = window.setTimeout(() => {
      void api
        .searchResources(searchQuery, { limit: 20 })
        .then((response) => {
          if (resourceSearchSequence.current === sequence) {
            setResourceResults(response.results);
          }
        })
        .catch(() => {
          if (resourceSearchSequence.current === sequence) setResourceResults([]);
        })
        .finally(() => {
          if (resourceSearchSequence.current === sequence) setResourceSearchPending(false);
        });
    }, 200);

    return () => window.clearTimeout(timeout);
  }, [isCommandMode, open, searchQuery]);

  const handleSelect = (callback: () => void) => {
    callback();
    onOpenChange(false);
  };

  const handleActionSelect = (entry: PaletteEntry) => {
    if (entry.disabled) return;
    if (user?.id) {
      recordCommandActionUsage(user.id, quickActionContext, entry.id);
    }
    handleSelect(entry.action);
  };

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      logout();
    }
    navigate("/login");
  }, [logout, navigate]);

  const askAI = (query: string) => {
    if (inferenceQuota.exhausted) return;
    const systemPrompt = `The user typed "${query}" in the command palette search but found no matching pages, resources, or actions. They are looking for help or information. Please ANSWER their question or explain how to do what they're asking about. Do NOT perform any actions, do NOT create or modify resources — just explain step by step how they can do it themselves through the UI or provide the information they need.`;
    const wrapped = `<system-instruction>${systemPrompt}</system-instruction>\n${query}`;
    useUIStore.getState().setAIPanelOpen(true);
    const store = useAIStore.getState();
    if (store.isConnected) {
      store.sendMessage(wrapped);
    } else {
      void store.connect().then(() => useAIStore.getState().sendMessage(wrapped));
    }
  };

  const navigationGroups = useMemo(
    () =>
      visibleNavigationGroups({
        scopes: user?.scopes ?? [],
        pkiEnabled,
        loggingEnabled,
        inferenceEnabled,
        statusPageEnabled,
      }),
    [inferenceEnabled, loggingEnabled, pkiEnabled, statusPageEnabled, user?.scopes]
  );

  const baseNavigationEntries = useMemo<PaletteEntry[]>(
    () =>
      navigationGroups.flatMap((group) =>
        group.items.map((item) => ({
          id: `navigation:${item.id}`,
          label: item.name,
          icon: item.icon,
          keywords: item.keywords,
          shortcut: item.shortcutKey ? `⌘${item.shortcutKey}` : undefined,
          action: () => navigate(item.href),
        }))
      ),
    [navigate, navigationGroups]
  );

  const deepNavigationEntries = useMemo<PaletteEntry[]>(() => {
    const accessibleParents = new Set(
      navigationGroups.flatMap((group) => group.items.map((item) => item.id))
    );
    const links: DeepLinkDefinition[] = [
      {
        id: "profile-preferences",
        label: "Profile preferences",
        href: "/profile/preferences",
        icon: UserRound,
        parentId: "profile",
        keywords: ["theme", "appearance"],
      },
      {
        id: "profile-authorizations",
        label: "Profile authorizations",
        href: "/profile/authorizations",
        icon: KeyRound,
        parentId: "profile",
        keywords: ["oauth", "tokens", "sessions"],
      },
      {
        id: "templates-nginx",
        label: "Nginx templates",
        href: "/templates/nginx",
        icon: Award,
        parentId: "templates",
        visible: hasScopedAccess("proxy:templates:view"),
      },
      {
        id: "templates-pki",
        label: "Certificate templates",
        href: "/templates/pki",
        icon: Award,
        parentId: "templates",
        visible: pkiEnabled && hasScopedAccess("pki:templates:view"),
      },
      {
        id: "docker-containers",
        label: "Docker containers",
        href: "/docker/containers",
        icon: Box,
        parentId: "docker",
        visible: hasScopedAccess("docker:containers:view"),
      },
      {
        id: "docker-images",
        label: "Docker images",
        href: "/docker/images",
        icon: Image,
        parentId: "docker",
        visible: hasScopedAccess("docker:images:view"),
      },
      {
        id: "docker-volumes",
        label: "Docker volumes",
        href: "/docker/volumes",
        icon: HardDrive,
        parentId: "docker",
        visible: hasScopedAccess("docker:volumes:view"),
      },
      {
        id: "docker-networks",
        label: "Docker networks",
        href: "/docker/networks",
        icon: Network,
        parentId: "docker",
        visible: hasScopedAccess("docker:networks:view"),
      },
      {
        id: "docker-tasks",
        label: "Docker tasks",
        href: "/docker/tasks",
        icon: ListTodo,
        parentId: "docker",
        visible: hasScope("docker:tasks"),
      },
      {
        id: "logging-environments",
        label: "Logging environments",
        href: "/logging/environments",
        icon: ScrollText,
        parentId: "logging",
        visible: loggingEnabled && hasScopedAccess("logs:environments:view"),
      },
      {
        id: "logging-schemas",
        label: "Logging schemas",
        href: "/logging/schemas",
        icon: FileText,
        parentId: "logging",
        visible: loggingEnabled && hasScopedAccess("logs:schemas:view"),
      },
      {
        id: "logging-settings",
        label: "Logging settings",
        href: "/logging/settings",
        icon: Settings,
        parentId: "logging",
        visible: loggingEnabled && hasScope("logs:manage"),
      },
      {
        id: "notifications-alerts",
        label: "Notification alert rules",
        href: "/notifications/alerts",
        icon: Bell,
        parentId: "notifications",
        visible:
          hasAnyScope(
            "notifications:view",
            "notifications:manage",
            "notifications:alerts:view",
            "notifications:alerts:create",
            "notifications:alerts:edit",
            "notifications:alerts:delete"
          ) || hasScopedAccess("notifications:alerts:view"),
      },
      {
        id: "notifications-webhooks",
        label: "Notification webhooks",
        href: "/notifications/webhooks",
        icon: Webhook,
        parentId: "notifications",
        visible:
          hasAnyScope(
            "notifications:view",
            "notifications:manage",
            "notifications:webhooks:view",
            "notifications:webhooks:create",
            "notifications:webhooks:edit",
            "notifications:webhooks:delete"
          ) || hasScopedAccess("notifications:webhooks:view"),
      },
      {
        id: "notifications-deliveries",
        label: "Notification deliveries",
        href: "/notifications/deliveries",
        icon: ScrollText,
        parentId: "notifications",
        visible:
          hasAnyScope("notifications:view", "notifications:manage") ||
          hasScopedAccess("notifications:deliveries:view"),
      },
      {
        id: "status-services",
        label: "Status page services",
        href: "/status-page/services",
        icon: Activity,
        parentId: "status-page",
      },
      {
        id: "status-incidents",
        label: "Status page incidents",
        href: "/status-page/incidents",
        icon: Activity,
        parentId: "status-page",
      },
      {
        id: "status-settings",
        label: "Status page settings",
        href: "/status-page/settings",
        icon: Settings,
        parentId: "status-page",
      },
      {
        id: "administration-users",
        label: "Administration users",
        href: "/administration/users",
        icon: Users,
        parentId: "administration",
        visible: hasScope("admin:users"),
      },
      {
        id: "administration-groups",
        label: "Administration groups",
        href: "/administration/groups",
        icon: Users,
        parentId: "administration",
        visible: hasScope("admin:groups"),
      },
      {
        id: "administration-audit",
        label: "Audit log",
        href: "/administration/audit",
        icon: ScrollText,
        parentId: "administration",
        visible: hasScope("admin:audit"),
      },
      {
        id: "settings-gateway",
        label: "Gateway settings",
        href: "/settings/gateway",
        icon: Settings,
        parentId: "settings",
        visible: hasAnyScope(
          "settings:gateway:view",
          "settings:gateway:edit",
          "docker:registries:view",
          "admin:update",
          "license:view",
          "license:manage"
        ),
      },
      {
        id: "settings-features",
        label: "Feature settings",
        href: "/settings/features",
        icon: Settings,
        parentId: "settings",
        visible: hasAnyScope(
          "status-page:view",
          "housekeeping:view",
          "housekeeping:run",
          "housekeeping:configure"
        ),
      },
      {
        id: "settings-integrations",
        label: "Integration settings",
        href: "/settings/integrations",
        icon: Settings,
        parentId: "settings",
        visible: hasAnyScope(
          "integrations:gitlab:view",
          "integrations:gitlab:manage",
          "integrations:cloudflare:view",
          "integrations:cloudflare:manage",
          "integrations:cloudflare:dns:view",
          "integrations:cloudflare:dns:edit",
          "integrations:cloudflare:dns:delete"
        ),
      },
      {
        id: "settings-inference",
        label: "Inference settings",
        href: "/settings/inference",
        icon: Sparkles,
        parentId: "settings",
        visible:
          inferenceEnabled &&
          hasAnyScope(
            "inference:providers:view",
            "inference:providers:manage",
            "inference:models:manage",
            "inference:limits:manage",
            "inference:usage:view"
          ),
      },
      {
        id: "settings-ai",
        label: "AI assistant settings",
        href: "/settings/ai",
        icon: Bot,
        parentId: "settings",
        visible: hasScope("feat:ai:configure"),
      },
    ];

    return links
      .filter((link) => accessibleParents.has(link.parentId) && link.visible !== false)
      .map((link) => ({
        id: `navigation:${link.id}`,
        label: link.label,
        icon: link.icon,
        keywords: link.keywords,
        action: () => navigate(link.href),
      }));
  }, [
    hasAnyScope,
    hasScope,
    hasScopedAccess,
    inferenceEnabled,
    loggingEnabled,
    navigate,
    navigationGroups,
    pkiEnabled,
  ]);

  const contextActions = useMemo<PaletteEntry[]>(() => {
    const resource = activePageResource;
    const resourceRoute = resolvedPageRouteKey;
    if (!resource || !resourceRoute) return [];

    const actions: PaletteEntry[] = [];
    const nodeId = resource.nodeId;
    if (resource.resourceType === "docker-container" && nodeId) {
      if (
        hasScope("docker:containers:console") ||
        hasScope(`docker:containers:console:${nodeId}`)
      ) {
        actions.push({
          id: "context:container-console",
          label: "Open container console",
          icon: Terminal,
          action: () =>
            window.open(
              `/docker/console/${nodeId}/${resource.resourceId}?shell=auto`,
              `console-${resource.resourceId}`,
              "width=900,height=600"
            ),
        });
      }
      if (hasScope("docker:containers:view") || hasScope(`docker:containers:view:${nodeId}`)) {
        actions.push({
          id: "context:container-logs",
          label: "Open container logs",
          icon: ScrollText,
          action: () =>
            window.open(
              `/docker/logs/${nodeId}/${resource.resourceId}`,
              `logs-${resource.resourceId}`,
              "width=900,height=600"
            ),
        });
      }
      if (hasScope("docker:containers:files") || hasScope(`docker:containers:files:${nodeId}`)) {
        actions.push({
          id: "context:container-files",
          label: "Browse container files",
          icon: FolderOpen,
          action: () => navigate(`${resourceRoute}/files`),
        });
      }
    }

    if (resource.resourceType === "docker-deployment" && nodeId) {
      actions.push({
        id: "context:deployment-logs",
        label: "Open deployment logs",
        icon: ScrollText,
        action: () =>
          window.open(
            `/docker/compose-logs/${nodeId}/${encodeURIComponent(resource.label ?? resource.resourceId)}`,
            `compose-logs-${resource.resourceId}`,
            "width=1000,height=700"
          ),
      });
    }

    if (
      resource.resourceType === "docker-volume" &&
      nodeId &&
      (hasScope("docker:volumes:files:read") || hasScope(`docker:volumes:files:read:${nodeId}`))
    ) {
      actions.push({
        id: "context:volume-files",
        label: "Browse volume files",
        icon: FolderOpen,
        action: () => navigate(`${resourceRoute}/files`),
      });
    }

    if (resource.resourceType === "node") {
      if (hasScope("nodes:console") || hasScope(`nodes:console:${resource.resourceId}`)) {
        actions.push({
          id: "context:node-console",
          label: "Open node console",
          icon: Terminal,
          action: () =>
            window.open(
              `/nodes/console/${resource.resourceId}?shell=auto`,
              `node-console-${resource.resourceId}`,
              "width=900,height=600"
            ),
        });
      }
      if (hasScope("nodes:files:read") || hasScope(`nodes:files:read:${resource.resourceId}`)) {
        actions.push({
          id: "context:node-files",
          label: "Browse node files",
          icon: FolderOpen,
          action: () => navigate(`${resourceRoute}/files`),
        });
      }
    }
    return actions;
  }, [activePageResource, hasScope, navigate, resolvedPageRouteKey]);

  const primaryActions = useMemo<PaletteEntry[]>(() => {
    const actions: PaletteEntry[] = [
      {
        id: "action:toggle-sidebar",
        label: "Toggle sidebar",
        icon: PanelLeft,
        shortcut: "⌘J",
        action: toggleSidebar,
      },
    ];
    if (hasScope("proxy:create")) {
      actions.push({
        id: "action:new-proxy",
        label: "New proxy host",
        contexts: ["proxy-hosts", "proxy-host"],
        icon: Plus,
        shortcut: "⌃H",
        action: () => navigate("/proxy-hosts/new"),
      });
    }
    if (hasScope("ssl:cert:issue")) {
      actions.push({
        id: "action:new-ssl",
        label: "New SSL certificate",
        contexts: ["ssl-certificates", "domains"],
        icon: Plus,
        shortcut: "⌃S",
        action: () => {
          navigate("/ssl-certificates");
          useUIStore.getState().openModal("createSSLCert");
        },
      });
    }
    if (pkiEnabled && hasScope("pki:ca:create:root")) {
      actions.push({
        id: "action:new-root-ca",
        label: "Create root CA",
        contexts: ["cas", "certificates", "templates"],
        icon: Plus,
        shortcut: "⌃R",
        action: () => {
          navigate("/cas");
          useUIStore.getState().openModal("createCA");
        },
      });
    }
    if (aiEnabled !== false && aiScopeOk) {
      actions.push({
        id: "action:open-ai",
        label: "Open AI assistant",
        icon: Sparkles,
        action: () => useUIStore.getState().setAIPanelOpen(true),
      });
    }
    return actions;
  }, [aiEnabled, aiScopeOk, hasScope, navigate, pkiEnabled, toggleSidebar]);

  const adaptiveQuickActions = useMemo(() => {
    const candidates = [...currentPageActions, ...contextActions, ...primaryActions].filter(
      (entry, index, entries) =>
        entries.findIndex((candidate) => candidate.id === entry.id) === index
    );
    const pageContexts = new Set([routeSection, quickActionContext]);

    const usageFor = (actionId: string) => {
      let contextCount = 0;
      let totalCount = 0;
      let lastUsedAt = 0;
      for (const usage of Object.values(commandActionUsage)) {
        if (usage.userId !== user?.id || usage.actionId !== actionId) continue;
        totalCount += usage.count;
        if (pageContexts.has(usage.context)) contextCount += usage.count;
        lastUsedAt = Math.max(lastUsedAt, usage.lastUsedAt);
      }
      return { contextCount, totalCount, lastUsedAt };
    };

    const ranked = candidates
      .map((entry, index) => {
        const usage = usageFor(entry.id);
        return {
          entry,
          index,
          relevant:
            currentPageActions.some((candidate) => candidate.id === entry.id) ||
            contextActions.some((candidate) => candidate.id === entry.id) ||
            entry.contexts?.some((context) => pageContexts.has(context)) === true,
          ...usage,
        };
      })
      .sort(
        (left, right) =>
          Number(right.relevant) - Number(left.relevant) ||
          right.contextCount - left.contextCount ||
          right.totalCount - left.totalCount ||
          right.lastUsedAt - left.lastUsedAt ||
          left.index - right.index
      );
    const contextual = ranked.filter(({ relevant, contextCount }) => relevant || contextCount > 0);
    return (routeSection === "dashboard" && contextual.length === 0 ? ranked : contextual)
      .slice(0, 5)
      .map(({ entry }) => entry);
  }, [
    commandActionUsage,
    contextActions,
    currentPageActions,
    primaryActions,
    quickActionContext,
    routeSection,
    user?.id,
  ]);

  const secondaryActions = useMemo<PaletteEntry[]>(
    () => [
      {
        id: "action:theme-light",
        label: "Light theme",
        detail: theme === "light" ? "Current theme" : undefined,
        icon: Sun,
        action: () => setTheme("light"),
      },
      {
        id: "action:theme-dark",
        label: "Dark theme",
        detail: theme === "dark" ? "Current theme" : undefined,
        icon: Moon,
        action: () => setTheme("dark"),
      },
      {
        id: "action:theme-system",
        label: "System theme",
        detail: theme === "system" ? "Current theme" : undefined,
        icon: Monitor,
        action: () => setTheme("system"),
      },
      {
        id: "action:logout",
        label: "Log out",
        icon: LogOut,
        action: handleLogout,
      },
    ],
    [handleLogout, setTheme, theme]
  );

  const entityCommands = useMemo<PaletteEntry[]>(() => {
    const entries: PaletteEntry[] = [];
    for (const container of commandContainers) {
      const nodeId = container._nodeId;
      if (!nodeId) continue;
      const filesRoute = container._nodeSlug
        ? container.kind === "deployment"
          ? dockerDeploymentRoute(container._nodeSlug, container.name, "files")
          : dockerContainerRoute(container._nodeSlug, container.name, "files")
        : null;
      if (
        hasScope("docker:containers:console") ||
        hasScope(`docker:containers:console:${nodeId}`)
      ) {
        entries.push({
          id: `command:container-console:${nodeId}:${container.id}`,
          label: `Console ${container.name}`,
          detail: `Open a shell in ${container.name}`,
          keywords: ["container terminal"],
          icon: Terminal,
          action: () =>
            window.open(
              `/docker/console/${nodeId}/${container.id}?shell=auto`,
              `console-${container.id}`,
              "width=900,height=600"
            ),
        });
      }
      if (hasScope("docker:containers:view") || hasScope(`docker:containers:view:${nodeId}`)) {
        entries.push({
          id: `command:container-logs:${nodeId}:${container.id}`,
          label: `Logs ${container.name}`,
          detail: `Open logs for ${container.name}`,
          keywords: ["container"],
          icon: ScrollText,
          action: () =>
            window.open(
              `/docker/logs/${nodeId}/${container.id}`,
              `logs-${container.id}`,
              "width=900,height=600"
            ),
        });
      }
      if (
        filesRoute &&
        (hasScope("docker:containers:files") || hasScope(`docker:containers:files:${nodeId}`))
      ) {
        entries.push({
          id: `command:container-files:${nodeId}:${container.id}`,
          label: `Files ${container.name}`,
          detail: `Browse files in ${container.name}`,
          keywords: ["container"],
          icon: FolderOpen,
          action: () => navigate(filesRoute),
        });
      }
    }

    for (const node of nodes) {
      if (
        node.status === "online" &&
        (hasScope("nodes:console") || hasScope(`nodes:console:${node.id}`))
      ) {
        const name = node.displayName || node.hostname;
        entries.push({
          id: `command:node-console:${node.id}`,
          label: `Console ${name}`,
          detail: `Open a shell on ${name}`,
          keywords: ["node terminal"],
          icon: Terminal,
          action: () =>
            window.open(
              `/nodes/console/${node.id}?shell=auto`,
              `node-console-${node.id}`,
              "width=900,height=600"
            ),
        });
      }
      if (hasScope("nodes:files:read") || hasScope(`nodes:files:read:${node.id}`)) {
        const name = node.displayName || node.hostname;
        entries.push({
          id: `command:node-files:${node.id}`,
          label: `Files ${name}`,
          detail: `Browse files on ${name}`,
          keywords: ["node"],
          icon: FolderOpen,
          action: () => navigate(nodeRoute(node.slug, "files")),
        });
      }
    }
    return entries;
  }, [commandContainers, hasScope, navigate, nodes]);

  const commandEntries = useMemo(() => {
    const entries = entityCommands;
    if (!commandQuery) return entries.slice(0, 50);
    return entries
      .map((entry) => ({ entry, score: entryScore(entry, commandQuery) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 50)
      .map(({ entry }) => entry);
  }, [commandQuery, entityCommands]);

  const filteredNavigation = useMemo(() => {
    if (!searchQuery) return baseNavigationEntries;
    return [...baseNavigationEntries, ...deepNavigationEntries]
      .map((entry) => ({ entry, score: entryScore(entry, searchQuery) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .map(({ entry }) => entry);
  }, [baseNavigationEntries, deepNavigationEntries, searchQuery]);

  const filteredActions = useMemo(() => {
    if (!searchQuery) return adaptiveQuickActions;
    return [...currentPageActions, ...contextActions, ...primaryActions, ...secondaryActions]
      .map((entry) => ({ entry, score: entryScore(entry, searchQuery) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .map(({ entry }) => entry);
  }, [
    adaptiveQuickActions,
    contextActions,
    currentPageActions,
    primaryActions,
    searchQuery,
    secondaryActions,
  ]);

  const hasSearchResults =
    resourceResults.length > 0 || filteredNavigation.length > 0 || filteredActions.length > 0;
  const askAIFallback =
    searchQuery.length > 0 &&
    !resourceSearchPending &&
    !hasSearchResults &&
    aiEnabled !== false &&
    aiScopeOk;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      onExitComplete={() => {
        setSearch("");
        setResourceResults([]);
        setResourceSearchPending(false);
      }}
      shouldFilter={false}
    >
      <CommandInput
        placeholder={isCommandMode ? "Type an action..." : "Search or type > for commands..."}
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        {isCommandMode &&
          (commandEntries.length > 0 ? (
            <CommandGroup heading="Actions">
              {commandEntries.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={entry.id}
                  onSelect={() => handleSelect(entry.action)}
                >
                  <entry.icon className="mr-2 h-4 w-4" />
                  <span className="min-w-0 truncate">{entry.label}</span>
                  {entry.detail && (
                    <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
                      {entry.detail}
                    </span>
                  )}
                  {entry.shortcut && <CommandShortcut>{entry.shortcut}</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : commandEntitiesPending ? (
            <CommandGroup heading="Actions">
              <CommandItem value="actions:loading" disabled>
                <Clock className="mr-2 h-4 w-4 animate-pulse" />
                Loading actions…
              </CommandItem>
            </CommandGroup>
          ) : (
            <CommandEmpty>No matching actions.</CommandEmpty>
          ))}

        {!isCommandMode && (
          <>
            {!searchQuery && adaptiveQuickActions.length > 0 && (
              <>
                <CommandGroup heading="Quick actions">
                  {adaptiveQuickActions.map((entry) => (
                    <CommandItem
                      key={entry.id}
                      value={entry.id}
                      disabled={entry.disabled}
                      onSelect={() => handleActionSelect(entry)}
                    >
                      {entry.iconNode ? (
                        <span className="mr-2 flex h-4 w-4 items-center justify-center [&_svg]:h-4 [&_svg]:w-4">
                          {entry.iconNode}
                        </span>
                      ) : (
                        <entry.icon className="mr-2 h-4 w-4" />
                      )}
                      {entry.label}
                      {entry.shortcut && <CommandShortcut>{entry.shortcut}</CommandShortcut>}
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}

            {!searchQuery && recentPages.length > 0 && (
              <>
                <CommandGroup heading="Recent">
                  {recentPages.slice(0, 5).map((page) => (
                    <CommandItem
                      key={page.path}
                      value={`recent:${page.path}`}
                      onSelect={() => handleSelect(() => navigate(page.path))}
                    >
                      <Clock className="mr-2 h-4 w-4 text-muted-foreground" />
                      <span className="truncate">{page.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}

            {searchQuery && filteredNavigation.length > 0 && (
              <>
                <CommandGroup heading="Navigation">
                  {filteredNavigation.map((entry) => (
                    <CommandItem
                      key={entry.id}
                      value={entry.id}
                      onSelect={() => handleSelect(entry.action)}
                    >
                      <entry.icon className="mr-2 h-4 w-4" />
                      {entry.label}
                      {entry.shortcut && <CommandShortcut>{entry.shortcut}</CommandShortcut>}
                    </CommandItem>
                  ))}
                </CommandGroup>
                {(resourceResults.length > 0 ||
                  resourceSearchPending ||
                  filteredActions.length > 0) && <CommandSeparator />}
              </>
            )}

            {searchQuery && (resourceResults.length > 0 || resourceSearchPending) && (
              <>
                <CommandGroup heading="Resources">
                  {resourceResults.map((result) => {
                    const Icon = RESOURCE_ICONS[result.type];
                    return (
                      <CommandItem
                        key={`${result.type}:${result.nodeId ?? ""}:${result.id}`}
                        value={`resource:${result.type}:${result.id}`}
                        onSelect={() => handleSelect(() => navigate(resourceHref(result)))}
                      >
                        <Icon className="mr-2 h-4 w-4" />
                        <span className="min-w-0 truncate">{result.name}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {RESOURCE_LABELS[result.type]}
                        </span>
                      </CommandItem>
                    );
                  })}
                  {resourceSearchPending && resourceResults.length === 0 && (
                    <CommandItem value="resources:loading" disabled>
                      <Clock className="mr-2 h-4 w-4 animate-pulse" />
                      Searching resources…
                    </CommandItem>
                  )}
                </CommandGroup>
                {filteredActions.length > 0 && <CommandSeparator />}
              </>
            )}

            {searchQuery && filteredActions.length > 0 && (
              <CommandGroup heading="Actions">
                {filteredActions.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    disabled={entry.disabled}
                    onSelect={() => handleActionSelect(entry)}
                  >
                    {entry.iconNode ? (
                      <span className="mr-2 flex h-4 w-4 items-center justify-center [&_svg]:h-4 [&_svg]:w-4">
                        {entry.iconNode}
                      </span>
                    ) : (
                      <entry.icon className="mr-2 h-4 w-4" />
                    )}
                    {entry.label}
                    {entry.shortcut && <CommandShortcut>{entry.shortcut}</CommandShortcut>}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {!searchQuery && filteredNavigation.length > 0 && (
              <CommandGroup heading="Navigation">
                {filteredNavigation.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    onSelect={() => handleSelect(entry.action)}
                  >
                    <entry.icon className="mr-2 h-4 w-4" />
                    {entry.label}
                    {entry.shortcut && <CommandShortcut>{entry.shortcut}</CommandShortcut>}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {!searchQuery && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Theme">
                  {secondaryActions.slice(0, 3).map((entry) => (
                    <CommandItem
                      key={entry.id}
                      value={entry.id}
                      onSelect={() => handleSelect(entry.action)}
                    >
                      <entry.icon className="mr-2 h-4 w-4" />
                      {entry.label.replace(/^Use /, "").replace(/ theme$/, "")}
                      {entry.detail && <CommandShortcut>✓</CommandShortcut>}
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Account">
                  <CommandItem value="action:logout" onSelect={() => handleSelect(handleLogout)}>
                    <LogOut className="mr-2 h-4 w-4" />
                    Log out
                  </CommandItem>
                </CommandGroup>
              </>
            )}

            {askAIFallback && (
              <CommandGroup heading="No results">
                <CommandItem
                  value="ask-ai"
                  disabled={inferenceQuota.exhausted}
                  onSelect={() => handleSelect(() => askAI(searchQuery))}
                >
                  <Sparkles className="mr-2 h-4 w-4" />
                  Ask AI: "{searchQuery}"
                  {inferenceQuota.exhausted && (
                    <span className="ml-auto text-xs text-muted-foreground">Quota exhausted</span>
                  )}
                </CommandItem>
              </CommandGroup>
            )}

            {!searchQuery && filteredNavigation.length === 0 && filteredActions.length === 0 && (
              <CommandEmpty>No available pages or actions.</CommandEmpty>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
