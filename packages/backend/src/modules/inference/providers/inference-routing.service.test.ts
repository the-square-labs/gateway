import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { __testOnly, canFailOver, InferenceRoutingService } from './inference-routing.service.js';

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
      set: vi.fn().mockResolvedValue('OK'),
    };

    const selected = await new InferenceRoutingService(db as never, redis as never).select({
      allowedConnectionIds: connections.map((connection) => connection.id),
      affinityKey: 'thread-1',
      existingThread: true,
    });

    expect(selected).toMatchObject({ connectionId: 'provider-high', providerId: 'anthropic' });
    expect(redis.set).toHaveBeenCalledWith(expect.stringContaining('inference:affinity:'), 'provider-high', 'EX', 86_400);
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
