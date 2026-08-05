import { AlertTriangle, ArrowRight, Info, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { PageTransition } from "@/components/common/PageTransition";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import { usePinnedDatabasesStore } from "@/stores/pinned-databases";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { usePinnedProxiesStore } from "@/stores/pinned-proxies";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import type {
  AuditLogEntry,
  DashboardStats,
  FinalizeSetupState,
  FinalizeSetupStep,
  LoggingMaintenanceSnapshot,
  Node,
  ProxyHost,
} from "@/types";
import type { InferenceSelfUsage } from "@/types/inference";
import { CertificateAuthoritiesCard } from "./dashboard/CertificateAuthoritiesCard";
import { CertificateExpiryCard, type ExpiringItem } from "./dashboard/CertificateExpiryCard";
import { FinalizeSetupDialog, type FinalizeSetupRootStep } from "./dashboard/FinalizeSetupDialog";
import {
  type AssistantSetupDraft,
  AssistantSetupWizard,
  EMPTY_ASSISTANT_SETUP_DRAFT,
} from "./dashboard/finalize-setup/AssistantSetupWizard";
import { InferenceSetupWizard } from "./dashboard/finalize-setup/InferenceSetupWizard";
import { IntegrationsSetupWizard } from "./dashboard/finalize-setup/IntegrationsSetupWizard";
import { InviteUsersSetupWizard } from "./dashboard/finalize-setup/InviteUsersSetupWizard";
import { MfaSetupWizard } from "./dashboard/finalize-setup/MfaSetupWizard";
import { NodeSetupWizard } from "./dashboard/finalize-setup/NodeSetupWizard";
import { HealthOverviewCard } from "./dashboard/HealthOverviewCard";
import { NodesCard } from "./dashboard/NodesCard";
import { PinnedNodeCard, WARN_THRESHOLD } from "./dashboard/PinnedNodeCard";
import { PinnedProxyCard } from "./dashboard/PinnedProxyCard";
import { PinnedDatabaseCard, PinnedDockerResourceCard } from "./dashboard/PinnedResourceCard";
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
  const dashboardPinnedIds = usePinnedNodesStore((s) => s.dashboardNodeIds);
  const sidebarPinnedNodeIds = usePinnedNodesStore((s) => s.sidebarNodeIds);
  const dashboardPinnedProxyIds = usePinnedProxiesStore((s) => s.dashboardProxyIds);
  const sidebarPinnedProxyIds = usePinnedProxiesStore((s) => s.sidebarProxyIds);
  const dashboardPinnedDatabaseIds = usePinnedDatabasesStore((s) => s.dashboardDatabaseIds);
  const sidebarPinnedDatabaseIds = usePinnedDatabasesStore((s) => s.sidebarDatabaseIds);
  const dashboardPinnedContainerIds = usePinnedContainersStore((s) => s.dashboardContainerIds);
  const sidebarPinnedContainerIds = usePinnedContainersStore((s) => s.sidebarContainerIds);
  const pinnedContainerMeta = usePinnedContainersStore((s) => s.containerMeta);
  const dashboardBootstrap = useDashboardBootstrapStore((s) => s.snapshot);
  const dashboardBootstrapLoading = useDashboardBootstrapStore((s) => s.loading);
  const dashboardBootstrapError = useDashboardBootstrapStore((s) => s.error);
  const loadDashboardBootstrap = useDashboardBootstrapStore((s) => s.load);
  const invalidateDashboardBootstrap = useDashboardBootstrapStore((s) => s.invalidate);
  const pkiEnabled = useSystemConfigStore((s) => s.config.features.pkiEnabled);
  const inferenceEnabled = useSystemConfigStore((s) => s.config.features.inferenceEnabled);
  const showUpdateNotifications = useUIStore((s) => s.showUpdateNotifications);
  const canViewSystemCertificates = useAuthStore((s) => s.hasScope("admin:details:certificates"));
  const showSystemCertificatePreference = useUIStore((s) => s.showSystemCertificates);
  const showSystemCertificates = canViewSystemCertificates && showSystemCertificatePreference;
  const dashboardBootstrapKey = useMemo(
    () =>
      JSON.stringify({
        userId: user?.id ?? null,
        scopes: [...(user?.scopes ?? [])].sort(),
        showSystemCertificates,
        showUpdateNotifications,
        dashboard: {
          nodeIds: dashboardPinnedIds,
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
      dashboardPinnedIds,
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
    if (!user?.id) return;
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
    void loadDashboardBootstrap(dashboardBootstrapKey, {
      showSystemCertificates,
      showUpdateNotifications,
      pins: {
        dashboard: {
          nodeIds: dashboardPinnedIds,
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
    dashboardBootstrapKey,
    dashboardPinnedContainerIds,
    dashboardPinnedDatabaseIds,
    dashboardPinnedIds,
    dashboardPinnedProxyIds,
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
  const [activity, setActivity] = useState<AuditLogEntry[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [healthHosts, setHealthHosts] = useState<ProxyHost[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [nodesLoading, setNodesLoading] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [expiringItems, setExpiringItems] = useState<ExpiringItem[]>([]);
  const [forcedExpiringItems, setForcedExpiringItems] = useState<ExpiringItem[] | null>(null);
  const [nodesList, setNodesList] = useState<Node[]>([]);
  const [pinnedProxyHosts, setPinnedProxyHosts] = useState<ProxyHost[]>([]);
  const [loggingHealth, setLoggingHealth] = useState<LoggingMaintenanceSnapshot | null>(null);
  const [finalizeSetup, setFinalizeSetup] = useState<FinalizeSetupState | null>(null);
  const [finalizeSetupOpen, setFinalizeSetupOpen] = useState(false);
  const [activeFinalizeWizard, setActiveFinalizeWizard] = useState<FinalizeSetupRootStep | null>(
    null
  );
  const [finalizeSetupBusy, setFinalizeSetupBusy] = useState(false);
  const [mfaStatus, setMfaStatus] = useState<{
    totpConfigured: boolean;
    passkeyCount: number;
    recoveryCodeCount: number;
    required: boolean;
  } | null>(null);
  const [showMfaOnboardingReminder, setShowMfaOnboardingReminder] = useState(false);
  const [mfaReminderOpen, setMfaReminderOpen] = useState(false);
  const [mfaReminderBusy, setMfaReminderBusy] = useState(false);
  const [inviteUserMethods, setInviteUserMethods] = useState<{
    password: boolean;
    emailOtp: boolean;
  } | null>(null);
  const [assistantDraft, setAssistantDraft] = useState<AssistantSetupDraft>(
    EMPTY_ASSISTANT_SETUP_DRAFT
  );
  const [returnToAssistant, setReturnToAssistant] = useState(false);
  const canViewNodeDetails = useCallback(
    (nodeId: string) => hasScope("nodes:details") || hasScope(`nodes:details:${nodeId}`),
    [hasScope]
  );
  const canViewProxyDetails = useCallback(
    (hostId: string) => hasScope("proxy:view") || hasScope(`proxy:view:${hostId}`),
    [hasScope]
  );
  const canViewInferenceUsage =
    inferenceEnabled && hasScope("inference:use") && hasScope("inference:usage:view:self");

  const refreshMfaState = useCallback(async () => {
    invalidateDashboardBootstrap();
  }, [invalidateDashboardBootstrap]);

  useEffect(() => {
    if (!dashboardBootstrap) return;
    setStats(dashboardBootstrap.stats);
    setHealthHosts(dashboardBootstrap.health as ProxyHost[]);
    setNodesList(dashboardBootstrap.nodes);
    setPinnedProxyHosts(dashboardBootstrap.pinned.dashboard.proxies);
    setActivity(dashboardBootstrap.activity as AuditLogEntry[]);
    setLoggingHealth(dashboardBootstrap.loggingHealth as LoggingMaintenanceSnapshot | null);
    setFinalizeSetup(dashboardBootstrap.finalizeSetup as FinalizeSetupState | null);
    setInviteUserMethods(dashboardBootstrap.inviteUserMethods);
    setMfaStatus(dashboardBootstrap.mfa);
    setShowMfaOnboardingReminder(Boolean(dashboardBootstrap.mfa?.showReminder));
    setExpiringItems(
      dashboardBootstrap.expiring.map((item) => ({
        ...item,
        daysLeft: Math.max(
          0,
          Math.ceil((new Date(item.expiresAt).getTime() - Date.now()) / 86_400_000)
        ),
      }))
    );
    setHealthLoading(false);
    setNodesLoading(false);
    setActivityLoading(false);
  }, [dashboardBootstrap]);

  const updateFinalizeSetupStep = useCallback(
    async (step: FinalizeSetupStep, status: "configured" | "skipped") => {
      const state = await api.updateFinalizeSetupStep(step, status);
      setFinalizeSetup(state);
      invalidateDashboardBootstrap();
      return state;
    },
    [invalidateDashboardBootstrap]
  );

  const completeFinalizeSetupStep = useCallback(
    async (
      step: Exclude<FinalizeSetupRootStep, "integrations">,
      status: "configured" | "skipped"
    ) => {
      setFinalizeSetupBusy(true);
      try {
        await updateFinalizeSetupStep(step, status);
        setActiveFinalizeWizard(null);
        setFinalizeSetupOpen(true);
      } finally {
        setFinalizeSetupBusy(false);
      }
    },
    [updateFinalizeSetupStep]
  );

  const dismissFinalizeSetup = useCallback(async () => {
    setFinalizeSetupBusy(true);
    try {
      await api.dismissFinalizeSetup();
      setFinalizeSetupOpen(false);
      // Keep the dialog mounted through Radix's closed-state animation.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
      setFinalizeSetup(null);
      await refreshMfaState();
    } finally {
      setFinalizeSetupBusy(false);
    }
  }, [refreshMfaState]);

  const openFinalizeWizard = useCallback((step: FinalizeSetupRootStep) => {
    setFinalizeSetupOpen(false);
    setActiveFinalizeWizard(step);
  }, []);

  const openStandaloneMfaSetup = useCallback(() => {
    setMfaReminderOpen(true);
  }, []);

  const hideMfaOnboardingReminder = useCallback(async () => {
    setMfaReminderBusy(true);
    try {
      await api.hideFinalizeSetupMfaReminder();
      await refreshMfaState();
    } finally {
      setMfaReminderBusy(false);
    }
  }, [refreshMfaState]);

  const mfaHasFactor = Boolean(mfaStatus?.totpConfigured || (mfaStatus?.passkeyCount ?? 0) > 0);
  const mfaRequired = Boolean(mfaStatus?.required && !mfaHasFactor);
  const mfaOnboardingReminder = Boolean(
    user?.authMethod !== "oidc" && showMfaOnboardingReminder && !mfaHasFactor && !mfaRequired
  );

  const finishInferenceWizard = useCallback(
    async (status: "configured" | "skipped") => {
      setFinalizeSetupBusy(true);
      try {
        await updateFinalizeSetupStep("inference", status);
        if (returnToAssistant) {
          setActiveFinalizeWizard("ai_assistant");
          setReturnToAssistant(false);
        } else {
          setActiveFinalizeWizard(null);
          setFinalizeSetupOpen(true);
        }
      } finally {
        setFinalizeSetupBusy(false);
      }
    },
    [returnToAssistant, updateFinalizeSetupStep]
  );

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

  const visibleHealthHosts = useMemo(
    () => healthHosts.filter((host) => canViewProxyDetails(host.id)),
    [canViewProxyDetails, healthHosts]
  );
  const visibleNodesForCards = useMemo(
    () => nodesList.filter((node) => canViewNodeDetails(node.id)),
    [canViewNodeDetails, nodesList]
  );

  const cas = dashboardBootstrap?.cas ?? [];
  const activeCAs = cas.filter((ca) => ca.status === "active").length;
  const totalCAs = cas.length;
  const totalCerts = cas.reduce((sum, ca) => sum + (ca.certCount || 0), 0);

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

  if (!dashboardBootstrap && dashboardBootstrapError) {
    return (
      <PageTransition>
        <div className="flex h-full min-h-[24rem] items-center justify-center p-6">
          <div className="max-w-sm space-y-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center border border-destructive/30 bg-destructive/5 mx-auto">
              <AlertTriangle className="h-6 w-6 text-destructive" />
            </div>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">Dashboard is temporarily unavailable</h1>
              <p className="text-sm text-muted-foreground">
                We could not load the latest dashboard data. Please try again.
              </p>
            </div>
            <Button onClick={invalidateDashboardBootstrap}>
              <RotateCw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </div>
        </div>
      </PageTransition>
    );
  }

  if (!dashboardBootstrap && (dashboardBootstrapLoading || !!user?.id)) {
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
          {dashboardBootstrap?.update?.updateAvailable &&
            dashboardBootstrap.update.latestVersion &&
            showUpdateNotifications && (
              <div className="border border-warning/60 bg-card">
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-warning">Update Available</span>
                    <span className="text-sm text-muted-foreground">
                      {dashboardBootstrap.update.latestVersion} is ready to install
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

          {mfaRequired && (
            <div className="border border-warning/50 bg-card">
              <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-warning">Set up MFA to keep access</p>
                    <p className="text-sm text-muted-foreground">
                      Your group now requires MFA. At your next login, you will need a passkey or
                      authenticator app. Set it up now to keep access uninterrupted.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="flex shrink-0 items-center gap-1 text-sm font-medium text-warning hover:underline"
                  onClick={openStandaloneMfaSetup}
                >
                  Set up MFA
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

          {mfaOnboardingReminder && (
            <div className="border border-warning/50 bg-card">
              <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-warning">Configure MFA</p>
                    <p className="text-sm text-muted-foreground">
                      Protect this administrator account with a passkey or authenticator app.
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <button
                    type="button"
                    className="text-sm font-medium text-muted-foreground hover:text-foreground hover:underline"
                    onClick={() => void hideMfaOnboardingReminder()}
                    disabled={mfaReminderBusy}
                  >
                    Hide
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-1 text-sm font-medium text-warning hover:underline"
                    onClick={openStandaloneMfaSetup}
                  >
                    Set up MFA
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {finalizeSetup && !mfaOnboardingReminder && (
            <div
              className="border bg-card"
              style={{ borderColor: "color-mix(in srgb, var(--color-link) 55%, transparent)" }}
            >
              <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <Info className="h-4 w-4 shrink-0 text-[color:var(--color-link)]" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[color:var(--color-link)]">
                      Finalize setup
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Connect infrastructure, secure your account, and enable optional Gateway
                      features.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="flex shrink-0 items-center gap-1 text-sm font-medium text-[color:var(--color-link)] hover:underline"
                  onClick={() => setFinalizeSetupOpen(true)}
                >
                  Open checklist
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

          <QuickStatsCard
            displayStats={displayStats}
            nodesList={nodesList}
            hasScope={hasScopedAccess}
            pkiEnabled={pkiEnabled}
          />

          <DashboardInferenceUsage
            enabled={canViewInferenceUsage}
            usage={dashboardBootstrap?.inferenceUsage as InferenceSelfUsage | null | undefined}
          />

          {/* Pinned Proxy Host Cards */}
          {pinnedProxyHosts
            .filter(
              (proxy) => dashboardPinnedProxyIds.includes(proxy.id) && canViewProxyDetails(proxy.id)
            )
            .map((proxy) => (
              <PinnedProxyCard key={proxy.id} proxy={proxy} />
            ))}

          {dashboardBootstrap?.pinned.dashboard.databases
            .filter((database) => dashboardPinnedDatabaseIds.includes(database.id))
            .map((database) => (
              <PinnedDatabaseCard key={database.id} database={database} />
            ))}

          {dashboardBootstrap?.pinned.dashboard.dockerResources
            .filter((resource) => dashboardPinnedContainerIds.includes(resource.id))
            .map((resource) => (
              <PinnedDockerResourceCard
                key={`${resource.kind}:${resource.id}`}
                resource={resource}
              />
            ))}

          {/* Pinned + Warning Node Overview Cards */}
          {visibleNodesForCards
            .filter((n) => {
              if (dashboardPinnedIds.includes(n.id)) return true;
              const disk = n.lastHealthReport?.diskMounts?.find((d) => d.mountPoint === "/");
              return disk ? disk.usagePercent >= WARN_THRESHOLD : false;
            })
            .map((node) => (
              <PinnedNodeCard key={node.id} node={node} />
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
        {finalizeSetup && (
          <>
            <FinalizeSetupDialog
              open={finalizeSetupOpen && activeFinalizeWizard === null}
              state={finalizeSetup}
              busy={finalizeSetupBusy}
              canInviteUsers={inviteUserMethods !== null}
              onOpenWizard={openFinalizeWizard}
              onDismiss={dismissFinalizeSetup}
            />
            <NodeSetupWizard
              open={activeFinalizeWizard === "nodes"}
              onBack={() => {
                setActiveFinalizeWizard(null);
                setFinalizeSetupOpen(true);
              }}
              onConfigured={() => completeFinalizeSetupStep("nodes", "configured")}
              onSkipped={() => completeFinalizeSetupStep("nodes", "skipped")}
            />
            {inviteUserMethods && (
              <InviteUsersSetupWizard
                open={activeFinalizeWizard === "invite_users"}
                methods={inviteUserMethods}
                onBack={() => {
                  setActiveFinalizeWizard(null);
                  setFinalizeSetupOpen(true);
                }}
                onConfigured={() => completeFinalizeSetupStep("invite_users", "configured")}
                onSkipped={() => completeFinalizeSetupStep("invite_users", "skipped")}
              />
            )}
            <AssistantSetupWizard
              open={activeFinalizeWizard === "ai_assistant"}
              draft={assistantDraft}
              onDraftChange={setAssistantDraft}
              onBack={() => {
                setActiveFinalizeWizard(null);
                setFinalizeSetupOpen(true);
              }}
              onConfigured={() => completeFinalizeSetupStep("ai_assistant", "configured")}
              onSkipped={() => completeFinalizeSetupStep("ai_assistant", "skipped")}
              onNeedInference={() => {
                setReturnToAssistant(true);
                setActiveFinalizeWizard("inference");
              }}
            />
            <InferenceSetupWizard
              open={activeFinalizeWizard === "inference"}
              onBack={() => {
                if (returnToAssistant) {
                  setActiveFinalizeWizard("ai_assistant");
                  setReturnToAssistant(false);
                } else {
                  setActiveFinalizeWizard(null);
                  setFinalizeSetupOpen(true);
                }
              }}
              onConfigured={() => finishInferenceWizard("configured")}
              onSkipped={() => finishInferenceWizard("skipped")}
            />
            <IntegrationsSetupWizard
              open={activeFinalizeWizard === "integrations"}
              state={finalizeSetup}
              onBack={() => {
                setActiveFinalizeWizard(null);
                setFinalizeSetupOpen(true);
              }}
              onStep={async (step, status) => {
                await updateFinalizeSetupStep(step, status);
              }}
            />
          </>
        )}
        <MfaSetupWizard
          open={activeFinalizeWizard === "mfa" || mfaReminderOpen}
          mode={mfaReminderOpen ? "standalone" : "onboarding"}
          onBack={() => {
            if (activeFinalizeWizard === "mfa") {
              setActiveFinalizeWizard(null);
              setFinalizeSetupOpen(true);
            } else {
              setMfaReminderOpen(false);
            }
          }}
          onConfigured={async () => {
            if (activeFinalizeWizard === "mfa" && finalizeSetup) {
              await completeFinalizeSetupStep("mfa", "configured");
              await refreshMfaState();
              return;
            }
            await refreshMfaState();
            setMfaReminderOpen(false);
          }}
          onSkipped={
            activeFinalizeWizard === "mfa" && finalizeSetup
              ? () => completeFinalizeSetupStep("mfa", "skipped")
              : undefined
          }
          allowSkip={activeFinalizeWizard === "mfa" && Boolean(finalizeSetup) && !mfaRequired}
        />
      </div>
    </PageTransition>
  );
}
