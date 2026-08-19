import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { __testOnly, canFailOver } from './inference-routing.service.js';

describe('inference routing policy', () => {
  const healthy = {
    id: 'connection-a',
    providerId: 'openai',
    order: 0,
    status: 'healthy',
    remainingFraction: 0.5,
    minimumRemainingFraction: 0,
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

  it('protects the new-thread and emergency floors', () => {
    expect(__testOnly.isUsable({ ...healthy, remainingFraction: 0.099 }, false)).toBe(false);
    expect(__testOnly.isUsable({ ...healthy, remainingFraction: 0.099 }, true)).toBe(true);
    expect(__testOnly.isUsable({ ...healthy, remainingFraction: 0.029 }, true)).toBe(false);
    expect(__testOnly.isUsable({ ...healthy, status: 'cooldown' }, true)).toBe(false);
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

  it('enforces a connection reserve above the hard safety floors', () => {
    const reserved = { ...healthy, remainingFraction: 0.2, minimumRemainingFraction: 0.25 };
    expect(__testOnly.isUsable(reserved, false)).toBe(false);
    expect(__testOnly.isUsable(reserved, true)).toBe(false);
    expect(__testOnly.isUsable({ ...reserved, remainingFraction: 0.25 }, false)).toBe(true);
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
    expect(canFailOver(new InferenceProtocolError(400, 'invalid_request', 'bad'), false)).toBe(false);
    expect(canFailOver(new Error('network details'), false)).toBe(false);
  });
});
