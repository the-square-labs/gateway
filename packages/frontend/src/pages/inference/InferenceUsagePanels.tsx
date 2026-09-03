import {
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Gauge,
  Plus,
  Server,
  Sigma,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import {
  useInferenceSelfUsage,
  useInferenceSelfUsageOverview,
} from "@/hooks/use-inference-self-usage";
import { DASHBOARD_INFERENCE_USAGE_THRESHOLD } from "@/lib/inference-self-usage";
import { cn, formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import type {
  InferenceSelfUsage,
  InferenceSystemUsage,
  InferenceUsageOverview,
  InferenceUsageWindow,
} from "@/types/inference";
import {
  InferenceEndpointRow,
  InferenceHarnessDialog,
} from "../settings/inference/InferenceEndpointSettingsPanel";

const COMPACT_USAGE_OPEN_KEY = "gateway:account-menu:ai-usage-open";

function remainingPercentage(percentage: number) {
  return Math.round(Math.max(0, Math.min(100, 100 - percentage)));
}

function initialCompactUsageOpen() {
  try {
    const stored = window.localStorage.getItem(COMPACT_USAGE_OPEN_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

function InferenceUsagePanel({ usage }: { usage: InferenceSelfUsage }) {
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const subscriptionWindows: Array<{
    label: string;
    value: InferenceUsageWindow;
    icon: typeof Gauge;
  }> = [
    ...(usage.subscription["5h"].configured
      ? [{ label: "5 hours", value: usage.subscription["5h"], icon: Clock3 }]
      : []),
    ...(usage.subscription["7d"].configured
      ? [{ label: "Weekly", value: usage.subscription["7d"], icon: Gauge }]
      : []),
    ...(usage.subscription["30d"].configured
      ? [{ label: "Monthly", value: usage.subscription["30d"], icon: Gauge }]
      : []),
  ];
  const cards = [
    ...(usage.api.configured
      ? [{ label: "API usage", value: usage.api, icon: CircleDollarSign }]
      : []),
    ...subscriptionWindows,
  ];
  const cardCount = cards.length;

  if (cardCount === 0) return null;

  return (
    <>
      <PanelShell
        icon={<Gauge className="h-4 w-4" />}
        title="Inference usage"
        description="Usage limits for the AI models available to you. Limits recover automatically."
        actions={
          <Button onClick={() => setInstructionsOpen(true)}>
            <Plus className="h-4 w-4" />
            Set up a harness
          </Button>
        }
      >
        <div
          className={cn(
            "grid grid-cols-1 gap-px bg-border",
            cardCount > 1 && "sm:grid-cols-2",
            cardCount === 4 && "xl:grid-cols-4",
            cardCount === 3 && "xl:grid-cols-3",
            cardCount === 2 && "xl:grid-cols-2"
          )}
        >
          {cards.map(({ label, value, icon }) => (
            <UsageStatCard key={label} label={label} value={value} icon={icon} />
          ))}
        </div>
        <div className="border-t border-border">
          <InferenceEndpointRow />
        </div>
      </PanelShell>
      <InferenceHarnessDialog open={instructionsOpen} onOpenChange={setInstructionsOpen} />
    </>
  );
}

function UsageStatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: InferenceUsageWindow;
  icon: typeof Gauge;
}) {
  const remaining = remainingPercentage(value.percentage);
  const isLow = 100 - value.percentage < DASHBOARD_INFERENCE_USAGE_THRESHOLD;
  return (
    <StatCard
      className="border-0"
      label={label}
      value={`${remaining}%`}
      valueClassName={isLow ? "text-warning" : undefined}
      icon={icon}
      progress={{
        percent: remaining,
        color: isLow ? "var(--color-warning)" : undefined,
      }}
      subtitle={
        value.active === false
          ? "Starts on next use"
          : `Recovers ${formatDateTime(value.recoveryAt)}`
      }
      subtitleClassName="text-xs"
    />
  );
}

function InferenceUsageOverviewSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-44 w-full" />
      ))}
    </div>
  );
}

export function InferenceUsage({
  previewUsage,
  previewOverview,
}: {
  previewUsage?: InferenceSelfUsage;
  previewOverview?: InferenceUsageOverview;
} = {}) {
  const liveUsage = useInferenceSelfUsage(previewUsage === undefined);
  const liveOverview = useInferenceSelfUsageOverview(previewOverview === undefined);
  const usage = previewUsage ?? liveUsage.usage;
  const overview = previewOverview ?? liveOverview.usage;
  const loading = previewUsage === undefined && liveUsage.loading;
  const overviewLoading = previewOverview === undefined && liveOverview.loading;
  const error = previewUsage === undefined ? liveUsage.error : null;

  if (loading) {
    return (
      <div className="space-y-4">
        <InferenceUsageOverviewSkeleton />
        <PanelShell
          icon={<Gauge className="h-4 w-4" />}
          title="Inference usage"
          description="Usage limits for the AI models available to you. Limits recover automatically."
        >
          <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2" aria-busy="true">
            {Array.from({ length: 2 }, (_, index) => (
              <div key={index} className="space-y-3 bg-card p-4">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-7 w-16" />
                <Skeleton className="h-2 w-full" />
                <Skeleton className="h-3 w-40" />
              </div>
            ))}
          </div>
        </PanelShell>
      </div>
    );
  }
  if (error || !usage?.enabled) return null;

  const hasConfiguredLimit =
    usage.api.configured ||
    usage.subscription["5h"].configured ||
    usage.subscription["7d"].configured ||
    usage.subscription["30d"].configured;
  if (!overview && !overviewLoading && !hasConfiguredLimit) return null;

  return (
    <div className="space-y-4">
      {overview ? (
        <InferenceUsageOverviewCards usage={overview} />
      ) : overviewLoading ? (
        <InferenceUsageOverviewSkeleton />
      ) : null}
      {hasConfiguredLimit ? <InferenceUsagePanel usage={usage} /> : null}
    </div>
  );
}

export function DashboardInferenceUsage({
  enabled,
  usage: bootstrapUsage,
}: {
  enabled: boolean;
  usage?: InferenceSelfUsage | null;
}) {
  const {
    usage: fetchedUsage,
    loading,
    error,
  } = useInferenceSelfUsage(enabled && bootstrapUsage === undefined);
  const usage = bootstrapUsage === undefined ? fetchedUsage : bootstrapUsage;

  if (loading || error || !usage?.enabled) return null;

  const lowWindows: Array<{
    label: string;
    value: InferenceUsageWindow;
  }> = [
    { label: "API usage", value: usage.api },
    { label: "5 hours", value: usage.subscription["5h"] },
    { label: "Weekly", value: usage.subscription["7d"] },
    { label: "Monthly", value: usage.subscription["30d"] },
  ].filter(
    ({ value }) =>
      value.configured &&
      value.active !== false &&
      100 - value.percentage < DASHBOARD_INFERENCE_USAGE_THRESHOLD
  );

  if (lowWindows.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-4">
      {lowWindows.map(({ label, value }) => {
        const remaining = remainingPercentage(value.percentage);
        return (
          <div
            key={label}
            role="status"
            aria-label={`${label} inference quota warning`}
            className="border border-warning/60 bg-card"
          >
            <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center bg-warning/10 text-warning">
                  <TriangleAlert className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {label} inference quota is running low
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Recovers {formatDateTime(value.recoveryAt)}.
                  </p>
                </div>
              </div>
              <div className="w-full shrink-0 sm:w-48">
                <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">Remaining</span>
                  <span className="font-semibold text-warning">{remaining}%</span>
                </div>
                <ProgressBar value={remaining} className="h-2" indicatorClassName="bg-warning" />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CompactInferenceUsage({
  withMenuSeparator = false,
}: {
  withMenuSeparator?: boolean;
}) {
  const dashboardUsage = useDashboardBootstrapStore((state) => state.snapshot?.inferenceUsage);
  const dashboardBootstrapLoading = useDashboardBootstrapStore((state) => state.loading);
  const dashboardBootstrapStarted = useDashboardBootstrapStore(
    (state) => state.key !== null || state.request !== null || state.snapshot !== null
  );
  // Sidebar starts the shared dashboard bootstrap after the authenticated shell
  // mounts. Hold this small permission-gated menu section in place until that
  // request settles so it cannot race a second /inference/usage/self request.
  const waitForDashboardBootstrap = !dashboardBootstrapStarted || dashboardBootstrapLoading;
  const useUsageFallback =
    dashboardBootstrapStarted && !dashboardBootstrapLoading && dashboardUsage === undefined;
  const { usage: fetchedUsage, error } = useInferenceSelfUsage(useUsageFallback);
  const usage = dashboardUsage === undefined ? fetchedUsage : dashboardUsage;
  const [open, setOpen] = useState(initialCompactUsageOpen);

  if (waitForDashboardBootstrap) {
    return (
      <>
        {withMenuSeparator ? <DropdownMenuSeparator className="bg-border" /> : null}
        <div className="space-y-2 px-2 py-2" aria-busy="true" aria-label="Loading AI usage">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-2 w-full" />
        </div>
      </>
    );
  }

  if (error || !usage?.enabled) return null;

  const windows = [
    ...(usage.subscription["5h"].configured
      ? [{ label: "5 hours", value: usage.subscription["5h"] }]
      : []),
    ...(usage.subscription["7d"].configured
      ? [{ label: "Weekly", value: usage.subscription["7d"] }]
      : []),
    ...(usage.subscription["30d"].configured
      ? [{ label: "Monthly", value: usage.subscription["30d"] }]
      : []),
    ...(usage.api.configured ? [{ label: "API", value: usage.api }] : []),
  ];

  if (windows.length === 0) return null;

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    try {
      window.localStorage.setItem(COMPACT_USAGE_OPEN_KEY, String(nextOpen));
    } catch {
      // Local storage can be unavailable in privacy-restricted browser contexts.
    }
  };

  return (
    <>
      <Collapsible open={open} onOpenChange={changeOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto w-full justify-start gap-2 px-2 py-3 text-sm font-normal md:py-1.5"
          >
            <Gauge />
            <span>AI usage remaining</span>
            <ChevronDown
              className={cn("ml-auto transition-transform", open && "rotate-180")}
              aria-hidden="true"
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 px-2 pb-2 pt-1">
            {windows.map(({ label, value }) => {
              const remaining = remainingPercentage(value.percentage);
              return (
                <div
                  key={label}
                  className="space-y-1"
                  aria-label={`${label} remaining ${remaining}%`}
                >
                  <div className="flex items-center justify-between text-[13px] text-muted-foreground">
                    <span>{label}</span>
                    <span>{remaining}%</span>
                  </div>
                  <ProgressBar value={remaining} indicatorClassName="bg-foreground" />
                </div>
              );
            })}
          </div>
        </CollapsibleContent>
      </Collapsible>
      {withMenuSeparator ? <DropdownMenuSeparator className="bg-border" /> : null}
    </>
  );
}

export function InferenceOverview({ refreshToken = 0 }: { refreshToken?: number }) {
  const cachedUsage = api.getCached<InferenceSystemUsage>(
    "req:/api/inference/usage/system",
    Number.POSITIVE_INFINITY
  );
  const [usage, setUsage] = useState<InferenceSystemUsage | null>(cachedUsage ?? null);
  const [loading, setLoading] = useState(!cachedUsage);
  const [error, setError] = useState<string | null>(null);
  const initializedRef = useRef(Boolean(cachedUsage));

  const load = useCallback(async () => {
    if (!initializedRef.current) setLoading(true);
    setError(null);
    try {
      setUsage(await api.getInferenceSystemUsage());
      initializedRef.current = true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load system usage");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshToken;
    void load();
  }, [load, refreshToken]);

  if (error && !usage) {
    return (
      <PanelShell
        icon={<Gauge className="h-4 w-4" />}
        title="Inference overview"
        actions={
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            Retry
          </Button>
        }
      >
        <div className="px-4 py-6 text-sm text-destructive">{error}</div>
      </PanelShell>
    );
  }

  if (loading && !usage) return <Skeleton />;

  return <InferenceUsageOverviewCards usage={usage!} />;
}

export function InferenceUsageOverviewCards({ usage }: { usage: InferenceUsageOverview }) {
  const totals = useMemo(() => {
    const requests = usage.requestTotals.reduce((sum, row) => sum + Number(row.requests), 0);
    return {
      requests,
      tokens: usage.ledgerTotals.reduce((sum, row) => sum + Number(row.tokens), 0),
      credits: usage.ledgerTotals.reduce((sum, row) => sum + Number(row.credits), 0),
      apiMicrodollars: usage.ledgerTotals.reduce(
        (sum, row) => sum + Number(row.apiMicrodollars),
        0
      ),
    };
  }, [usage]);
  const subtitle = `Last ${usage.windowDays} days`;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Inference API usage"
        value={`$${(totals.apiMicrodollars / 1_000_000).toFixed(2)}`}
        icon={CircleDollarSign}
        history={usage.dailyUsage.map((row) => row.apiMicrodollars / 1_000_000)}
        color="#22c55e"
        subtitle={subtitle}
        appearance="dashboard"
      />
      <StatCard
        label="Inference tokens"
        value={totals.tokens.toLocaleString()}
        icon={Sigma}
        history={usage.dailyUsage.map((row) => row.tokens)}
        color="#3b82f6"
        subtitle={subtitle}
        appearance="dashboard"
      />
      <StatCard
        label="Inference credits"
        value={Math.round(totals.credits).toLocaleString()}
        icon={Gauge}
        history={usage.dailyUsage.map((row) => row.credits)}
        color="#8b5cf6"
        subtitle={subtitle}
        appearance="dashboard"
      />
      <StatCard
        label="Inference requests"
        value={totals.requests.toLocaleString()}
        icon={Server}
        history={usage.dailyUsage.map((row) => row.requests)}
        color="#f59e0b"
        subtitle={subtitle}
        appearance="dashboard"
      />
    </div>
  );
}
