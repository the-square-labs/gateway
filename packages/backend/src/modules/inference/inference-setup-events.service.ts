import { injectable } from 'tsyringe';
import type { EventBusService } from '@/services/event-bus.service.js';

export const INFERENCE_SETUP_EVENT_CHANNEL = 'inference.catalog.changed';
const HISTORY_LIMIT = 100;

export type InferenceSetupEvent = {
  id: string;
  type: 'catalog.changed';
  occurredAt: string;
};

@injectable()
export class InferenceSetupEventsService {
  private sequence = 0;
  private readonly history: InferenceSetupEvent[] = [];

  constructor(private readonly eventBus: EventBusService) {
    // Catalog visibility can change without a model mutation when a user or
    // permission group changes. A global invalidation is intentionally cheap:
    // every connected CLI performs a conditional ETag refresh afterwards.
    this.eventBus.subscribe('user.changed', () => this.publishCatalogChanged());
    this.eventBus.subscribe('group.changed', () => this.publishCatalogChanged());
  }

  publishCatalogChanged(): InferenceSetupEvent {
    const event: InferenceSetupEvent = {
      id: `${Date.now()}-${++this.sequence}`,
      type: 'catalog.changed',
      occurredAt: new Date().toISOString(),
    };
    this.history.push(event);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    this.eventBus.publish(INFERENCE_SETUP_EVENT_CHANNEL, event);
    return event;
  }

  subscribe(listener: (event: InferenceSetupEvent) => void): () => void {
    return this.eventBus.subscribe(INFERENCE_SETUP_EVENT_CHANNEL, (payload) =>
      listener(payload as InferenceSetupEvent)
    );
  }

  since(lastEventId: string | undefined): InferenceSetupEvent[] {
    if (!lastEventId) return [];
    const index = this.history.findIndex((event) => event.id === lastEventId);
    return index < 0 ? [] : this.history.slice(index + 1);
  }
}
