import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeMonitoringService } from './node-monitoring.service.js';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('NodeMonitoringService active polling', () => {
  function createService() {
    const write = vi.fn((_command, callback?: (error?: Error | null) => void) => callback?.(null));
    const registry = {
      getNode: vi.fn().mockReturnValue({
        type: 'docker',
        commandStream: { write },
        lastHealthReport: null,
        lastStatsReport: null,
      }),
      getConnectedNodeIds: vi.fn().mockReturnValue([]),
      isNodeUpdateInProgress: vi.fn().mockReturnValue(false),
    };
    return { service: new NodeMonitoringService(registry as never), registry, write };
  }

  it('keeps non-focused stream consumers on the 5 second cadence', async () => {
    vi.useFakeTimers();
    const { service, write } = createService();

    service.registerClient('node-1');
    expect(write).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(write).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(4);

    service.unregisterClient('node-1');
    service.destroy();
  });

  it('uses one 2 second poller while at least one Monitoring tab is focused', async () => {
    vi.useFakeTimers();
    const { service, write } = createService();

    service.registerClient('node-1');
    await vi.advanceTimersByTimeAsync(1_000);

    service.registerClient('node-1', { focused: true });
    expect(write).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(write).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(6);

    service.registerClient('node-1', { focused: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(write).toHaveBeenCalledTimes(8);

    service.unregisterClient('node-1', { focused: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(write).toHaveBeenCalledTimes(10);

    service.unregisterClient('node-1', { focused: true });
    expect(write).toHaveBeenCalledTimes(12);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(write).toHaveBeenCalledTimes(12);
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(14);

    service.unregisterClient('node-1');
    service.destroy();
  });

  it('does not poll a node while its daemon update is in progress', () => {
    vi.useFakeTimers();
    const { registry, service, write } = createService();
    registry.isNodeUpdateInProgress.mockReturnValue(true);

    service.registerClient('node-1');

    expect(write).not.toHaveBeenCalled();
    service.destroy();
  });
});
