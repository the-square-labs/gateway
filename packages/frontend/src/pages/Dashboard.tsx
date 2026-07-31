import { AlertTriangle, ArrowRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { PageTransition } from "@/components/common/PageTransition";
import { useRealtime } from "@/hooks/use-realtime";
import { daysUntil } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import { useNodesStore } from "@/stores/nodes";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { usePinnedProxiesStore } from "@/stores/pinned-proxies";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import { useUpdateStore } from "@/stores/update";
import type {
  AuditLogEntry,
  DashboardStats,
  LoggingMaintenanceSnapshot,
  Node,
  NodeHealthReport,
  ProxyHost,
} from "@/types";
import { CertificateAuthoritiesCard } from "./dashboard/CertificateAuthoritiesCard";
import { CertificateExpiryCard, type ExpiringItem } from "./dashboard/CertificateExpiryCard";
import { HealthOverviewCard } from "./dashboard/HealthOverviewCard";
import { NodesCard } from "./dashboard/NodesCard";
import { PinnedNodeCard, WARN_THRESHOLD } from "./dashboard/PinnedNodeCard";
import { PinnedProxyCard } from "./dashboard/PinnedProxyCard";
import { QuickStatsCard } from "./dashboard/QuickStatsCard";
import { RecentActivityCard } from "./dashboard/RecentActivityCard";
import { DashboardInferenceUsage } from "./inference/InferenceUsagePanels";

type DashboardDevWindow = Window & {
  gatewayDev?: Record<string, unknown>;
  gatewayDevShowExpiringSoon?: () => void;
  gatewayDevHideExpiringSoon?: () => void;
};

function makeDevExpiringItems(): ExpiringItem[] {
  const makeItem = (id: string, name: string, daysLeft: number): ExpiringItem => ({
    id,
    name,
    type: "ssl",
    expiresAt: new Date(Date.now() + daysLeft * 24 * 60 * 60 * 1000).toISOString(),
    daysLeft,
  });

  return [
    makeItem("dev-expiring-preview", "backend.preview.pearldivergame.com", 15),
    makeItem("dev-expiring-staging", "backend.staging.pearldivergame.com", 15),
  ];
}

export function Dashboard() {
  const { user, hasScope, hasScopedAccess } = useAuthStore();
  const { cas, fetchCAs, isLoading: casLoading } = useCAStore();
  const nodeRefreshTick = useNodesStore((s) => s.refreshTick);
  const dashboardPinnedIds = usePinnedNodesStore((s) => s.dashboardNodeIds);
  const dashboardPinnedProxyIds = usePinnedProxiesStore((s) => s.dashboardProxyIds);
  const updateStatus = useUpdateStore((s) => s.status);
  const pkiEnabled = useSystemConfigStore((s) => s.config.features.pkiEnabled);
  const inferenceEnabled = useSystemConfigStore((s) => s.config.features.inferenceEnabled);
  const loggingEnabled = useSystemConfigStore((s) => s.config.features.loggingEnabled);
  const showUpdateNotifications = useUIStore((s) => s.showUpdateNotifications);
  const canViewSystemCertificates = useAuthStore((s) => s.hasScope("admin:details:certificates"));
  const showSystemCertificatePreference = useUIStore((s) => s.showSystemCertificates);
  const showSystemCertificates = canViewSystemCertificates && showSystemCertificatePreference;
  const cacheScopeKey = useMemo(
    () => `${user?.id ?? "anonymous"}:${[...(user?.scopes ?? [])].sort().join(",")}`,
    [user?.id, user?.scopes]
  );
  const statsCacheKey = `dashboard:stats:${cacheScopeKey}:${showSystemCertificates ? "system" : "default"}`;
  const healthCacheKey = `dashboard:health:${cacheScopeKey}`;
  const activityCacheKey = `dashboard:activity:${cacheScopeKey}`;
  const nodesCacheKey = `dashboard:nodes:${cacheScopeKey}`;
  const pinnedProxyIdsKey = useMemo(
    () => [...dashboardPinnedProxyIds].sort().join(","),
    [dashboardPinnedProxyIds]
  );
  const pinnedProxiesCacheKey = `dashboard:pinned-proxies:${cacheScopeKey}:${pinnedProxyIdsKey}`;
  const [activity, setActivity] = useState<AuditLogEntry[]>(
    () => api.getCached<AuditLogEntry[]>(activityCacheKey) ?? []
  );
  const [stats, setStats] = useState<DashboardStats | null>(
    () => api.getCached<DashboardStats>(statsCacheKey) ?? null
  );
  const [healthHosts, setHealthHosts] = useState<ProxyHost[]>(
    () => api.getCached<ProxyHost[]>(healthCacheKey) ?? []
  );
  const [statsLoading, setStatsLoading] = useState(
    () => api.getCached<DashboardStats>(statsCacheKey) === undefined
  );
  const [activityLoading, setActivityLoading] = useState(
    () => hasScope("admin:audit") && api.getCached<AuditLogEntry[]>(activityCacheKey) === undefined
  );
  const [nodesLoading, setNodesLoading] = useState(
    () => hasScopedAccess("nodes:details") && api.getCached<Node[]>(nodesCacheKey) === undefined
  );
  const [healthLoading, setHealthLoading] = useState(
    () => hasScopedAccess("proxy:view") && api.getCached<ProxyHost[]>(healthCacheKey) === undefined
  );
  const [expiringItems, setExpiringItems] = useState<ExpiringItem[]>([]);
  const [forcedExpiringItems, setForcedExpiringItems] = useState<ExpiringItem[] | null>(null);
  const [nodesList, setNodesList] = useState<Node[]>(
    () => api.getCached<Node[]>(nodesCacheKey) ?? []
  );
  const [pinnedProxyHosts, setPinnedProxyHosts] = useState<ProxyHost[]>(
    () => api.getCached<ProxyHost[]>(pinnedProxiesCacheKey) ?? []
  );
  const [loggingHealth, setLoggingHealth] = useState<LoggingMaintenanceSnapshot | null>(null);
  const canViewNodeDetails = useCallback(
    (nodeId: string) => hasScope("nodes:details") || hasScope(`nodes:details:${nodeId}`),
    [hasScope]
  );
  const canViewProxyDetails = useCallback(
    (hostId: string) => hasScope("proxy:view") || hasScope(`proxy:view:${hostId}`),
    [hasScope]
  );
  const canViewCAs =
    pkiEnabled && (hasScope("pki:ca:view:root") || hasScope("pki:ca:view:intermediate"));
  const canViewInferenceUsage =
    inferenceEnabled && hasScope("inference:use") && hasScope("inference:usage:view:self");
  const canViewLoggingHealth = loggingEnabled && hasScope("housekeeping:view");

  useEffect(() => {
    if (!canViewLoggingHealth) {
      setLoggingHealth(null);
      return;
    }
    let active = true;
    const refresh = () => {
      api
        .getLoggingHealth()
        .then((health) => {
          if (active) setLoggingHealth(health);
        })
        .catch(() => {});
    };
    refresh();
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [canViewLoggingHealth]);

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return;

    const win = window as DashboardDevWindow;
    const gatewayDev = (win.gatewayDev ??= {});
    const showExpiringSoon = () => setForcedExpiringItems(makeDevExpiringItems());
    const hideExpiringSoon = () => setForcedExpiringItems(null);

    gatewayDev.showExpiringSoon = showExpiringSoon;
    gatewayDev.hideExpiringSoon = hideExpiringSoon;
    win.gatewayDevShowExpiringSoon = showExpiringSoon;
    win.gatewayDevHideExpiringSoon = hideExpiringSoon;

    return () => {
      if (gatewayDev.showExpiringSoon === showExpiringSoon) delete gatewayDev.showExpiringSoon;
      if (gatewayDev.hideExpiringSoon === hideExpiringSoon) delete gatewayDev.hideExpiringSoon;
      if (win.gatewayDevShowExpiringSoon === showExpiringSoon)
        delete win.gatewayDevShowExpiringSoon;
      if (win.gatewayDevHideExpiringSoon === hideExpiringSoon)
        delete win.gatewayDevHideExpiringSoon;
    };
  }, []);

  const refreshNodes = useCallback(() => {
    if (!hasScopedAccess("nodes:details")) {
      setNodesList([]);
      setNodesLoading(false);
      return;
    }
    const cachedNodes = api.getCached<Node[]>(nodesCacheKey);
    if (cachedNodes) {
      setNodesList(cachedNodes);
      setNodesLoading(false);
    } else {
      setNodesList([]);
      setNodesLoading(true);
    }
    api
      .listNodes({ limit: 100 })
      .then((r) => {
        const nodes = r.data ?? [];
        api.setCache(nodesCacheKey, nodes);
        setNodesList(nodes);
      })
      .catch(() => {})
      .finally(() => setNodesLoading(false));
  }, [hasScopedAccess, nodesCacheKey]);

  const refreshStats = useCallback(() => {
    return api
      .getDashboardStats(showSystemCertificates)
      .then((data) => {
        api.setCache(statsCacheKey, data);
        setStats(data);
      })
      .catch(() => {});
  }, [showSystemCertificates, statsCacheKey]);

  const refreshHealthOverview = useCallback(() => {
    if (!hasScopedAccess("proxy:view")) {
      setHealthHosts([]);
      setHealthLoading(false);
      return Promise.resolve();
    }
    return api
      .getHealthOverview()
      .then((hosts) => {
        api.setCache(healthCacheKey, hosts || []);
        setHealthHosts(hosts || []);
      })
      .catch(() => {})
      .finally(() => setHealthLoading(false));
  }, [hasScopedAccess, healthCacheKey]);

  const refreshExpiringSSL = useCallback(() => {
    if (!hasScopedAccess("ssl:cert:view")) return Promise.resolve();
    return api
      .listSSLCertificates({
        status: "active",
        limit: 100,
        showSystem: showSystemCertificates,
      })
      .then((res) => {
        const expiring = (res.data || [])
          .filter((c) => c.notAfter && daysUntil(c.notAfter) <= 30 && daysUntil(c.notAfter) >= 0)
          .map((c) => ({
            id: c.id,
            name: c.name,
            type: "ssl" as const,
            expiresAt: c.notAfter!,
            daysLeft: daysUntil(c.notAfter!),
          }));
        setExpiringItems((prev) => [...prev.filter((i) => i.type !== "ssl"), ...expiring]);
      })
      .catch(() => {});
  }, [hasScopedAccess, showSystemCertificates]);

  const refreshExpiringPKI = useCallback(() => {
    if (!pkiEnabled || !hasScopedAccess("pki:cert:view")) {
      setExpiringItems((prev) => prev.filter((i) => i.type !== "pki"));
      return Promise.resolve();
    }
    return api
      .listCertificates({ status: "active", limit: 100, showSystem: showSystemCertificates })
      .then((res) => {
        const expiring = (res.data || [])
          .filter((c) => daysUntil(c.notAfter) <= 30 && daysUntil(c.notAfter) >= 0)
          .map((c) => ({
            id: c.id,
            name: c.commonName,
            type: "pki" as const,
            expiresAt: c.notAfter,
            daysLeft: daysUntil(c.notAfter),
          }));
        setExpiringItems((prev) => [...prev.filter((i) => i.type !== "pki"), ...expiring]);
      })
      .catch(() => {});
  }, [hasScopedAccess, pkiEnabled, showSystemCertificates]);

  const refreshPinnedProxies = useCallback(() => {
    if (dashboardPinnedProxyIds.length === 0) {
      setPinnedProxyHosts([]);
      return Promise.resolve();
    }
    if (!hasScopedAccess("proxy:view")) {
      setPinnedProxyHosts([]);
      return Promise.resolve();
    }
    return api
      .listProxyHosts({ limit: 100 })
      .then((r) => {
        const hosts = r.data ?? [];
        const visiblePinned = hosts.filter(
          (p) => dashboardPinnedProxyIds.includes(p.id) && canViewProxyDetails(p.id)
        );
        api.setCache(pinnedProxiesCacheKey, visiblePinned);
        setPinnedProxyHosts(visiblePinned);
      })
      .catch(() => {});
  }, [canViewProxyDetails, dashboardPinnedProxyIds, hasScopedAccess, pinnedProxiesCacheKey]);

  useEffect(() => {
    if (canViewCAs) {
      fetchCAs();
    }

    if (hasScope("admin:audit")) {
      const cachedActivity = api.getCached<AuditLogEntry[]>(activityCacheKey);
      if (cachedActivity) {
        setActivity(cachedActivity);
        setActivityLoading(false);
      } else {
        setActivity([]);
        setActivityLoading(true);
      }
      api
        .getAuditLog({ limit: 6 })
        .then((r) => {
          const next = r.data || [];
          api.setCache(activityCacheKey, next);
          setActivity(next);
        })
        .catch(() => {})
        .finally(() => setActivityLoading(false));
    } else {
      setActivity([]);
      setActivityLoading(false);
    }

    // Use cached stats immediately, then refetch
    const cachedStats = api.getCached<DashboardStats>(statsCacheKey);
    if (cachedStats) {
      setStats(cachedStats);
      setStatsLoading(false);
    } else {
      setStats(null);
      setStatsLoading(true);
    }
    refreshStats().finally(() => setStatsLoading(false));

    if (hasScopedAccess("proxy:view")) {
      const cachedHealth = api.getCached<ProxyHost[]>(healthCacheKey);
      if (cachedHealth) {
        setHealthHosts(cachedHealth);
      } else {
        setHealthHosts([]);
        setHealthLoading(true);
      }
      refreshHealthOverview();
    } else {
      setHealthHosts([]);
      setHealthLoading(false);
    }

    refreshExpiringSSL();
    refreshExpiringPKI();
  }, [
    activityCacheKey,
    fetchCAs,
    hasScope,
    hasScopedAccess,
    healthCacheKey,
    canViewCAs,
    refreshExpiringPKI,
    refreshExpiringSSL,
    refreshHealthOverview,
    refreshStats,
    statsCacheKey,
  ]);

  // Fetch/refetch nodes — also triggers on nodeRefreshTick from RealtimeBridge
  useEffect(() => {
    void nodeRefreshTick;
    refreshNodes();
  }, [refreshNodes, nodeRefreshTick]);

  useRealtime(hasScopedAccess("nodes:details") ? "node.changed" : null, () => {
    refreshNodes();
  });

  useRealtime(canViewCAs ? "ca.changed" : null, () => {
    fetchCAs();
    refreshStats();
  });

  useRealtime(hasScopedAccess("pki:cert:view") ? "cert.changed" : null, () => {
    if (canViewCAs) {
      fetchCAs();
    }
    refreshStats();
    refreshExpiringPKI();
  });

  useRealtime(hasScopedAccess("ssl:cert:view") ? "ssl.cert.changed" : null, () => {
    refreshStats();
    refreshExpiringSSL();
  });

  useRealtime(hasScopedAccess("proxy:view") ? "proxy.host.changed" : null, () => {
    refreshStats();
    refreshHealthOverview();
    refreshPinnedProxies();
  });

  // Fetch pinned proxy hosts
  useEffect(() => {
    refreshPinnedProxies();
  }, [refreshPinnedProxies]);

  // IDs of nodes shown on dashboard (pinned + disk warning)
  const warningNodeIds = useMemo(
    () =>
      nodesList
        .filter((n) => {
          if (!canViewNodeDetails(n.id)) return false;
          if (dashboardPinnedIds.includes(n.id)) return false;
          const disk = n.lastHealthReport?.diskMounts?.find((d) => d.mountPoint === "/");
          return disk ? disk.usagePercent >= WARN_THRESHOLD : false;
        })
        .map((n) => n.id),
    [canViewNodeDetails, dashboardPinnedIds, nodesList]
  );
  const dashboardVisibleIds = useMemo(
    () => [...dashboardPinnedIds.filter(canViewNodeDetails), ...warningNodeIds],
    [canViewNodeDetails, dashboardPinnedIds, warningNodeIds]
  );
  const visibleHealthHosts = useMemo(
    () => healthHosts.filter((host) => canViewProxyDetails(host.id)),
    [canViewProxyDetails, healthHosts]
  );
  const visibleNodesForCards = useMemo(
    () => nodesList.filter((node) => canViewNodeDetails(node.id)),
    [canViewNodeDetails, nodesList]
  );

  // Open monitoring SSE streams for visible dashboard nodes.
  const [pinnedHealth, setPinnedHealth] = useState<Record<string, NodeHealthReport>>({});
  const [nodeHealthHistory, setNodeHealthHistory] = useState<
    Record<string, Array<{ ts: string; status: string }>>
  >({});

  useEffect(() => {
    if (dashboardVisibleIds.length === 0) {
      setNodeHealthHistory({});
      return;
    }
    let cancelled = false;
    Promise.all(
      dashboardVisibleIds.map(async (nodeId) => {
        try {
          return [nodeId, await api.getNodeHealthHistory(nodeId)] as const;
        } catch {
          return [nodeId, []] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setNodeHealthHistory(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [dashboardVisibleIds]);

  useEffect(() => {
    if (!hasScopedAccess("nodes:details")) return;
    if (dashboardVisibleIds.length === 0) return;
    const streams: EventSource[] = [];
    for (const nodeId of dashboardVisibleIds) {
      const es = api.createNodeMonitoringStream(nodeId);
      es.addEventListener("snapshot", (e) => {
        try {
          const snap = JSON.parse((e as MessageEvent).data);
          if (snap.health) {
            setPinnedHealth((prev) => ({ ...prev, [nodeId]: snap.health }));
          }
        } catch {}
      });
      streams.push(es);
    }
    return () => streams.forEach((es) => es.close());
  }, [dashboardVisibleIds, hasScopedAccess]);

  // Collect expiring CAs from store
  useEffect(() => {
    if (!pkiEnabled) {
      setExpiringItems((prev) => prev.filter((i) => i.type !== "ca"));
      return;
    }
    const expiringCAs = (cas || [])
      .filter(
        (ca) =>
          ca.status === "active" && daysUntil(ca.notAfter) <= 30 && daysUntil(ca.notAfter) >= 0
      )
      .map((ca) => ({
        id: ca.id,
        name: ca.commonName,
        type: "ca" as const,
        expiresAt: ca.notAfter,
        daysLeft: daysUntil(ca.notAfter),
      }));
    setExpiringItems((prev) => [...prev.filter((i) => i.type !== "ca"), ...expiringCAs]);
  }, [cas, pkiEnabled]);

  // Derive fallback stats from CA store when API stats not available
  const activeCAs = (cas || []).filter((ca) => ca.status === "active").length;
  const totalCAs = (cas || []).length;
  const totalCerts = (cas || []).reduce((sum, ca) => sum + (ca.certCount || 0), 0);

  const displayStats: DashboardStats = stats ?? {
    proxyHosts: { total: 0, enabled: 0, online: 0, offline: 0, degraded: 0 },
    sslCertificates: { total: 0, active: 0, expiringSoon: 0, expired: 0 },
    pkiCertificates: { total: totalCerts, active: totalCerts, revoked: 0, expired: 0 },
    cas: { total: totalCAs, active: activeCAs },
  };
  const expiringItemsForCard = forcedExpiringItems ?? expiringItems;
  const hasExpiringItemScope = useCallback(
    (scope: string) => (forcedExpiringItems ? true : hasScopedAccess(scope)),
    [forcedExpiringItems, hasScopedAccess]
  );

  if (casLoading && statsLoading && !stats) {
    return <LoadingSpinner />;
  }

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6">
        <div className="mb-4">
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Gateway and PKI infrastructure overview</p>
        </div>
        <div className="space-y-6">
          {/* Update available */}
          {updateStatus?.updateAvailable &&
            updateStatus.latestVersion &&
            showUpdateNotifications && (
              <div className="border border-warning/60 bg-card">
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-warning">Update Available</span>
                    <span className="text-sm text-muted-foreground">
                      {updateStatus.latestVersion} is ready to install
                    </span>
                  </div>
                  <Link
                    to="/settings/gateway"
                    className="flex items-center gap-1 text-sm font-medium text-warning hover:underline"
                  >
                    Go to Settings
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </div>
            )}

          {loggingHealth && !["disabled", "healthy"].includes(loggingHealth.status) && (
            <div className="border border-warning/60 bg-card">
              <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-warning">
                      {loggingHealth.status === "exhausted"
                        ? "Structured logging capacity exhausted"
                        : loggingHealth.status === "unavailable"
                          ? "Structured logging unavailable"
                          : loggingHealth.status === "pressure"
                            ? "Structured logging storage is running low"
                            : "Structured logging maintenance degraded"}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">
                      {loggingHealth.reason ??
                        "Check ClickHouse storage health and maintenance settings."}
                    </p>
                  </div>
                </div>
                <Link
                  to="/settings/housekeeping"
                  className="flex shrink-0 items-center gap-1 text-sm font-medium text-warning hover:underline"
                >
                  Open Housekeeping
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>
          )}

          <QuickStatsCard
            displayStats={displayStats}
            nodesList={nodesList}
            hasScope={hasScopedAccess}
            pkiEnabled={pkiEnabled}
          />

          <DashboardInferenceUsage enabled={canViewInferenceUsage} />

          {/* Pinned Proxy Host Cards */}
          {pinnedProxyHosts
            .filter(
              (proxy) => dashboardPinnedProxyIds.includes(proxy.id) && canViewProxyDetails(proxy.id)
            )
            .map((proxy) => (
              <PinnedProxyCard key={proxy.id} proxy={proxy} />
            ))}

          {/* Pinned + Warning Node Overview Cards */}
          {visibleNodesForCards
            .filter((n) => {
              if (dashboardPinnedIds.includes(n.id)) return true;
              const disk = n.lastHealthReport?.diskMounts?.find((d) => d.mountPoint === "/");
              return disk ? disk.usagePercent >= WARN_THRESHOLD : false;
            })
            .map((node) => (
              <PinnedNodeCard
                key={node.id}
                node={node}
                liveHealth={pinnedHealth[node.id]}
                healthHistory={nodeHealthHistory[node.id]}
              />
            ))}

          <CertificateExpiryCard
            expiringItems={expiringItemsForCard}
            hasScope={hasExpiringItemScope}
          />

          <HealthOverviewCard
            healthHosts={visibleHealthHosts}
            hasScope={hasScopedAccess}
            loading={healthLoading}
          />

          <NodesCard
            nodesList={visibleNodesForCards}
            hasScope={hasScopedAccess}
            loading={nodesLoading}
          />

          {pkiEnabled && <CertificateAuthoritiesCard cas={cas} hasScope={hasScope} />}

          <RecentActivityCard activity={activity} hasScope={hasScope} loading={activityLoading} />
        </div>
      </div>
    </PageTransition>
  );
}
