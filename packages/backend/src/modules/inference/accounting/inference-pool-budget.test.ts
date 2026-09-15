import 'reflect-metadata';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { modelPoolBurnMultiplier, poolBurnMultiplier } from './inference-pool-budget.js';

const now = new Date('2026-09-15T14:00:00Z');
const accounts = ['a', 'b'].map((connectionId) => ({ connectionId, providerId: 'openai' }));
const quota = (connectionId: string, remainingFraction: string, overrides = {}) => ({
  connectionId,
  dimension: '7d',
  modelBucket: null,
  remainingFraction,
  limitValue: null,
  resetAt: new Date(now.getTime() + 7 * 86_400_000 * 0.55),
  fetchedAt: new Date(now.getTime() - 60_000),
  validUntil: new Date(now.getTime() + 60_000),
  ...overrides,
});

describe('model pool burn multiplier', () => {
  it.each([
    '0.2',
    '0.3',
  ])('preserves simultaneous bucket reset constraints independently of row order (%s)', (modelRemaining) => {
    const members = [{ ...accounts[0]!, modelIds: ['gpt-6-astra'] }];
    const rows = [
      quota('a', '0.2', { resetAt: new Date(now.getTime() + 7 * 86_400_000 * 0.1) }),
      quota('a', modelRemaining, { modelBucket: 'gpt-6-astra', resetAt: new Date(now.getTime() + 7 * 86_400_000) }),
    ];
    expect(poolBurnMultiplier(members, rows, now)).toBe(5);
    expect(poolBurnMultiplier(members, [...rows].reverse(), now)).toBe(5);
  });
  it('deduplicates a provider account registered as multiple connections', () => {
    const members = [
      { ...accounts[0]!, accountExternalId: 'physical-a' },
      { ...accounts[0]!, connectionId: 'a-copy', accountExternalId: 'physical-a' },
      accounts[1]!,
    ];
    expect(
      poolBurnMultiplier(members, [quota('a', '0.03'), quota('a-copy', '0.03'), quota('b', '0.19')], now)
    ).toBeCloseTo(5);
  });

  it('ignores quotas of unrelated model buckets and keeps the matching model bucket', () => {
    const members = accounts.map((account) => ({ ...account, modelIds: ['gpt-6-astra'] }));
    const rows = [
      quota('a', '0.03', { modelBucket: 'gpt-6-astra' }),
      quota('b', '0.19'),
      quota('a', '0', { modelBucket: 'unrelated-model' }),
    ];
    expect(poolBurnMultiplier(members, rows, now)).toBeCloseTo(5);
  });

  it('treats explicitly unknown quota as unavailable instead of reviving an older fresh sample', () => {
    const rows = [
      quota('a', '1', { fetchedAt: new Date(now.getTime() - 120_000) }),
      quota('a', '0', { remainingFraction: null }),
      quota('b', '1'),
    ];
    expect(poolBurnMultiplier(accounts, rows, now)).toBeCloseTo(1.1);
    expect(
      poolBurnMultiplier(
        accounts,
        [quota('a', '0', { remainingFraction: null }), quota('b', '0', { remainingFraction: null })],
        now
      )
    ).toBe(8);
  });

  it('normalizes each reset before pooling and does not mix providers absolute capacity units', () => {
    const members = [accounts[0]!, { ...accounts[1]!, providerId: 'another-provider' }];
    const rows = [
      quota('a', '0', { resetAt: new Date(now.getTime() - 10_000), limitValue: '100' }),
      quota('b', '0.5', { resetAt: new Date(now.getTime() + 14 * 86_400_000), limitValue: '900' }),
    ];
    expect(poolBurnMultiplier(members, rows, now)).toBeCloseTo(2);
  });

  it('prices 3% and 19% accounts from their common 11% pool, not either selected account', () => {
    const rows = [quota('a', '0.03'), quota('b', '0.19')];
    expect(poolBurnMultiplier(accounts, rows, now)).toBeCloseTo(5);
    expect(poolBurnMultiplier([...accounts].reverse(), [...rows].reverse(), now)).toBeCloseTo(5);
  });

  it('does not average clamped per-account multipliers or discard depleted capacity', () => {
    expect(poolBurnMultiplier(accounts, [quota('a', '0'), quota('b', '1')], now)).toBeCloseTo(1.1);
    expect(poolBurnMultiplier(accounts, [quota('a', '0'), quota('b', '0')], now)).toBe(8);
  });

  it('weights comparable absolute quotas and falls back to equal shares for unknown capacities', () => {
    const rows = [quota('a', '0', { limitValue: '100' }), quota('b', '0.2', { limitValue: '900' })];
    expect(poolBurnMultiplier(accounts, rows, now)).toBeCloseTo(0.55 / 0.18);
    expect(poolBurnMultiplier(accounts, [rows[0]!, quota('b', '0.2')], now)).toBeCloseTo(5.5);
  });

  it('uses each account latest batch and does not count duplicate aliases or rows twice', () => {
    const rows = [
      quota('a', '0.03'),
      quota('a', '0.03'),
      quota('b', '0.19', { fetchedAt: now }),
      quota('a', '0.9', { fetchedAt: new Date(now.getTime() - 120_000), dimension: '5h' }),
      quota('outside', '0'),
    ];
    expect(poolBurnMultiplier([...accounts, accounts[0]!], rows, now)).toBeCloseTo(5);
  });

  it('does not let one stale account force the whole pool to x8', () => {
    expect(poolBurnMultiplier(accounts, [quota('a', '1', { validUntil: now }), quota('b', '1')], now)).toBeCloseTo(1.1);
    expect(poolBurnMultiplier(accounts, [], now)).toBe(1);
  });

  it('keeps quota dimensions separate and uses their most constrained pooled window', () => {
    const rows = [
      quota('a', '0.2'),
      quota('b', '0.2'),
      quota('a', '1', { dimension: '5h', resetAt: new Date(now.getTime() + 18_000_000) }),
      quota('b', '1', { dimension: '5h', resetAt: new Date(now.getTime() + 18_000_000) }),
    ];
    expect(poolBurnMultiplier(accounts, rows, now)).toBeCloseTo(2.75);
  });

  it('queries enabled subscription membership by model, retaining depleted accounts', async () => {
    const predicates: unknown[] = [];
    const results = [
      [...accounts, accounts[0]!],
      [quota('a', '0.03'), quota('b', '0.19')],
    ];
    const db = {
      select: vi.fn(() => {
        const chain = {
          from: () => chain,
          innerJoin: () => chain,
          where: (value: unknown) => {
            predicates.push(value);
            return Promise.resolve(results.shift());
          },
        };
        return chain;
      }),
    };
    expect(await modelPoolBurnMultiplier(db as never, 'model-astra', now)).toBeCloseTo(5);
    const queries = predicates.map((value) => new PgDialect().sqlToQuery(value as never));
    expect(queries[0]!.params).toContain('model-astra');
    expect(queries[0]!.params).toContain('subscription');
    expect(queries[0]!.params).toContain('reauth_required');
    expect(queries[0]!.params).not.toContain('quota_hot');
    expect(queries[1]!.params).toEqual(['a', 'a', 'b', 'b']);
    expect(queries[1]!.sql).toContain('order by q.fetched_at desc limit 1');
    db.select.mockClear();
    expect(await modelPoolBurnMultiplier(db as never, 'model-astra', now, true)).toBe(1);
    expect(db.select).not.toHaveBeenCalled();
  });
});
