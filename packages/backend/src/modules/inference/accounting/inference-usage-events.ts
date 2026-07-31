import type { EventBusService } from '@/services/event-bus.service.js';

export const INFERENCE_USAGE_CHANGED_CHANNEL = 'inference.usage.changed';

export type InferenceUsageChangedEvent = {
  targetUserId: string | null;
  reason: 'limits' | 'settlement';
};

export function publishInferenceUsageChanged(
  eventBus: EventBusService | undefined,
  event: InferenceUsageChangedEvent
): void {
  eventBus?.publish(INFERENCE_USAGE_CHANGED_CHANNEL, event);
}
