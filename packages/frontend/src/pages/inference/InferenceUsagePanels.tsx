import { ChevronDown, CircleDollarSign, Clock3, Gauge, Server, Sigma } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ProgressBar } from "@/components/ui/progress-bar";
import { StatCard } from "@/components/ui/stat-card";
import {
  INFERENCE_SELF_USAGE_CACHE_KEY,
  subscribeToInferenceSelfUsage,
} from "@/lib/inference-self-usage";
import { cn, formatDate } from "@/lib/utils";
import { api } from "@/services/api";
import type {
  InferenceSelfUsage,
  InferenceSystemUsage,
  InferenceUsageWindow,
} from "@/types/inference";

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

function useInferenceSelfUsage() {
  const cached = api.getCached<InferenceSelfUsage>(INFERENCE_SELF_USAGE_CACHE_KEY);
  const [usage, setUsage] = useState<InferenceSelfUsage | null>(cached ?? null);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setUsage(await api.getInferenceSelfUsage());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load inference usage");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToInferenceSelfUsage(setUsage);
    void load();
    return unsubscribe;
  }, [load]);

  return { usage, loading, error, load };
}

export function InferenceUsage() {
  const { usage, loading, error, load } = useInferenceSelfUsage();

  if (loading) {
    return (
      <PanelShell title="Inference usage">
        <div className="px-4 py-6 text-sm text-muted-foreground">Loading usage...</div>
      </PanelShell>
    );
  }
  if (error || !usage) {
    return (
      <PanelShell
        title="Inference usage"
        actions={
          <Button variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        }
      >
        <div className="px-4 py-6 text-sm text-destructive">{error ?? "Usage is unavailable"}</div>
      </PanelShell>
    );
  }

  const windows: Array<{ label: string; value: InferenceUsageWindow; icon: typeof Gauge }> = [
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
  if (usage.api.configured) {
    windows.unshift({ label: "API usage", value: usage.api, icon: CircleDollarSign });
  }

  return (
    <PanelShell
      title="Inference usage"
      description="Credit limits are shared across eligible AI providers. Limits recover automatically."
    >
      {!usage.enabled && (
        <div className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
          Inference is currently unavailable for your account.
        </div>
      )}
      {windows.length > 0 ? (
        <div
          className={cn(
            "grid grid-cols-1 gap-px bg-border sm:grid-cols-2",
            windows.length === 4 && "xl:grid-cols-4",
            windows.length === 3 && "xl:grid-cols-3",
            windows.length === 2 && "xl:grid-cols-2"
          )}
        >
          {windows.map(({ label, value, icon }) => {
            const remaining = remainingPercentage(value.percentage);
            return (
              <StatCard
                key={label}
                className="border-0"
                label={label}
                value={`${remaining}%`}
                icon={icon}
                progress={{ percent: remaining }}
                subtitle={`Recovers ${formatDate(value.recoveryAt)}`}
                subtitleClassName="text-xs"
              />
            );
          })}
        </div>
      ) : (
        <div className="px-4 py-6 text-sm text-muted-foreground">Usage is unlimited.</div>
      )}
    </PanelShell>
  );
}

export function CompactInferenceUsage() {
  const { usage, loading, error } = useInferenceSelfUsage();
  const [open, setOpen] = useState(initialCompactUsageOpen);

  if (loading || error || !usage?.enabled) return null;

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

  if (windows.length === 0) {
    return (
      <Button
        variant="ghost"
        className="h-auto w-full justify-start gap-2 px-2 py-3 text-sm font-normal md:py-1.5"
        disabled
      >
        <Gauge />
        <span>Unlimited AI usage</span>
      </Button>
    );
  }

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    try {
      window.localStorage.setItem(COMPACT_USAGE_OPEN_KEY, String(nextOpen));
    } catch {
      // Local storage can be unavailable in privacy-restricted browser contexts.
    }
  };

  return (
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
  );
}

export function InferenceOverview() {
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

  useEffect(() => void load(), [load]);

  const totals = useMemo(() => {
    const requests = usage?.requestTotals.reduce((sum, row) => sum + Number(row.requests), 0) ?? 0;
    return {
      requests,
      tokens: usage?.ledgerTotals.reduce((sum, row) => sum + Number(row.tokens), 0) ?? 0,
      credits: usage?.ledgerTotals.reduce((sum, row) => sum + Number(row.credits), 0) ?? 0,
      apiMicrodollars:
        usage?.ledgerTotals.reduce((sum, row) => sum + Number(row.apiMicrodollars), 0) ?? 0,
    };
  }, [usage]);

  if (error && !usage) {
    return (
      <PanelShell
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

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="API cost"
        value={`$${(totals.apiMicrodollars / 1_000_000).toFixed(2)}`}
        icon={CircleDollarSign}
        appearance="dashboard"
      />
      <StatCard
        label="Tokens"
        value={totals.tokens.toLocaleString()}
        icon={Sigma}
        appearance="dashboard"
      />
      <StatCard
        label="Credits"
        value={totals.credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        icon={Gauge}
        appearance="dashboard"
      />
      <StatCard
        label="Requests"
        value={totals.requests.toLocaleString()}
        icon={Server}
        appearance="dashboard"
      />
    </div>
  );
}
