import { Activity, Table2, Terminal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { PageTransition } from "@/components/common/PageTransition";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HealthBars } from "@/components/ui/health-bars";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { useUrlTab } from "@/hooks/use-url-tab";
import { databaseRoute } from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { usePinnedDatabasesStore } from "@/stores/pinned-databases";
import type { DatabaseConnection, DatabaseMetricSnapshot } from "@/types";
import { DatabaseConsoleTab } from "./database-detail/DatabaseConsoleTab";
import { DatabaseHeader } from "./database-detail/DatabaseHeader";
import { DatabaseOverviewTab } from "./database-detail/DatabaseOverviewTab";
import { DatabaseSettingsTab } from "./database-detail/DatabaseSettingsTab";
import { SqlExplorer } from "./database-detail/SqlExplorer";

export function DatabaseDetail({
  resolvedDatabaseId,
  resolvedDatabaseSlug,
}: {
  resolvedDatabaseId?: string;
  resolvedDatabaseSlug?: string;
} = {}) {
  const params = useParams<{ id?: string; databaseSlug?: string; tab?: string }>();
  const id = resolvedDatabaseId ?? params.id;
  const routeSlug = resolvedDatabaseSlug ?? params.databaseSlug ?? params.id ?? "";
  const navigate = useStableNavigate();
  const { hasScope } = useAuthStore();
  const [database, setDatabase] = useState<DatabaseConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveHealthHistory, setLiveHealthHistory] = useState<DatabaseConnection["healthHistory"]>(
    []
  );
  const [liveHealthStatus, setLiveHealthStatus] =
    useState<DatabaseConnection["healthStatus"]>("unknown");
  const [monitoringHistory, setMonitoringHistory] = useState<DatabaseMetricSnapshot[]>([]);
  const [monitoringLoading, setMonitoringLoading] = useState(true);
  const [pinOpen, setPinOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [explorerFocused, setExplorerFocused] = useState(false);
  const [revealedCredentials, setRevealedCredentials] = useState<Record<string, unknown> | null>(
    null
  );
  const [loadingCredentials, setLoadingCredentials] = useState(false);
  const { isPinnedSidebar, toggleSidebar } = usePinnedDatabasesStore();

  const canEdit = !!(id && (hasScope("databases:edit") || hasScope(`databases:edit:${id}`)));
  const canDelete = !!(id && (hasScope("databases:delete") || hasScope(`databases:delete:${id}`)));
  const canRead = !!(
    id &&
    (hasScope("databases:query:read") || hasScope(`databases:query:read:${id}`))
  );
  const canWrite = !!(
    id &&
    (hasScope("databases:query:write") || hasScope(`databases:query:write:${id}`))
  );
  const canAdmin = !!(
    id &&
    (hasScope("databases:query:admin") || hasScope(`databases:query:admin:${id}`))
  );
  const canReveal = !!(
    id &&
    (hasScope("databases:credentials:reveal") || hasScope(`databases:credentials:reveal:${id}`))
  );
  const canViewMonitoring = !!(
    id &&
    (hasScope("databases:view") || hasScope(`databases:view:${id}`))
  );

  const [activeTab, setActiveTab] = useUrlTab(
    ["overview", "explorer", "console"],
    "overview",
    (tab) => databaseRoute(routeSlug, tab)
  );

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [database, healthHistory] = await Promise.all([
        api.getDatabase(id),
        api.getDatabaseHealthHistory(id),
      ]);
      setDatabase(database);
      setLiveHealthHistory(healthHistory);
      setLiveHealthStatus(database.healthStatus);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load database");
      navigate("/databases");
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (
      ((database && !(database.capabilities?.catalogExplorer ?? database.type !== "redis")) ||
        liveHealthStatus === "offline") &&
      activeTab === "explorer"
    ) {
      setActiveTab("overview");
    }
  }, [activeTab, database, liveHealthStatus, setActiveTab]);

  useEffect(() => {
    if (liveHealthStatus === "offline" && activeTab === "console") {
      setActiveTab("overview");
    }
  }, [activeTab, liveHealthStatus, setActiveTab]);

  useEffect(() => {
    if (
      activeTab !== "explorer" ||
      (database && !(database.capabilities?.catalogExplorer ?? database.type !== "redis"))
    ) {
      setExplorerFocused(false);
    }
  }, [activeTab, database]);

  useEffect(() => {
    if (!database) return;
    setLiveHealthStatus(database.healthStatus);
    setMonitoringHistory([]);
    setMonitoringLoading(canViewMonitoring && database.healthStatus !== "offline");
  }, [canViewMonitoring, database]);

  useEffect(() => {
    if (!database || !canViewMonitoring) {
      setMonitoringLoading(false);
      return;
    }
    const es = api.createDatabaseMonitoringStream(database.id);
    es.addEventListener("connected", (event: MessageEvent) => {
      const message = JSON.parse(event.data);
      setLiveHealthHistory(message.healthHistory ?? database.healthHistory ?? []);
      setLiveHealthStatus(message.healthStatus ?? database.healthStatus);
      setMonitoringLoading(false);
    });
    es.addEventListener("history", (event: MessageEvent) => {
      const message = JSON.parse(event.data);
      setMonitoringHistory(message.history ?? []);
      setMonitoringLoading(false);
    });
    es.addEventListener("snapshot", (event: MessageEvent) => {
      const snapshot = JSON.parse(event.data) as DatabaseMetricSnapshot;
      setMonitoringHistory((prev) => [...prev, snapshot].slice(-60));
      setLiveHealthStatus(snapshot.status);
      setMonitoringLoading(false);
    });
    es.onerror = () => setMonitoringLoading(false);
    return () => es.close();
  }, [canViewMonitoring, database]);

  useRealtime(id ? "database.changed" : null, (payload) => {
    const event = payload as {
      id?: string;
      action?: string;
      healthStatus?: DatabaseConnection["healthStatus"];
      sampledAt?: string;
      oldSlug?: string;
      slug?: string;
    };
    if (!event || event.id !== id) return;
    if (event.oldSlug === routeSlug && event.slug) {
      navigate(databaseRoute(event.slug, activeTab), { replace: true });
      return;
    }
    if (event.action === "deleted") {
      navigate("/databases");
      return;
    }
    if (event.action === "health.sampled") {
      if (event.healthStatus) setLiveHealthStatus(event.healthStatus);
      if (event.sampledAt && event.healthStatus) {
        setLiveHealthHistory((prev) => [
          ...(prev ?? []),
          { ts: event.sampledAt!, status: event.healthStatus! },
        ]);
      }
      return;
    }
    if (
      event.action === "health.online" ||
      event.action === "health.degraded" ||
      event.action === "health.offline"
    ) {
      if (event.healthStatus) setLiveHealthStatus(event.healthStatus);
      return;
    }
    if (event.action === "data.updated" || event.action === "query.executed") return;
    void load();
  });

  const remove = async () => {
    if (!id || !database) return;
    const ok = await confirm({
      title: "Delete Database",
      description: `Delete saved connection "${database.name}"?`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await api.deleteDatabase(id);
      usePinnedDatabasesStore.getState().removePin(id);
      toast.success("Database deleted");
      navigate("/databases");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete database");
    }
  };

  const testConnection = async () => {
    if (!canEdit || !database) return;
    try {
      const result = await api.testDatabase(database.id);
      toast.success(`Connection OK in ${result.responseMs} ms`);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Connection test failed");
    }
  };

  const revealCredentials = async () => {
    if (!database || !canReveal) return;
    setCredentialsOpen(true);
    if (revealedCredentials) return;
    setLoadingCredentials(true);
    try {
      setRevealedCredentials(await api.revealDatabaseCredentials(database.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to reveal credentials");
    } finally {
      setLoadingCredentials(false);
    }
  };

  if (loading || !database) {
    return (
      <div className="flex items-center justify-center py-16">
        <LoadingSpinner className="" />
      </div>
    );
  }

  const isFullHeightTab = activeTab === "explorer" || activeTab === "console";
  const supportsExplorer = database.capabilities?.catalogExplorer ?? database.type !== "redis";
  const supportsConsole =
    (database.capabilities?.sqlConsole ?? database.type !== "redis") ||
    (database.capabilities?.commandConsole ?? database.type === "redis");
  const hideDatabaseChrome = explorerFocused && activeTab === "explorer" && supportsExplorer;
  const consoleDisabled = liveHealthStatus === "offline";
  const explorerDisabled = liveHealthStatus === "offline";

  return (
    <PageTransition>
      <div
        className={cn(
          hideDatabaseChrome
            ? "h-full flex flex-col overflow-hidden gap-0 p-0"
            : isFullHeightTab
              ? "h-full flex flex-col overflow-hidden gap-4 p-6"
              : "h-full overflow-y-auto p-6 space-y-4"
        )}
      >
        {!hideDatabaseChrome && (
          <>
            <DatabaseHeader
              database={database}
              healthStatus={liveHealthStatus}
              canEdit={canEdit}
              canReveal={canReveal}
              canDelete={canDelete}
              onOpenPin={() => setPinOpen(true)}
              onBack={() => navigate("/databases")}
              onTest={() => void testConnection()}
              onOpenSettings={() => setSettingsOpen(true)}
              onRevealCredentials={() => void revealCredentials()}
              onRemove={() => void remove()}
            />

            <HealthBars history={liveHealthHistory} currentStatus={liveHealthStatus} />
          </>
        )}

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className={cn("flex flex-col", isFullHeightTab && "flex-1 min-h-0")}
        >
          {!hideDatabaseChrome && (
            <TabsList className="shrink-0">
              <TabsTrigger value="overview" className="gap-1.5">
                <Activity className="h-3.5 w-3.5" />
                Overview
              </TabsTrigger>
              {canRead &&
                (supportsExplorer ? (
                  <TabsTrigger value="explorer" disabled={explorerDisabled} className="gap-1.5">
                    <Table2 className="h-3.5 w-3.5" />
                    Explorer
                  </TabsTrigger>
                ) : (
                  <TabsTrigger value="explorer" disabled className="gap-1.5">
                    <Table2 className="h-3.5 w-3.5" />
                    <span className="flex items-center gap-2">
                      Explorer
                      <Badge variant="secondary">SOON</Badge>
                    </span>
                  </TabsTrigger>
                ))}
              {(canRead || canWrite || canAdmin) && supportsConsole && (
                <TabsTrigger value="console" disabled={consoleDisabled} className="gap-1.5">
                  <Terminal className="h-3.5 w-3.5" />
                  Console
                </TabsTrigger>
              )}
            </TabsList>
          )}

          <TabsContent value="overview" className="space-y-4">
            <DatabaseOverviewTab
              database={database}
              canViewMonitoring={canViewMonitoring}
              healthStatus={liveHealthStatus}
              history={monitoringHistory}
              monitoringLoading={monitoringLoading}
            />
          </TabsContent>

          {canRead && (
            <TabsContent
              value="explorer"
              className={cn("flex flex-col flex-1 min-h-0", hideDatabaseChrome && "mt-0")}
            >
              {(database.type === "postgres" || database.type === "clickhouse") &&
              !explorerDisabled ? (
                <SqlExplorer
                  database={database}
                  canWrite={canWrite || canAdmin}
                  canAdmin={canAdmin}
                  focused={explorerFocused}
                  onToggleFocus={() => setExplorerFocused((current) => !current)}
                />
              ) : explorerDisabled ? (
                <div className="border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                  Explorer is unavailable while the database is offline.
                </div>
              ) : (
                <div className="border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                  Explorer is not available for this database provider.
                </div>
              )}
            </TabsContent>
          )}

          {(canRead || canWrite || canAdmin) && supportsConsole && !consoleDisabled && (
            <TabsContent
              value="console"
              className="space-y-4 flex flex-col flex-1 min-h-0 overflow-hidden"
            >
              <DatabaseConsoleTab database={database} />
            </TabsContent>
          )}
        </Tabs>
      </div>

      <Dialog open={credentialsOpen} onOpenChange={setCredentialsOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Stored Credentials</DialogTitle>
          </DialogHeader>
          <div className="border border-border bg-card overflow-hidden">
            {loadingCredentials ? (
              <div className="p-6 text-sm text-muted-foreground">Revealing credentials...</div>
            ) : (
              <pre className="overflow-x-auto p-4 text-sm whitespace-pre-wrap">
                {revealedCredentials
                  ? JSON.stringify(revealedCredentials, null, 2)
                  : "Credentials are hidden."}
              </pre>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={pinOpen} onOpenChange={setPinOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pin Database</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Add to sidebar</p>
                <p className="text-xs text-muted-foreground">Quick access link in the sidebar</p>
              </div>
              <Switch
                checked={isPinnedSidebar(database.id)}
                onChange={() => {
                  toggleSidebar(database.id, {
                    slug: database.slug,
                    name: database.name,
                    type: database.type,
                    healthStatus: liveHealthStatus,
                  });
                  usePinnedDatabasesStore.getState().invalidate();
                }}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {canEdit && (
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Database Settings</DialogTitle>
            </DialogHeader>
            <DatabaseSettingsTab
              database={database}
              onSaved={(updated) => {
                setSettingsOpen(false);
                setDatabase(updated);
                if (updated.slug !== routeSlug) {
                  navigate(databaseRoute(updated.slug, activeTab), { replace: true });
                } else {
                  void load();
                }
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </PageTransition>
  );
}
