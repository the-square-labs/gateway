import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { InferenceLimitPolicy } from '@/db/schema/inference-models.js';
import { __testOnly, InferenceBudgetPolicyService } from './inference-budget-policy.js';

describe('effective inference fixed-window policy', () => {
  it('keeps setup and status available before a default policy is configured', async () => {
    const database = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ orderBy: vi.fn().mockResolvedValue([]) })),
        })),
      })),
    };
    const service = new InferenceBudgetPolicyService(database as never);

    await expect(service.effective('cef8fbd8-f149-4cd6-b69f-34bea4a10c52')).resolves.toEqual({
      enabled: false,
      credits5hEnabled: false,
      credits5h: 0,
      credits7dEnabled: false,
      credits7d: 0,
      credits30dEnabled: false,
      credits30d: 0,
      apiMonthlyMicrodollars: 0,
      billingTimezone: 'UTC',
    });
  });

  it('treats disabled default windows as global gates over a user override', () => {
    const defaults = policy({
      policyType: 'default',
      userId: null,
      credits5hEnabled: false,
      credits7dEnabled: true,
      credits30dEnabled: false,
    });
    const user = policy({
      policyType: 'user',
      userId: 'cef8fbd8-f149-4cd6-b69f-34bea4a10c52',
      credits5hEnabled: true,
      credits7dEnabled: true,
      credits30dEnabled: true,
      credits5h: '10.000000',
      credits7d: '20.000000',
      credits30d: '30.000000',
    });

    expect(__testOnly.effectiveLimits(user, defaults)).toMatchObject({
      credits5hEnabled: false,
      credits7dEnabled: true,
      credits30dEnabled: false,
      credits5h: 10,
      credits7d: 20,
      credits30d: 30,
    });
  });

  it('lets a user disable a window that remains enabled globally', () => {
    const defaults = policy({ policyType: 'default', userId: null });
    const user = policy({
      policyType: 'user',
      userId: 'cef8fbd8-f149-4cd6-b69f-34bea4a10c52',
      credits7dEnabled: false,
    });

    expect(__testOnly.effectiveLimits(user, defaults).credits7dEnabled).toBe(false);
  });

  it('keeps usage monotonic inside fixed windows and reports their reset boundaries', async () => {
    const now = new Date('2026-07-31T00:00:00.000Z');
    const execute = vi.fn().mockResolvedValue({
      rows: [{ credits_5h: '95', credits_7d: '475', credits_30d: '950' }],
    });
    const select = vi
      .fn()
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([
            { dimension: 'credits5h', resetAt: new Date('2026-07-30T22:00:00.000Z'), windowActive: true },
            { dimension: 'credits7d', resetAt: new Date('2026-07-30T22:00:00.000Z'), windowActive: true },
            { dimension: 'credits30d', resetAt: new Date('2026-07-30T22:00:00.000Z'), windowActive: true },
          ]),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ value: 0 }]) })),
      }));
    const database = {
      execute,
      select,
    };
    const limits = __testOnly.effectiveLimits(policy({}));
    const service = new InferenceBudgetPolicyService(database as never);

    const usage = await service.usage('cef8fbd8-f149-4cd6-b69f-34bea4a10c52', limits, now, database as never);

    expect(usage).toMatchObject({
      credits5h: 95,
      credits7d: 475,
      credits30d: 950,
    });
    expect(usage.recoveryAt.credits5h).toEqual(new Date('2026-07-31T03:00:00.000Z'));
    expect(usage.recoveryAt.credits7d).toEqual(new Date('2026-08-06T22:00:00.000Z'));
    expect(usage.recoveryAt.credits30d).toEqual(new Date('2026-08-29T22:00:00.000Z'));
    expect(execute).toHaveBeenCalledOnce();
  });

  it('closes the whole window at its reset boundary without opening the next one', () => {
    const anchor = new Date('2026-07-30T22:00:00.000Z');

    expect(__testOnly.activeUsageWindow(new Date('2026-07-31T02:59:59.999Z'), anchor, 5 * 60 * 60_000)).toEqual({
      start: anchor,
      end: new Date('2026-07-31T03:00:00.000Z'),
    });
    expect(__testOnly.activeUsageWindow(new Date('2026-07-31T03:00:00.000Z'), anchor, 5 * 60 * 60_000)).toBeNull();
  });

  it('keeps expired subscription windows idle during usage reads', async () => {
    const now = new Date('2026-07-31T00:00:00.000Z');
    const execute = vi.fn().mockResolvedValue({
      rows: [{ credits_5h: '0', credits_7d: '0', credits_30d: '0' }],
    });
    const select = vi
      .fn()
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([
            { dimension: 'credits5h', resetAt: new Date('2026-07-30T19:00:00.000Z'), windowActive: true },
            { dimension: 'credits7d', resetAt: new Date('2026-07-24T00:00:00.000Z'), windowActive: true },
            { dimension: 'credits30d', resetAt: new Date('2026-07-01T00:00:00.000Z'), windowActive: true },
            { dimension: 'apiMonthlyMicrodollars', resetAt: now, windowActive: true },
          ]),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ value: 0 }]) })),
      }));
    const database = { execute, select };
    const service = new InferenceBudgetPolicyService(database as never);

    const usage = await service.usage(
      'cef8fbd8-f149-4cd6-b69f-34bea4a10c52',
      __testOnly.effectiveLimits(policy({})),
      now,
      database as never
    );

    expect(usage).toMatchObject({
      credits5h: 0,
      credits7d: 0,
      credits30d: 0,
      apiMonthlyMicrodollars: 0,
    });
    expect(usage.recoveryAt).toEqual({
      credits5h: now,
      credits7d: now,
      credits30d: now,
      apiMonthly: new Date('2026-08-31T00:00:00.000Z'),
    });
  });

  it('starts fresh subscription windows only on the first request after expiry', async () => {
    const now = new Date('2026-07-31T00:00:00.000Z');
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const database = {
      select: vi
        .fn()
        .mockImplementationOnce(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
        }))
        .mockImplementationOnce(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ value: 0 }]) })),
        })),
      insert: vi.fn(() => ({ values })),
      execute: vi.fn().mockResolvedValue({
        rows: [{ credits_5h: '0', credits_7d: '0', credits_30d: '0' }],
      }),
    };
    const service = new InferenceBudgetPolicyService(database as never);

    const usage = await service.usage(
      'cef8fbd8-f149-4cd6-b69f-34bea4a10c52',
      __testOnly.effectiveLimits(policy({})),
      now,
      database as never,
      { startSubscriptionWindows: true }
    );

    expect(database.insert).toHaveBeenCalledTimes(3);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ dimension: 'credits5h', resetAt: now, createdBy: null })
    );
    expect(usage.recoveryAt).toEqual({
      credits5h: new Date('2026-07-31T05:00:00.000Z'),
      credits7d: new Date('2026-08-07T00:00:00.000Z'),
      credits30d: new Date('2026-08-30T00:00:00.000Z'),
      apiMonthly: new Date('2026-08-01T00:00:00.000Z'),
    });
  });

  it('reconstructs an existing active window from immutable ledger history', async () => {
    const now = new Date('2026-07-31T00:00:00.000Z');
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ started_at: new Date('2026-07-30T22:00:00.000Z') }] })
      .mockResolvedValueOnce({ rows: [{ started_at: new Date('2026-07-30T22:00:00.000Z') }] })
      .mockResolvedValueOnce({ rows: [{ started_at: new Date('2026-07-30T22:00:00.000Z') }] })
      .mockResolvedValueOnce({ rows: [{ credits_5h: '10', credits_7d: '10', credits_30d: '10' }] });
    const database = {
      execute,
      select: vi
        .fn()
        .mockImplementationOnce(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
        }))
        .mockImplementationOnce(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ value: 0 }]) })),
        })),
    };
    const service = new InferenceBudgetPolicyService(database as never);

    const usage = await service.usage(
      'cef8fbd8-f149-4cd6-b69f-34bea4a10c52',
      __testOnly.effectiveLimits(policy({})),
      now,
      database as never
    );

    expect(usage.credits5h).toBe(10);
    expect(usage.active).toMatchObject({ credits5h: true, credits7d: true, credits30d: true });
    expect(usage.recoveryAt.credits5h).toEqual(new Date('2026-07-31T03:00:00.000Z'));
  });
});

describe('API token pricing', () => {
  const gpt56LunaPricing = {
    inputMicrodollarsPerMillion: 200_000,
    cachedInputMicrodollarsPerMillion: 20_000,
    cacheWriteMicrodollarsPerMillion: 250_000,
    outputMicrodollarsPerMillion: 1_200_000,
    reasoningMicrodollarsPerMillion: null,
    otherUnitPrices: {
      long_context_threshold_tokens: 272_000,
      long_context_input_microdollars_per_million: 400_000,
      long_context_cached_input_microdollars_per_million: 40_000,
      long_context_cache_write_microdollars_per_million: 500_000,
      long_context_output_microdollars_per_million: 1_800_000,
    },
  };

  it('keeps the short-context rate at exactly 272K input tokens', () => {
    expect(
      __testOnly.apiMicrodollars(
        { inputTokens: 272_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10_000, reasoningTokens: 0 },
        gpt56LunaPricing
      )
    ).toBe(66_400);
  });

  it('uses the long-context rate for the entire request above 272K input tokens', () => {
    expect(
      __testOnly.apiMicrodollars(
        { inputTokens: 272_001, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10_000, reasoningTokens: 0 },
        gpt56LunaPricing
      )
    ).toBe(126_801);
  });

  it('does not charge cache writes again as ordinary input', () => {
    expect(
      __testOnly.apiMicrodollars(
        { inputTokens: 1000, cachedInputTokens: 700, cacheWriteTokens: 200, outputTokens: 0, reasoningTokens: 0 },
        gpt56LunaPricing
      )
    ).toBe(84);
  });
});

describe('subscription token pricing', () => {
  it('weights cache reads and writes independently from ordinary tokens', () => {
    expect(
      __testOnly.subscriptionCreditsForUsage(
        { inputTokens: 1000, cachedInputTokens: 800, cacheWriteTokens: 100, outputTokens: 100, reasoningTokens: 50 },
        2,
        1
      )
    ).toBeCloseTo(0.91);
  });

  it('falls back to charging all input normally when a provider reports an invalid cache split', () => {
    expect(
      __testOnly.subscriptionCreditsForUsage(
        { inputTokens: 100, cachedInputTokens: 80, cacheWriteTokens: 30, outputTokens: 0, reasoningTokens: 0 },
        1,
        1
      )
    ).toBeCloseTo(0.1);
  });
});

function policy(overrides: Partial<InferenceLimitPolicy>): InferenceLimitPolicy {
  return {
    id: '6a3cb7ab-73c1-4fdb-baa5-7fdc757cc126',
    policyType: 'default',
    userId: null,
    enabled: true,
    credits5hEnabled: true,
    credits5h: '100.000000',
    credits7dEnabled: true,
    credits7d: '500.000000',
    credits30dEnabled: true,
    credits30d: '1000.000000',
    apiMonthlyMicrodollars: 10_000_000,
    billingTimezone: 'UTC',
    createdBy: null,
    createdAt: new Date('2026-07-27T00:00:00.000Z'),
    updatedAt: new Date('2026-07-27T00:00:00.000Z'),
    ...overrides,
  };
}
