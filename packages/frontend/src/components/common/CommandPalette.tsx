import {
  Award,
  Box,
  Clock,
  Database,
  FileText,
  Globe,
  Globe2,
  LayoutDashboard,
  Lock,
  LogOut,
  Monitor,
  Moon,
  PanelLeft,
  Plus,
  ScrollText,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
  Terminal,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import {
  dockerContainerRoute,
  dockerDeploymentRoute,
  nodeRoute,
  proxyHostRoute,
} from "@/lib/resource-routes";
import { deriveAllowedResourceIdsByScope } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import { useDockerStore } from "@/stores/docker";
import { useResolvedPageContext } from "@/stores/resolved-page-context";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import type { Node, ProxyHost } from "@/types";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function fuzzyMatch(text: string, query: string): number {
  if (!query) return 1;
  const words = query.split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  let score = 0;
  for (const word of words) {
    const idx = lower.indexOf(word);
    if (idx === -1) return 0;
    score +=
      idx === 0 || lower[idx - 1] === " " || lower[idx - 1] === "-" || lower[idx - 1] === "/"
        ? 2
        : 1;
  }
  return score;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useState("");
  const { user, hasScope, hasAnyScope, hasScopedAccess, logout } = useAuthStore();
  const { cas } = useCAStore();
  const { setTheme, theme, toggleSidebar } = useUIStore();
  const pkiEnabled = useSystemConfigStore((s) => s.config.features.pkiEnabled);
  const loggingEnabled = useSystemConfigStore((s) => s.config.features.loggingEnabled);
  const recentPages = useUIStore((s) => s.recentPages);
  const containers = useDockerStore((s) => s.containers);
  const resolvedPageStatus = useResolvedPageContext((s) => s.status);
  const resolvedPageRouteKey = useResolvedPageContext((s) => s.routeKey);
  const resolvedPageResource = useResolvedPageContext((s) => s.resource);
  const gatewayInferenceMode = useAIStore(
    (state) => state.providerStatus?.providerType === "gateway_inference"
  );
  const inferenceStreaming = useAIStore((state) => state.isStreaming);
  const canViewInferenceUsage = hasScope("inference:usage:view:self");
  const inferenceQuota = useInferenceQuotaSnapshot(gatewayInferenceMode && canViewInferenceUsage);

  // Lazy-loaded entities
  const [nodes, setNodes] = useState<Node[]>([]);
  const [proxyHosts, setProxyHosts] = useState<ProxyHost[]>([]);

  useEffect(() => {
    if (!open) return;
    // Fetch entities on palette open
    api
      .listNodes({ limit: 100 })
      .then((r) => setNodes(r.data ?? []))
      .catch(() => {});
    api
      .listProxyHosts({ limit: 100 })
      .then((r) => setProxyHosts(r.data ?? []))
      .catch(() => {});
    // Containers are preloaded on app startup via DashboardLayout
  }, [open]);

  useEffect(() => {
    if (!open || !gatewayInferenceMode || !canViewInferenceUsage || inferenceStreaming) return;
    void api.getInferenceSelfUsage().catch(() => {
      // The command palette remains usable when quota visibility is temporarily unavailable.
    });
  }, [canViewInferenceUsage, gatewayInferenceMode, inferenceStreaming, open]);

  const handleSelect = (callback: () => void) => {
    callback();
    onOpenChange(false);
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      logout();
    }
    navigate("/login");
  };

  const askAI = (query: string) => {
    if (inferenceQuota.exhausted) return;
    const systemPrompt = `The user typed "${query}" in the command palette search but found no matching pages, entities, or commands. They are looking for help or information. Please ANSWER their question or explain how to do what they're asking about. Do NOT perform any actions, do NOT create or modify resources — just explain step by step how they can do it themselves through the UI or provide the information they need.`;
    const wrapped = `<system-instruction>${systemPrompt}</system-instruction>\n${query}`;
    useUIStore.getState().setAIPanelOpen(true);
    // Ensure WS is connected before sending
    const store = useAIStore.getState();
    if (store.isConnected) {
      store.sendMessage(wrapped);
    } else {
      store.connect().then(() => useAIStore.getState().sendMessage(wrapped));
    }
  };

  const isCommandMode = search.startsWith(">");
  const commandQuery = isCommandMode ? search.slice(1).trim().toLowerCase() : "";
  const searchQuery = search.toLowerCase().trim();

  /** Returns true if an item should be visible given the current search query */
  const matches = (text: string) => !searchQuery || fuzzyMatch(text, searchQuery) > 0;

  // Check if AI is available for "Ask AI" fallback
  const aiEnabled = useAIStore((s) => s.isEnabled);
  const aiScopeOk = hasScope("feat:ai:use");

  // ── Command mode: >action entity ──
  const commandItems = useMemo(() => {
    if (!isCommandMode) return [];

    type CmdItem = { label: string; detail: string; icon: React.ElementType; action: () => void };
    const items: CmdItem[] = [];

    // Console + logs for containers
    for (const c of containers) {
      const nodeId = (c as any)._nodeId;
      if (!nodeId) continue;
      if (
        hasScope("docker:containers:console") ||
        hasScope(`docker:containers:console:${nodeId}`)
      ) {
        items.push({
          label: `console ${c.name}`,
          detail: `Open console in ${c.name}`,
          icon: Terminal,
          action: () =>
            window.open(
              `/docker/console/${nodeId}/${c.id}?shell=auto`,
              `console-${c.id}`,
              "width=900,height=600"
            ),
        });
      }
      if (hasScope("docker:containers:view") || hasScope(`docker:containers:view:${nodeId}`)) {
        items.push({
          label: `logs ${c.name}`,
          detail: `Open logs for ${c.name}`,
          icon: ScrollText,
          action: () =>
            window.open(`/docker/logs/${nodeId}/${c.id}`, `logs-${c.id}`, "width=900,height=600"),
        });
      }
    }

    // Console for nodes
    if (hasScopedAccess("nodes:console")) {
      for (const n of nodes) {
        if (n.status !== "online") continue;
        if (!hasScope("nodes:console") && !hasScope(`nodes:console:${n.id}`)) continue;
        const name = n.displayName || n.hostname;
        items.push({
          label: `console ${name}`,
          detail: `Open console on node ${name}`,
          icon: Terminal,
          action: () =>
            window.open(
              `/nodes/console/${n.id}?shell=auto`,
              `node-console-${n.id}`,
              "width=900,height=600"
            ),
        });
      }
    }

    if (!commandQuery) return items;
    return items
      .map((i) => ({ ...i, score: fuzzyMatch(`${i.label} ${i.detail}`, commandQuery) }))
      .filter((i) => i.score > 0)
      .sort((a, b) => b.score - a.score);
  }, [isCommandMode, commandQuery, containers, nodes, hasScope, hasScopedAccess]);

  // ── Context-aware actions based on current page ──
  const contextActions = useMemo(() => {
    const path = location.pathname;
    type CtxItem = { label: string; icon: React.ElementType; action: () => void };
    const items: CtxItem[] = [];
    const resource =
      resolvedPageStatus === "ready" &&
      resolvedPageRouteKey &&
      (path === resolvedPageRouteKey || path.startsWith(`${resolvedPageRouteKey}/`))
        ? resolvedPageResource
        : null;

    // Container detail page
    if (resource?.resourceType === "docker-container" && resource.nodeId) {
      const nodeId = resource.nodeId;
      const containerId = resource.resourceId;
      if (
        hasScope("docker:containers:console") ||
        hasScope(`docker:containers:console:${nodeId}`)
      ) {
        items.push({
          label: "Open console",
          icon: Terminal,
          action: () =>
            window.open(
              `/docker/console/${nodeId}/${containerId}?shell=auto`,
              `console-${containerId}`,
              "width=900,height=600"
            ),
        });
      }
      if (hasScope("docker:containers:view") || hasScope(`docker:containers:view:${nodeId}`)) {
        items.push({
          label: "Open logs",
          icon: ScrollText,
          action: () =>
            window.open(
              `/docker/logs/${nodeId}/${containerId}`,
              `logs-${containerId}`,
              "width=900,height=600"
            ),
        });
      }
    }

    // Node detail page
    if (resource?.resourceType === "node") {
      const nodeId = resource.resourceId;
      if (hasScope("nodes:console") || hasScope(`nodes:console:${nodeId}`)) {
        items.push({
          label: "Open node console",
          icon: Terminal,
          action: () =>
            window.open(
              `/nodes/console/${nodeId}?shell=auto`,
              `node-console-${nodeId}`,
              "width=900,height=600"
            ),
        });
      }
    }

    return items;
  }, [location.pathname, hasScope, resolvedPageResource, resolvedPageRouteKey, resolvedPageStatus]);

  // Build flat nav/action items and filter through fuzzyMatch
  type NavEntry = {
    label: string;
    icon: React.ElementType;
    shortcut?: string;
    action: () => void;
    scope?: string;
  };
  const allNavItems: NavEntry[] = [
    { label: "Dashboard", icon: LayoutDashboard, shortcut: "⌘1", action: () => navigate("/") },
    {
      label: "Proxy Hosts",
      icon: Globe,
      shortcut: "⌘2",
      action: () => navigate("/proxy-hosts"),
      scope: "proxy:view",
    },
    {
      label: "Domains",
      icon: Globe2,
      shortcut: "⌘3",
      action: () => navigate("/domains"),
      scope: "domains:view",
    },
    {
      label: "SSL Certificates",
      icon: Lock,
      shortcut: "⌘4",
      action: () => navigate("/ssl-certificates"),
      scope: "ssl:cert:view",
    },
    {
      label: "Authorities",
      icon: ShieldCheck,
      shortcut: "⌘5",
      action: () => navigate("/cas"),
      scope: "pki:ca:view:root",
    },
    {
      label: "Certificates",
      icon: FileText,
      shortcut: "⌘6",
      action: () => navigate("/certificates"),
      scope: "pki:cert:view",
    },
    {
      label: "Templates",
      icon: Award,
      shortcut: "⌘7",
      action: () => navigate(pkiEnabled ? "/templates/pki" : "/templates/nginx"),
      scope: "pki:templates:view",
    },
    {
      label: "Docker",
      icon: Box,
      action: () => navigate("/docker"),
      scope: "docker:containers:view",
    },
    {
      label: "Databases",
      icon: Database,
      action: () => navigate("/databases"),
      scope: "databases:view",
    },
    {
      label: "Logging",
      icon: ScrollText,
      action: () => navigate("/logging"),
      scope: "logs:read",
    },
    {
      label: "Nodes",
      icon: Server,
      shortcut: "⌘9",
      action: () => navigate("/nodes"),
      scope: "nodes:details",
    },
    {
      label: "Access Lists",
      icon: ShieldAlert,
      shortcut: "⌘0",
      action: () => navigate("/access-lists"),
      scope: "acl:view",
    },
    {
      label: "Administration",
      icon: Users,
      action: () => navigate("/administration"),
    },
    { label: "Settings", icon: Settings, shortcut: "⌘,", action: () => navigate("/settings") },
  ];
  const filteredNav = allNavItems.filter((i) => {
    if (!matches(i.label)) return false;
    if (i.label === "Administration") {
      return hasAnyScope("admin:audit", "admin:users", "admin:groups");
    }
    if (!i.scope) return true;
    if (i.label === "Authorities") {
      return pkiEnabled && hasAnyScope("pki:ca:view:root", "pki:ca:view:intermediate");
    }
    if (i.label === "Certificates") {
      return pkiEnabled && hasScopedAccess("pki:cert:view");
    }
    if (i.label === "Domains") {
      return hasScopedAccess("domains:view");
    }
    if (i.label === "Logging") {
      const hasResourceScopedSchemaView = user
        ? (deriveAllowedResourceIdsByScope(user.scopes)["logs:schemas:view"]?.length ?? 0) > 0
        : false;
      return (
        loggingEnabled &&
        (hasAnyScope(
          "logs:environments:view",
          "logs:environments:view",
          "logs:schemas:view",
          "logs:schemas:create",
          "logs:read",
          "logs:manage"
        ) ||
          hasResourceScopedSchemaView)
      );
    }
    if (i.label === "Templates") {
      return (
        (pkiEnabled && hasScopedAccess("pki:templates:view")) ||
        hasScopedAccess("proxy:templates:view")
      );
    }
    if (i.label === "Proxy Hosts") {
      return hasScopedAccess("proxy:view") || hasScope("proxy:folders:manage");
    }
    if (i.label === "Docker") {
      return (
        hasScopedAccess("docker:containers:view") ||
        hasScopedAccess("docker:images:view") ||
        hasScopedAccess("docker:volumes:view") ||
        hasScopedAccess("docker:networks:view") ||
        hasScope("docker:tasks") ||
        hasScope("docker:containers:folders:manage")
      );
    }
    return hasScopedAccess(i.scope);
  });

  const allActionItems: NavEntry[] = [
    { label: "Toggle sidebar", icon: PanelLeft, shortcut: "⌘J", action: () => toggleSidebar() },
    {
      label: "New Proxy Host",
      icon: Plus,
      shortcut: "⌃H",
      action: () => navigate("/proxy-hosts/new"),
      scope: "proxy:create",
    },
    {
      label: "New SSL Certificate",
      icon: Plus,
      shortcut: "⌃S",
      action: () => {
        navigate("/ssl-certificates");
        useUIStore.getState().openModal("createSSLCert");
      },
      scope: "ssl:cert:issue",
    },
    {
      label: "Create Root CA",
      icon: Plus,
      shortcut: "⌃R",
      action: () => {
        navigate("/cas");
        useUIStore.getState().openModal("createCA");
      },
      scope: "pki:ca:create:root",
    },
  ];
  const filteredActions = allActionItems.filter((i) => {
    if (i.label === "Create Root CA" && !pkiEnabled) return false;
    return (!i.scope || hasScope(i.scope)) && matches(i.label);
  });

  const themeItems = [
    { label: "Light theme", icon: Sun, action: () => setTheme("light"), active: theme === "light" },
    { label: "Dark theme", icon: Moon, action: () => setTheme("dark"), active: theme === "dark" },
    {
      label: "System theme",
      icon: Monitor,
      action: () => setTheme("system"),
      active: theme === "system",
    },
  ].filter((i) => matches(i.label));

  const showLogout = matches("log out");

  // Filtered entities for search mode
  const filteredContainers =
    searchQuery && hasScopedAccess("docker:containers:view")
      ? containers
          .filter((c) => c._nodeSlug && fuzzyMatch(`${c.name} ${c.image}`, searchQuery) > 0)
          .slice(0, 5)
      : [];
  const filteredProxies =
    searchQuery && hasScopedAccess("proxy:view")
      ? proxyHosts.filter((p) => fuzzyMatch(p.domainNames.join(" "), searchQuery) > 0).slice(0, 5)
      : [];
  const filteredNodes =
    searchQuery && hasScopedAccess("nodes:details")
      ? nodes
          .filter((n) => fuzzyMatch(`${n.displayName || ""} ${n.hostname}`, searchQuery) > 0)
          .slice(0, 5)
      : [];
  const filteredCAs =
    searchQuery && pkiEnabled && hasAnyScope("pki:ca:view:root", "pki:ca:view:intermediate")
      ? (cas || []).filter((ca) => fuzzyMatch(ca.commonName, searchQuery) > 0).slice(0, 5)
      : [];

  // Check if anything would render for "Ask AI" fallback
  const hasAnyResults =
    filteredContainers.length > 0 ||
    filteredProxies.length > 0 ||
    filteredNodes.length > 0 ||
    filteredCAs.length > 0 ||
    filteredNav.length > 0 ||
    filteredActions.length > 0 ||
    themeItems.length > 0 ||
    showLogout;
  const askAIFallback = searchQuery && !hasAnyResults && aiEnabled !== false && aiScopeOk;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      onExitComplete={() => setSearch("")}
      shouldFilter={false}
    >
      <CommandInput
        placeholder={
          isCommandMode ? "Type a command... (console, logs)" : "Search or type > for commands..."
        }
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        {/* ── Command mode ── */}
        {isCommandMode &&
          (commandItems.length > 0 ? (
            <CommandGroup heading="Commands">
              {commandItems.map((item, i) => (
                <CommandItem key={i} value={item.label} onSelect={() => handleSelect(item.action)}>
                  <item.icon className="mr-2 h-4 w-4" />
                  {item.detail}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : aiEnabled !== false && aiScopeOk ? (
            <CommandGroup heading="No commands found">
              <CommandItem
                value="ask-ai"
                disabled={inferenceQuota.exhausted}
                onSelect={() => handleSelect(() => askAI(search.slice(1).trim()))}
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Ask AI: "{search.slice(1).trim()}"
                {inferenceQuota.exhausted && (
                  <span className="ml-auto text-xs text-muted-foreground">Quota exhausted</span>
                )}
              </CommandItem>
            </CommandGroup>
          ) : (
            <CommandEmpty>No matching commands.</CommandEmpty>
          ))}

        {/* ── Normal mode ── */}
        {!isCommandMode && (
          <>
            {/* Context actions */}
            {contextActions.length > 0 && !searchQuery && (
              <>
                <CommandGroup heading="Current Page">
                  {contextActions.map((item, i) => (
                    <CommandItem
                      key={i}
                      value={item.label}
                      onSelect={() => handleSelect(item.action)}
                    >
                      <item.icon className="mr-2 h-4 w-4" />
                      {item.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}

            {/* Recent pages */}
            {recentPages.length > 0 && !searchQuery && (
              <>
                <CommandGroup heading="Recent">
                  {recentPages.slice(0, 5).map((page) => (
                    <CommandItem
                      key={page.path}
                      value={page.label}
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

            {/* Entity search results */}
            {filteredContainers.length > 0 && (
              <>
                <CommandGroup heading="Containers">
                  {filteredContainers.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={`container ${c.name}`}
                      onSelect={() =>
                        handleSelect(() =>
                          navigate(
                            c.kind === "deployment"
                              ? dockerDeploymentRoute(c._nodeSlug!, c.name)
                              : dockerContainerRoute(c._nodeSlug!, c.name)
                          )
                        )
                      }
                    >
                      <Box className="mr-2 h-4 w-4" />
                      <span className="truncate">{c.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground">{c.state}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            {filteredProxies.length > 0 && (
              <>
                <CommandGroup heading="Proxy Hosts">
                  {filteredProxies.map((p) => (
                    <CommandItem
                      key={p.id}
                      value={`proxy ${p.domainNames[0]}`}
                      onSelect={() => handleSelect(() => navigate(proxyHostRoute(p.slug)))}
                    >
                      <Globe className="mr-2 h-4 w-4" />
                      <span className="truncate">{p.domainNames[0]}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            {filteredNodes.length > 0 && (
              <>
                <CommandGroup heading="Nodes">
                  {filteredNodes.map((n) => (
                    <CommandItem
                      key={n.id}
                      value={`node ${n.displayName || n.hostname}`}
                      onSelect={() => handleSelect(() => navigate(nodeRoute(n.slug)))}
                    >
                      <Server className="mr-2 h-4 w-4" />
                      <span className="truncate">{n.displayName || n.hostname}</span>
                      <span className="ml-auto text-xs text-muted-foreground">{n.status}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            {filteredCAs.length > 0 && (
              <>
                <CommandGroup heading="Certificate Authorities">
                  {filteredCAs.map((ca) => (
                    <CommandItem
                      key={ca.id}
                      value={`ca ${ca.commonName}`}
                      onSelect={() => handleSelect(() => navigate(`/cas/${ca.id}`))}
                    >
                      <Shield className="mr-2 h-4 w-4" />
                      <span className="truncate">{ca.commonName}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}

            {/* CAs when no search */}
            {!searchQuery &&
              pkiEnabled &&
              hasAnyScope("pki:ca:view:root", "pki:ca:view:intermediate") &&
              (cas || []).length > 0 && (
                <>
                  <CommandGroup heading="Certificate Authorities">
                    {(cas || []).slice(0, 5).map((ca) => (
                      <CommandItem
                        key={ca.id}
                        value={`ca ${ca.commonName}`}
                        onSelect={() => handleSelect(() => navigate(`/cas/${ca.id}`))}
                      >
                        <Shield className="mr-2 h-4 w-4" />
                        <span className="truncate">{ca.commonName}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  <CommandSeparator />
                </>
              )}

            {/* Navigation */}
            {filteredNav.length > 0 && (
              <CommandGroup heading="Navigation">
                {filteredNav.map((item) => (
                  <CommandItem
                    key={item.label}
                    value={item.label}
                    onSelect={() => handleSelect(item.action)}
                  >
                    <item.icon className="mr-2 h-4 w-4" />
                    {item.label}
                    {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Actions */}
            {filteredActions.length > 0 && (
              <>
                {filteredNav.length > 0 && <CommandSeparator />}
                <CommandGroup heading="Actions">
                  {filteredActions.map((item) => (
                    <CommandItem
                      key={item.label}
                      value={item.label}
                      onSelect={() => handleSelect(item.action)}
                    >
                      <item.icon className="mr-2 h-4 w-4" />
                      {item.label}
                      {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {/* Theme */}
            {themeItems.length > 0 && (
              <>
                {(filteredNav.length > 0 || filteredActions.length > 0) && <CommandSeparator />}
                <CommandGroup heading="Theme">
                  {themeItems.map((item) => (
                    <CommandItem
                      key={item.label}
                      value={item.label}
                      onSelect={() => handleSelect(item.action)}
                    >
                      <item.icon className="mr-2 h-4 w-4" />
                      {item.label.replace(" theme", "")}
                      {item.active && <CommandShortcut>✓</CommandShortcut>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {/* Account */}
            {showLogout && (
              <>
                {(filteredNav.length > 0 ||
                  filteredActions.length > 0 ||
                  themeItems.length > 0) && <CommandSeparator />}
                <CommandGroup heading="Account">
                  <CommandItem value="log out" onSelect={() => handleSelect(handleLogout)}>
                    <LogOut className="mr-2 h-4 w-4" />
                    Log out
                  </CommandItem>
                </CommandGroup>
              </>
            )}

            {/* Ask AI fallback */}
            {askAIFallback && (
              <>
                {(filteredNav.length > 0 ||
                  filteredActions.length > 0 ||
                  themeItems.length > 0 ||
                  showLogout) && <CommandSeparator />}
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
              </>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
