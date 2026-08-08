import { describe, expect, it, vi } from 'vitest';
import { ReadModelCoordinator } from './read-model-coordinator.service.js';

function makeEventBus() {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  return {
    subscribe: vi.fn((channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      return () =>
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((item) => item !== listener)
        );
    }),
    emit(channel: string, payload: unknown) {
      listeners.get(channel)?.forEach((listener) => {
        listener(payload);
      });
    },
  };
}

describe('ReadModelCoordinator', () => {
  it('deduplicates events while a refresh is in flight and runs one follow-up', async () => {
    const eventBus = makeEventBus();
    const coordinator = new ReadModelCoordinator(eventBus as never);
    let release!: () => void;
    const firstRefresh = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(async () => {
      if (refresh.mock.calls.length === 1) await firstRefresh;
    });
    coordinator.register({ id: 'nodes', refresh, initial: false, events: [{ channel: 'node.changed' }] });
    coordinator.start();

    eventBus.emit('node.changed', {});
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    eventBus.emit('node.changed', {});
    eventBus.emit('node.changed', {});
    release();

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    coordinator.stop();
  });
});
