import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { InferenceRequest } from '../protocol/inference-protocol.types.js';
import { __testOnly } from './inference-accounting.helpers.js';
import { dynamicBurnMultiplier, subscriptionCredits } from './inference-budget-policy.js';

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

  it('shrinks the final subscription response to fit the bounded last-request grace', () => {
    const estimate = {
      inputTokens: 7_808,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 8_192,
      reasoningTokens: 0,
      totalTokens: 16_000,
      estimated: true,
    };
    const capped = __testOnly.capSubscriptionEstimateToBudget({
      estimate,
      limits: {
        enabled: true,
        credits5hEnabled: false,
        credits5h: 100,
        credits7dEnabled: true,
        credits7d: 2_950,
        credits30dEnabled: false,
        credits30d: 1_000,
        apiMonthlyMicrodollars: 0,
        billingTimezone: 'UTC',
      },
      usage: {
        credits5h: 0,
        credits7d: 2_741.657456,
        credits30d: 0,
        apiMonthlyMicrodollars: 0,
        recoveryAt: {
          credits5h: new Date(),
          credits7d: new Date(),
          credits30d: new Date(),
          apiMonthly: new Date(),
        },
      },
      modelMultiplier: 10,
      burnMultiplier: 1,
      serviceTierMultiplier: 1,
      isCompaction: false,
      allowLastRequestGrace: true,
    });

    expect(capped.outputTokens).toBe(774);
    expect(capped.totalTokens).toBe(8_582);
    expect(subscriptionCredits(capped.totalTokens, 10, 1)).toBeLessThan(90.342544);
  });

  it('does not cap requests that fit or protected compaction requests', () => {
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
        credits5h: 100,
        credits7dEnabled: false,
        credits7d: 100,
        credits30dEnabled: false,
        credits30d: 100,
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
      allowLastRequestGrace: true,
    };

    expect(__testOnly.capSubscriptionEstimateToBudget(input)).toBe(estimate);
    expect(
      __testOnly.capSubscriptionEstimateToBudget({
        ...input,
        usage: { ...input.usage, credits5h: 95 },
        isCompaction: true,
      })
    ).toBe(estimate);
    expect(
      __testOnly.capSubscriptionEstimateToBudget({
        ...input,
        usage: { ...input.usage, credits5h: 95 },
        allowLastRequestGrace: false,
      })
    ).toBe(estimate);
  });

  it('allows last-request grace only while the visible chat budget remains positive', () => {
    const limits = {
      enabled: true,
      credits5hEnabled: true,
      credits5h: 100,
      credits7dEnabled: false,
      credits7d: 100,
      credits30dEnabled: false,
      credits30d: 100,
      apiMonthlyMicrodollars: 0,
      billingTimezone: 'UTC',
    };
    const usage = {
      credits5h: 94.999,
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
    expect(__testOnly.hasSpendableSubscriptionBudget(limits, { ...usage, credits5h: 95 })).toBe(false);
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
