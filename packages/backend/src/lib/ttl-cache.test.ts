import { describe, expect, it, vi } from 'vitest';
import { ScopeTargetRateLimiter } from '@/modules/integrations/git-scope-targets.js';
import { LookupBudget, LookupBudgetExceededError, TtlCache } from './ttl-cache.js';

describe('TtlCache', () => {
  it('expires entries, bypasses them for fresh loads and forgets a key prefix', async () => {
    let now = 0;
    const cache = new TtlCache<string>(1000, 10, () => now);
    const loader = vi.fn(async () => `value-${loader.mock.calls.length}`);

    expect(await cache.load('c1:a', loader)).toBe('value-1');
    expect(await cache.load('c1:a', loader)).toBe('value-1');
    // A fresh load always asks the provider, and refreshes the entry.
    expect(await cache.load('c1:a', loader, { fresh: true })).toBe('value-2');
    expect(await cache.load('c1:a', loader)).toBe('value-2');
    now = 1000;
    expect(await cache.load('c1:a', loader)).toBe('value-3');
    await cache.load('c2:a', loader);
    cache.deletePrefix('c1:');
    expect(cache.get('c1:a')).toBeUndefined();
    expect(cache.get('c2:a')).toBeDefined();
  });

  it('spends a lookup budget only on cache misses', async () => {
    const cache = new TtlCache<number>(60_000);
    const budget = new LookupBudget(2);
    await cache.load('a', async () => 1, { budget });
    await cache.load('a', async () => 1, { budget });
    await cache.load('b', async () => 2, { budget });
    await expect(cache.load('c', async () => 3, { budget })).rejects.toBeInstanceOf(LookupBudgetExceededError);
  });
});

describe('ScopeTargetRateLimiter', () => {
  it('limits requests per principal and window', () => {
    let now = 0;
    const limiter = new ScopeTargetRateLimiter({ windowMs: 1000, maxRequests: 2 }, () => now);
    limiter.consume('user-1');
    limiter.consume('user-1');
    expect(() => limiter.consume('user-1')).toThrowError(
      expect.objectContaining({ statusCode: 429, code: 'SCOPE_TARGET_RATE_LIMITED' })
    );
    // Another principal has its own window.
    expect(() => limiter.consume('user-2')).not.toThrow();
    now = 1000;
    expect(() => limiter.consume('user-1')).not.toThrow();
  });
});
