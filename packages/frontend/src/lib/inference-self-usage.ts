import type { InferenceSelfUsage } from "@/types/inference";

export const INFERENCE_SELF_USAGE_CACHE_KEY = "req:/api/inference/usage/self";
export const INFERENCE_SELF_USAGE_UPDATED_EVENT = "gateway:inference-self-usage-updated";

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
