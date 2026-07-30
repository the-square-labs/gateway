import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { assertProviderApiBudget, providerApiBudgetAvailable, utcMonthStart } from './inference-provider-budget.js';

describe('provider API monthly budget', () => {
  it('resets usage at the start of each UTC month', () => {
    expect(utcMonthStart(new Date('2026-07-27T23:59:59.000Z')).toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('admits the boundary and rejects usage above the configured limit', () => {
    expect(providerApiBudgetAvailable(900, 100, 1_000)).toBe(true);
    expect(providerApiBudgetAvailable(900, 101, 1_000)).toBe(false);
    expect(providerApiBudgetAvailable(10_000, 10_000, null)).toBe(true);
  });

  it('includes settled and active usage when enforcing a connection budget', async () => {
    const database = fakeDatabase(700, 200);
    await expect(
      assertProviderApiBudget(
        database as never,
        { id: 'connection-1', apiMonthlyLimitMicrodollars: 1_000 },
        100,
        'request-1',
        new Date('2026-07-27T12:00:00.000Z')
      )
    ).resolves.toBeUndefined();

    await expect(
      assertProviderApiBudget(
        fakeDatabase(700, 200) as never,
        { id: 'connection-1', apiMonthlyLimitMicrodollars: 1_000 },
        101,
        'request-2',
        new Date('2026-07-27T12:00:00.000Z')
      )
    ).rejects.toMatchObject({ status: 429, code: 'provider_api_budget_exhausted' });
  });
});

function fakeDatabase(settled: number, active: number) {
  const groupBy = vi
    .fn()
    .mockResolvedValueOnce([{ connectionId: 'connection-1', microdollars: settled }])
    .mockResolvedValueOnce([{ connectionId: 'connection-1', microdollars: active }]);
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({ where: vi.fn(() => ({ groupBy })) })),
        where: vi.fn(() => ({ groupBy })),
      })),
    })),
  };
}
