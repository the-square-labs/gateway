import { createChildLogger } from '@/lib/logger.js';
import type { EventBusService } from '@/services/event-bus.service.js';

const logger = createChildLogger('ReadModelCoordinator');

export interface ReadModelEventSubscription {
  channel: string;
  matches?: (payload: unknown) => boolean;
}

export interface ReadModelRefreshDefinition {
  id: string;
  refresh: () => Promise<void>;
  events?: ReadModelEventSubscription[];
  fallbackIntervalMs?: number;
  initial?: boolean;
}

interface RefreshState {
  active: boolean;
  queued: boolean;
  dirty: boolean;
  notify: boolean;
}

/**
 * Schedules source refreshes without putting source I/O in request handlers.
 * The source retains ownership of sanitization and replacement semantics.
 */
export class ReadModelCoordinator {
  private readonly definitions = new Map<string, ReadModelRefreshDefinition>();
  private readonly states = new Map<string, RefreshState>();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly activeRuns = new Set<Promise<void>>();
  private started = false;

  constructor(private readonly eventBus: EventBusService) {}

  register(definition: ReadModelRefreshDefinition): void {
    if (this.definitions.has(definition.id)) {
      throw new Error(`Read model refresh already registered: ${definition.id}`);
    }
    this.definitions.set(definition.id, definition);
    this.states.set(definition.id, { active: false, queued: false, dirty: false, notify: false });
    if (this.started) this.startDefinition(definition);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const definition of this.definitions.values()) this.startDefinition(definition);
  }

  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    this.started = false;
    for (const state of this.states.values()) {
      state.queued = false;
      state.dirty = false;
      state.notify = false;
    }
    await Promise.allSettled([...this.activeRuns]);
  }

  enqueue(id: string, notify = false): void {
    if (!this.started) return;
    const definition = this.definitions.get(id);
    const state = this.states.get(id);
    if (!definition || !state) return;
    if (state.active) {
      state.dirty = true;
      state.notify ||= notify;
      return;
    }
    if (state.queued) {
      state.notify ||= notify;
      return;
    }
    state.queued = true;
    state.notify ||= notify;
    queueMicrotask(() => {
      if (!this.started) {
        state.queued = false;
        return;
      }
      const promise = this.run(definition).finally(() => this.activeRuns.delete(promise));
      this.activeRuns.add(promise);
    });
  }

  private startDefinition(definition: ReadModelRefreshDefinition): void {
    if (definition.initial !== false) this.enqueue(definition.id);
    for (const event of definition.events ?? []) {
      this.unsubscribers.push(
        this.eventBus.subscribe(event.channel, (payload) => {
          if (!event.matches || event.matches(payload)) this.enqueue(definition.id, true);
        })
      );
    }
    if (definition.fallbackIntervalMs && definition.fallbackIntervalMs > 0) {
      this.timers.push(setInterval(() => this.enqueue(definition.id), definition.fallbackIntervalMs));
    }
  }

  private async run(definition: ReadModelRefreshDefinition): Promise<void> {
    const state = this.states.get(definition.id);
    if (!state) return;
    state.queued = false;
    state.active = true;
    const notify = state.notify;
    state.notify = false;
    try {
      await definition.refresh();
      if (notify) this.eventBus.publish('read-model.refreshed', { id: definition.id });
    } catch (error) {
      logger.warn('Read model refresh failed', {
        id: definition.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      state.active = false;
      if (state.dirty && this.started) {
        state.dirty = false;
        this.enqueue(definition.id, state.notify);
      }
    }
  }
}
