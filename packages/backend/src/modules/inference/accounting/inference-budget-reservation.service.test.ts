import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { __testOnly, InferenceBudgetReservationService } from './inference-budget-reservation.service.js';

describe('inference live reservation policy', () => {
  const limits = {
    enabled: true,
    credits5hEnabled: true,
    credits5h: 1_000,
    credits7dEnabled: true,
    credits7d: 2_000,
    credits30dEnabled: true,
    credits30d: 3_000,
    apiMonthlyMicrodollars: 400,
    billingTimezone: 'UTC',
  };

  it('reserves against the full configured personal limit without a hidden percentage reserve', () => {
    expect(__testOnly.reservationLimit('credits5h', limits, false)).toBe(1_000);
    expect(__testOnly.reservationLimit('credits5h', limits, true)).toBe(1_000);
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

  it('separates live reservations by the fixed window they were admitted into', () => {
    expect(
      __testOnly.reservationWindowIds({
        credits5h: 0,
        credits7d: 0,
        credits30d: 0,
        apiMonthlyMicrodollars: 0,
        recoveryAt: {
          credits5h: new Date('2026-09-02T08:00:00.000Z'),
          credits7d: new Date('2026-09-09T03:00:00.000Z'),
          credits30d: new Date('2026-10-02T03:00:00.000Z'),
          apiMonthly: new Date('2026-10-01T00:00:00.000Z'),
        },
      })
    ).toEqual(['1788336000000', '1788922800000', '1790910000000', '1790812800000']);
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

  it('keeps the tail reservation atomic: the admitted turn holds the remaining credits and the next one rejects', async () => {
    const evalMock = vi
      .fn()
      .mockResolvedValueOnce([0, '500', '500', '500', '0', '1000', '1000', '1000', '0'])
      .mockResolvedValueOnce([1]);
    const service = new InferenceBudgetReservationService({ eval: evalMock } as never);
    const input = {
      userId: 'user-1',
      amounts: { credits5h: 5_000, credits7d: 5_000, credits30d: 5_000, apiMonthlyMicrodollars: 0 },
      usage: {
        credits5h: 500,
        credits7d: 1_500,
        credits30d: 2_500,
        apiMonthlyMicrodollars: 0,
        recoveryAt: {
          credits5h: new Date('2026-09-16T00:00:00.000Z'),
          credits7d: new Date('2026-09-17T00:00:00.000Z'),
          credits30d: new Date('2026-10-15T00:00:00.000Z'),
          apiMonthly: new Date('2026-10-01T00:00:00.000Z'),
        },
      },
      limits,
      isCompaction: false,
    };

    await expect(service.reserve({ ...input, reservationId: 'request-1' })).resolves.toMatchObject({
      amounts: { credits5h: 500, credits7d: 500, credits30d: 500 },
      admittedAmounts: { credits5h: 1_500, credits7d: 1_500, credits30d: 1_500 },
    });
    await expect(service.reserve({ ...input, reservationId: 'request-2' })).rejects.toMatchObject({
      status: 429,
      code: 'subscription_budget_exhausted',
    });
    expect(evalMock).toHaveBeenCalledTimes(2);
  });

  const redisUrl = process.env.INFERENCE_REDIS_INTEGRATION_URL;
  (redisUrl ? it : it.skip)(
    'atomically preserves a visible half-credit tail and one visible-credit overage in Redis',
    async () => {
      const redis = new Redis(redisUrl!);
      const service = new InferenceBudgetReservationService(redis as never);
      const input = {
        userId: `quota-proof-${randomUUID()}`,
        amounts: { credits5h: 5_000, credits7d: 5_000, credits30d: 5_000, apiMonthlyMicrodollars: 0 },
        usage: {
          credits5h: 500,
          credits7d: 1_500,
          credits30d: 2_500,
          apiMonthlyMicrodollars: 0,
          recoveryAt: {
            credits5h: new Date('2026-09-16T00:00:00.000Z'),
            credits7d: new Date('2026-09-17T00:00:00.000Z'),
            credits30d: new Date('2026-10-15T00:00:00.000Z'),
            apiMonthly: new Date('2026-10-01T00:00:00.000Z'),
          },
        },
        limits,
        isCompaction: false,
      };
      try {
        const results = await Promise.allSettled(
          Array.from({ length: 16 }, (_, index) =>
            service.reserve({ ...input, reservationId: `request-live-${index}` })
          )
        );
        const admitted = results.filter(
          (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.reserve>>> =>
            result.status === 'fulfilled'
        );
        const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

        expect(admitted).toHaveLength(1);
        expect(rejected).toHaveLength(15);
        expect(admitted[0]!.value).toMatchObject({
          amounts: { credits5h: 500, credits7d: 500, credits30d: 500 },
          admittedAmounts: { credits5h: 1_500, credits7d: 1_500, credits30d: 1_500 },
        });
        expect(rejected[0]!.reason).toMatchObject({ code: 'subscription_budget_exhausted' });
        const stored = await redis.hget(__testOnly.reservationKeys(input.userId)[1]!, admitted[0]!.value.id);
        // The pre-update reader still sees the entire admitted cost after rollback.
        expect(Number(stored!.slice(stored!.indexOf(':') + 1))).toBe(1_500);
        await (service as unknown as { renew(value: unknown): Promise<void> }).renew(admitted[0]!.value);
        expect(await redis.hget(__testOnly.reservationKeys(input.userId)[1]!, admitted[0]!.value.id)).toBe(stored);
        await service.release(admitted[0]!.value);
        await expect(
          service.reserve({
            ...input,
            reservationId: 'after-settlement',
            usage: {
              ...input.usage,
              credits5h: 2_000,
              credits7d: 3_000,
              credits30d: 4_000,
            },
          })
        ).rejects.toMatchObject({ code: 'subscription_budget_exhausted' });
      } finally {
        await redis.quit();
      }
    }
  );

  (redisUrl ? it : it.skip)(
    'preserves fractional internal reservation amounts through the Lua RESP result',
    async () => {
      const redis = new Redis(redisUrl!);
      const service = new InferenceBudgetReservationService(redis as never);
      try {
        const reservation = await service.reserve({
          reservationId: 'request-fraction',
          userId: `quota-proof-${randomUUID()}`,
          amounts: { credits5h: 5_000, credits7d: 5_000, credits30d: 5_000, apiMonthlyMicrodollars: 0 },
          usage: {
            credits5h: 999.5,
            credits7d: 1_999.5,
            credits30d: 2_999.5,
            apiMonthlyMicrodollars: 0,
            recoveryAt: {
              credits5h: new Date('2026-09-16T00:00:00.000Z'),
              credits7d: new Date('2026-09-17T00:00:00.000Z'),
              credits30d: new Date('2026-10-15T00:00:00.000Z'),
              apiMonthly: new Date('2026-10-01T00:00:00.000Z'),
            },
          },
          limits,
          isCompaction: false,
        });

        expect(reservation).toMatchObject({
          amounts: { credits5h: 0.5, credits7d: 0.5, credits30d: 0.5 },
          admittedAmounts: { credits5h: 1_000.5, credits7d: 1_000.5, credits30d: 1_000.5 },
        });
        await service.release(reservation);
      } finally {
        await redis.quit();
      }
    }
  );
});
