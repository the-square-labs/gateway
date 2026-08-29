import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { __testOnly, canFailOver, InferenceRoutingService } from './inference-routing.service.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function routingHarness(options: {
  affinity: string | null;
  quotas: Array<number | null>;
  activeThreads?: number[];
  strategy?: 'balanced' | 'even' | 'sequential';
  evalResults?: number[];
  subsequentAffinity?: string;
}) {
  const connections = options.quotas.map((_, index) => ({
    id: `connection-${index + 1}`,
    providerId: 'openai',
    enabled: true,
    deletedAt: null,
    routingOrder: index,
    status: 'healthy',
    healthReason: null,
    minimumRemainingPercent: 1,
  }));
  const selection = Promise.resolve(connections) as Promise<typeof connections> & {
    from: () => unknown;
    where: () => unknown;
  };
  selection.from = () => selection;
  selection.where = () => selection;
  const findMany = vi.fn();
  for (const [index, remainingFraction] of options.quotas.entries()) {
    findMany.mockResolvedValueOnce(
      remainingFraction === null
        ? []
        : [
            {
              connectionId: connections[index]!.id,
              status: 'fresh',
              dimension: '5h',
              modelBucket: null,
              remainingFraction: String(remainingFraction),
              fetchedAt: new Date('2099-08-28T10:00:00Z'),
              validUntil: new Date('2099-08-28T11:00:00Z'),
            },
          ]
    );
  }
  const db = {
    select: vi.fn().mockReturnValue(selection),
    update: vi.fn(),
    query: {
      inferenceProviderSettings: {
        findFirst: vi.fn().mockResolvedValue({ routingStrategy: options.strategy ?? 'balanced' }),
      },
      inferenceQuotaSnapshots: { findMany },
    },
  };
  const pipeline = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(
      connections.flatMap((_, index) => [
        [null, 0],
        [null, options.activeThreads?.[index] ?? 0],
      ])
    ),
  };
  const get = vi.fn().mockResolvedValueOnce(options.affinity);
  if (options.subsequentAffinity !== undefined) get.mockResolvedValueOnce(options.subsequentAffinity);
  const evalMock = vi.fn();
  for (const result of options.evalResults ?? [1]) evalMock.mockResolvedValueOnce(result);
  const redis = {
    get,
    exists: vi.fn().mockResolvedValue(0),
    pipeline: vi.fn().mockReturnValue(pipeline),
    eval: evalMock,
    del: vi.fn().mockResolvedValue(1),
  };
  return {
    service: new InferenceRoutingService(db as never, redis as never),
    connections,
    db,
    redis,
    pipeline,
  };
}

describe('inference routing policy', () => {
  const healthy = {
    id: 'connection-a',
    providerId: 'openai',
    order: 0,
    status: 'healthy',
    remainingFraction: 0.5,
    minimumRemainingFraction: 0.01,
  };

  it('keeps even routing deterministic and approximately equal', () => {
    expect(__testOnly.uniformScore('thread-1', healthy)).toBe(__testOnly.uniformScore('thread-1', healthy));
    const lowQuota = { ...healthy, id: 'connection-b', remainingFraction: 0.05 };
    let healthyWins = 0;
    let lowWins = 0;
    for (let index = 0; index < 500; index += 1) {
      const seed = `thread-${index}`;
      if (__testOnly.uniformScore(seed, healthy) > __testOnly.uniformScore(seed, lowQuota)) healthyWins += 1;
      else lowWins += 1;
    }
    expect(healthyWins).toBeGreaterThan(200);
    expect(lowWins).toBeGreaterThan(200);
  });

  it('weights balanced routing by remaining quota', () => {
    const high = { ...healthy, id: 'connection-high', remainingFraction: 0.9 };
    const low = { ...healthy, id: 'connection-low', remainingFraction: 0.1 };
    let highWins = 0;
    for (let index = 0; index < 2_000; index += 1) {
      if (__testOnly.quotaWeightedCandidate(`thread-${index}`, [high, low]).id === high.id) highWins += 1;
    }
    expect(highWins).toBeGreaterThan(1_700);
    expect(highWins).toBeLessThan(1_900);
  });

  it('keeps affinity sticky until it has been inactive for more than one hour', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const affinity = JSON.stringify({ connectionId: 'connection-1', lastActivityAt: now - 60 * 60 * 1000 });
    const { service, connections, pipeline } = routingHarness({ affinity, quotas: [0.2, 0.8] });

    const selected = await service.select({
      providerId: 'openai',
      allowedConnectionIds: connections.map(({ id }) => id),
      affinityKey: 'thread-1',
      existingThread: true,
    });

    expect(selected.connectionId).toBe('connection-1');
    expect(pipeline.exec).not.toHaveBeenCalled();
  });

  it('rebalances an idle affinity when another account has at least twice the normalized quota headroom', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const affinity = JSON.stringify({ connectionId: 'connection-1', lastActivityAt: now - 60 * 60 * 1000 - 1 });
    const { service, connections, redis } = routingHarness({
      affinity,
      quotas: [0.2, 0.8],
      activeThreads: [1, 1],
      evalResults: [0, 1],
    });

    const selected = await service.select({
      providerId: 'openai',
      allowedConnectionIds: connections.map(({ id }) => id),
      affinityKey: 'thread-quota',
      existingThread: true,
    });

    expect(selected.connectionId).toBe('connection-2');
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      3,
      expect.stringContaining('inference:affinity:'),
      'inference:active-threads:connection-1',
      'inference:active-threads:connection-2',
      affinity,
      expect.stringContaining('"connectionId":"connection-2"'),
      expect.any(String),
      now,
      86_400
    );
  });

  it('rebalances an idle affinity away from an account with twice the active thread load', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const affinity = JSON.stringify({ connectionId: 'connection-1', lastActivityAt: now - 2 * 60 * 60 * 1000 });
    const { service, connections } = routingHarness({
      affinity,
      quotas: [0.5, 0.5],
      activeThreads: [6, 2],
      evalResults: [0, 1],
    });

    await expect(
      service.select({
        providerId: 'openai',
        allowedConnectionIds: connections.map(({ id }) => id),
        affinityKey: 'thread-load',
        existingThread: true,
      })
    ).resolves.toMatchObject({ connectionId: 'connection-2' });
  });

  it('does not rebalance a single active thread merely because another account has zero', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const affinity = JSON.stringify({ connectionId: 'connection-1', lastActivityAt: now - 2 * 60 * 60 * 1000 });
    const { service, connections } = routingHarness({
      affinity,
      quotas: [0.5, 0.5],
      activeThreads: [1, 0],
      evalResults: [0, 1],
    });

    await expect(
      service.select({
        providerId: 'openai',
        allowedConnectionIds: connections.map(({ id }) => id),
        affinityKey: 'thread-small-load',
        existingThread: true,
      })
    ).resolves.toMatchObject({ connectionId: 'connection-1' });
  });

  it('does not apply idle affinity rebalancing to sequential routing', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const affinity = JSON.stringify({ connectionId: 'connection-1', lastActivityAt: now - 2 * 60 * 60 * 1000 });
    const { service, connections, pipeline } = routingHarness({
      affinity,
      quotas: [0.1, 0.9],
      activeThreads: [20, 0],
      strategy: 'sequential',
    });

    await expect(
      service.select({
        providerId: 'openai',
        allowedConnectionIds: connections.map(({ id }) => id),
        affinityKey: 'thread-sequential',
        existingThread: true,
      })
    ).resolves.toMatchObject({ connectionId: 'connection-1' });
    expect(pipeline.exec).not.toHaveBeenCalled();
  });

  it('applies a one-hour hysteresis after a normal account switch', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const affinity = JSON.stringify({
      connectionId: 'connection-1',
      lastActivityAt: now - 2 * 60 * 60 * 1000,
      lastRebalancedAt: now - 30 * 60 * 1000,
    });
    const { service, connections, pipeline } = routingHarness({
      affinity,
      quotas: [0.1, 0.9],
      activeThreads: [20, 0],
    });

    await expect(
      service.select({
        providerId: 'openai',
        allowedConnectionIds: connections.map(({ id }) => id),
        affinityKey: 'thread-hysteresis',
        existingThread: true,
      })
    ).resolves.toMatchObject({ connectionId: 'connection-1' });
    expect(pipeline.exec).not.toHaveBeenCalled();
  });

  it('allows a normal idle rebalance once the one-hour hysteresis has elapsed', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const affinity = JSON.stringify({
      connectionId: 'connection-1',
      lastActivityAt: now - 2 * 60 * 60 * 1000,
      lastRebalancedAt: now - 60 * 60 * 1000,
    });
    const { service, connections } = routingHarness({
      affinity,
      quotas: [0.1, 0.9],
      activeThreads: [20, 0],
      evalResults: [0, 1],
    });

    await expect(
      service.select({
        providerId: 'openai',
        allowedConnectionIds: connections.map(({ id }) => id),
        affinityKey: 'thread-hysteresis-elapsed',
        existingThread: true,
      })
    ).resolves.toMatchObject({ connectionId: 'connection-2' });
  });

  it('bypasses hysteresis when the pinned account reaches its configured reserve', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const affinity = JSON.stringify({
      connectionId: 'connection-1',
      lastActivityAt: now - 2 * 60 * 60 * 1000,
      lastRebalancedAt: now - 5 * 60 * 1000,
    });
    const { service, connections, pipeline } = routingHarness({
      affinity,
      quotas: [0.01, 0.9],
      activeThreads: [20, 0],
    });

    await expect(
      service.select({
        providerId: 'openai',
        allowedConnectionIds: connections.map(({ id }) => id),
        affinityKey: 'thread-emergency',
        existingThread: true,
      })
    ).resolves.toMatchObject({ connectionId: 'connection-2' });
    expect(pipeline.exec).not.toHaveBeenCalled();
  });

  it('does not rebalance an idle affinity while the thread still has an in-flight turn', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const affinity = JSON.stringify({ connectionId: 'connection-1', lastActivityAt: now - 2 * 60 * 60 * 1000 });
    const { service, connections, pipeline } = routingHarness({
      affinity,
      quotas: [0.1, 0.9],
      activeThreads: [20, 0],
      evalResults: [1, 1],
    });

    await expect(
      service.select({
        providerId: 'openai',
        allowedConnectionIds: connections.map(({ id }) => id),
        affinityKey: 'thread-in-flight',
        existingThread: true,
      })
    ).resolves.toMatchObject({ connectionId: 'connection-1' });
    expect(pipeline.exec).not.toHaveBeenCalled();
  });

  it('adopts a concurrently committed affinity instead of splitting one waking thread', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const affinity = JSON.stringify({ connectionId: 'connection-1', lastActivityAt: now - 2 * 60 * 60 * 1000 });
    const concurrent = JSON.stringify({ connectionId: 'connection-3', lastActivityAt: now });
    const { service, connections } = routingHarness({
      affinity,
      quotas: [0.1, 0.8, 0.7],
      activeThreads: [8, 1, 1],
      evalResults: [0, 0],
      subsequentAffinity: concurrent,
    });

    await expect(
      service.select({
        providerId: 'openai',
        allowedConnectionIds: connections.map(({ id }) => id),
        affinityKey: 'thread-concurrent',
        existingThread: true,
      })
    ).resolves.toMatchObject({ connectionId: 'connection-3' });
  });

  it('reads legacy plain affinity values without treating them as immediately idle', () => {
    expect(__testOnly.parseAffinityRecord('connection-legacy')).toEqual({
      connectionId: 'connection-legacy',
      lastActivityAt: null,
      lastRebalancedAt: null,
    });
  });

  it('clears affinity only when the stored value still matches the value that was read', async () => {
    const affinity = JSON.stringify({
      connectionId: 'connection-1',
      lastActivityAt: new Date('2026-08-28T12:00:00.000Z').getTime(),
      lastRebalancedAt: null,
    });
    const { service, redis } = routingHarness({ affinity, quotas: [], evalResults: [0] });

    await service.clearAffinity('thread-clear-race');

    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('if current ~= ARGV[1] then return 0 end'),
      2,
      expect.stringContaining('inference:affinity:'),
      'inference:active-threads:connection-1',
      affinity,
      expect.any(String)
    );
  });

  it('holds and releases a renewable per-thread turn lease', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { service, redis } = routingHarness({ affinity: null, quotas: [], evalResults: [1, 1] });

    const release = await service.beginAffinityTurn('thread-long-running');
    await release();

    expect(redis.eval).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("redis.call('ZADD', KEYS[1]"),
      1,
      expect.stringContaining('inference:affinity-turns:'),
      now,
      now + 5 * 60 * 1000,
      expect.any(String),
      6 * 60 * 1000
    );
    expect(redis.eval).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("redis.call('ZREM', KEYS[1]"),
      1,
      expect.stringContaining('inference:affinity-turns:'),
      expect.any(String)
    );
  });

  it('retries lease acquisition after a transient Redis failure', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-28T12:00:00.000Z').getTime();
    vi.setSystemTime(now);
    const { service, redis } = routingHarness({ affinity: null, quotas: [], evalResults: [] });
    redis.eval
      .mockRejectedValueOnce(new Error('temporary Redis outage'))
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);

    const release = await service.beginAffinityTurn('thread-retry-acquire');
    expect(redis.eval).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100_000);
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(redis.eval).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("redis.call('ZADD', KEYS[1]"),
      1,
      expect.stringContaining('inference:affinity-turns:'),
      now + 100_000,
      now + 100_000 + 5 * 60 * 1000,
      expect.any(String),
      6 * 60 * 1000
    );

    await release();
    expect(redis.eval).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("redis.call('ZREM', KEYS[1]"),
      1,
      expect.stringContaining('inference:affinity-turns:'),
      expect.any(String)
    );
  });

  it('waits for in-flight lease maintenance before releasing and does not reschedule it', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-28T12:00:00.000Z').getTime();
    vi.setSystemTime(now);
    const { service, redis } = routingHarness({ affinity: null, quotas: [], evalResults: [] });
    let finishRenewal!: (result: number) => void;
    redis.eval
      .mockResolvedValueOnce(1)
      .mockReturnValueOnce(
        new Promise<number>((resolve) => {
          finishRenewal = resolve;
        })
      )
      .mockResolvedValueOnce(1);

    const release = await service.beginAffinityTurn('thread-release-race');
    await vi.advanceTimersByTimeAsync(100_000);
    expect(redis.eval).toHaveBeenCalledTimes(2);

    const releasePromise = release();
    expect(redis.eval).toHaveBeenCalledTimes(2);
    finishRenewal(1);
    await releasePromise;

    expect(redis.eval).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("redis.call('ZREM', KEYS[1]"),
      1,
      expect.stringContaining('inference:affinity-turns:'),
      expect.any(String)
    );
    await vi.advanceTimersByTimeAsync(100_000);
    expect(redis.eval).toHaveBeenCalledTimes(3);
  });

  it('preserves the rebalance timestamp when completion refreshes thread activity', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const lastRebalancedAt = now - 30 * 60 * 1000;
    const affinity = JSON.stringify({
      connectionId: 'connection-1',
      lastActivityAt: now - 10 * 60 * 1000,
      lastRebalancedAt,
    });
    const { service, redis } = routingHarness({ affinity, quotas: [] });

    await service.markAffinityActive('thread-completed');

    const persisted = JSON.parse(String(redis.eval.mock.calls[0]?.[6]));
    expect(persisted).toMatchObject({ connectionId: 'connection-1', lastActivityAt: now, lastRebalancedAt });
  });

  it('selects the cross-provider route furthest above its reserve', () => {
    const nearlyReserved = {
      ...healthy,
      id: 'provider-low',
      providerId: 'provider-a',
      remainingFraction: 0.12,
      minimumRemainingFraction: 0.1,
    };
    const highCapacity = {
      ...healthy,
      id: 'provider-high',
      providerId: 'provider-b',
      remainingFraction: 0.7,
      minimumRemainingFraction: 0.05,
    };
    expect(__testOnly.highestCapacityCandidate('thread-1', [nearlyReserved, highCapacity]).id).toBe('provider-high');
  });

  it('uses an unknown-capacity cross-provider route only when no fresh quota is known', () => {
    const known = { ...healthy, id: 'known', providerId: 'provider-a', remainingFraction: 0.2 };
    const unknown = { ...healthy, id: 'unknown', providerId: 'provider-b', remainingFraction: null };
    expect(__testOnly.highestCapacityCandidate('thread-1', [known, unknown]).id).toBe('known');
    expect(['unknown-a', 'unknown-b']).toContain(
      __testOnly.highestCapacityCandidate('thread-1', [
        { ...unknown, id: 'unknown-a' },
        { ...unknown, id: 'unknown-b' },
      ]).id
    );
  });

  it('replaces old affinity across providers when the pinned account is below its reserve', async () => {
    const connections = [
      {
        id: 'provider-low',
        providerId: 'openai',
        enabled: true,
        deletedAt: null,
        routingOrder: 0,
        status: 'quota_hot',
        healthReason: null,
        minimumRemainingPercent: 10,
      },
      {
        id: 'provider-high',
        providerId: 'anthropic',
        enabled: true,
        deletedAt: null,
        routingOrder: 0,
        status: 'healthy',
        healthReason: null,
        minimumRemainingPercent: 5,
      },
    ];
    const selection = Promise.resolve(connections) as Promise<typeof connections> & {
      from: () => unknown;
      where: () => unknown;
    };
    selection.from = () => selection;
    selection.where = () => selection;
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([
        {
          connectionId: 'provider-low',
          status: 'fresh',
          dimension: '5h',
          modelBucket: null,
          remainingFraction: '0.07',
          fetchedAt: new Date('2099-08-27T10:00:00Z'),
          validUntil: new Date('2099-08-27T11:00:00Z'),
        },
      ])
      .mockResolvedValueOnce([
        {
          connectionId: 'provider-high',
          status: 'fresh',
          dimension: '5h',
          modelBucket: null,
          remainingFraction: '0.70',
          fetchedAt: new Date('2099-08-27T10:00:00Z'),
          validUntil: new Date('2099-08-27T11:00:00Z'),
        },
      ]);
    const db = {
      select: vi.fn().mockReturnValue(selection),
      update: vi.fn(),
      query: {
        inferenceProviderSettings: { findFirst: vi.fn() },
        inferenceQuotaSnapshots: { findMany },
      },
    };
    const redis = {
      get: vi.fn().mockResolvedValue('provider-low'),
      exists: vi.fn().mockResolvedValue(0),
      eval: vi.fn().mockResolvedValue(1),
    };

    const selected = await new InferenceRoutingService(db as never, redis as never).select({
      allowedConnectionIds: connections.map((connection) => connection.id),
      affinityKey: 'thread-1',
      existingThread: true,
    });

    expect(selected).toMatchObject({ connectionId: 'provider-high', providerId: 'anthropic' });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('SET', KEYS[1]"),
      3,
      expect.stringContaining('inference:affinity:'),
      'inference:active-threads:provider-low',
      'inference:active-threads:provider-high',
      'provider-low',
      expect.stringContaining('"connectionId":"provider-high"'),
      expect.any(String),
      expect.any(Number),
      86_400
    );
  });

  it('keeps a usable quota-hot affinity for an existing thread', async () => {
    const candidates = [
      { ...healthy, id: 'connection-low', status: 'quota_hot', remainingFraction: 0.07 },
      { ...healthy, id: 'connection-high', remainingFraction: 0.75 },
    ];
    expect(__testOnly.preferredCandidate('connection-low', __testOnly.usableCandidates(candidates))?.id).toBe(
      'connection-low'
    );
  });

  it('excludes unknown quota candidates when known quota exists and falls back to even when all are unknown', () => {
    const high = { ...healthy, id: 'connection-high', remainingFraction: 0.8 };
    const low = { ...healthy, id: 'connection-low', remainingFraction: 0.2 };
    const unknown = { ...healthy, id: 'connection-unknown', remainingFraction: null };
    const selected = __testOnly.quotaWeightedCandidate('thread-42', [high, low, unknown]);
    const expected = __testOnly.highestScore('thread-42', [high, low], (candidate) => candidate.remainingFraction!);
    expect(selected.id).toBe(expected.id);
    expect(selected.id).not.toBe(unknown.id);

    const unknownA = { ...unknown, id: 'unknown-a' };
    const unknownB = { ...unknown, id: 'unknown-b' };
    expect(__testOnly.quotaWeightedCandidate('thread-43', [unknownA, unknownB]).id).toBe(
      __testOnly.highestScore('thread-43', [unknownA, unknownB], () => 1).id
    );
  });

  it('uses the configured reserve equally for new and existing threads', () => {
    expect(__testOnly.isUsable({ ...healthy, remainingFraction: 0.099 })).toBe(true);
    expect(__testOnly.isUsable({ ...healthy, remainingFraction: 0.011 })).toBe(true);
    expect(__testOnly.isUsable({ ...healthy, remainingFraction: 0.01 })).toBe(false);
    expect(__testOnly.isUsable({ ...healthy, remainingFraction: 0.009 })).toBe(false);
    expect(__testOnly.isUsable({ ...healthy, remainingFraction: 0 })).toBe(false);
    expect(__testOnly.isUsable({ ...healthy, status: 'cooldown' })).toBe(false);
  });

  it('keeps every account above its configured reserve in the routing pool', () => {
    const lowAccounts = [
      { ...healthy, id: 'connection-a', status: 'quota_hot', remainingFraction: 0.07 },
      { ...healthy, id: 'connection-b', status: 'quota_hot', remainingFraction: 0.04 },
    ];

    expect(__testOnly.usableCandidates(lowAccounts).map((candidate) => candidate.id)).toEqual([
      'connection-a',
      'connection-b',
    ]);
  });

  it('excludes only accounts at or below their own reserve', () => {
    const candidates = [
      { ...healthy, id: 'connection-normal', remainingFraction: 0.2 },
      { ...healthy, id: 'connection-low', status: 'quota_hot', remainingFraction: 0.01 },
    ];

    expect(__testOnly.usableCandidates(candidates).map((candidate) => candidate.id)).toEqual(['connection-normal']);
  });

  it('reports only routing-safe candidate diagnostics when capacity is unavailable', () => {
    expect(
      __testOnly.candidateDiagnostic({
        ...healthy,
        id: 'connection-low',
        providerId: 'openai',
        status: 'quota_hot',
        remainingFraction: 0.07,
        minimumRemainingFraction: 0.1,
      })
    ).toEqual({
      connectionId: 'connection-low',
      providerId: 'openai',
      status: 'quota_hot',
      remainingFraction: 0.07,
      minimumRemainingFraction: 0.1,
      usable: false,
    });
  });

  it('uses routing order only for sequential selection', () => {
    expect(
      __testOnly.firstSequentialCandidate([
        { ...healthy, id: 'connection-later', order: 2 },
        { ...healthy, id: 'connection-first', order: 0 },
        { ...healthy, id: 'connection-middle', order: 1 },
      ]).id
    ).toBe('connection-first');
  });

  it('enforces the configured reserve as a strict lower bound', () => {
    const reserved = { ...healthy, remainingFraction: 0.2, minimumRemainingFraction: 0.25 };
    expect(__testOnly.isUsable(reserved)).toBe(false);
    expect(__testOnly.isUsable({ ...reserved, remainingFraction: 0.25 })).toBe(false);
    expect(__testOnly.isUsable({ ...reserved, remainingFraction: 0.251 })).toBe(true);
  });

  it('uses only quota windows reported by the latest synchronization', () => {
    const rows = [
      { dimension: '5h', modelBucket: null, fetchedAt: new Date('2026-07-27T12:00:00Z') },
      { dimension: '7d', modelBucket: null, fetchedAt: new Date('2026-07-27T12:00:00Z') },
      { dimension: '5h', modelBucket: null, fetchedAt: new Date('2026-07-27T11:00:00Z') },
      { dimension: 'subscription', modelBucket: null, fetchedAt: new Date('2026-07-26T10:00:00Z') },
    ] as never;
    expect(__testOnly.latestQuotaWindows(rows).map((row) => [row.dimension, row.fetchedAt.toISOString()])).toEqual([
      ['5h', '2026-07-27T12:00:00.000Z'],
      ['7d', '2026-07-27T12:00:00.000Z'],
    ]);
  });

  it('restores a connection after its timed cooldown expires', () => {
    expect(__testOnly.statusAfterCooldown('cooldown', true)).toBe('cooldown');
    expect(__testOnly.statusAfterCooldown('cooldown', false)).toBe('healthy');
  });

  it('permits classified failover only before client-visible output', () => {
    const retryable = new InferenceProtocolError(429, 'provider_rate_limited', 'busy');
    expect(canFailOver(retryable, false)).toBe(true);
    expect(
      canFailOver(new InferenceProtocolError(429, 'provider_api_budget_exhausted', 'budget exhausted'), false)
    ).toBe(true);
    expect(canFailOver(retryable, true)).toBe(false);
    expect(canFailOver(new InferenceProtocolError(502, 'cyber_policy', 'blocked by policy'), false)).toBe(false);
    expect(canFailOver(new InferenceProtocolError(400, 'invalid_request', 'bad'), false)).toBe(false);
    expect(canFailOver(new Error('network details'), false)).toBe(false);
  });
});
