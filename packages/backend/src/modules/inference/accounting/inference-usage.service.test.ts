import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { toInternalCredits, toPublicCredits } from './inference-credit-units.js';
import { __testOnly, InferenceUsageService } from './inference-usage.service.js';
import { INFERENCE_USAGE_CHANGED_CHANNEL } from './inference-usage-events.js';

const LIMIT_INPUT = {
  enabled: true,
  credits5hEnabled: true,
  credits5h: 1_000,
  credits7dEnabled: true,
  credits7d: 4_000,
  credits30dEnabled: true,
  credits30d: 10_000,
  apiMonthlyMicrodollars: 10_000_000,
  billingTimezone: 'UTC',
};

function policyDb() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const where = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  return {
    query: { users: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1' }) } },
    insert: vi.fn(() => ({ values })),
    delete: vi.fn(() => ({ where })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ orderBy: vi.fn().mockResolvedValue([]) })) })),
    values,
  };
}

describe('inference usage presentation', () => {
  it('converts between internal accounting units and public credits', () => {
    expect(toPublicCredits(2_000_000)).toBe(2_000);
    expect(toInternalCredits(2_000)).toBe(2_000_000);
  });

  it('fills the system overview with ordered daily buckets', () => {
    expect(
      __testOnly.mergeDailyUsage(
        [
          { date: '2026-08-21', requests: 2 },
          { date: '2026-08-23', requests: 5 },
        ],
        [
          {
            date: '2026-08-22',
            credits: '2500',
            apiMicrodollars: 1_500_000,
            tokens: 90_000,
          },
        ],
        new Date('2026-08-21T00:00:00.000Z'),
        3
      )
    ).toEqual([
      { date: '2026-08-21', requests: 2, credits: 0, apiMicrodollars: 0, tokens: 0 },
      { date: '2026-08-22', requests: 0, credits: 2.5, apiMicrodollars: 1_500_000, tokens: 90_000 },
      { date: '2026-08-23', requests: 5, credits: 0, apiMicrodollars: 0, tokens: 0 },
    ]);
  });

  it('fills client token usage with ordered UTC daily buckets', () => {
    expect(
      __testOnly.mergeDailyTokenUsage(
        [
          { date: '2026-08-22', tokens: 90_000 },
          { date: '2026-08-23', tokens: 125_000 },
        ],
        new Date('2026-08-21T00:00:00.000Z'),
        3
      )
    ).toEqual([
      { date: '2026-08-21', tokens: 0 },
      { date: '2026-08-22', tokens: 90_000 },
      { date: '2026-08-23', tokens: 125_000 },
    ]);
  });

  it('combines current-user quota with lifetime and 30-day raw token totals', async () => {
    const lifetimeWhere = vi.fn().mockResolvedValue([{ tokens: 1_000_000 }]);
    const dailyOrderBy = vi.fn().mockResolvedValue([
      { date: '2026-08-22', tokens: 10_000 },
      { date: '2026-08-23', tokens: 20_000 },
    ]);
    const dailyGroupBy = vi.fn(() => ({ orderBy: dailyOrderBy }));
    const dailyWhere = vi.fn(() => ({ groupBy: dailyGroupBy }));
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: lifetimeWhere })) })
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: dailyWhere })) }),
    };
    const recoveryAt = {
      credits5h: new Date('2026-08-23T15:00:00.000Z'),
      credits7d: new Date('2026-08-30T00:00:00.000Z'),
      credits30d: new Date('2026-09-22T00:00:00.000Z'),
      apiMonthly: new Date('2026-09-01T00:00:00.000Z'),
    };
    const policies = {
      effective: vi.fn().mockResolvedValue({
        enabled: false,
        credits5hEnabled: false,
        credits5h: 0,
        credits7dEnabled: false,
        credits7d: 0,
        credits30dEnabled: false,
        credits30d: 0,
        apiMonthlyMicrodollars: 0,
        billingTimezone: 'UTC',
      }),
      usage: vi.fn().mockResolvedValue({
        credits5h: 0,
        credits7d: 0,
        credits30d: 0,
        apiMonthlyMicrodollars: 0,
        recoveryAt,
      }),
    };
    const service = new InferenceUsageService(
      db as unknown as ConstructorParameters<typeof InferenceUsageService>[0],
      policies as unknown as ConstructorParameters<typeof InferenceUsageService>[1],
      {} as ConstructorParameters<typeof InferenceUsageService>[2]
    );

    const result = await service.clientUsage(
      { id: 'user-1', groupId: 'group-1', scopes: ['feat:ai:use'], isBlocked: false } as never,
      new Date('2026-08-23T12:00:00.000Z')
    );

    expect(result.enabled).toBe(false);
    expect(result.tokens.lifetime).toBe(1_000_000);
    expect(result.tokens.daily).toHaveLength(30);
    expect(result.tokens.daily.at(-2)).toEqual({ date: '2026-08-22', tokens: 10_000 });
    expect(result.tokens.daily.at(-1)).toEqual({ date: '2026-08-23', tokens: 20_000 });
    expect(lifetimeWhere).toHaveBeenCalledOnce();
    expect(dailyWhere).toHaveBeenCalledOnce();
  });

  it('stores public policy limits in internal accounting units', async () => {
    const db = policyDb();
    const service = new InferenceUsageService(
      db as unknown as ConstructorParameters<typeof InferenceUsageService>[0],
      {} as ConstructorParameters<typeof InferenceUsageService>[1],
      { log: vi.fn().mockResolvedValue(undefined) } as unknown as ConstructorParameters<typeof InferenceUsageService>[2]
    );

    await service.setDefault('admin-1', LIMIT_INPUT);

    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        credits5h: '1000000',
        credits7d: '4000000',
        credits30d: '10000000',
      })
    );
  });

  it('presents internal limits and usage in public credits', () => {
    expect(
      __testOnly.publicLimits({
        enabled: true,
        credits5hEnabled: true,
        credits5h: 1_000_000,
        credits7dEnabled: true,
        credits7d: 4_000_000,
        credits30dEnabled: true,
        credits30d: 10_000_000,
        apiMonthlyMicrodollars: 10_000_000,
        billingTimezone: 'UTC',
      })
    ).toMatchObject({ credits5h: 1_000, credits7d: 4_000, credits30d: 10_000 });
    expect(
      __testOnly.publicUsage({
        credits5h: 125_000,
        credits7d: 250_000,
        credits30d: 500_000,
        apiMonthlyMicrodollars: 100,
        recoveryAt: {
          credits5h: new Date(0),
          credits7d: new Date(0),
          credits30d: new Date(0),
          apiMonthly: new Date(0),
        },
      })
    ).toMatchObject({ credits5h: 125, credits7d: 250, credits30d: 500 });
  });

  it('publishes global and user-scoped invalidations when limit policies change', async () => {
    const db = policyDb();
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const eventBus = { publish: vi.fn() };
    const service = new InferenceUsageService(
      db as unknown as ConstructorParameters<typeof InferenceUsageService>[0],
      {} as ConstructorParameters<typeof InferenceUsageService>[1],
      audit as unknown as ConstructorParameters<typeof InferenceUsageService>[2],
      eventBus as unknown as ConstructorParameters<typeof InferenceUsageService>[3]
    );

    await service.setDefault('admin-1', LIMIT_INPUT);
    await service.setUser('admin-1', 'user-1', LIMIT_INPUT);
    await service.removeUser('admin-1', 'user-1');

    expect(eventBus.publish).toHaveBeenNthCalledWith(1, INFERENCE_USAGE_CHANGED_CHANNEL, {
      targetUserId: null,
      reason: 'limits',
    });
    expect(eventBus.publish).toHaveBeenNthCalledWith(2, INFERENCE_USAGE_CHANGED_CHANNEL, {
      targetUserId: 'user-1',
      reason: 'limits',
    });
    expect(eventBus.publish).toHaveBeenNthCalledWith(3, INFERENCE_USAGE_CHANGED_CHANNEL, {
      targetUserId: 'user-1',
      reason: 'limits',
    });
  });

  it('closes subscription windows on reset and leaves them idle until the next request', async () => {
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const tx = {
      delete: vi.fn(() => ({ where: deleteWhere })),
      insert: vi.fn(() => ({ values })),
    };
    const db = {
      query: { users: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1' }) } },
      transaction: vi.fn(async (callback: (database: typeof tx) => Promise<void>) => callback(tx)),
    };
    const policies = {
      effective: vi.fn().mockResolvedValue({}),
      usage: vi.fn().mockResolvedValue({
        credits5h: 0,
        credits7d: 0,
        credits30d: 0,
        apiMonthlyMicrodollars: 0,
        active: { credits5h: false, credits7d: false, credits30d: false, apiMonthly: true },
        recoveryAt: {
          credits5h: new Date(0),
          credits7d: new Date(0),
          credits30d: new Date(0),
          apiMonthly: new Date(0),
        },
      }),
    };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const service = new InferenceUsageService(
      db as unknown as ConstructorParameters<typeof InferenceUsageService>[0],
      policies as unknown as ConstructorParameters<typeof InferenceUsageService>[1],
      audit as unknown as ConstructorParameters<typeof InferenceUsageService>[2]
    );

    const result = await service.resetUserLimits('admin-1', 'user-1');

    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.insert).toHaveBeenCalledTimes(4);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ dimension: 'credits5h', windowActive: false, createdBy: 'admin-1' })
    );
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ dimension: 'apiMonthlyMicrodollars', windowActive: true, createdBy: 'admin-1' })
    );
    expect(result.usage.active).toMatchObject({ credits5h: false, credits7d: false, credits30d: false });
  });

  it('exposes bounded percentages rather than raw values', () => {
    expect(__testOnly.percentage(25, 100)).toBe(25);
    expect(__testOnly.percentage(150, 100)).toBe(100);
    expect(__testOnly.percentage(0, 0)).toBe(0);
  });

  it('presents the spendable chat budget as exhausted before the protected compaction reserve', () => {
    expect(__testOnly.subscriptionPercentage(47.5, 100)).toBe(50);
    expect(__testOnly.subscriptionPercentage(95, 100)).toBe(100);
    expect(__testOnly.subscriptionPercentage(96, 100)).toBe(100);
  });

  it.each([
    { sourceTypes: ['subscription'], apiConfigured: false, subscriptionConfigured: true },
    { sourceTypes: ['api'], apiConfigured: true, subscriptionConfigured: false },
    { sourceTypes: [], apiConfigured: false, subscriptionConfigured: false },
  ])('shows only limits for budget types reachable through available models', async ({
    sourceTypes,
    apiConfigured,
    subscriptionConfigured,
  }) => {
    const policies = {
      effective: vi.fn().mockResolvedValue({
        enabled: true,
        credits5hEnabled: false,
        credits5h: 100,
        credits7dEnabled: true,
        credits7d: 500,
        credits30dEnabled: false,
        credits30d: 1_000,
        apiMonthlyMicrodollars: 10_000_000,
        billingTimezone: 'UTC',
      }),
      usage: vi.fn().mockResolvedValue({
        credits5h: 0,
        credits7d: 0,
        credits30d: 0,
        apiMonthlyMicrodollars: 0,
        recoveryAt: {
          credits5h: new Date('2026-07-27T20:00:00.000Z'),
          credits7d: new Date('2026-08-03T00:00:00.000Z'),
          credits30d: new Date('2026-08-26T00:00:00.000Z'),
          apiMonthly: new Date('2026-08-01T00:00:00.000Z'),
        },
      }),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(sourceTypes.map((sourceType) => ({ sourceType }))),
          })),
        })),
      })),
    };
    const modelAccess = { allowedModelIds: vi.fn().mockResolvedValue(new Set(['model-1'])) };
    const service = new InferenceUsageService(
      db as unknown as ConstructorParameters<typeof InferenceUsageService>[0],
      policies as unknown as ConstructorParameters<typeof InferenceUsageService>[1],
      {} as ConstructorParameters<typeof InferenceUsageService>[2],
      undefined,
      modelAccess as unknown as ConstructorParameters<typeof InferenceUsageService>[4]
    );

    const result = await service.self({
      id: 'user-1',
      groupId: 'group-1',
      scopes: ['feat:ai:use'],
      isBlocked: false,
    } as never);

    expect(result.api.configured).toBe(apiConfigured);
    expect(result.subscription['5h'].configured).toBe(false);
    expect(result.subscription['7d'].configured).toBe(subscriptionConfigured);
    expect(result.subscription['30d'].configured).toBe(false);
    expect(result.api).not.toHaveProperty('limit');
  });
});
