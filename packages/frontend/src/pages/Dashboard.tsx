import { AlertTriangle, ArrowUpCircle, Info, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { refreshDynamicScopes } from "@/lib/live-scopes";
import { formatRelativeDate } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import { usePinnedDatabasesStore } from "@/stores/pinned-databases";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { usePinnedProxiesStore } from "@/stores/pinned-proxies";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type {
  AuditLogEntry,
  DashboardRelaySnapshot,
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
import { DashboardNotice, DashboardNoticeAction } from "./dashboard/DashboardNotice";
import { FinalizeSetupDialog, type FinalizeSetupRootStep } from "./dashboard/FinalizeSetupDialog";
import { ConfigureAIWorkspaceWizard } from "./dashboard/finalize-setup/ConfigureAIWorkspaceWizard";
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

function isFinalizeSetupComplete(state: FinalizeSetupState): boolean {
  return Object.values(state.steps).every((status) => status !== "pending");
}

function relayReasonLabel(reason: string | null | undefined): string {
  return reason ? reason.replaceAll("_", " ") : "Not reported";
}

function relayImageSummary(image: string | null | undefined): string {
  if (!image) return "Not reported";
  const [repository, digest] = image.split("@sha256:");
  const name = repository?.split("/").at(-1) || repository;
  return digest ? `${name}@sha256:${digest.slice(0, 12)}…` : image;
}

function relayNoticeContent(relay: DashboardRelaySnapshot) {
  if (relay.state === "critical") {
    return {
      title: "Gateway relay is unavailable",
      summary: "Managed nodes and secure database connections are disconnected.",
      description: "Automatic recovery failed. Immediate administrator action is required.",
    };
  }
  if (relay.state === "recovering") {
    return {
      title: "Gateway relay recovery in progress",
      summary: `Recovery attempt ${relay.attempt} of ${relay.maxAttempts} is in progress.`,
      description:
        "Secure database connections are temporarily unavailable while Gateway recovers the relay.",
    };
  }
  if (relay.state === "degraded") {
    return {
      title: "Gateway relay management needs attention",
      summary: "Relay runtime ownership could not be verified.",
      description: "Traffic may continue, but automatic container recovery is unavailable.",
    };
  }
  if (relay.state === "maintenance") {
    return {
      title: "Gateway relay maintenance in progress",
      summary: "Secure database connections are temporarily unavailable.",
      description:
        "Gateway is updating the relay and will restore connections when maintenance completes.",
    };
  }
  return {
    title: "Gateway relay activation in progress",
    summary: "Secure database connections may be temporarily unavailable.",
    description:
      "Gateway is activating the standalone relay required for managed database connections.",
  };
}

export function RelayHealthNotice({
  relay,
  isAdmin,
  retryPending,
  onRetry,
}: {
  relay: DashboardRelaySnapshot | null;
  isAdmin: boolean;
  retryPending: boolean;
  onRetry: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (
    !relay ||
    !["migration_pending", "maintenance", "recovering", "degraded", "critical"].includes(
      relay.state
    )
  ) {
    return null;
  }
  const critical = relay.state === "critical";
  const copy = relayNoticeContent(relay);
  const diagnostics = [
    { label: "Reason", value: relayReasonLabel(relay.reason) },
    {
      label: "Last healthy",
      value: relay.lastHealthyAt ? formatRelativeDate(relay.lastHealthyAt) : "Never",
    },
    {
      label: "Last probe",
      value: relay.lastProbeAt ? formatRelativeDate(relay.lastProbeAt) : "Not reported",
    },
    {
      label: "Versions",
      value: `relay ${relay.relayBuildVersion ?? "?"}, protocol ${relay.protocolMajor ?? "?"}`,
    },
    { label: "Service", value: relay.expectedService ?? "relay" },
    {
      label: "Image",
      value: relayImageSummary(relay.expectedImage),
      title: relay.expectedImage ?? undefined,
      breakAll: true,
    },
    ...(relay.attemptHistory && relay.attemptHistory.length > 0
      ? [
          {
            label: "Attempts",
            value: relay.attemptHistory
              .map(
                (attempt) => `#${attempt.attempt} ${attempt.action ?? "check"} ${attempt.result}`
              )
              .join(" · "),
          },
        ]
      : []),
  ];
  const tone = critical ? "destructive" : "warning";
  return (
    <>
      <DashboardNotice
        tone={tone}
        role={critical ? "alert" : "status"}
        aria-live="polite"
        title={copy.title}
        actions={
          <DashboardNoticeAction tone={tone} onClick={() => setDetailsOpen(true)}>
            View details
          </DashboardNoticeAction>
        }
      >
        <p className="text-sm text-muted-foreground">{copy.summary}</p>
      </DashboardNotice>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className={isAdmin ? "sm:max-w-lg" : "sm:max-w-md"}>
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
          </DialogHeader>

          {isAdmin ? <DialogDescription>{copy.description}</DialogDescription> : null}

          {isAdmin ? (
            <div className="border border-border bg-muted/40">
              <table className="w-full table-fixed text-sm">
                <tbody className="divide-y divide-border">
                  {diagnostics.map((diagnostic) => (
                    <tr key={diagnostic.label}>
                      <th
                        scope="row"
                        className="w-32 px-3 py-2.5 text-left align-top font-normal text-muted-foreground"
                      >
                        {diagnostic.label}
                      </th>
                      <td
                        className={`px-3 py-2.5 align-top text-foreground ${diagnostic.breakAll ? "break-all" : "break-words"}`}
                        title={diagnostic.title}
                      >
                        {diagnostic.value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="space-y-3 text-sm text-muted-foreground">
              <DialogDescription>{copy.description}</DialogDescription>
              <p>
                {critical
                  ? "Please contact your administrator to restore managed nodes and secure database connections."
                  : "Gateway is handling this automatically. No action is required unless this message remains visible."}
              </p>
            </div>
          )}

          {critical && isAdmin ? (
            <DialogFooter>
              <Button
                variant="destructive"
                pending={retryPending}
                disabled={relay.canRetry !== true}
                onClick={onRetry}
              >
                {retryPending ? null : <RotateCw />}
                {retryPending ? "Retrying recovery" : "Retry recovery"}
              </Button>
            </DialogFooter>
          ) : !isAdmin ? (
            <DialogFooter>
              <Button onClick={() => setDetailsOpen(false)}>Close</Button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatGraceRemaining(deadline: number, now: number): string {
  const totalMinutes = Math.max(0, Math.ceil((deadline - now) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`]
    .filter(Boolean)
    .join(" ");
}

export function LicenseGraceNotice({
  graceUntil,
  canManage,
}: {
  graceUntil: string | null;
  canManage: boolean;
}) {
  const invalidateLicense = useUIBootstrapStore((state) => state.invalidate);
  const deadline = graceUntil ? new Date(graceUntil).getTime() : Number.NaN;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!Number.isFinite(deadline) || deadline <= Date.now()) return;
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    const timeout = window.setTimeout(
      () => {
        setNow(Date.now());
        invalidateLicense();
      },
      Math.min(deadline - Date.now() + 50, 2_147_483_647)
    );
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [deadline, invalidateLicense]);

  if (!Number.isFinite(deadline) || deadline <= now) return null;
  const absolute = new Date(deadline).toLocaleString();

  return (
    <DashboardNotice
      tone="destructive"
      role="alert"
      aria-live="polite"
      title="Gateway license has expired"
      actions={
        canManage ? (
          <DashboardNoticeAction
            tone="destructive"
            to="/settings/general"
            state={{ scrollTarget: "gateway-license" }}
          >
            Update license key
          </DashboardNoticeAction>
        ) : null
      }
    >
      <p className="text-sm text-muted-foreground">
        Paid features remain available until {absolute} (
        <span aria-live="off">{formatGraceRemaining(deadline, now)} remaining</span>).
      </p>
      {!canManage ? (
        <p className="text-sm text-muted-foreground">
          Contact your administrator before the grace period ends.
        </p>
      ) : null}
    </DashboardNotice>
  );
}

/** Holds the page gate until the first dashboard snapshot arrives. */
function DashboardSkeleton() {
  return (
    <PageTransition>
      <div className="h-full" aria-busy="true" aria-label="Loading dashboard">
        <Skeleton />
      </div>
    </PageTransition>
  );
}

export function Dashboard() {
  const navigate = useNavigate();
  const { user, hasScope, hasScopedAccess, logout } = useAuthStore();
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
    sessionMfaSatisfied: boolean;
    graceExpiresAt: number | null;
  } | null>(null);
  const [showMfaOnboardingReminder, setShowMfaOnboardingReminder] = useState(false);
  const [mfaReminderOpen, setMfaReminderOpen] = useState(false);
  const [mfaReminderBusy, setMfaReminderBusy] = useState(false);
  const [inviteUserMethods, setInviteUserMethods] = useState<{
    password: boolean;
    emailOtp: boolean;
  } | null>(null);
  const [relayRetryPending, setRelayRetryPending] = useState(false);
  // Keep the page and sidebar on the same bootstrap generation. The session-wide
  // realtime bridge invalidates this snapshot on node changes, so a recovered node
  // cannot turn the page green before the sidebar attention state is refreshed.
  const canViewInferenceUsage = inferenceEnabled && hasScope("feat:ai:use");

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
    // Row links and actions use the cached scopes: let them catch up with folder grants.
    void refreshDynamicScopes();
    setExpiringItems(
      dashboardBootstrap.expiring.map((item) => ({
        ...item,
        daysLeft: Math.max(
          0,
          Math.ceil((new Date(item.expiresAt).getTime() - Date.now()) / 86_400_000)
        ),
      }))
    );
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

  const skipFinalizeSetupForNow = useCallback(() => {
    setFinalizeSetupOpen(false);
  }, []);

  const openFinalizeWizard = useCallback((step: FinalizeSetupRootStep) => {
    setFinalizeSetupOpen(false);
    setActiveFinalizeWizard(step);
  }, []);

  const openStandaloneMfaSetup = useCallback(() => {
    setMfaReminderOpen(true);
  }, []);

  const signOutForMfa = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      logout();
    }
    navigate("/login");
  }, [logout, navigate]);

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
  const mfaGraceDeadline =
    mfaStatus?.required &&
    !mfaStatus.sessionMfaSatisfied &&
    typeof mfaStatus.graceExpiresAt === "number" &&
    Number.isFinite(mfaStatus.graceExpiresAt) &&
    mfaStatus.graceExpiresAt > Date.now()
      ? new Date(mfaStatus.graceExpiresAt).toLocaleString()
      : null;
  const mfaGraceReauthenticationRequired = Boolean(mfaGraceDeadline);
  const mfaOnboardingReminder = Boolean(
    user?.authMethod !== "oidc" && showMfaOnboardingReminder && !mfaHasFactor && !mfaRequired
  );
  const relay = dashboardBootstrap?.relay ?? null;
  const license = useUIBootstrapStore((state) => state.snapshot?.license ?? null);
  const relayNotice =
    relay &&
    ["migration_pending", "maintenance", "recovering", "degraded", "critical"].includes(relay.state)
      ? relay
      : null;
  const tlsCertificateDistributionNeedsAttention = Boolean(
    dashboardBootstrap?.attention.notices.some(
      (notice) => notice.id === "tls-certificate-distribution"
    )
  );
  const canRetryRelay = hasScope("admin:system") && relayNotice?.state === "critical";

  useEffect(() => {
    if (relay?.state !== "critical" || relay.canRetry === false) setRelayRetryPending(false);
  }, [relay?.canRetry, relay?.state]);

  const retryRelayRecovery = useCallback(async () => {
    if (!canRetryRelay || !relay?.canRetry || relayRetryPending) return;
    setRelayRetryPending(true);
    try {
      await api.retryRelayRecovery();
      invalidateDashboardBootstrap();
    } catch {
      setRelayRetryPending(false);
    }
  }, [canRetryRelay, invalidateDashboardBootstrap, relay?.canRetry, relayRetryPending]);

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

  // The bootstrap is filtered by the server with the live (folder-expanded) scopes, so resources
  // created in a granted folder after these scopes were cached are already included.
  const visibleHealthHosts = healthHosts;
  const visibleNodesForCards = nodesList;

  const cas = dashboardBootstrap?.cas ?? [];
  const activeCAs = cas.filter((ca) => ca.status === "active").length;
  const totalCAs = cas.length;
  const totalCerts = cas.reduce((sum, ca) => sum + (ca.certCount || 0), 0);

  const displayStats: DashboardStats = stats ?? {
    proxyHosts: { total: 0, enabled: 0, online: 0, offline: 0, degraded: 0 },
    sslCertificates: { total: 0, active: 0, expiringSoon: 0, expired: 0 },
    pkiCertificates: {
      total: totalCerts,
      active: totalCerts,
      revoked: 0,
      expired: 0,
    },
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
            <div className="mx-auto flex h-12 w-12 items-center justify-center border border-destructive/30 bg-destructive/5">
              <AlertTriangle className="h-6 w-6 text-destructive" />
            </div>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">Dashboard is temporarily unavailable</h1>
              <p className="text-sm text-muted-foreground">
                We could not load the latest dashboard data. Please try again.
              </p>
            </div>
            <Button onClick={invalidateDashboardBootstrap}>
              <RotateCw />
              Retry
            </Button>
          </div>
        </div>
      </PageTransition>
    );
  }

  if (!dashboardBootstrap && (dashboardBootstrapLoading || !!user?.id)) {
    return <DashboardSkeleton />;
  }

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6">
        <PageHeader
          className="mb-4"
          leading={<LiteModeBackButton />}
          title="Dashboard"
          description="Gateway and PKI infrastructure overview"
        />
        <div className="space-y-6">
          {license?.status === "expired_grace" ? (
            <LicenseGraceNotice
              graceUntil={license.graceUntil}
              canManage={hasScope("license:manage")}
            />
          ) : null}
          <RelayHealthNotice
            relay={relayNotice}
            isAdmin={hasScope("admin:system")}
            retryPending={relayRetryPending}
            onRetry={() => void retryRelayRecovery()}
          />

          {tlsCertificateDistributionNeedsAttention && (
            <DashboardNotice
              tone="destructive"
              role="alert"
              title="TLS certificate distribution needs attention"
              actions={
                <DashboardNoticeAction tone="destructive" to="/ssl-certificates">
                  View certificates
                </DashboardNoticeAction>
              }
            >
              <p className="text-sm text-muted-foreground">
                At least one active route has not received its current certificate.
              </p>
            </DashboardNotice>
          )}

          {/* Update available */}
          {(dashboardBootstrap?.update?.updateAvailable ||
            dashboardBootstrap?.update?.relay?.updateAvailable) &&
            showUpdateNotifications && (
              <DashboardNotice
                tone="warning"
                icon={ArrowUpCircle}
                title="Update Available"
                actions={
                  <DashboardNoticeAction
                    tone="warning"
                    to="/settings/general"
                    state={{ scrollTarget: "system-updates" }}
                  >
                    Go to Settings
                  </DashboardNoticeAction>
                }
              >
                <p className="text-sm text-muted-foreground">
                  {dashboardBootstrap.update.updateAvailable
                    ? `Gateway ${dashboardBootstrap.update.latestVersion} is ready to install`
                    : `Relay ${dashboardBootstrap.update.relay?.latestVersion} is ready to install`}
                </p>
              </DashboardNotice>
            )}

          {loggingHealth && !["disabled", "healthy"].includes(loggingHealth.status) && (
            <DashboardNotice
              tone="warning"
              title={
                loggingHealth.status === "exhausted"
                  ? "Structured logging capacity exhausted"
                  : loggingHealth.status === "unavailable"
                    ? "Structured logging unavailable"
                    : loggingHealth.status === "pressure"
                      ? loggingHealth.internal.bytes >= loggingHealth.internal.warningBytes
                        ? "ClickHouse internal logs are running high"
                        : "Structured logging storage is running low"
                      : "Structured logging maintenance degraded"
              }
              actions={
                <DashboardNoticeAction
                  tone="warning"
                  to="/settings/features"
                  state={{ scrollTarget: "housekeeping" }}
                >
                  Open Housekeeping
                </DashboardNoticeAction>
              }
            >
              <p className="truncate text-sm text-muted-foreground">
                {loggingHealth.reason ??
                  "Check ClickHouse storage health and maintenance settings."}
              </p>
            </DashboardNotice>
          )}

          {(mfaRequired || mfaGraceReauthenticationRequired) && (
            <DashboardNotice
              tone="warning"
              title={
                mfaHasFactor
                  ? "Sign in with MFA to keep access"
                  : "Set up MFA and sign in again to keep access"
              }
              actions={
                <>
                  {!mfaHasFactor && (
                    <DashboardNoticeAction tone="warning" onClick={openStandaloneMfaSetup}>
                      Set up MFA
                    </DashboardNoticeAction>
                  )}
                  <DashboardNoticeAction tone="warning" onClick={() => void signOutForMfa()}>
                    Sign out
                  </DashboardNoticeAction>
                </>
              }
            >
              <p className="text-sm text-muted-foreground">
                {mfaGraceDeadline
                  ? `Your group now requires MFA. Complete a fresh sign-in with a passkey or authenticator app before ${mfaGraceDeadline}. Setting up a factor alone will not preserve this current session.`
                  : "Your group requires MFA. Sign in with a passkey or authenticator app to continue."}
              </p>
            </DashboardNotice>
          )}

          {mfaOnboardingReminder && (
            <DashboardNotice
              tone="warning"
              title="Configure MFA"
              actions={
                <>
                  <DashboardNoticeAction
                    tone="warning"
                    muted
                    arrow={false}
                    onClick={() => void hideMfaOnboardingReminder()}
                    disabled={mfaReminderBusy}
                  >
                    Hide
                  </DashboardNoticeAction>
                  <DashboardNoticeAction tone="warning" onClick={openStandaloneMfaSetup}>
                    Set up MFA
                  </DashboardNoticeAction>
                </>
              }
            >
              <p className="text-sm text-muted-foreground">
                Protect this administrator account with a passkey or authenticator app.
              </p>
            </DashboardNotice>
          )}

          {finalizeSetup && !isFinalizeSetupComplete(finalizeSetup) && !mfaOnboardingReminder && (
            <DashboardNotice
              tone="info"
              icon={Info}
              title="Finalize setup"
              actions={
                <DashboardNoticeAction tone="info" onClick={() => setFinalizeSetupOpen(true)}>
                  Open checklist
                </DashboardNoticeAction>
              }
            >
              <p className="text-sm text-muted-foreground">
                Connect infrastructure, secure your account, and enable optional Gateway features.
              </p>
            </DashboardNotice>
          )}

          <QuickStatsCard
            displayStats={displayStats}
            nodesList={nodesList}
            hasScopedAccess={hasScopedAccess}
            pkiEnabled={pkiEnabled}
          />

          <DashboardInferenceUsage
            enabled={canViewInferenceUsage}
            usage={dashboardBootstrap?.inferenceUsage as InferenceSelfUsage | null | undefined}
          />

          {/* Pinned Proxy Host Cards */}
          {pinnedProxyHosts
            .filter(
              // Server-filtered like the other bootstrap lists.
              (proxy) => dashboardPinnedProxyIds.includes(proxy.id)
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
            hasScopedAccess={hasExpiringItemScope}
          />

          <HealthOverviewCard healthHosts={visibleHealthHosts} hasScope={hasScopedAccess} />

          <NodesCard nodesList={visibleNodesForCards} hasScope={hasScopedAccess} />

          {pkiEnabled && <CertificateAuthoritiesCard cas={cas} hasScope={hasScope} />}

          <RecentActivityCard activity={activity} hasScope={hasScope} />
        </div>
        {finalizeSetup && (
          <>
            <FinalizeSetupDialog
              open={finalizeSetupOpen && activeFinalizeWizard === null}
              state={finalizeSetup}
              userId={user?.id ?? ""}
              busy={finalizeSetupBusy}
              canInviteUsers={inviteUserMethods !== null}
              onOpenWizard={openFinalizeWizard}
              onSkipForNow={skipFinalizeSetupForNow}
              onFinish={() => setFinalizeSetupOpen(false)}
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
            <ConfigureAIWorkspaceWizard
              open={activeFinalizeWizard === "ai_workspace"}
              allowGatewayInference={[
                "settings:gateway:edit",
                "inference:providers:view",
                "inference:providers:manage",
                "inference:models:manage",
                "inference:limits:manage",
              ].every(hasScope)}
              onBack={() => {
                setActiveFinalizeWizard(null);
                setFinalizeSetupOpen(true);
              }}
              onConfigured={() => completeFinalizeSetupStep("ai_workspace", "configured")}
              onSkipped={() => completeFinalizeSetupStep("ai_workspace", "skipped")}
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
