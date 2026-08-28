import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Eye,
  GripVertical,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Settings as SettingsIcon,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type {
  DatabaseConnection,
  DockerComposeProjectSummary,
  DockerContainer,
  Node,
  PageProject,
  ProxyHost,
  StatusPageConfig,
  StatusPageIncident,
  StatusPageIncidentSeverity,
  StatusPageIncidentUpdateStatus,
  StatusPageServiceItem,
} from "@/types";
import {
  Field,
  getStatusPreviewUrl,
  IncidentDialog,
  ServiceDialog,
  statusBadge,
} from "./settings/StatusPageSection";
import { StatusPageSettingsTab } from "./status-page/StatusPageSettingsTab";

const TABS = [
  { value: "services", label: "Exposed Services", icon: ShieldCheck },
  { value: "incidents", label: "Incidents", icon: AlertTriangle },
  { value: "settings", label: "Settings", icon: SettingsIcon },
] as const;

const DEFAULT_CONFIG: StatusPageConfig = {
  enabled: false,
  title: "System Status",
  description: "",
  domain: "",
  nodeId: null,
  sslCertificateId: null,
  proxyTemplateId: null,
  upstreamUrl: null,
  proxyHostId: null,
  publicIncidentLimit: 25,
  recentIncidentDays: 14,
  autoDegradedEnabled: true,
  autoOutageEnabled: true,
  autoDegradedSeverity: "warning",
  autoOutageSeverity: "critical",
  autoCreateThresholdSeconds: 600,
  autoResolveThresholdSeconds: 60,
};
const INCIDENT_PAGE_SIZE = 20;

function findVerticalScrollParent(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null;
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return current;
    current = current.parentElement;
  }
  return null;
}

const INCIDENT_UPDATE_DEFAULT_MESSAGES: Record<StatusPageIncidentUpdateStatus, string> = {
  update:
    "We are continuing to investigate and will share more information as it becomes available.",
  investigating: "We are investigating reports of an issue affecting this service.",
  identified: "We have identified the cause and are working on a fix.",
  monitoring: "A fix has been applied and we are monitoring recovery.",
  resolved: "The incident has been resolved and service is operating normally.",
};

function normalizeDockerTarget(item: DockerContainer, node: Node): DockerContainer {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item as unknown as Record<string, unknown>)) {
    normalized[key.charAt(0).toLowerCase() + key.slice(1)] = value;
  }
  return {
    ...normalized,
    _nodeId: node.id,
    _nodeName: node.displayName || node.hostname,
  } as unknown as DockerContainer;
}

function incidentStatusLabel(status: StatusPageIncidentUpdateStatus) {
  return {
    update: "Info",
    investigating: "Investigating",
    identified: "Identified",
    monitoring: "Monitoring",
    resolved: "Resolved",
  }[status];
}

function displayIncidentUpdateStatus(
  incident: StatusPageIncident,
  update: StatusPageIncident["updates"][number],
  index: number
) {
  if (index === 0 && update.status === "investigating" && update.message === incident.message) {
    return "update";
  }
  return update.status;
}

function incidentSeverityBorderColor(severity: StatusPageIncidentSeverity) {
  if (severity === "critical") return "#f87171";
  if (severity === "warning") return "var(--color-warning)";
  return "#60a5fa";
}

function incidentUpdateMarkerClass(status: StatusPageIncidentUpdateStatus) {
  return {
    update: "bg-muted-foreground",
    investigating: "rotate-45 bg-warning",
    identified: "rotate-45 bg-blue-500",
    monitoring: "bg-emerald-500",
    resolved: "rounded-full bg-emerald-500",
  }[status];
}

function IncidentUpdateMarker({ status }: { status: StatusPageIncidentUpdateStatus }) {
  return (
    <span aria-hidden="true" className={`block h-2 w-2 ${incidentUpdateMarkerClass(status)}`} />
  );
}

function affectedServices(incident: StatusPageIncident, services: StatusPageServiceItem[]) {
  const byId = new Map(services.map((service) => [service.id, service]));
  return incident.affectedServiceIds
    .map((id) => byId.get(id))
    .filter((service): service is StatusPageServiceItem => Boolean(service));
}

export function StatusPage() {
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const { hasScope } = useAuthStore();
  const canView = hasScope("status-page:view");
  const canManage = hasScope("status-page:manage");
  const canCreateIncidents = hasScope("status-page:incidents:create");
  const canUpdateIncidents = hasScope("status-page:incidents:update");
  const canResolveIncidents = hasScope("status-page:incidents:resolve");
  const canDeleteIncidents = hasScope("status-page:incidents:delete");
  const activeTab = tabParam && TABS.some((tab) => tab.value === tabParam) ? tabParam : "services";

  const [config, setConfig] = useState<StatusPageConfig>(
    () => api.getCached<StatusPageConfig>("status-page:config") ?? DEFAULT_CONFIG
  );
  const [savedConfig, setSavedConfig] = useState<StatusPageConfig>(
    () => api.getCached<StatusPageConfig>("status-page:config") ?? DEFAULT_CONFIG
  );
  const [services, setServices] = useState<StatusPageServiceItem[]>(
    () => api.getCached<StatusPageServiceItem[]>("status-page:services") ?? []
  );
  const [incidents, setIncidents] = useState<StatusPageIncident[]>(
    () => api.getCached<StatusPageIncident[]>("status-page:incidents") ?? []
  );
  const [nodes, setNodes] = useState<Node[]>(
    () => api.getCached<Node[]>("status-page:source-nodes") ?? []
  );
  const [proxies, setProxies] = useState<ProxyHost[]>(
    () => api.getCached<ProxyHost[]>("status-page:source-proxies") ?? []
  );
  const [databases, setDatabases] = useState<DatabaseConnection[]>(
    () => api.getCached<DatabaseConnection[]>("status-page:source-databases") ?? []
  );
  const [dockerTargets, setDockerTargets] = useState<DockerContainer[]>(
    () => api.getCached<DockerContainer[]>("status-page:source-docker-targets") ?? []
  );
  const [composeProjects, setComposeProjects] = useState<DockerComposeProjectSummary[]>(
    () => api.getCached<DockerComposeProjectSummary[]>("status-page:source-compose-projects") ?? []
  );
  const [pageProjects, setPageProjects] = useState<PageProject[]>(
    () => api.getCached<PageProject[]>("status-page:source-page-projects") ?? []
  );
  const [loading, setLoading] = useState(
    () =>
      api.getCached<StatusPageConfig>("status-page:config") === undefined ||
      api.getCached<StatusPageServiceItem[]>("status-page:services") === undefined ||
      api.getCached<StatusPageIncident[]>("status-page:incidents") === undefined
  );
  const [sourceOptionsLoading, setSourceOptionsLoading] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [serviceOpen, setServiceOpen] = useState(false);
  const [editingService, setEditingService] = useState<StatusPageServiceItem | null>(null);
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [editingIncident, setEditingIncident] = useState<StatusPageIncident | null>(null);
  const [hasMoreIncidents, setHasMoreIncidents] = useState(false);
  const [loadingMoreIncidents, setLoadingMoreIncidents] = useState(false);
  const {
    open: updateIncidentOpen,
    value: updateIncident,
    setValue: setUpdateIncident,
    onOpenChange: onUpdateIncidentOpenChange,
  } = useDeferredDialogState<StatusPageIncident>();

  const loadSourceOptions = useCallback(async () => {
    setSourceOptionsLoading(true);
    try {
      const nodeRows = await api.listNodes({ limit: 100 }).then((res) => res.data ?? []);
      api.setCache("status-page:source-nodes", nodeRows);
      setNodes(nodeRows);
      const dockerNodes = nodeRows.filter((node) => node.type === "docker");
      const [dockerResults, proxyRows, databaseRows, composeRows, pageProjectRows] =
        await Promise.all([
          Promise.allSettled(
            dockerNodes.map(async (node) => {
              const rows = await api.listDockerContainers(node.id);
              return rows.map((row) => normalizeDockerTarget(row, node));
            })
          ),
          api.listProxyHosts({ limit: 100 }).then((res) => res.data ?? []),
          api.listDatabases({ limit: 200 }).then((res) => res.data ?? []),
          api.listDockerComposeProjects(),
          api.listPageProjects({ page: 1, limit: 100 }).then((res) => res.data ?? []),
        ]);
      const nextDockerTargets = dockerResults.flatMap((result) =>
        result.status === "fulfilled" ? result.value : []
      );
      api.setCache("status-page:source-docker-targets", nextDockerTargets);
      api.setCache("status-page:source-proxies", proxyRows);
      api.setCache("status-page:source-databases", databaseRows);
      api.setCache("status-page:source-compose-projects", composeRows);
      api.setCache("status-page:source-page-projects", pageProjectRows);
      setDockerTargets(nextDockerTargets);
      setProxies(proxyRows);
      setDatabases(databaseRows);
      setComposeProjects(composeRows);
      setPageProjects(pageProjectRows);
    } finally {
      setSourceOptionsLoading(false);
    }
  }, []);

  const loadStatusPage = useCallback(async () => {
    const cachedConfig = api.getCached<StatusPageConfig>("status-page:config");
    const cachedServices = api.getCached<StatusPageServiceItem[]>("status-page:services");
    const cachedIncidents = api.getCached<StatusPageIncident[]>("status-page:incidents");
    if (cachedConfig) {
      setConfig(cachedConfig);
      setSavedConfig(cachedConfig);
    }
    if (cachedServices) setServices(cachedServices);
    if (cachedIncidents) setIncidents(cachedIncidents);
    setLoading(!(cachedConfig && cachedServices && cachedIncidents));
    try {
      const [settings, serviceRows, incidentRows] = await Promise.all([
        api.getStatusPageSettings(),
        api.listStatusPageServices(),
        api.listStatusPageIncidents({ status: "all", limit: INCIDENT_PAGE_SIZE + 1, offset: 0 }),
      ]);
      const visibleIncidents = incidentRows.slice(0, INCIDENT_PAGE_SIZE);
      api.setCache("status-page:config", settings);
      api.setCache("status-page:services", serviceRows);
      api.setCache("status-page:incidents", visibleIncidents);
      setConfig(settings);
      setSavedConfig(settings);
      setServices(serviceRows);
      setIncidents(visibleIncidents);
      setHasMoreIncidents(incidentRows.length > INCIDENT_PAGE_SIZE);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load status page");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMoreIncidents = async () => {
    if (loadingMoreIncidents || !hasMoreIncidents) return;
    setLoadingMoreIncidents(true);
    try {
      const incidentRows = await api.listStatusPageIncidents({
        status: "all",
        limit: INCIDENT_PAGE_SIZE + 1,
        offset: incidents.length,
      });
      const nextPage = incidentRows.slice(0, INCIDENT_PAGE_SIZE);
      setIncidents((current) => {
        const knownIds = new Set(current.map((incident) => incident.id));
        const next = [...current, ...nextPage.filter((incident) => !knownIds.has(incident.id))];
        api.setCache("status-page:incidents", next);
        return next;
      });
      setHasMoreIncidents(incidentRows.length > INCIDENT_PAGE_SIZE);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load more incidents");
    } finally {
      setLoadingMoreIncidents(false);
    }
  };

  useEffect(() => {
    loadStatusPage();
  }, [loadStatusPage]);

  useEffect(() => {
    if (!serviceOpen) return;
    loadSourceOptions().catch(() => {});
  }, [loadSourceOptions, serviceOpen]);

  useRealtime("status-page.changed", () => {
    loadStatusPage();
  });
  useRealtime("docker.container.changed", () => {
    if (serviceOpen) loadSourceOptions().catch(() => {});
  });
  useRealtime("docker.deployment.changed", () => {
    if (serviceOpen) loadSourceOptions().catch(() => {});
  });
  useRealtime("docker.health.changed", () => {
    if (serviceOpen) loadSourceOptions().catch(() => {});
  });
  useRealtime("docker.compose.changed", () => {
    if (serviceOpen) loadSourceOptions().catch(() => {});
  });
  useRealtime("pages.project.changed", () => {
    if (serviceOpen) loadSourceOptions().catch(() => {});
  });
  useRealtime("pages.deployment.changed", () => {
    if (serviceOpen) loadSourceOptions().catch(() => {});
  });

  useEffect(() => {
    if (!tabParam || !TABS.some((tab) => tab.value === tabParam)) {
      navigate(`/status-page/${activeTab}`, { replace: true });
    }
  }, [activeTab, navigate, tabParam]);

  const groupedServices = useMemo(() => {
    const map = new Map<string, StatusPageServiceItem[]>();
    for (const service of services) {
      const group = service.publicGroup || "Ungrouped";
      map.set(group, [...(map.get(group) ?? []), service]);
    }
    return Array.from(map.entries());
  }, [services]);

  const reorderGroups = async (activeGroup: string, overGroup: string) => {
    if (!canManage || activeGroup === overGroup) return;
    const oldIndex = groupedServices.findIndex(([group]) => group === activeGroup);
    const newIndex = groupedServices.findIndex(([group]) => group === overGroup);
    if (oldIndex < 0 || newIndex < 0) return;

    const reorderedGroups = arrayMove(groupedServices, oldIndex, newIndex);
    const serviceIds = reorderedGroups.flatMap(([, groupServices]) =>
      groupServices.map((service) => service.id)
    );
    const orderById = new Map(serviceIds.map((id, sortOrder) => [id, sortOrder]));
    const previous = services;
    const optimistic = services
      .map((service) => ({ ...service, sortOrder: orderById.get(service.id) ?? service.sortOrder }))
      .sort((left, right) => left.sortOrder - right.sortOrder);
    setServices(optimistic);
    api.setCache("status-page:services", optimistic);

    try {
      const updated = await api.reorderStatusPageServices(serviceIds);
      setServices(updated);
      api.setCache("status-page:services", updated);
      toast.success("Service groups reordered");
    } catch (error) {
      setServices(previous);
      api.setCache("status-page:services", previous);
      toast.error(error instanceof Error ? error.message : "Failed to reorder service groups");
    }
  };

  if (!canView) return <Navigate to="/" replace />;

  const openCreateService = () => {
    if (!canManage) return;
    setEditingService(null);
    setServiceOpen(true);
  };

  const deleteService = async (service: StatusPageServiceItem) => {
    if (!canManage) return;
    const ok = await confirm({
      title: "Remove exposed service",
      description: `Remove "${service.publicName}" from the public status page?`,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    try {
      await api.deleteStatusPageService(service.id);
      toast.success("Service removed");
      loadStatusPage();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove service");
    }
  };

  const openCreateIncident = () => {
    if (!canCreateIncidents) return;
    setEditingIncident(null);
    setIncidentOpen(true);
  };

  const updateConfig = async (patch: Partial<StatusPageConfig>) => {
    if (!canManage) return;
    setSavingConfig(true);
    try {
      const updated = await api.updateStatusPageSettings(patch);
      api.setCache("status-page:config", updated);
      const persistedPatch = Object.fromEntries(
        (Object.keys(patch) as Array<keyof StatusPageConfig>).map((key) => [key, updated[key]])
      ) as Partial<StatusPageConfig>;
      setConfig((current) => ({ ...current, ...persistedPatch }));
      setSavedConfig(updated);
      toast.success("Status page details updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update status page details");
      loadStatusPage();
    } finally {
      setSavingConfig(false);
    }
  };

  const resolveIncident = async (incident: StatusPageIncident) => {
    if (!canResolveIncidents) return;
    try {
      await api.resolveStatusPageIncident(incident.id);
      toast.success("Incident resolved");
      loadStatusPage();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resolve incident");
    }
  };

  const promoteIncident = async (incident: StatusPageIncident) => {
    if (!canCreateIncidents) return;
    try {
      await api.promoteStatusPageIncident(incident.id);
      toast.success("Incident is now manually managed");
      loadStatusPage();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update incident");
    }
  };

  const deleteIncident = async (incident: StatusPageIncident) => {
    if (!canDeleteIncidents) return;
    const ok = await confirm({
      title: "Delete past incident",
      description: `Delete "${incident.title}" and its timeline from the status page?`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await api.deleteStatusPageIncident(incident.id);
      toast.success("Incident deleted");
      loadStatusPage();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete incident");
    }
  };

  const headerAction =
    activeTab === "services" && canManage ? (
      <Button onClick={openCreateService}>
        <Plus className="h-4 w-4" />
        Expose Service
      </Button>
    ) : activeTab === "incidents" && canCreateIncidents ? (
      <Button onClick={openCreateIncident}>
        <Plus className="h-4 w-4" />
        Create Incident
      </Button>
    ) : activeTab === "settings" ? (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={() => window.open(getStatusPreviewUrl(), "_blank", "noopener,noreferrer")}
        >
          <Eye className="h-4 w-4" />
          Preview
        </Button>
        {config.domain && (
          <Button
            variant="outline"
            onClick={() =>
              window.open(
                `${config.sslCertificateId ? "https" : "http"}://${config.domain}`,
                "_blank",
                "noopener,noreferrer"
              )
            }
          >
            <ExternalLink className="h-4 w-4" />
            Open
          </Button>
        )}
      </div>
    ) : null;
  const headerActions =
    activeTab === "services" && canManage
      ? [
          {
            label: "Expose Service",
            icon: <Plus className="h-4 w-4" />,
            onClick: openCreateService,
          },
        ]
      : activeTab === "incidents" && canCreateIncidents
        ? [
            {
              label: "Create Incident",
              icon: <Plus className="h-4 w-4" />,
              onClick: openCreateIncident,
            },
          ]
        : activeTab === "settings"
          ? [
              {
                label: "Preview",
                icon: <Eye className="h-4 w-4" />,
                onClick: () => window.open(getStatusPreviewUrl(), "_blank", "noopener,noreferrer"),
              },
              ...(config.domain
                ? [
                    {
                      label: "Open",
                      icon: <ExternalLink className="h-4 w-4" />,
                      onClick: () =>
                        window.open(
                          `${config.sslCertificateId ? "https" : "http"}://${config.domain}`,
                          "_blank",
                          "noopener,noreferrer"
                        ),
                    },
                  ]
                : []),
            ]
          : [];

  return (
    <PageTransition>
      <div className="h-full space-y-4 overflow-y-auto p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <LiteModeBackButton />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold">Status Page</h1>
                <Badge variant={config.enabled ? "success" : "secondary"} size="inline">
                  {config.enabled ? "Enabled" : "Disabled"}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Manage public services and incident communication
              </p>
            </div>
          </div>
          <ResponsiveHeaderActions actions={headerActions}>{headerAction}</ResponsiveHeaderActions>
        </div>

        {!config.enabled && !loading && (
          <div className="border border-border bg-card p-4">
            <p className="text-sm font-medium">Status page is disabled</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Enable it and configure the domain in Settings before publishing services or
              incidents.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => navigate("/settings")}
            >
              Open Settings
            </Button>
          </div>
        )}

        <Tabs
          value={activeTab}
          onValueChange={(value) => navigate(`/status-page/${value}`, { replace: true })}
        >
          <TabsList className="shrink-0">
            {TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="gap-1.5">
                <tab.icon className="h-3.5 w-3.5" />
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="services">
            <ServicesTab
              groupedServices={groupedServices}
              loading={loading}
              canManage={canManage}
              onEdit={(service) => {
                setEditingService(service);
                setServiceOpen(true);
              }}
              onDelete={deleteService}
              onReorderGroups={reorderGroups}
            />
          </TabsContent>

          <TabsContent value="incidents">
            <IncidentsTab
              incidents={incidents}
              services={services}
              loading={loading}
              canCreate={canCreateIncidents}
              canUpdate={canUpdateIncidents}
              canResolve={canResolveIncidents}
              canDelete={canDeleteIncidents}
              onEdit={(incident) => {
                setEditingIncident(incident);
                setIncidentOpen(true);
              }}
              onUpdate={setUpdateIncident}
              onResolve={resolveIncident}
              onPromote={promoteIncident}
              onDelete={deleteIncident}
              hasMore={hasMoreIncidents}
              loadingMore={loadingMoreIncidents}
              onLoadMore={loadMoreIncidents}
            />
          </TabsContent>

          <TabsContent value="settings">
            <StatusPageSettingsTab
              config={config}
              savedConfig={savedConfig}
              canManage={canManage}
              saving={savingConfig}
              onConfigChange={setConfig}
              onSave={updateConfig}
            />
          </TabsContent>
        </Tabs>

        <ServiceDialog
          open={serviceOpen}
          onOpenChange={setServiceOpen}
          service={editingService}
          services={services}
          nodes={nodes}
          proxies={proxies}
          databases={databases}
          dockerTargets={dockerTargets}
          composeProjects={composeProjects}
          pageProjects={pageProjects}
          sourceOptionsLoading={sourceOptionsLoading}
          onSaved={loadStatusPage}
        />
        <IncidentDialog
          open={incidentOpen}
          onOpenChange={setIncidentOpen}
          incident={editingIncident}
          services={services}
          onSaved={loadStatusPage}
        />
        <IncidentUpdateDialog
          open={updateIncidentOpen}
          incident={updateIncident}
          onOpenChange={onUpdateIncidentOpenChange}
          onSaved={loadStatusPage}
        />
      </div>
    </PageTransition>
  );
}

function ServicesTab({
  groupedServices,
  loading,
  canManage,
  onEdit,
  onDelete,
  onReorderGroups,
}: {
  groupedServices: Array<[string, StatusPageServiceItem[]]>;
  loading: boolean;
  canManage: boolean;
  onEdit: (service: StatusPageServiceItem) => void;
  onDelete: (service: StatusPageServiceItem) => void;
  onReorderGroups: (activeGroup: string, overGroup: string) => void;
}) {
  const initialLoading = useInitialLoading(loading);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const finishReorder = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    onReorderGroups(String(event.active.id), String(event.over.id));
  };

  if (initialLoading && groupedServices.length === 0) {
    return (
      <div className="space-y-4" aria-label="Loading status page services">
        {Array.from({ length: 2 }, (_, index) => (
          <PanelShell key={index} title={<Skeleton className="h-4 w-28" />}>
            <div className="space-y-3 p-4">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          </PanelShell>
        ))}
      </div>
    );
  }

  if (groupedServices.length === 0) {
    return (
      <div className="border border-border bg-card p-4 text-sm text-muted-foreground">
        No services exposed.
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={finishReorder}>
      <SortableContext
        items={groupedServices.map(([group]) => group)}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-4">
          {groupedServices.map(([group, services]) => (
            <SortableServiceGroup
              key={group}
              group={group}
              services={services}
              canManage={canManage}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableServiceGroup({
  group,
  services,
  canManage,
  onEdit,
  onDelete,
}: {
  group: string;
  services: StatusPageServiceItem[];
  canManage: boolean;
  onEdit: (service: StatusPageServiceItem) => void;
  onDelete: (service: StatusPageServiceItem) => void;
}) {
  const sortable = useSortable({ id: group, disabled: !canManage });

  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        zIndex: sortable.isDragging ? 10 : undefined,
      }}
      className={sortable.isDragging ? "relative opacity-70" : "relative"}
    >
      <PanelShell
        title={group}
        icon={
          canManage ? (
            <Button
              ref={sortable.setActivatorNodeRef}
              size="icon"
              variant="ghost"
              className="h-7 w-7 cursor-grab text-muted-foreground active:cursor-grabbing"
              aria-label={`Reorder ${group}`}
              {...sortable.attributes}
              {...sortable.listeners}
            >
              <GripVertical className="h-4 w-4" />
            </Button>
          ) : null
        }
        headerClassName="px-3 py-2"
      >
        <div className="divide-y divide-border">
          {services.map((service) => (
            <div
              key={service.id}
              role={canManage ? "button" : undefined}
              tabIndex={canManage ? 0 : undefined}
              aria-label={canManage ? `Open ${service.publicName} editor` : undefined}
              className={`flex items-center justify-between gap-3 p-3 transition-colors ${
                canManage
                  ? "cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                  : ""
              }`}
              onClick={() => {
                if (canManage) onEdit(service);
              }}
              onKeyDown={(event) => {
                if (!canManage || event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onEdit(service);
                }
              }}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">{service.publicName}</p>
                  <Badge variant={statusBadge(service.currentStatus) as never} size="inline">
                    {service.currentStatus}
                  </Badge>
                  {!service.enabled && (
                    <Badge variant="secondary" size="inline">
                      Hidden
                    </Badge>
                  )}
                  {service.broken && (
                    <Badge variant="warning" size="inline">
                      Source missing
                    </Badge>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {service.source?.label || "Missing source"}
                </p>
              </div>
              {canManage && (
                <div
                  className="flex items-center gap-1"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Edit ${service.publicName}`}
                    onClick={() => onEdit(service)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${service.publicName}`}
                    onClick={() => onDelete(service)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </PanelShell>
    </div>
  );
}

function IncidentsTab({
  incidents,
  services,
  loading,
  canCreate,
  canUpdate,
  canResolve,
  canDelete,
  onEdit,
  onUpdate,
  onResolve,
  onPromote,
  onDelete,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  incidents: StatusPageIncident[];
  services: StatusPageServiceItem[];
  loading: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canResolve: boolean;
  canDelete: boolean;
  onEdit: (incident: StatusPageIncident) => void;
  onUpdate: (incident: StatusPageIncident) => void;
  onResolve: (incident: StatusPageIncident) => void;
  onPromote: (incident: StatusPageIncident) => void;
  onDelete: (incident: StatusPageIncident) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const initialLoading = useInitialLoading(loading);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const getScrollElement = useCallback(() => findVerticalScrollParent(listRef.current), []);
  const virtualizer = useVirtualizer({
    count: incidents.length + (hasMore ? 1 : 0),
    getScrollElement,
    estimateSize: (index) => (index === incidents.length ? 44 : 330),
    overscan: 3,
    getItemKey: (index) => incidents[index]?.id ?? "incident-loader",
    scrollMargin,
    initialRect: { width: 1024, height: 720 },
  });

  useLayoutEffect(() => {
    const updateScrollMargin = () => {
      const list = listRef.current;
      const scroller = getScrollElement();
      if (!list || !scroller) return;
      setScrollMargin(
        list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      );
    };
    updateScrollMargin();
    window.addEventListener("resize", updateScrollMargin);
    return () => window.removeEventListener("resize", updateScrollMargin);
  }, [getScrollElement]);

  const virtualItems = virtualizer.getVirtualItems();
  const lastVirtualItemIndex = virtualItems.at(-1)?.index;

  useEffect(() => {
    if (
      lastVirtualItemIndex !== undefined &&
      lastVirtualItemIndex >= incidents.length - 1 &&
      hasMore &&
      !loadingMore
    ) {
      onLoadMore();
    }
  }, [hasMore, incidents.length, lastVirtualItemIndex, loadingMore, onLoadMore]);

  if (initialLoading && incidents.length === 0) {
    return (
      <div className="space-y-3" aria-label="Loading status page incidents">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="space-y-3 border border-border bg-card p-4">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ))}
      </div>
    );
  }

  if (incidents.length === 0) {
    return (
      <div className="border border-border bg-card p-4 text-sm text-muted-foreground">
        No incidents.
      </div>
    );
  }

  return (
    <div ref={listRef} aria-label="Status page incidents">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((virtualItem) => {
          const incident = incidents[virtualItem.index];
          if (!incident) {
            return (
              <div
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                className={`absolute left-0 top-0 flex w-full items-center justify-center text-xs text-muted-foreground ${
                  loadingMore ? "py-3" : "h-px"
                }`}
                style={{ transform: `translateY(${virtualItem.start - scrollMargin}px)` }}
                role={loadingMore ? "status" : undefined}
                aria-hidden={loadingMore ? undefined : true}
              >
                {loadingMore ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {loadingMore ? "Loading incidents…" : null}
              </div>
            );
          }

          const affected = affectedServices(incident, services);
          const canPromoteIncident =
            canCreate && incident.type === "automatic" && incident.autoManaged;
          const canResolveIncident = canResolve && incident.status === "active";
          const canDeleteIncident = canDelete && incident.status === "resolved";
          const hasPrimaryActions = canPromoteIncident || canUpdate;
          const hasActions =
            canPromoteIncident || canUpdate || canResolveIncident || canDeleteIncident;
          const events = incident.updates?.length
            ? incident.updates
            : [
                {
                  id: `${incident.id}:initial`,
                  status: "update" as const,
                  message: incident.message,
                  createdAt: incident.startedAt,
                },
              ];
          return (
            <div
              key={virtualItem.key}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              className="absolute left-0 top-0 w-full pb-3"
              style={{ transform: `translateY(${virtualItem.start - scrollMargin}px)` }}
            >
              <div
                className="border border-l-4 border-border bg-card"
                style={
                  incident.status === "active"
                    ? { borderLeftColor: incidentSeverityBorderColor(incident.severity) }
                    : undefined
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <div className="flex min-h-7 flex-wrap items-center gap-2">
                      <Badge variant={statusBadge(incident.severity) as never} size="inline">
                        {incident.severity}
                      </Badge>
                      <Badge
                        variant={incident.status === "active" ? "warning" : "secondary"}
                        size="inline"
                      >
                        {incident.status}
                      </Badge>
                      {incident.type === "automatic" && (
                        <Badge variant="secondary" size="inline">
                          AUTO
                        </Badge>
                      )}
                      <h2 className="m-0 translate-y-px text-sm font-medium leading-none">
                        {incident.title}
                      </h2>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className="text-xs text-muted-foreground">
                      {new Date(incident.startedAt).toLocaleString()}
                    </span>
                    {hasActions && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" aria-label="Incident actions">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {canPromoteIncident && (
                            <DropdownMenuItem onClick={() => onPromote(incident)}>
                              <ShieldCheck className="h-4 w-4" />
                              Promote
                            </DropdownMenuItem>
                          )}
                          {canUpdate && (
                            <>
                              <DropdownMenuItem onClick={() => onUpdate(incident)}>
                                <Plus className="h-4 w-4" />
                                Post Update
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => onEdit(incident)}>
                                <Pencil className="h-4 w-4" />
                                Edit Details
                              </DropdownMenuItem>
                            </>
                          )}
                          {canResolveIncident && (
                            <>
                              {hasPrimaryActions && <DropdownMenuSeparator />}
                              <DropdownMenuItem onClick={() => onResolve(incident)}>
                                <CheckCircle2 className="h-4 w-4" />
                                Resolve
                              </DropdownMenuItem>
                            </>
                          )}
                          {canDeleteIncident && (
                            <>
                              {hasPrimaryActions && <DropdownMenuSeparator />}
                              <DropdownMenuItem
                                onClick={() => onDelete(incident)}
                                className="text-destructive"
                              >
                                <Trash2 className="h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>

                <div className="border-t border-border p-4">
                  <p className="text-xs font-medium text-muted-foreground">Affected services</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {affected.length > 0 ? (
                      affected.map((service) => (
                        <span
                          key={service.id}
                          className="border border-border bg-muted px-2 py-1 text-xs text-muted-foreground"
                        >
                          {service.publicName}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        No affected services selected
                      </span>
                    )}
                  </div>
                </div>

                <div className="border-t border-border p-4">
                  <p className="text-xs font-medium text-muted-foreground">Timeline</p>
                  <div className="mt-3 space-y-6">
                    {events.map((update, index) => {
                      const displayStatus = displayIncidentUpdateStatus(incident, update, index);
                      const showConnector =
                        index < events.length - 1 || incident.status === "active";
                      return (
                        <div
                          key={update.id}
                          className="relative grid grid-cols-[22px_minmax(0,1fr)] gap-3"
                        >
                          {showConnector && (
                            <span
                              className={`absolute left-[10px] top-[19px] w-px bg-border ${
                                index === events.length - 1 ? "bottom-[3px]" : "-bottom-[21px]"
                              }`}
                            />
                          )}
                          <span className="relative top-[-3px] z-10 flex h-[22px] w-[22px] items-center justify-center">
                            <IncidentUpdateMarker status={displayStatus} />
                          </span>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <span>{new Date(update.createdAt).toLocaleString()}</span>
                              <span className="font-medium text-foreground">
                                {incidentStatusLabel(displayStatus)}
                              </span>
                            </div>
                            <p className="mt-1 text-[0.94rem] leading-6">{update.message}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IncidentUpdateDialog({
  open,
  incident,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  incident: StatusPageIncident | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<StatusPageIncidentUpdateStatus>("update");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!incident) return;
    setStatus("update");
    setMessage(INCIDENT_UPDATE_DEFAULT_MESSAGES.update);
  }, [incident]);

  const selectStatus = (nextStatus: StatusPageIncidentUpdateStatus) => {
    setStatus(nextStatus);
    setMessage(INCIDENT_UPDATE_DEFAULT_MESSAGES[nextStatus]);
  };

  const save = async () => {
    if (!incident) return;
    try {
      await api.createStatusPageIncidentUpdate(incident.id, {
        status,
        message: message.trim(),
      });
      toast.success("Incident update posted");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to post incident update");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Post Incident Update</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Event state">
            <Select
              value={status}
              onValueChange={(value) => selectStatus(value as StatusPageIncidentUpdateStatus)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="update">Update</SelectItem>
                <SelectItem value="investigating">Investigating</SelectItem>
                <SelectItem value="identified">Identified</SelectItem>
                <SelectItem value="monitoring">Monitoring</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Message">
            <Textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              className="min-h-28"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!message.trim()}>
            Post Update
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
