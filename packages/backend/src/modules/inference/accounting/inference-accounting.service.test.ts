import 'reflect-metadata';
import { expect, it, vi } from 'vitest';
import { InferenceAccountingService } from './inference-accounting.service.js';

it('preserves the admission window through delayed dispatch and settlement', async () => {
  const anchor = new Date('2026-09-09T13:24:04.591Z');
  vi.useFakeTimers();
  vi.setSystemTime(anchor);
  try {
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }),
      insert: () => ({
        values: async (row: Record<string, unknown>) => {
          writes.push(row);
        },
      }),
      update: () => ({
        set: (row: Record<string, unknown>) => {
          writes.push(row);
          return { where: () => ({ returning: async () => [{ id: 'request' }] }) };
        },
      }),
    };
    const limits = { enabled: true, credits5hEnabled: false, credits7dEnabled: false, credits30dEnabled: false };
    const policies = {
      effective: async () => limits,
      usage: vi.fn(async () => ({ credits5h: 0, credits7d: 0, credits30d: 0, apiMonthlyMicrodollars: 0 })),
    };
    const reservations = {
      reserve: async () => {
        // Cross the admission window's end while retaining the original reservation identity.
        vi.setSystemTime(new Date(anchor.getTime() + 5 * 60 * 60_000));
        return { id: 'reservation', userId: 'user' };
      },
      release: vi.fn(),
    };
    const locks = { withUserLock: async (_user: string, run: (database: unknown) => Promise<unknown>) => run(db) };
    const service = new InferenceAccountingService(policies as never, reservations as never, locks as never);
    const admission = await service.admit({
      userId: 'user',
      tokenId: null,
      protocol: 'responses',
      request: {
        protocol: 'responses',
        model: 'model',
        messages: [],
        tools: [],
        stream: false,
        isCompaction: false,
        extensions: {},
      },
      model: {
        id: 'model',
        publicId: 'model',
        subscriptionMultiplier: '1',
        maxInputTokens: 100,
        maxOutputTokens: 10,
      } as never,
      source: { id: 'source', sourceType: 'subscription', upstreamModelId: 'model' } as never,
      connection: { id: 'connection', providerId: 'openai-apikey' } as never,
    });
    expect(policies.usage).toHaveBeenCalledWith('user', limits, anchor, db, { startSubscriptionWindows: true });
    expect(admission.startedAtMs).toBe(anchor.getTime());
    await service.markDispatched(admission);
    expect(admission.startedAtMs).toBe(anchor.getTime());
    expect(admission.dispatchedAtMs).toBe(anchor.getTime() + 5 * 60 * 60_000);
    await service.settle(
      admission,
      {
        inputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10,
        reasoningTokens: 0,
        totalTokens: 110,
        estimated: false,
      },
      true
    );
    expect(writes.find((row) => row.entryType === 'settlement')).toMatchObject({ occurredAt: anchor });
    expect(
      writes
        .filter((row) => row.startedAt !== undefined)
        .every((row) => (row.startedAt as Date).getTime() === anchor.getTime())
    ).toBe(true);
    expect(writes.find((row) => row.latencyMs !== undefined)?.latencyMs).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('settles a tail admission at the bounded one-credit overage without reopening quota for a second turn', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }),
    query: { inferenceRequests: { findFirst: async () => null } },
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        writes.push(row);
      },
    }),
    update: () => ({
      set: (row: Record<string, unknown>) => {
        writes.push(row);
        return { where: () => ({ returning: async () => [{ id: 'request' }] }) };
      },
    }),
  };
  const limits = {
    enabled: true,
    credits5hEnabled: true,
    credits5h: 100,
    credits7dEnabled: true,
    credits7d: 100,
    credits30dEnabled: true,
    credits30d: 100,
    apiMonthlyMicrodollars: 0,
    billingTimezone: 'UTC',
  };
  const usage = {
    credits5h: 99.5,
    credits7d: 99.5,
    credits30d: 99.5,
    apiMonthlyMicrodollars: 0,
    recoveryAt: { credits5h: new Date(), credits7d: new Date(), credits30d: new Date(), apiMonthly: new Date() },
  };
  const policies = { effective: async () => limits, usage: async () => usage };
  const reservations = {
    reserve: vi.fn(async (input) => ({
      id: input.reservationId,
      userId: input.userId,
      amounts: { credits5h: 0.5, credits7d: 0.5, credits30d: 0.5, apiMonthlyMicrodollars: 0 },
      expiresAt: new Date(),
    })),
    release: vi.fn(),
  };
  const locks = { withUserLock: async (_user: string, run: (database: unknown) => Promise<unknown>) => run(db) };
  const service = new InferenceAccountingService(policies as never, reservations as never, locks as never);
  const admission = await service.admit({
    userId: 'user',
    tokenId: null,
    protocol: 'responses',
    request: {
      protocol: 'responses',
      model: 'model',
      messages: [],
      tools: [],
      stream: false,
      maxOutputTokens: 5_000,
      isCompaction: false,
      extensions: {},
    },
    model: {
      id: 'model',
      publicId: 'model',
      subscriptionMultiplier: '1',
      maxInputTokens: 8_000,
      maxOutputTokens: 5_000,
    } as never,
    source: { id: 'source', sourceType: 'subscription', upstreamModelId: 'model' } as never,
    connection: { id: 'connection', providerId: 'openai-apikey' } as never,
  });

  expect(admission.admittedMaxOutputTokens).toBe(1_499);
  expect(reservations.reserve).toHaveBeenCalledWith(
    expect.objectContaining({ amounts: expect.objectContaining({ credits5h: 1.5 }) })
  );
  await service.settle(
    admission,
    {
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_499,
      reasoningTokens: 0,
      totalTokens: 1_500,
      estimated: false,
    },
    true
  );
  expect(writes.find((row) => row.entryType === 'settlement')).toMatchObject({ credits: '1.5' });
  expect(reservations.release).toHaveBeenCalledOnce();
});
