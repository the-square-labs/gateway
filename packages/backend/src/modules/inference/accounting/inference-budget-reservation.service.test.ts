import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { __testOnly, InferenceBudgetReservationService } from './inference-budget-reservation.service.js';

describe('inference live reservation policy', () => {
  const limits = {
    enabled: true,
    credits5hEnabled: true,
    credits5h: 100,
    credits7dEnabled: true,
    credits7d: 200,
    credits30dEnabled: true,
    credits30d: 300,
    apiMonthlyMicrodollars: 400,
    billingTimezone: 'UTC',
  };

  it('allows one percent bounded grace while retaining the compaction reserve', () => {
    expect(__testOnly.reservationLimit('credits5h', limits, false)).toBe(95);
    expect(__testOnly.reservationLimit('credits5h', limits, false, true)).toBe(96);
    expect(__testOnly.reservationLimit('credits5h', limits, true)).toBe(100);
    expect(__testOnly.reservationLimit('apiMonthlyMicrodollars', limits, false)).toBe(400);
  });

  it('does not constrain disabled subscription windows', () => {
    const unlimited = {
      ...limits,
      credits5hEnabled: false,
      credits7dEnabled: false,
      credits30dEnabled: false,
    };

    expect(__testOnly.reservationLimit('credits5h', unlimited, false)).toBe(Number.MAX_SAFE_INTEGER);
    expect(__testOnly.reservationLimit('credits7d', unlimited, false)).toBe(Number.MAX_SAFE_INTEGER);
    expect(__testOnly.reservationLimit('credits30d', unlimited, true)).toBe(Number.MAX_SAFE_INTEGER);
    expect(__testOnly.reservationLimit('apiMonthlyMicrodollars', unlimited, false)).toBe(400);
  });

  it('uses one Redis cluster hash slot across every user dimension', () => {
    const keys = __testOnly.reservationKeys('user-1');
    expect(keys).toHaveLength(8);
    expect(keys.every((key) => key.includes('{user-1}'))).toBe(true);
  });

  it('fails closed when Redis admission is unavailable', async () => {
    const service = new InferenceBudgetReservationService({
      eval: async () => {
        throw new Error('redis unavailable');
      },
    } as never);
    await expect(
      service.reserve({
        reservationId: 'request-1',
        userId: 'user-1',
        amounts: { credits5h: 1, credits7d: 1, credits30d: 1, apiMonthlyMicrodollars: 0 },
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
        limits,
        isCompaction: false,
      })
    ).rejects.toMatchObject({ status: 503, code: 'reservation_unavailable' });
  });
});
