import { describe, expect, it, vi } from 'vitest';
import { EventBusService } from '@/services/event-bus.service.js';
import {
  DatabaseMonitoringService,
  measureConfirmedClickHousePingLatency,
  measureConfirmedDatabasePingLatency,
  redisPersistedSizeBytes,
} from './database-monitoring.service.js';

describe('measureConfirmedClickHousePingLatency', () => {
  it('uses a single fast probe', async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125);

    await expect(measureConfirmedClickHousePingLatency(ping, now)).resolves.toBe(25);
    expect(ping).toHaveBeenCalledOnce();
  });

  it('does not treat one cold tunnel probe as sustained degradation', async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const now = vi
      .fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(1150)
      .mockReturnValueOnce(1200)
      .mockReturnValueOnce(1214);

    await expect(measureConfirmedClickHousePingLatency(ping, now)).resolves.toBe(14);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('keeps confirmed slow probes degraded', async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const now = vi
      .fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(1100)
      .mockReturnValueOnce(1200)
      .mockReturnValueOnce(2305);

    await expect(measureConfirmedClickHousePingLatency(ping, now)).resolves.toBe(1105);
    expect(ping).toHaveBeenCalledTimes(2);
  });
});

describe('measureConfirmedDatabasePingLatency', () => {
  it('does not mark a one-off slow Redis ping as degraded', async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const now = vi
      .fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(1_600)
      .mockReturnValueOnce(1_700)
      .mockReturnValueOnce(1_708);

    await expect(measureConfirmedDatabasePingLatency(ping, now)).resolves.toBe(8);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('keeps PostgreSQL health independent from slower dashboard metric queries', async () => {
    const ping = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(112);

    await expect(measureConfirmedDatabasePingLatency(ping, now)).resolves.toBe(12);
    expect(ping).toHaveBeenCalledOnce();
  });
});

describe('redisPersistedSizeBytes', () => {
  it('uses the current AOF size for persistent Redis storage', () => {
    expect(redisPersistedSizeBytes({ aof_enabled: '1', aof_current_size: '4096' })).toBe(4096);
  });

  it('does not report an in-memory value as disk usage when AOF is disabled', () => {
    expect(redisPersistedSizeBytes({ aof_enabled: '0', aof_current_size: '4096' })).toBeNull();
  });
});

describe('database monitoring poll scheduling', () => {
  it('runs the first background sweep immediately without a registered client', async () => {
    const databaseService = {
      listAllRows: vi.fn().mockResolvedValue([{ id: 'database-1' }]),
      get: vi.fn().mockResolvedValue({ managed: { status: 'paused' } }),
    };
    const service = new DatabaseMonitoringService(databaseService as never, null);
    service.start();

    await vi.waitFor(() => expect(databaseService.get).toHaveBeenCalledWith('database-1'));

    expect(databaseService.listAllRows).toHaveBeenCalledOnce();
    service.destroy();
  });

  it('polls newly ready managed databases without waiting for the next background sweep', async () => {
    const databaseService = {
      listAllRows: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ managed: { status: 'paused' } }),
    };
    const service = new DatabaseMonitoringService(databaseService as never, null);
    const eventBus = new EventBusService();
    service.setEventBus(eventBus);

    eventBus.publish('database.changed', {
      resourceKind: 'managed_database',
      id: 'database-1',
      action: 'created',
    });
    await Promise.resolve();
    expect(databaseService.get).not.toHaveBeenCalled();

    eventBus.publish('database.changed', {
      resourceKind: 'managed_database',
      id: 'database-1',
      action: 'ready',
    });

    await vi.waitFor(() => expect(databaseService.get).toHaveBeenCalledWith('database-1'));
    service.destroy();
  });

  it('stops cleanly when a connection is deleted during an in-flight poll', async () => {
    const databaseService = {
      get: vi.fn().mockRejectedValue(new Error('Connection not found')),
      updateHealth: vi.fn(),
    };
    const service = new DatabaseMonitoringService(databaseService as never, null);
    const poll = service as unknown as { pollOnce(databaseId: string): Promise<void> };

    await expect(poll.pollOnce('deleted-clickhouse')).resolves.toBeUndefined();
    expect(databaseService.updateHealth).not.toHaveBeenCalled();
    service.destroy();
  });

  it('does not run overlapping polls for the same database', async () => {
    let resolveConnection!: (value: { managed: { status: 'paused' } }) => void;
    const connection = new Promise<{ managed: { status: 'paused' } }>((resolve) => {
      resolveConnection = resolve;
    });
    const databaseService = { get: vi.fn(() => connection) };
    const service = new DatabaseMonitoringService(databaseService as never, null);

    const poll = service as unknown as { pollOnce(databaseId: string): Promise<void> };
    const first = poll.pollOnce('database-1');
    const second = poll.pollOnce('database-1');
    await Promise.resolve();

    expect(databaseService.get).toHaveBeenCalledOnce();
    resolveConnection({ managed: { status: 'paused' } });
    await Promise.all([first, second]);
    service.destroy();
  });

  it('serializes managed polling on the same database node', async () => {
    const service = new DatabaseMonitoringService({} as never, null);
    const scheduler = service as unknown as {
      queueManagedNodePoll<T>(nodeId: string | undefined, task: () => Promise<T>): Promise<T>;
    };
    const execution: string[] = [];
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = scheduler.queueManagedNodePoll('node-1', async () => {
      execution.push('first-start');
      markFirstStarted();
      await firstGate;
      execution.push('first-end');
    });
    const second = scheduler.queueManagedNodePoll('node-1', async () => {
      execution.push('second');
    });

    await firstStarted;
    expect(execution).toEqual(['first-start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(execution).toEqual(['first-start', 'first-end', 'second']);
    service.destroy();
  });
});
