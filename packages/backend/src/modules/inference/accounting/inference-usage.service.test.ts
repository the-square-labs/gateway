import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { __testOnly, InferenceUsageService } from './inference-usage.service.js';

describe('inference usage presentation', () => {
  it('exposes bounded percentages rather than raw values', () => {
    expect(__testOnly.percentage(25, 100)).toBe(25);
    expect(__testOnly.percentage(150, 100)).toBe(100);
    expect(__testOnly.percentage(0, 0)).toBe(0);
  });

  it.each([
    { limit: 0, configured: false },
    { limit: 10_000_000, configured: true },
  ])('reports whether the API budget is configured without exposing its value', async ({ limit, configured }) => {
    const policies = {
      effective: vi.fn().mockResolvedValue({
        enabled: true,
        credits5hEnabled: false,
        credits5h: 100,
        credits7dEnabled: true,
        credits7d: 500,
        credits30dEnabled: false,
        credits30d: 1_000,
        apiMonthlyMicrodollars: limit,
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
    const service = new InferenceUsageService(
      {} as ConstructorParameters<typeof InferenceUsageService>[0],
      policies as unknown as ConstructorParameters<typeof InferenceUsageService>[1],
      {} as ConstructorParameters<typeof InferenceUsageService>[2]
    );

    const result = await service.self('user-1');

    expect(result.api.configured).toBe(configured);
    expect(result.subscription['5h'].configured).toBe(false);
    expect(result.subscription['7d'].configured).toBe(true);
    expect(result.subscription['30d'].configured).toBe(false);
    expect(result.api).not.toHaveProperty('limit');
  });
});
