import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { InferenceRequest } from '../protocol/inference-protocol.types.js';
import { __testOnly } from './inference-accounting.helpers.js';
import { dynamicBurnMultiplier, subscriptionCredits, subscriptionCreditsForUsage } from './inference-budget-policy.js';

describe('inference accounting estimates', () => {
  it('uses a bounded conservative reservation ceiling when maximum output is unknown', () => {
    const request = {
      protocol: 'responses',
      publicModelId: 'gpt-4',
      messages: [],
      tools: [],
      reasoning: {},
      stream: false,
      isCompaction: false,
      extensions: {},
    } as unknown as InferenceRequest;

    expect(__testOnly.conservativeEstimate(request, null, 1_048_576).outputTokens).toBe(8192);
    expect(__testOnly.conservativeEstimate({ ...request, maxOutputTokens: 2048 }, null, 1_048_576).outputTokens).toBe(
      2048
    );
  });

  it('admits a positive tail balance and caps only its maximum terminal overage', () => {
    const estimate = {
      inputTokens: 100_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 2_000_000,
      reasoningTokens: 0,
      totalTokens: 2_100_000,
      estimated: true,
    };
    const capped = __testOnly.capSubscriptionEstimateToBudget({
      estimate,
      limits: {
        enabled: true,
        credits5hEnabled: true,
        credits5h: 1_000,
        credits7dEnabled: false,
        credits7d: 1_000,
        credits30dEnabled: false,
        credits30d: 1_000,
        apiMonthlyMicrodollars: 0,
        billingTimezone: 'UTC',
      },
      usage: {
        credits5h: 500,
        credits7d: 0,
        credits30d: 0,
        apiMonthlyMicrodollars: 0,
        recoveryAt: {
          credits5h: new Date(),
          credits7d: new Date(),
          credits30d: new Date(),
          apiMonthly: new Date(),
        },
      },
      modelMultiplier: 1,
      burnMultiplier: 1,
      serviceTierMultiplier: 1,
      isCompaction: false,
    });

    expect(capped).toMatchObject({ outputTokens: 1_375_000, totalTokens: 1_475_000 });
    expect(
      subscriptionCreditsForUsage({ ...capped!, cacheWriteTokens: capped!.inputTokens }, 1, 1)
    ).toBeLessThanOrEqual(1_500);
  });

  it('uses settlement cache-write pricing for both admission and the output cap', () => {
    const estimate = {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
      reasoningTokens: 0,
      totalTokens: 2_000_000,
      estimated: true,
    };
    const capped = __testOnly.capSubscriptionEstimateToCredits({
      estimate,
      maximumCredits: 1_500,
      modelMultiplier: 1,
      burnMultiplier: 1,
      serviceTierMultiplier: 1,
    });
    expect(capped?.outputTokens).toBe(250_000);
    const charge = subscriptionCreditsForUsage({ ...capped!, cacheWriteTokens: estimate.inputTokens }, 1, 1);
    expect(charge).toBe(1_500);
    expect(__testOnly.reservationAmounts('subscription', capped!, 1, 1, 1, null).credits5h).toBe(charge);
  });

  it('does not cap requests that fit, disabled windows, or compaction requests', () => {
    const estimate = {
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 0,
      totalTokens: 200,
      estimated: true,
    };
    const input = {
      estimate,
      limits: {
        enabled: true,
        credits5hEnabled: true,
        credits5h: 1_000,
        credits7dEnabled: false,
        credits7d: 1_000,
        credits30dEnabled: false,
        credits30d: 1_000,
        apiMonthlyMicrodollars: 0,
        billingTimezone: 'UTC',
      },
      usage: {
        credits5h: 0,
        credits7d: 0,
        credits30d: 0,
        apiMonthlyMicrodollars: 0,
        recoveryAt: {
          credits5h: new Date(),
          credits7d: new Date(),
          credits30d: new Date(),
          apiMonthly: new Date(),
        },
      },
      modelMultiplier: 1,
      burnMultiplier: 1,
      serviceTierMultiplier: 1,
      isCompaction: false,
    };

    expect(__testOnly.capSubscriptionEstimateToBudget(input)).toBe(estimate);
    expect(
      __testOnly.capSubscriptionEstimateToBudget({
        ...input,
        usage: { ...input.usage, credits5h: 950 },
        isCompaction: true,
      })
    ).toBe(estimate);
    expect(
      __testOnly.capSubscriptionEstimateToBudget({
        ...input,
        limits: { ...input.limits, credits5hEnabled: false },
        usage: { ...input.usage, credits5h: 10_000 },
      })
    ).toBe(estimate);
  });

  it('allows admission only while a real full-window balance remains', () => {
    const limits = {
      enabled: true,
      credits5hEnabled: true,
      credits5h: 1_000,
      credits7dEnabled: false,
      credits7d: 1_000,
      credits30dEnabled: false,
      credits30d: 1_000,
      apiMonthlyMicrodollars: 0,
      billingTimezone: 'UTC',
    };
    const usage = {
      credits5h: 500,
      credits7d: 0,
      credits30d: 0,
      apiMonthlyMicrodollars: 0,
      recoveryAt: {
        credits5h: new Date(),
        credits7d: new Date(),
        credits30d: new Date(),
        apiMonthly: new Date(),
      },
    };

    expect(__testOnly.hasSpendableSubscriptionBudget(limits, usage)).toBe(true);
    expect(__testOnly.hasSpendableSubscriptionBudget(limits, { ...usage, credits5h: 1_000 })).toBe(false);
    expect(
      __testOnly.capSubscriptionEstimateToBudget({
        estimate: {
          inputTokens: 100_000,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 100_000,
          reasoningTokens: 0,
          totalTokens: 200_000,
          estimated: true,
        },
        limits,
        usage: { ...usage, credits5h: 1_000 },
        modelMultiplier: 1,
        burnMultiplier: 1,
        serviceTierMultiplier: 1,
        isCompaction: false,
      })
    ).toBeNull();
  });

  it('rejects a tail reservation that cannot leave at least one output token', () => {
    expect(
      __testOnly.capSubscriptionEstimateToCredits({
        estimate: {
          inputTokens: 1_500_000,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 1,
          reasoningTokens: 0,
          totalTokens: 1_500_001,
          estimated: true,
        },
        maximumCredits: 1_500,
        modelMultiplier: 1,
        burnMultiplier: 1,
        serviceTierMultiplier: 1,
      })
    ).toBeNull();
  });

  it('composes model, dynamic-burn, and Fast multipliers for subscription credits', () => {
    expect(subscriptionCredits(2_000, 3, 4, 2)).toBe(48);
  });

  it('keeps compaction exempt from dynamic burn while still allowing the Fast multiplier', () => {
    const burn = dynamicBurnMultiplier(
      [
        {
          dimension: '5h',
          remainingFraction: 0.05,
          resetAt: new Date('2026-07-29T05:00:00.000Z'),
          validUntil: new Date('2026-07-29T05:00:00.000Z'),
        },
      ],
      new Date('2026-07-29T00:00:00.000Z'),
      true
    );

    expect(burn).toBe(1);
    expect(subscriptionCredits(1_000, 1, burn, 2)).toBe(2);
  });

  it('keeps API reservation cost independent from the Fast multiplier', () => {
    const pricing = {
      inputMicrodollarsPerMillion: 1_000_000,
      cachedInputMicrodollarsPerMillion: null,
      cacheWriteMicrodollarsPerMillion: null,
      outputMicrodollarsPerMillion: 1_000_000,
      reasoningMicrodollarsPerMillion: null,
    } as never;
    const usage = {
      inputTokens: 1_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
      reasoningTokens: 0,
      totalTokens: 2_000,
      estimated: true,
    };

    expect(__testOnly.reservationAmounts('api', usage, 9, 8, 2, pricing)).toMatchObject({
      credits5h: 0,
      credits7d: 0,
      credits30d: 0,
      apiMonthlyMicrodollars: 2_000,
    });
  });

  it('uses only quota dimensions reported by the latest synchronization batch', () => {
    const rows = [
      {
        dimension: 'subscription',
        modelBucket: null,
        remainingFraction: '0.01',
        fetchedAt: new Date('2026-07-27T00:00:00.000Z'),
        resetAt: null,
        validUntil: new Date('2026-07-28T00:00:00.000Z'),
      },
      {
        dimension: '5h',
        modelBucket: null,
        remainingFraction: '1',
        fetchedAt: new Date('2026-07-29T00:00:00.000Z'),
        resetAt: new Date('2026-07-29T05:00:00.000Z'),
        validUntil: new Date('2026-07-29T05:00:00.000Z'),
      },
      {
        dimension: '7d',
        modelBucket: null,
        remainingFraction: '0.84',
        fetchedAt: new Date('2026-07-29T00:00:00.000Z'),
        resetAt: new Date('2026-08-05T00:00:00.000Z'),
        validUntil: new Date('2026-08-05T00:00:00.000Z'),
      },
    ] as never;

    expect(__testOnly.latestQuotaRows(rows).map((row) => row.dimension)).toEqual(['5h', '7d']);
  });
});
