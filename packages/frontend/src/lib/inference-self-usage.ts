import type { InferenceSelfUsage } from "@/types/inference";

export const INFERENCE_SELF_USAGE_CACHE_KEY = "req:/api/inference/usage/self";
export const INFERENCE_SELF_USAGE_UPDATED_EVENT = "gateway:inference-self-usage-updated";
export const INFERENCE_USAGE_CHANGED_CHANNEL = "inference.usage.changed";
export type InferenceUsageChangedEvent = {
  targetUserId: string | null;
  reason: "limits" | "settlement";
};
export const DASHBOARD_INFERENCE_USAGE_THRESHOLD = 20;

export function hasLowInferenceUsage(
  usage: InferenceSelfUsage | null,
  threshold = DASHBOARD_INFERENCE_USAGE_THRESHOLD
): boolean {
  if (!usage?.enabled) return false;

  return [
    usage.api,
    usage.subscription["5h"],
    usage.subscription["7d"],
    usage.subscription["30d"],
  ].some((window) => {
    if (!window.configured) return false;
    const remaining = Math.max(0, Math.min(100, 100 - window.percentage));
    return remaining < threshold;
  });
}

export function publishInferenceSelfUsage(usage: InferenceSelfUsage): void {
  window.dispatchEvent(
    new CustomEvent<InferenceSelfUsage>(INFERENCE_SELF_USAGE_UPDATED_EVENT, {
      detail: usage,
    })
  );
}

export function subscribeToInferenceSelfUsage(
  listener: (usage: InferenceSelfUsage) => void
): () => void {
  const handleUsageUpdate = (event: Event) => {
    listener((event as CustomEvent<InferenceSelfUsage>).detail);
  };

  window.addEventListener(INFERENCE_SELF_USAGE_UPDATED_EVENT, handleUsageUpdate);
  return () => window.removeEventListener(INFERENCE_SELF_USAGE_UPDATED_EVENT, handleUsageUpdate);
}
