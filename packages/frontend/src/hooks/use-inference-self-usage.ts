import { useCallback, useEffect, useState } from "react";
import {
  INFERENCE_CATALOG_CHANGED_CHANNEL,
  INFERENCE_SELF_USAGE_CACHE_KEY,
  INFERENCE_USAGE_CHANGED_CHANNEL,
  subscribeToInferenceSelfUsage,
} from "@/lib/inference-self-usage";
import { api } from "@/services/api";
import { eventStream } from "@/services/event-stream";
import type { InferenceSelfUsage, InferenceUsageOverview } from "@/types/inference";

let activeRequest: Promise<InferenceSelfUsage> | null = null;
let activeOverviewRequest: Promise<InferenceUsageOverview> | null = null;
const INFERENCE_SELF_USAGE_OVERVIEW_CACHE_KEY = "req:/api/inference/usage/self/overview";

function loadInferenceSelfUsage(): Promise<InferenceSelfUsage> {
  if (!activeRequest) {
    activeRequest = api.getInferenceSelfUsage().finally(() => {
      activeRequest = null;
    });
  }
  return activeRequest;
}

function loadInferenceSelfUsageOverview(): Promise<InferenceUsageOverview> {
  if (!activeOverviewRequest) {
    activeOverviewRequest = api.getInferenceSelfUsageOverview().finally(() => {
      activeOverviewRequest = null;
    });
  }
  return activeOverviewRequest;
}

export function useInferenceSelfUsage(enabled = true) {
  const cached = enabled
    ? api.getCached<InferenceSelfUsage>(INFERENCE_SELF_USAGE_CACHE_KEY)
    : undefined;
  const [usage, setUsage] = useState<InferenceSelfUsage | null>(cached ?? null);
  const [loading, setLoading] = useState(enabled && !cached);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    setError(null);
    try {
      setUsage(await loadInferenceSelfUsage());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load inference usage");
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setUsage(null);
      setLoading(false);
      setError(null);
      return;
    }

    setUsage(api.getCached<InferenceSelfUsage>(INFERENCE_SELF_USAGE_CACHE_KEY) ?? null);
    setLoading(api.getCached<InferenceSelfUsage>(INFERENCE_SELF_USAGE_CACHE_KEY) === undefined);
    const unsubscribeUsage = subscribeToInferenceSelfUsage(setUsage);
    const unsubscribeRealtime = eventStream.subscribe(INFERENCE_USAGE_CHANGED_CHANNEL, () => {
      void load();
    });
    const unsubscribeCatalog = eventStream.subscribe(INFERENCE_CATALOG_CHANGED_CHANNEL, () => {
      void load();
    });
    if (!api.getCached<InferenceSelfUsage>(INFERENCE_SELF_USAGE_CACHE_KEY)) void load();
    return () => {
      unsubscribeUsage();
      unsubscribeRealtime();
      unsubscribeCatalog();
    };
  }, [enabled, load]);

  return { usage, loading, error, load };
}

export function useInferenceSelfUsageOverview(enabled = true) {
  const cached = enabled
    ? api.getCached<InferenceUsageOverview>(INFERENCE_SELF_USAGE_OVERVIEW_CACHE_KEY)
    : undefined;
  const [usage, setUsage] = useState<InferenceUsageOverview | null>(cached ?? null);
  const [loading, setLoading] = useState(enabled && !cached);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    setError(null);
    try {
      setUsage(await loadInferenceSelfUsageOverview());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load inference usage overview");
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setUsage(null);
      setLoading(false);
      setError(null);
      return;
    }

    const cachedUsage = api.getCached<InferenceUsageOverview>(
      INFERENCE_SELF_USAGE_OVERVIEW_CACHE_KEY
    );
    setUsage(cachedUsage ?? null);
    setLoading(cachedUsage === undefined);
    const unsubscribeRealtime = eventStream.subscribe(INFERENCE_USAGE_CHANGED_CHANNEL, () => {
      void load();
    });
    if (!cachedUsage) void load();
    return unsubscribeRealtime;
  }, [enabled, load]);

  return { usage, loading, error, load };
}
