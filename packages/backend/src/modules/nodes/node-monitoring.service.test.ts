import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compactMonitoringHistorySnapshot,
  NODE_MONITORING_IDLE_TTL_MS,
  NODE_MONITORING_MAX_KEYS,
  NodeMonitoringService,
} from './node-monitoring.service.js';

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

  it('keeps container stats in live monitoring snapshots', () => {
    const containerStats = [{ containerId: 'container-1', cpuPercent: 12.5 }];
    expect(
      compactMonitoringHistorySnapshot({
        timestamp: '2026-09-02T20:00:00.000Z',
        health: { containerStats },
        stats: {},
      }).health.containerStats
    ).toEqual(containerStats);
  });

  it('bounds resource keys and expires idle history even without new snapshots', async () => {
    vi.useFakeTimers();
    const { service } = createService();
    service.pushSnapshot('old', {}, {});
    for (let i = 0; i < NODE_MONITORING_MAX_KEYS; i++) service.pushSnapshot(String(i), {}, {});
    expect(await service.getHistory('old')).toEqual([]);
    expect(await service.getHistory('0')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(NODE_MONITORING_IDLE_TTL_MS + 15_000);
    expect((service as any).history.size).toBe(0);
    expect((service as any).historyActivity.size).toBe(0);
    service.destroy();
  });

  it('clears history and prevents delayed startup after destroy', async () => {
    vi.useFakeTimers();
    const { service } = createService();
    service.pushSnapshot('node', {}, {});
    service.destroy();
    await vi.advanceTimersByTimeAsync(15_000);
    service.pushSnapshot('late', {}, {});
    expect((service as any).history.size).toBe(0);
    expect((service as any).historyActivity.size).toBe(0);
    expect(await service.getHistory('node')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not repopulate history from a poll completing after destroy', async () => {
    vi.useFakeTimers();
    const { service, registry } = createService();
    registry.getNode.mockReturnValue({
      type: 'docker',
      commandStream: { write: vi.fn() },
      lastHealthReport: { cpuPercent: 1 },
      lastStatsReport: {},
    } as never);
    service.registerClient('node');
    service.destroy();
    await vi.advanceTimersByTimeAsync(2000);
    expect((service as any).history.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

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

  it('loads bootstrap history from Redis before falling back to process memory', async () => {
    const snapshot = {
      timestamp: '2026-08-31T08:00:00.000Z',
      health: { cpuPercent: 12 },
      stats: { requests: 34 },
      traffic: null,
    };
    const cache = {
      getClient: () => ({ lrange: vi.fn().mockResolvedValue([JSON.stringify(snapshot)]) }),
    };
    const { registry } = createService();
    const service = new NodeMonitoringService(registry as never, cache as never);

    await expect(service.getHistory('node-1')).resolves.toEqual([snapshot]);
    service.destroy();
  });

  it('keeps a newer process-local point while its asynchronous Redis write is still pending', async () => {
    const persisted = {
      timestamp: '2026-08-31T08:00:00.000Z',
      health: { cpuPercent: 12 },
      stats: {},
      traffic: null,
    };
    const pipeline = {
      rpush: vi.fn(),
      ltrim: vi.fn(),
      expire: vi.fn(),
      exec: vi.fn().mockReturnValue(new Promise(() => {})),
    };
    pipeline.rpush.mockReturnValue(pipeline);
    pipeline.ltrim.mockReturnValue(pipeline);
    pipeline.expire.mockReturnValue(pipeline);
    const cache = {
      getClient: () => ({
        lrange: vi.fn().mockResolvedValue([JSON.stringify(persisted)]),
        multi: () => pipeline,
      }),
    };
    const { registry } = createService();
    const service = new NodeMonitoringService(registry as never, cache as never);

    vi.setSystemTime(new Date('2026-08-31T08:00:02.000Z'));
    service.pushSnapshot('node-1', { cpuPercent: 24 }, {});

    await expect(service.getHistory('node-1')).resolves.toEqual([
      persisted,
      expect.objectContaining({ timestamp: '2026-08-31T08:00:02.000Z', health: { cpuPercent: 24 } }),
    ]);
    service.destroy();
  });

  it('persists a compact bounded history entry in Redis', () => {
    const pipeline = {
      rpush: vi.fn(),
      ltrim: vi.fn(),
      expire: vi.fn(),
      exec: vi.fn().mockResolvedValue([]),
    };
    pipeline.rpush.mockReturnValue(pipeline);
    pipeline.ltrim.mockReturnValue(pipeline);
    pipeline.expire.mockReturnValue(pipeline);
    const cache = { getClient: () => ({ multi: () => pipeline }) };
    const { registry } = createService();
    const service = new NodeMonitoringService(registry as never, cache as never);
    const emitted = vi.fn();
    service.on('snapshot', emitted);

    service.pushSnapshot('node-1', { cpuPercent: 12, privateField: 'omitted' }, { requests: 34 });

    expect(pipeline.rpush).toHaveBeenCalledOnce();
    expect(pipeline.rpush.mock.calls[0]?.[0]).toBe('node-monitoring-history:v1:node-1');
    const persistedSnapshot = JSON.parse(String(pipeline.rpush.mock.calls[0]?.[1]));
    expect(persistedSnapshot).toMatchObject({
      health: { cpuPercent: 12 },
      stats: { requests: 34 },
    });
    expect(emitted).toHaveBeenCalledWith({ nodeId: 'node-1', snapshot: persistedSnapshot });
    expect(String(pipeline.rpush.mock.calls[0]?.[1])).not.toContain('privateField');
    expect(pipeline.ltrim).toHaveBeenCalledWith('node-monitoring-history:v1:node-1', -60, -1);
    expect(pipeline.expire).toHaveBeenCalledWith('node-monitoring-history:v1:node-1', 3600);
    service.destroy();
  });
});
