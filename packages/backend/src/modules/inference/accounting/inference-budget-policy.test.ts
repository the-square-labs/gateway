import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { InferenceLimitPolicy } from '@/db/schema/inference-models.js';
import { __testOnly } from './inference-budget-policy.js';

describe('effective inference rolling-window policy', () => {
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
