import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
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
  return {
    query: { users: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1' }) } },
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate })) })),
    delete: vi.fn(() => ({ where })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ orderBy: vi.fn().mockResolvedValue([]) })) })),
  };
}

describe('inference usage presentation', () => {
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
      scopes: ['inference:use'],
      isBlocked: false,
    } as never);

    expect(result.api.configured).toBe(apiConfigured);
    expect(result.subscription['5h'].configured).toBe(false);
    expect(result.subscription['7d'].configured).toBe(subscriptionConfigured);
    expect(result.subscription['30d'].configured).toBe(false);
    expect(result.api).not.toHaveProperty('limit');
  });
});
