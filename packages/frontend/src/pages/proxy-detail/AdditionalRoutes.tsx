import {
  Box,
  FileCode,
  Globe2,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirmAction } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { PagesFeatureDisabledDialog } from "@/components/pages/PagesFeatureDisabledDialog";
import { PagesTargetPicker } from "@/components/proxy/PagesTargetPicker";
import {
  DEFAULT_PROXY_UPSTREAM,
  isProxyUpstreamValid,
  ProxyUpstreamFields,
  type ProxyUpstreamSelection,
} from "@/components/proxy/ProxyUpstreamEditor";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useRealtime } from "@/hooks/use-realtime";
import { getNodeAppearanceColor } from "@/lib/node-appearance";
import { api } from "@/services/api";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type {
  CreateProxyAdditionalRouteRequest,
  DockerContainer,
  PageProject,
  PageTag,
  ProxyAdditionalRoute,
  ProxyAdditionalRouteStatus,
  ProxyAdditionalRouteTargetKind,
  ProxyHost,
  UpdateProxyAdditionalRouteRequest,
} from "@/types";

const DEFAULT_TIMEOUT_SECONDS = 60;
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;

export const DEFAULT_ADDITIONAL_ROUTE_OPTIONS = {
  enabled: true,
  stripPrefix: false,
  websocketSupport: false,
  requestBuffering: true,
  responseBuffering: true,
  connectTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  readTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  sendTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
};

export interface AdditionalRouteDraft {
  path: string;
  targetKind: ProxyAdditionalRouteTargetKind;
  upstream: ProxyUpstreamSelection;
  pageProjectId: string;
  pageTagId: string;
  enabled: boolean;
  stripPrefix: boolean;
  websocketSupport: boolean;
  requestBuffering: boolean;
  responseBuffering: boolean;
  connectTimeoutSeconds: number;
  readTimeoutSeconds: number;
  sendTimeoutSeconds: number;
}

function defaultDraft(): AdditionalRouteDraft {
  return {
    path: "",
    targetKind: "manual",
    upstream: { ...DEFAULT_PROXY_UPSTREAM, kind: "manual" },
    pageProjectId: "",
    pageTagId: "",
    ...DEFAULT_ADDITIONAL_ROUTE_OPTIONS,
  };
}

function upstreamKindForTarget(
  targetKind: ProxyAdditionalRouteTargetKind
): ProxyUpstreamSelection["kind"] {
  return targetKind === "pages" ? "manual" : targetKind;
}

function containsControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function draftFromRoute(route: ProxyAdditionalRoute): AdditionalRouteDraft {
  return {
    path: route.path,
    targetKind: route.targetKind,
    upstream: {
      ...DEFAULT_PROXY_UPSTREAM,
      kind: upstreamKindForTarget(route.targetKind),
      scheme: route.forwardScheme,
      manualHost: route.forwardHost ?? "",
      manualPort: route.forwardPort ?? 80,
      dockerNodeId: route.dockerNodeId,
      containerName: route.dockerContainerName,
      deploymentId: route.dockerDeploymentId,
      containerPort: route.dockerContainerPort,
    },
    pageProjectId: route.pageProjectId ?? "",
    pageTagId: route.pageTagId ?? "",
    enabled: route.enabled,
    stripPrefix: route.stripPrefix,
    websocketSupport: route.websocketSupport,
    requestBuffering: route.requestBuffering,
    responseBuffering: route.responseBuffering,
    connectTimeoutSeconds: route.connectTimeoutSeconds,
    readTimeoutSeconds: route.readTimeoutSeconds,
    sendTimeoutSeconds: route.sendTimeoutSeconds,
  };
}

/** Return the canonical literal path used by the API, or null for malformed input. */
export function normalizeAdditionalRoutePath(value: string): string | null {
  const path = value.trim();
  if (path.length === 0 || !path.startsWith("/") || path.includes("?")) return null;
  if (path.includes("#") || path.includes("%") || /[\\*()[\]{}]/.test(path)) return null;
  if (containsControlCharacters(path) || path.includes("//")) return null;
  const canonicalInput = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const segments = canonicalInput.split("/").slice(1);
  if (
    segments.some((segment) => segment === "." || segment === ".." || !PATH_SEGMENT.test(segment))
  ) {
    return null;
  }
  const withoutTrailingSlash = canonicalInput;
  return withoutTrailingSlash || "/";
}

export function validateAdditionalRoutePath(
  value: string,
  routes: ProxyAdditionalRoute[] = [],
  editingId?: string
): string | null {
  const path = value.trim();
  if (!path) return "Enter a path prefix.";
  if (!path.startsWith("/")) return "Path prefixes must start with /.";
  if (path === "/" || normalizeAdditionalRoutePath(path) === "/") {
    return "The root path is reserved for the primary upstream.";
  }
  if (path.includes("?") || path.includes("#"))
    return "Query strings and fragments are not allowed.";
  if (path.includes("%")) return "Use a literal path; encoded paths are not allowed.";
  if (/[\\*()[\]{}]/.test(path)) return "Regex and glob syntax are not allowed.";
  if (containsControlCharacters(path)) return "Control characters are not allowed.";
  if (path.includes("//")) return "Empty path segments are not allowed.";
  const canonicalInput = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const segments = canonicalInput.split("/").slice(1);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "Traversal segments are not allowed.";
  }
  if (segments.some((segment) => !PATH_SEGMENT.test(segment))) {
    return "Path segments may contain letters, numbers, ., _, -, and ~ only.";
  }

  const normalized = normalizeAdditionalRoutePath(path);
  if (!normalized) return "Enter a valid literal path prefix.";
  const lower = normalized.toLowerCase();
  const reserved = ["/.well-known/acme-challenge", "/_gateway"];
  if (reserved.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`))) {
    return "This path is reserved by Gateway.";
  }
  if (
    routes.some(
      (route) => route.id !== editingId && normalizeAdditionalRoutePath(route.path) === normalized
    )
  ) {
    return "A route with this path already exists.";
  }
  return null;
}

export function routeRequestFromDraft(
  draft: AdditionalRouteDraft
): CreateProxyAdditionalRouteRequest {
  const normalizedPath = normalizeAdditionalRoutePath(draft.path) ?? draft.path.trim();
  const request: CreateProxyAdditionalRouteRequest = {
    path: normalizedPath,
    enabled: draft.enabled,
    targetKind: draft.targetKind,
    forwardScheme: draft.upstream.scheme,
    stripPrefix: draft.targetKind === "pages" ? true : draft.stripPrefix,
    websocketSupport: draft.targetKind === "pages" ? false : draft.websocketSupport,
    requestBuffering: draft.targetKind === "pages" ? false : draft.requestBuffering,
    responseBuffering: draft.targetKind === "pages" ? false : draft.responseBuffering,
    connectTimeoutSeconds: draft.connectTimeoutSeconds,
    readTimeoutSeconds: draft.readTimeoutSeconds,
    sendTimeoutSeconds: draft.sendTimeoutSeconds,
  };

  if (draft.targetKind === "manual") {
    request.forwardHost = draft.upstream.manualHost.trim();
    request.forwardPort = draft.upstream.manualPort;
  } else if (draft.targetKind === "docker_container") {
    request.dockerNodeId = draft.upstream.dockerNodeId;
    request.dockerContainerName = draft.upstream.containerName;
    request.dockerContainerPort = draft.upstream.containerPort;
  } else if (draft.targetKind === "docker_deployment") {
    request.dockerDeploymentId = draft.upstream.deploymentId;
    request.dockerContainerPort = draft.upstream.containerPort;
  } else {
    request.pageProjectId = draft.pageProjectId;
    request.pageTagId = draft.pageTagId;
  }

  return request;
}

function statusVariant(status: ProxyAdditionalRouteStatus): BadgeProps["variant"] {
  if (status === "ready") return "success";
  if (status === "failed" || status === "capability_missing") return "destructive";
  if (status === "provisioning" || status === "staging" || status === "pending") return "warning";
  return "secondary";
}

function statusLabel(status: ProxyAdditionalRouteStatus): string {
  return status.replaceAll("_", " ");
}

function routeTargetSummary(route: ProxyAdditionalRoute): string {
  if (route.targetKind === "manual") {
    return `${route.forwardScheme.toUpperCase()} ${route.forwardHost ?? "—"}:${route.forwardPort ?? "—"}`;
  }
  if (route.targetKind === "docker_container") {
    return route.dockerContainerName ?? "Container";
  }
  if (route.targetKind === "docker_deployment") {
    return route.dockerDeploymentName ?? route.dockerDeploymentId ?? "Deployment";
  }
  return `${route.pageProjectName ?? "Project"} / ${route.pageTagName ?? "Tag"}`;
}

function routeTarget(
  route: ProxyAdditionalRoute,
  dockerNodeColors: Record<string, DockerContainer["_nodeColor"]>
) {
  const label = routeTargetSummary(route);
  if (route.targetKind === "pages") {
    const appearance = getNodeAppearanceColor(route.pageProjectAppearanceColor);
    return (
      <Badge variant="secondary" className={appearance?.badgeClassName} title={label}>
        <Globe2 className="mr-1.5 h-3.5 w-3.5" />
        {label}
      </Badge>
    );
  }
  if (route.targetKind === "docker_container" || route.targetKind === "docker_deployment") {
    const appearance = getNodeAppearanceColor(
      route.dockerNodeId ? dockerNodeColors[route.dockerNodeId] : null
    );
    return (
      <Badge variant="secondary" className={appearance?.badgeClassName} title={label}>
        <Box className="mr-1.5 h-3.5 w-3.5" />
        {label}
      </Badge>
    );
  }
  return <span>{label}</span>;
}

function pageTagReady(tag: PageTag | null): boolean {
  return tag?.deployment?.status === "ready";
}

export interface AdditionalRoutesPanelProps {
  host: ProxyHost;
  canManage: boolean;
  selectedTemplate?: { isBuiltin: boolean } | null;
}

export function AdditionalRoutesPanel({
  host,
  canManage,
  selectedTemplate,
}: AdditionalRoutesPanelProps) {
  const [routes, setRoutes] = useState<ProxyAdditionalRoute[] | null>(null);
  const [dockerNodeColors, setDockerNodeColors] = useState<
    Record<string, DockerContainer["_nodeColor"]>
  >({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRoute, setEditingRoute] = useState<ProxyAdditionalRoute | null>(null);
  const [pendingRouteId, setPendingRouteId] = useState<string | null>(null);
  const [advancedRoute, setAdvancedRoute] = useState<ProxyAdditionalRoute | null>(null);
  const [advancedDialogOpen, setAdvancedDialogOpen] = useState(false);
  const [advancedConfig, setAdvancedConfig] = useState("");
  const [savingAdvanced, setSavingAdvanced] = useState(false);

  const load = useCallback(async () => {
    if (!host.id) {
      setRoutes([]);
      return;
    }
    try {
      const nextRoutes = await api.listProxyAdditionalRoutes(host.id);
      setRoutes(nextRoutes);
      setLoadError(null);
    } catch (error) {
      setRoutes([]);
      setLoadError(error instanceof Error ? error.message : "Failed to load additional routes");
    }
  }, [host.id]);

  useEffect(() => {
    setRoutes(null);
    if (!host.id) {
      setRoutes([]);
      return;
    }
    void load();
  }, [host.id, load]);

  const loadDockerNodeColors = useCallback(async () => {
    const containers = await api.listDockerContainerSnapshots();
    setDockerNodeColors(
      Object.fromEntries(
        containers
          .filter((container) => container._nodeId)
          .map((container) => [container._nodeId as string, container._nodeColor])
      )
    );
  }, []);

  useEffect(() => {
    void loadDockerNodeColors().catch(() => setDockerNodeColors({}));
  }, [loadDockerNodeColors]);
  useRealtime("docker.snapshot.changed", loadDockerNodeColors);
  useRealtime("node.changed", loadDockerNodeColors);

  useRealtime("proxy.additional-route.changed", load);

  const unavailableReason = useMemo(() => {
    if (routes === null) return "Additional routes are still loading.";
    if (loadError) return "Additional routes are unavailable until they can be loaded.";
    if (host.maintenanceEnabled) return "Additional routes are unavailable during maintenance.";
    if (host.rawConfigEnabled) return "Disable Raw Config Mode before adding managed routes.";
    if (!host.nodeId) return "Additional routes require an assigned Nginx node.";
    if (selectedTemplate && !selectedTemplate.isBuiltin) {
      return "Additional routes require the built-in proxy template.";
    }
    return null;
  }, [
    host.maintenanceEnabled,
    host.nodeId,
    host.rawConfigEnabled,
    loadError,
    routes,
    selectedTemplate,
  ]);

  const mutationAllowed = canManage && !unavailableReason;

  const upsertRoute = (route: ProxyAdditionalRoute) => {
    setRoutes((current) => {
      if (!current) return [route];
      const index = current.findIndex((item) => item.id === route.id);
      if (index < 0) return [...current, route];
      const next = [...current];
      next[index] = route;
      return next;
    });
  };

  const openCreate = () => {
    setEditingRoute(null);
    setDialogOpen(true);
  };

  const openEdit = (route: ProxyAdditionalRoute) => {
    setEditingRoute(route);
    setDialogOpen(true);
  };

  const toggleRoute = async (route: ProxyAdditionalRoute, enabled: boolean) => {
    if (!mutationAllowed) return;
    setPendingRouteId(route.id);
    try {
      const updated = await api.updateProxyAdditionalRoute(host.id, route.id, { enabled });
      upsertRoute(updated);
      toast.success(enabled ? "Additional route enabled" : "Additional route disabled");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update additional route");
    } finally {
      setPendingRouteId(null);
    }
  };

  const retryRoute = async (route: ProxyAdditionalRoute) => {
    if (!mutationAllowed) return;
    setPendingRouteId(route.id);
    try {
      const updated = await api.retryProxyAdditionalRoute(host.id, route.id);
      upsertRoute(updated);
      toast.success("Additional route retry started");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to retry additional route");
    } finally {
      setPendingRouteId(null);
    }
  };

  const removeRoute = (route: ProxyAdditionalRoute) => {
    if (!mutationAllowed) return;
    void confirmAction(
      {
        title: "Delete additional route?",
        description: `The managed route ${route.path} will be removed from this proxy host.`,
        confirmLabel: "Delete",
        variant: "destructive",
      },
      async () => {
        setPendingRouteId(route.id);
        try {
          await api.deleteProxyAdditionalRoute(host.id, route.id);
          setRoutes((current) => current?.filter((item) => item.id !== route.id) ?? []);
          toast.success("Additional route deletion started");
          return true;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Failed to delete additional route");
          return false;
        } finally {
          setPendingRouteId(null);
        }
      }
    );
  };

  const openAdvancedConfig = (route: ProxyAdditionalRoute) => {
    setAdvancedRoute(route);
    setAdvancedConfig(route.advancedConfig ?? "");
    setAdvancedDialogOpen(true);
  };

  const saveAdvancedConfig = async () => {
    if (!advancedRoute || savingAdvanced) return;
    setSavingAdvanced(true);
    try {
      const updated = await api.updateProxyAdditionalRoute(host.id, advancedRoute.id, {
        advancedConfig: advancedConfig || null,
      });
      upsertRoute(updated);
      setAdvancedDialogOpen(false);
      toast.success("Additional route advanced config saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save advanced config");
    } finally {
      setSavingAdvanced(false);
    }
  };

  const columns: SimpleTableColumn<ProxyAdditionalRoute>[] = [
    {
      id: "path",
      header: "Path",
      className: "w-[46%]",
      render: (route) => (
        <div className="min-w-0">
          <div className="truncate font-medium" title={route.path}>
            {route.path}
          </div>
          <div className="text-xs text-muted-foreground">
            {route.stripPrefix ? "Prefix stripped" : "Prefix preserved"}
          </div>
        </div>
      ),
    },
    {
      id: "target",
      header: "Target",
      className: "w-[28%]",
      render: (route) => routeTarget(route, dockerNodeColors),
    },
    {
      id: "status",
      header: "Status",
      className: "w-[8rem]",
      render: (route) => (
        <Badge variant={statusVariant(route.status)} title={route.lastError ?? undefined}>
          {statusLabel(route.status)}
        </Badge>
      ),
    },
    {
      id: "enabled",
      header: "Enabled",
      className: "w-[5.5rem]",
      cellClassName: "w-[5.5rem]",
      render: (route) => (
        <div onClick={(event) => event.stopPropagation()}>
          <Switch
            checked={route.enabled}
            onChange={() => void toggleRoute(route, !route.enabled)}
            disabled={!mutationAllowed || pendingRouteId === route.id}
            ariaLabel={`Toggle ${route.path}`}
          />
        </div>
      ),
    },
    ...(canManage
      ? [
          {
            id: "actions",
            header: "Actions",
            align: "right" as const,
            className: "w-[5rem]",
            render: (route: ProxyAdditionalRoute) => {
              const pending = pendingRouteId === route.id;
              return (
                <div onClick={(event) => event.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        disabled={!mutationAllowed || pending}
                        aria-label={`Actions for ${route.path}`}
                      >
                        {pending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <MoreVertical className="h-4 w-4" />
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(route)}>
                        <Pencil /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => openAdvancedConfig(route)}>
                        <FileCode /> Edit advanced config
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void toggleRoute(route, !route.enabled)}>
                        <Power />
                        {route.enabled ? "Disable" : "Enable"}
                      </DropdownMenuItem>
                      {route.status === "failed" || route.status === "capability_missing" ? (
                        <DropdownMenuItem onClick={() => void retryRoute(route)}>
                          <RefreshCw /> Retry
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => removeRoute(route)}>
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            },
          },
        ]
      : []),
  ];

  return (
    <PanelShell
      title="Additional Routes"
      description="Route literal path prefixes to managed upstream targets"
      className="overflow-visible"
      actions={
        canManage ? (
          <Button
            onClick={openCreate}
            disabled={!mutationAllowed}
            title={unavailableReason ?? undefined}
          >
            <Plus className="h-4 w-4" /> Add route
          </Button>
        ) : null
      }
      wrapHeader
    >
      <SimpleTable
        columns={columns}
        rows={routes ?? []}
        getRowKey={(route) => route.id}
        loading={routes === null}
        emptyMessage={loadError ?? "No additional routes configured."}
        onRowClick={canManage ? openEdit : undefined}
        isRowClickable={(route) => mutationAllowed && pendingRouteId !== route.id}
      />

      <AdditionalRouteWizard
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        hostId={host.id}
        route={editingRoute}
        existingRoutes={routes ?? []}
        onSaved={upsertRoute}
      />

      <Dialog
        open={advancedDialogOpen}
        onOpenChange={(open) => {
          if (!open && savingAdvanced) return;
          setAdvancedDialogOpen(open);
        }}
      >
        <DialogContent
          onAnimationEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.currentTarget.dataset.state === "closed"
            ) {
              window.setTimeout(() => {
                setAdvancedRoute(null);
                setAdvancedConfig("");
              }, 100);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit advanced config</DialogTitle>
            <DialogDescription>
              Additional Nginx directives inside {advancedRoute?.path ?? "this location"}.
            </DialogDescription>
          </DialogHeader>
          <div className="h-80 min-h-0 border border-border">
            <CodeEditor
              value={advancedConfig}
              onChange={setAdvancedConfig}
              minHeight="0px"
              bordered={false}
              showGutterBorder={false}
              readOnly={savingAdvanced}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAdvancedDialogOpen(false)}
              disabled={savingAdvanced}
            >
              Cancel
            </Button>
            <Button onClick={() => void saveAdvancedConfig()} disabled={savingAdvanced}>
              {savingAdvanced ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {savingAdvanced ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelShell>
  );
}

interface AdditionalRouteWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostId: string;
  route: ProxyAdditionalRoute | null;
  existingRoutes: ProxyAdditionalRoute[];
  onSaved: (route: ProxyAdditionalRoute) => void;
}

function AdditionalRouteWizard({
  open,
  onOpenChange,
  hostId,
  route,
  existingRoutes,
  onSaved,
}: AdditionalRouteWizardProps) {
  const [draft, setDraft] = useState<AdditionalRouteDraft>(defaultDraft);
  const [saving, setSaving] = useState(false);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [projects, setProjects] = useState<PageProject[]>([]);
  const [tags, setTags] = useState<PageTag[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [pagesDisabledDialogOpen, setPagesDisabledDialogOpen] = useState(false);
  const pagesEnabled = useUIBootstrapStore(
    (state) => state.snapshot?.navigation.pagesEnabled === true
  );

  useEffect(() => {
    if (!open) return;
    setDraft(route ? draftFromRoute(route) : defaultDraft());

    void api
      .listDockerContainerSnapshots()
      .then(setContainers)
      .catch(() => setContainers([]));
    if (pagesEnabled) {
      setProjectsLoading(true);
      void api
        .listPageProjects({ page: 1, limit: 100 })
        .then((response) => setProjects(response.data ?? []))
        .catch(() => setProjects([]))
        .finally(() => setProjectsLoading(false));
    } else {
      setProjects([]);
      setProjectsLoading(false);
    }
  }, [open, pagesEnabled, route]);

  useEffect(() => {
    if (!open) return;
    if (!draft.pageProjectId || !pagesEnabled) {
      setTags([]);
      setTagsLoading(false);
      return;
    }
    setTagsLoading(true);
    void api
      .listPageTags(draft.pageProjectId)
      .then(setTags)
      .catch(() => setTags([]))
      .finally(() => setTagsLoading(false));
  }, [draft.pageProjectId, open, pagesEnabled]);

  const selectedTag = useMemo(
    () => tags.find((tag) => tag.id === draft.pageTagId) ?? null,
    [draft.pageTagId, tags]
  );
  const pathError = validateAdditionalRoutePath(draft.path, existingRoutes, route?.id);
  const targetValid =
    draft.targetKind === "pages"
      ? !!draft.pageProjectId && !!draft.pageTagId && pageTagReady(selectedTag)
      : isProxyUpstreamValid(draft.upstream);

  const pageAvailability =
    !draft.pageProjectId || !draft.pageTagId
      ? { label: "Select a Project and Tag", variant: "secondary" as const }
      : !pageTagReady(selectedTag)
        ? { label: "Tag has no ready Deployment", variant: "warning" as const }
        : { label: "Ready", variant: "success" as const };

  const setTargetKind = (targetKind: ProxyAdditionalRouteTargetKind) => {
    setDraft((current) => ({
      ...current,
      targetKind,
      upstream: {
        ...DEFAULT_PROXY_UPSTREAM,
        scheme: current.upstream.scheme,
        kind: upstreamKindForTarget(targetKind),
      },
    }));
  };

  const save = async () => {
    if (pathError || !targetValid || saving) return;
    setSaving(true);
    const request = routeRequestFromDraft(draft);
    try {
      const saved = route
        ? await api.updateProxyAdditionalRoute(
            hostId,
            route.id,
            request as UpdateProxyAdditionalRouteRequest
          )
        : await api.createProxyAdditionalRoute(hostId, request);
      onSaved(saved);
      toast.success(route ? "Additional route updated" : "Additional route created");
      onOpenChange(false);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Failed to save additional route";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const resetAfterExit = (event: React.AnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.currentTarget.dataset.state !== "closed")
      return;
    window.setTimeout(() => setDraft(defaultDraft()), 100);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && saving) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        onAnimationEnd={resetAfterExit}
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{route ? "Edit Additional Route" : "Add Additional Route"}</DialogTitle>
          <DialogDescription>Choose a path prefix and its upstream target.</DialogDescription>
        </DialogHeader>

        <div className="border border-border">
          <SettingsControlRow title="Path prefix" description="Literal path prefix for this route.">
            <Input
              id="additional-route-path"
              value={draft.path}
              onChange={(event) =>
                setDraft((current) => ({ ...current, path: event.target.value }))
              }
              placeholder="/api"
              disabled={saving || Boolean(route)}
              aria-invalid={Boolean(pathError)}
            />
          </SettingsControlRow>
          <SettingsControlRow title="Target" description="Choose the destination for this path.">
            <Select
              value={draft.targetKind}
              onValueChange={(value) => {
                if (value === "pages" && !pagesEnabled) {
                  setPagesDisabledDialogOpen(true);
                  return;
                }
                setTargetKind(value as ProxyAdditionalRouteTargetKind);
              }}
              disabled={saving}
            >
              <SelectTrigger aria-label="Additional route target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Manual address</SelectItem>
                <SelectItem value="docker_container">Docker container</SelectItem>
                <SelectItem value="docker_deployment">Docker deployment</SelectItem>
                <SelectItem value="pages">Pages</SelectItem>
              </SelectContent>
            </Select>
          </SettingsControlRow>
          {draft.targetKind === "pages" ? (
            <PagesTargetPicker
              projectId={draft.pageProjectId}
              tagId={draft.pageTagId}
              onProjectChange={(projectId) =>
                setDraft((current) => ({ ...current, pageProjectId: projectId, pageTagId: "" }))
              }
              onTagChange={(pageTagId) => setDraft((current) => ({ ...current, pageTagId }))}
              projects={projects}
              tags={tags}
              projectsLoading={projectsLoading}
              tagsLoading={tagsLoading}
              availability={pagesEnabled ? pageAvailability : undefined}
              availabilityDescription="The selected Tag must point to a ready Deployment."
              disabled={saving || !pagesEnabled}
              selectedProjectLabel={
                route?.pageProjectName
                  ? `${route.pageProjectName} · ${route.pageProjectSlug ?? "Project"}`
                  : undefined
              }
              selectedTagLabel={route?.pageTagName ?? undefined}
            />
          ) : (
            <ProxyUpstreamFields
              value={draft.upstream}
              onChange={(upstream) => setDraft((current) => ({ ...current, upstream }))}
              containers={containers}
              disabled={saving || Boolean(route)}
              showTargetSelect={false}
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={!targetValid || Boolean(pathError) || saving}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
        <PagesFeatureDisabledDialog
          open={pagesDisabledDialogOpen}
          onOpenChange={setPagesDisabledDialogOpen}
        />
      </DialogContent>
    </Dialog>
  );
}
