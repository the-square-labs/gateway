import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import {
  INFERENCE_SELF_USAGE_CACHE_KEY,
  subscribeToInferenceSelfUsage,
} from "@/lib/inference-self-usage";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import type { InferenceSelfUsage } from "@/types/inference";

const LOW_USAGE_THRESHOLD = 10;
const EXHAUSTED_USAGE_THRESHOLD = 0.5;
const USAGE_POLL_INTERVAL_MS = 5_000;
const USAGE_SETTLEMENT_DELAY_MS = 1_500;

interface InferenceUsageWindowState {
  key: keyof InferenceSelfUsage["subscription"];
  label: string;
  remaining: number;
  recoveryAt: string;
}

export interface InferenceQuotaState {
  exhausted: boolean;
  lowWindows: InferenceUsageWindowState[];
  exhaustedWindows: InferenceUsageWindowState[];
  resetAt: string | null;
}

const EMPTY_QUOTA_STATE: InferenceQuotaState = {
  exhausted: false,
  lowWindows: [],
  exhaustedWindows: [],
  resetAt: null,
};

export function getInferenceQuotaState(usage: InferenceSelfUsage | null): InferenceQuotaState {
  if (!usage?.enabled) return EMPTY_QUOTA_STATE;

  const windows: Array<{
    key: keyof InferenceSelfUsage["subscription"];
    label: string;
  }> = [
    { key: "5h", label: "5-hour" },
    { key: "7d", label: "weekly" },
    { key: "30d", label: "monthly" },
  ];

  const lowWindows = windows.flatMap(({ key, label }) => {
    const window = usage.subscription[key];
    const remaining = Math.max(0, Math.min(100, 100 - window.percentage));
    return window.configured && remaining <= LOW_USAGE_THRESHOLD
      ? [{ key, label, remaining, recoveryAt: window.recoveryAt }]
      : [];
  });
  const exhaustedWindows = lowWindows.filter(
    ({ remaining }) => remaining < EXHAUSTED_USAGE_THRESHOLD
  );
  const validResetTimes = exhaustedWindows
    .map(({ recoveryAt }) => Date.parse(recoveryAt))
    .filter(Number.isFinite);
  const resetAt =
    validResetTimes.length > 0 ? new Date(Math.max(...validResetTimes)).toISOString() : null;

  return {
    exhausted: exhaustedWindows.length > 0,
    lowWindows,
    exhaustedWindows,
    resetAt,
  };
}

export function formatInferenceQuotaResetIn(resetAt: string, now = Date.now()): string {
  const resetTime = Date.parse(resetAt);
  if (!Number.isFinite(resetTime) || resetTime <= now) return "shortly";

  const totalMinutes = Math.max(1, Math.ceil((resetTime - now) / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function useInferenceQuota({
  enabled,
  isStreaming,
}: {
  enabled: boolean;
  isStreaming: boolean;
}): InferenceQuotaState {
  const [usage, setUsage] = useState<InferenceSelfUsage | null>(() =>
    enabled ? (api.getCached<InferenceSelfUsage>(INFERENCE_SELF_USAGE_CACHE_KEY) ?? null) : null
  );

  useEffect(() => {
    if (!enabled) {
      setUsage(null);
      return;
    }

    let active = true;
    const refresh = async () => {
      try {
        const nextUsage = await api.getInferenceSelfUsage();
        if (active) setUsage(nextUsage);
      } catch {
        // Usage visibility is best-effort and must never break the chat surface.
      }
    };
    const unsubscribe = subscribeToInferenceSelfUsage((nextUsage) => {
      if (active) setUsage(nextUsage);
    });

    void refresh();
    const pollTimer = window.setInterval(() => void refresh(), USAGE_POLL_INTERVAL_MS);
    const settlementTimer = isStreaming
      ? null
      : window.setTimeout(() => void refresh(), USAGE_SETTLEMENT_DELAY_MS);

    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(pollTimer);
      if (settlementTimer !== null) window.clearTimeout(settlementTimer);
    };
  }, [enabled, isStreaming]);

  return getInferenceQuotaState(usage);
}

export function useInferenceQuotaSnapshot(enabled: boolean): InferenceQuotaState {
  const [usage, setUsage] = useState<InferenceSelfUsage | null>(() =>
    enabled ? (api.getCached<InferenceSelfUsage>(INFERENCE_SELF_USAGE_CACHE_KEY) ?? null) : null
  );

  useEffect(() => {
    if (!enabled) {
      setUsage(null);
      return;
    }
    return subscribeToInferenceSelfUsage(setUsage);
  }, [enabled]);

  return getInferenceQuotaState(usage);
}

export function InferenceQuotaStatus({
  quota,
  exhaustedClassName,
}: {
  quota: InferenceQuotaState;
  exhaustedClassName?: string;
}) {
  if (quota.exhausted) {
    return (
      <div
        role="status"
        className={cn("border border-border bg-muted/40 px-3 py-3", exhaustedClassName)}
      >
        <div className="flex min-w-0 items-center gap-3">
          <TriangleAlert className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Inference quota exhausted</p>
            <p className="text-sm text-muted-foreground">
              {quota.resetAt
                ? `Quota resets in ${formatInferenceQuotaResetIn(quota.resetAt)}.`
                : "Wait for the quota to reset."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (quota.lowWindows.length === 0) return null;

  return (
    <div
      role="status"
      className="mb-2 flex items-start gap-2 border border-border bg-muted/30 px-3 py-2 text-sm text-foreground"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        Inference quota is almost exhausted:{" "}
        {quota.lowWindows
          .map(({ label, remaining }) => `${label} ${Math.round(remaining)}% remaining`)
          .join(", ")}
        .
      </span>
    </div>
  );
}
