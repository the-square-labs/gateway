import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { InferenceCoreAccountingService } from './inference-core-accounting.service.js';

const REQUEST = {
  id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  userId: 'user-1',
  tokenId: 'token-1',
  modelId: 'model-1',
  sourceId: 'source-1',
  connectionId: 'conn-1',
  protocol: 'responses',
  operation: 'responses',
  publicModelId: 'gpt-5.5',
  budgetType: 'subscription',
  status: 'reserved',
  isCompaction: false,
  serviceTier: null,
  priceVersion: null,
  modelMultiplier: null,
  burnMultiplier: null,
  serviceTierMultiplier: null,
  fixedApiMicrodollars: 0,
  apiMicrodollarsCharged: 0,
};

const MODEL = { id: 'model-1', enabled: true, subscriptionMultiplier: '1' };
const SOURCE = {
  id: 'source-1',
  connectionId: 'conn-1',
  enabled: true,
  sourceType: 'subscription',
  subscriptionMultiplierOverride: null,
  coreAccountId: 'core-conn-1',
  coreModelId: 'core-conn-1/gpt-5.5',
};
const CONNECTION = {
  id: 'conn-1',
  providerId: 'openai-apikey',
  enabled: true,
  deletedAt: null,
  apiMonthlyLimitMicrodollars: null,
};
const ATTEMPT = {
  id: 'a1',
  requestId: REQUEST.id,
  status: 'running',
  sourceId: SOURCE.id,
  connectionId: CONNECTION.id,
  coreAttemptId: 'att_1',
  parentCoreAttemptId: null,
  attemptKind: 'root',
  budgetType: 'subscription',
  pricingSnapshotId: null,
  priceVersion: null,
  modelMultiplier: '1',
  burnMultiplier: '1',
  serviceTierMultiplier: '1',
  fixedApiMicrodollars: 0,
  reservedApiMicrodollars: 0,
  reservationId: `${REQUEST.id}:att_1`,
};

const ADMISSION = {
  contractId: 'wiolett-core/v1' as const,
  rootRequestId: REQUEST.id,
  attemptId: 'att_1',
  parentAttemptId: null,
  attemptKind: 'root' as const,
  coreAccountId: 'core-conn-1',
  coreModelId: 'core-conn-1/gpt-5.5',
  sourceType: 'subscription' as const,
  operation: 'responses',
  estimate: { inputTokens: 1000, maxOutputTokens: 500 },
  occurredAt: new Date().toISOString(),
};

function createHarness(
  options: {
    request?: unknown;
    attempt?: unknown;
    attemptLookups?: unknown[];
    attempts?: unknown[];
    limits?: Record<string, unknown>;
    reserveError?: unknown;
    claimEmpty?: boolean;
    selectRows?: unknown[][];
  } = {}
) {
  const insertedAttempts: unknown[] = [];
  const ledgerRows: unknown[] = [];
  const requestUpdates: unknown[] = [];
  const tx = {
    query: {
      inferenceRequestAttempts: {
        findFirst: options.attemptLookups
          ? vi
              .fn()
              .mockResolvedValueOnce(options.attemptLookups[0] ?? null)
              .mockResolvedValueOnce(options.attemptLookups[1] ?? null)
          : vi.fn().mockResolvedValue(options.attempt ?? null),
        findMany: vi.fn().mockResolvedValue(options.attempts ?? (options.attempt ? [options.attempt] : [])),
      },
      inferenceModels: { findFirst: vi.fn().mockResolvedValue(MODEL) },
      inferenceModelSources: { findFirst: vi.fn().mockResolvedValue(SOURCE) },
      inferenceProviderConnections: { findFirst: vi.fn().mockResolvedValue(CONNECTION) },
      inferencePricingSnapshots: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        if ('entryType' in values) ledgerRows.push(values);
        else insertedAttempts.push(values);
        return Promise.resolve();
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        requestUpdates.push(values);
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(options.claimEmpty ? [] : [{ id: REQUEST.id }]),
          }),
        };
      }),
    })),
    select: vi.fn(() => {
      const rows: unknown[] = options.selectRows?.shift() ?? [];
      const chain = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
      for (const method of ['from', 'where', 'orderBy', 'innerJoin', 'limit', 'groupBy']) {
        chain[method] = vi.fn().mockReturnValue(chain);
      }
      return chain;
    }),
  };
  const db = {
    query: {
      inferenceRequests: {
        findFirst: vi.fn().mockResolvedValue(options.request === undefined ? REQUEST : options.request),
      },
    },
  };
  const policies = {
    effective: vi.fn().mockResolvedValue({
      enabled: true,
      credits5hEnabled: false,
      credits7dEnabled: false,
      credits30dEnabled: false,
      apiMonthlyMicrodollars: 0,
      ...options.limits,
    }),
    usage: vi.fn().mockResolvedValue({
      credits5h: 0,
      credits7d: 0,
      credits30d: 0,
      apiMonthlyMicrodollars: 0,
      recoveryAt: {},
    }),
  };
  const reservations = {
    reserve: options.reserveError
      ? vi.fn().mockRejectedValue(options.reserveError)
      : vi.fn().mockResolvedValue({ id: REQUEST.id, userId: 'user-1' }),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const locks = {
    withUserLock: vi.fn(async (_userId: string, work: (tx: never) => Promise<unknown>) => work(tx as never)),
    lockProviderConnection: vi.fn(),
  };
  const eventBus = { publish: vi.fn() };
  const service = new InferenceCoreAccountingService(
    db as never,
    policies as never,
    reservations as never,
    locks as never,
    eventBus as never
  );
  return { service, db, tx, policies, reservations, locks, eventBus, insertedAttempts, ledgerRows, requestUpdates };
}

describe('inference core accounting', () => {
  it('admits a root attempt with a budget reservation and marks the request running', async () => {
    const { service, reservations, insertedAttempts, requestUpdates } = createHarness();
    const decision = await service.admitCoreAttempt(ADMISSION);
    expect(decision).toEqual({ decision: 'allow' });
    expect(reservations.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: `${REQUEST.id}:att_1`, userId: 'user-1' })
    );
    expect(insertedAttempts[0]).toMatchObject({
      requestId: REQUEST.id,
      coreAttemptId: 'att_1',
      attemptKind: 'root',
      status: 'running',
    });
    expect(requestUpdates[0]).toMatchObject({ status: 'running' });
  });

  it('uses the Gateway source billing type when API-key auth backs a subscription plan', async () => {
    const { service, reservations } = createHarness();
    const decision = await service.admitCoreAttempt({ ...ADMISSION, sourceType: 'api' });

    expect(decision).toEqual({ decision: 'allow' });
    expect(reservations.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        amounts: expect.objectContaining({
          credits5h: 1.5,
          apiMonthlyMicrodollars: 0,
        }),
      })
    );
  });

  it('acknowledges a redelivered admission without side effects', async () => {
    const { service, reservations, insertedAttempts } = createHarness({ attempt: ATTEMPT });
    const decision = await service.admitCoreAttempt(ADMISSION);
    expect(decision).toEqual({ decision: 'allow' });
    expect(reservations.reserve).not.toHaveBeenCalled();
    expect(insertedAttempts).toHaveLength(0);
  });

  it('denies admission when inference is disabled for the tenant', async () => {
    const { service } = createHarness({ limits: { enabled: false } });
    await expect(service.admitCoreAttempt(ADMISSION)).resolves.toEqual({ decision: 'deny', reason: 'tenant_revoked' });
  });

  it('denies admission when the model was disabled after ingress', async () => {
    const harness = createHarness();
    harness.tx.query.inferenceModels.findFirst.mockResolvedValue({ ...MODEL, enabled: false });
    await expect(harness.service.admitCoreAttempt(ADMISSION)).resolves.toEqual({
      decision: 'deny',
      reason: 'model_disabled',
    });
  });

  it('maps budget exhaustion to a deny with retry guidance', async () => {
    const recoveryAt = new Date(Date.now() + 60_000).toISOString();
    const { service } = createHarness({
      reserveError: new InferenceProtocolError(429, 'subscription_budget_exhausted', 'exhausted', { recoveryAt }),
    });
    const decision = await service.admitCoreAttempt(ADMISSION);
    expect(decision.decision).toBe('deny');
    expect(decision).toMatchObject({ reason: 'budget_exceeded' });
  });

  it('rejects admission for an unknown root request', async () => {
    const { service } = createHarness({ request: null });
    await expect(service.admitCoreAttempt(ADMISSION)).rejects.toMatchObject({
      statusCode: 404,
      code: 'core_request_not_found',
    });
  });

  it('admits child attempts with lineage and their own reservation', async () => {
    const { service, reservations, insertedAttempts } = createHarness({ attemptLookups: [null] });
    const decision = await service.admitCoreAttempt({
      ...ADMISSION,
      attemptId: 'att_2',
      parentAttemptId: 'att_1',
      attemptKind: 'subagent',
    });
    expect(decision).toEqual({ decision: 'allow' });
    expect(reservations.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: `${REQUEST.id}:att_2`, userId: 'user-1' })
    );
    expect(insertedAttempts[0]).toMatchObject({
      attemptKind: 'subagent',
      parentCoreAttemptId: 'att_1',
      coreAttemptId: 'att_2',
    });
  });

  it('reserves the first physical attempt even when it is classified as a subagent', async () => {
    const { service, reservations, insertedAttempts } = createHarness({ attemptLookups: [null, null] });
    const decision = await service.admitCoreAttempt({
      ...ADMISSION,
      attemptKind: 'subagent',
    });
    expect(decision).toEqual({ decision: 'allow' });
    expect(reservations.reserve).toHaveBeenCalledOnce();
    expect(insertedAttempts[0]).toMatchObject({ attemptKind: 'subagent', coreAttemptId: 'att_1' });
  });

  it('settles a completed attempt with a ledger row and publishes usage', async () => {
    const { service, ledgerRows, eventBus, reservations, requestUpdates } = createHarness({
      attempt: ATTEMPT,
      selectRows: [
        [
          {
            uncachedInputTokens: 800,
            cachedInputTokens: 100,
            cacheWriteTokens: 100,
            outputTokens: 400,
            reasoningTokens: 50,
          },
        ],
        [{ credits: '1.385', apiMicrodollars: 0, estimatedUsage: false }],
      ],
    });
    await service.settleCoreAttempt({
      contractId: 'wiolett-core/v1',
      rootRequestId: REQUEST.id,
      attemptId: 'att_1',
      parentAttemptId: null,
      attemptKind: 'root',
      terminalStatus: 'completed',
      coreAccountId: 'core-conn-1',
      coreModelId: 'core-conn-1/gpt-5.5',
      sourceType: 'subscription',
      upstreamStatus: 200,
      errorCode: null,
      usage: {
        uncachedInputTokens: 800,
        cachedInputTokens: 100,
        cacheWriteTokens: 100,
        outputTokens: 400,
        reasoningTokens: 50,
      },
      usageEstimated: false,
      emittedOutput: true,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      completedAt: new Date().toISOString(),
    });
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({
      requestId: REQUEST.id,
      attemptId: 'a1',
      userId: 'user-1',
      entryType: 'settlement',
      outputTokens: 400,
      credits: '1.385',
      snapshot: expect.objectContaining({ coreAttemptId: 'att_1', attemptKind: 'root' }),
    });
    expect(requestUpdates).toContainEqual(expect.objectContaining({ estimatedUsage: false }));
    expect(eventBus.publish).toHaveBeenCalled();
    expect(reservations.release).toHaveBeenCalledWith({ id: `${REQUEST.id}:att_1`, userId: 'user-1' });
  });

  it('does not charge silent failures and acknowledges identical redelivery', async () => {
    const failedAttempt = {
      ...ATTEMPT,
      status: 'failed',
      upstreamStatus: 500,
      outputTokens: 0,
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
    };
    const { service, ledgerRows } = createHarness({ attempt: failedAttempt });
    await service.settleCoreAttempt({
      contractId: 'wiolett-core/v1',
      rootRequestId: REQUEST.id,
      attemptId: 'att_1',
      parentAttemptId: null,
      attemptKind: 'root',
      terminalStatus: 'failed',
      coreAccountId: 'core-conn-1',
      coreModelId: 'core-conn-1/gpt-5.5',
      sourceType: 'subscription',
      upstreamStatus: 500,
      errorCode: 'upstream_error',
      usage: { uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      usageEstimated: true,
      emittedOutput: false,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      completedAt: new Date().toISOString(),
    });
    expect(ledgerRows).toHaveLength(0);
  });

  it('rejects a redelivered settlement whose payload differs', async () => {
    const { service } = createHarness({
      attempt: {
        ...ATTEMPT,
        status: 'completed',
        upstreamStatus: 200,
        outputTokens: 10,
        uncachedInputTokens: 5,
        cachedInputTokens: 0,
      },
    });
    await expect(
      service.settleCoreAttempt({
        contractId: 'wiolett-core/v1',
        rootRequestId: REQUEST.id,
        attemptId: 'att_1',
        parentAttemptId: null,
        attemptKind: 'root',
        terminalStatus: 'completed',
        coreAccountId: 'core-conn-1',
        coreModelId: 'core-conn-1/gpt-5.5',
        sourceType: 'subscription',
        upstreamStatus: 200,
        errorCode: null,
        usage: {
          uncachedInputTokens: 999,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
        },
        usageEstimated: false,
        emittedOutput: true,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        completedAt: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'core_settlement_conflict' });
  });

  it('finalizes a running request exactly once and releases the reservation', async () => {
    const { service, reservations, requestUpdates } = createHarness();
    await service.finalizeCoreRequest(REQUEST.id, 'completed');
    expect(requestUpdates[0]).toMatchObject({ status: 'completed' });
    expect(reservations.release).toHaveBeenCalledWith({ id: REQUEST.id, userId: 'user-1' });
  });

  it('does not overwrite a settled failed root attempt with transport completion', async () => {
    const { service, requestUpdates } = createHarness({
      attempts: [{ ...ATTEMPT, status: 'failed', errorCode: 'upstream_server_error' }],
    });

    await service.finalizeCoreRequest(REQUEST.id, 'completed');

    expect(requestUpdates[0]).toMatchObject({ status: 'failed', errorCode: 'upstream_server_error' });
  });

  it('keeps transport completion when a failover root attempt completed', async () => {
    const { service, requestUpdates } = createHarness({
      attempts: [
        { ...ATTEMPT, id: 'failed-attempt', status: 'failed' },
        { ...ATTEMPT, id: 'completed-attempt', status: 'completed' },
      ],
    });

    await service.finalizeCoreRequest(REQUEST.id, 'completed');

    expect(requestUpdates[0]).toMatchObject({ status: 'completed', errorCode: null });
  });

  it('does not let a failed child attempt override a completed top-level request', async () => {
    const { service, requestUpdates } = createHarness({
      attempts: [
        { ...ATTEMPT, id: 'root-attempt', status: 'completed' },
        {
          ...ATTEMPT,
          id: 'child-attempt',
          status: 'failed',
          parentCoreAttemptId: 'att_1',
          attemptKind: 'subagent',
        },
      ],
    });

    await service.finalizeCoreRequest(REQUEST.id, 'completed');

    expect(requestUpdates[0]).toMatchObject({ status: 'completed', errorCode: null });
  });

  it('downgrades an already completed request when a failed root settlement arrives later', async () => {
    const { service, requestUpdates } = createHarness({
      request: { ...REQUEST, status: 'completed' },
      attemptLookups: [ATTEMPT, null],
      selectRows: [
        [
          {
            uncachedInputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
        ],
        [{ credits: '0', apiMicrodollars: 0, estimatedUsage: true }],
      ],
    });

    await service.settleCoreAttempt({
      contractId: 'wiolett-core/v1',
      rootRequestId: REQUEST.id,
      attemptId: 'att_1',
      parentAttemptId: null,
      attemptKind: 'root',
      coreAccountId: 'core-conn-1',
      coreModelId: 'core-conn-1/gpt-5.5',
      sourceType: 'subscription',
      terminalStatus: 'failed',
      upstreamStatus: 502,
      errorCode: 'cyber_policy',
      usage: { uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      usageEstimated: true,
      emittedOutput: true,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      completedAt: new Date().toISOString(),
    });

    expect(requestUpdates).toContainEqual(expect.objectContaining({ status: 'failed', errorCode: 'cyber_policy' }));
  });

  it('replaces a transport-level upstream_error with the settled cyber_policy code', async () => {
    const { service, requestUpdates } = createHarness({
      request: { ...REQUEST, status: 'failed', errorCode: 'upstream_error' },
      attemptLookups: [ATTEMPT, null],
      selectRows: [
        [
          {
            uncachedInputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
        ],
        [{ credits: '0', apiMicrodollars: 0, estimatedUsage: false }],
      ],
    });

    await service.settleCoreAttempt({
      contractId: 'wiolett-core/v1',
      rootRequestId: REQUEST.id,
      attemptId: 'att_1',
      parentAttemptId: null,
      attemptKind: 'root',
      coreAccountId: 'core-conn-1',
      coreModelId: 'core-conn-1/gpt-5.5',
      sourceType: 'subscription',
      terminalStatus: 'failed',
      upstreamStatus: 400,
      errorCode: 'cyber_policy',
      usage: { uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      usageEstimated: false,
      emittedOutput: false,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      completedAt: new Date().toISOString(),
    });

    expect(requestUpdates).toContainEqual(expect.objectContaining({ status: 'failed', errorCode: 'cyber_policy' }));
  });

  it('persists cancellation distinctly from failure', async () => {
    const { service, requestUpdates } = createHarness();
    await service.finalizeCoreRequest(REQUEST.id, 'cancelled');
    expect(requestUpdates[0]).toMatchObject({ status: 'cancelled', errorCode: 'client_cancelled' });
  });

  it('propagates AppError from finalize lookups as-is', async () => {
    const { service } = createHarness({ request: null });
    await expect(service.finalizeCoreRequest(REQUEST.id, 'failed')).resolves.toBeUndefined();
    await expect(service.admitCoreAttempt(ADMISSION)).rejects.toBeInstanceOf(AppError);
  });

  it('stores the pricing snapshot at admission so API usage settles at a nonzero token cost', async () => {
    const pricing = {
      id: 'price-1',
      sourceId: 'source-1',
      version: 3,
      inputMicrodollarsPerMillion: 1000,
      cachedInputMicrodollarsPerMillion: 100,
      cacheWriteMicrodollarsPerMillion: null,
      outputMicrodollarsPerMillion: 2000,
      reasoningMicrodollarsPerMillion: null,
      otherUnitPrices: {},
    };
    const { service, tx, requestUpdates, ledgerRows, insertedAttempts } = createHarness({
      request: { ...REQUEST, budgetType: 'api' },
      limits: { apiMonthlyMicrodollars: 1_000_000_000 },
    });
    tx.query.inferenceModelSources.findFirst.mockResolvedValue({ ...SOURCE, sourceType: 'api' });
    tx.query.inferencePricingSnapshots.findFirst.mockResolvedValue(pricing);

    const decision = await service.admitCoreAttempt({ ...ADMISSION, sourceType: 'api' });
    expect(decision).toEqual({ decision: 'allow' });
    expect(requestUpdates[0]).toMatchObject({ pricingSnapshotId: 'price-1', priceVersion: 3 });
    expect(insertedAttempts[0]).toMatchObject({
      budgetType: 'api',
      pricingSnapshotId: 'price-1',
      priceVersion: 3,
      reservationId: `${REQUEST.id}:att_1`,
    });

    // The settle path must use the attempt snapshot even if the mutable root
    // now describes a different subscription route after failover.
    const settleHarness = createHarness({
      request: { ...REQUEST, budgetType: 'subscription', pricingSnapshotId: null, modelMultiplier: '99' },
      attempt: {
        ...ATTEMPT,
        budgetType: 'api',
        pricingSnapshotId: 'price-1',
        priceVersion: 3,
        fixedApiMicrodollars: 7,
      },
    });
    settleHarness.tx.query.inferencePricingSnapshots.findFirst.mockResolvedValue(pricing);
    await settleHarness.service.settleCoreAttempt({
      contractId: 'wiolett-core/v1',
      rootRequestId: REQUEST.id,
      attemptId: 'att_1',
      parentAttemptId: null,
      attemptKind: 'root',
      terminalStatus: 'completed',
      coreAccountId: 'core-conn-1',
      coreModelId: 'core-conn-1/gpt-5.5',
      sourceType: 'api',
      upstreamStatus: 200,
      errorCode: null,
      usage: {
        uncachedInputTokens: 900,
        cachedInputTokens: 100,
        cacheWriteTokens: 0,
        outputTokens: 400,
        reasoningTokens: 50,
      },
      usageEstimated: false,
      emittedOutput: true,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      completedAt: new Date().toISOString(),
    });
    expect(settleHarness.ledgerRows).toHaveLength(1);
    expect(settleHarness.ledgerRows[0]).toMatchObject({ budgetType: 'api' });
    expect((settleHarness.ledgerRows[0] as { apiMicrodollars: number }).apiMicrodollars).toBeGreaterThan(0);
    expect(ledgerRows).toHaveLength(0);
  });

  it('rejects settlement when the attempt belongs to another root request', async () => {
    const { service } = createHarness({ attempt: { ...ATTEMPT, requestId: 'other-request' } });
    await expect(
      service.settleCoreAttempt({
        contractId: 'wiolett-core/v1',
        rootRequestId: REQUEST.id,
        attemptId: 'att_1',
        parentAttemptId: null,
        attemptKind: 'root',
        terminalStatus: 'failed',
        coreAccountId: 'core-conn-1',
        coreModelId: 'core-conn-1/gpt-5.5',
        sourceType: 'subscription',
        upstreamStatus: 503,
        errorCode: 'provider_unavailable',
        usage: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        usageEstimated: true,
        emittedOutput: false,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        completedAt: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'core_attempt_root_mismatch' });
  });

  it('replays the admitted output cap on an idempotent admission redelivery', async () => {
    const { service } = createHarness({ attempt: { ...ATTEMPT, admittedMaxOutputTokens: 321 } });
    await expect(service.admitCoreAttempt(ADMISSION)).resolves.toEqual({
      decision: 'allow',
      maxOutputTokens: 321,
    });
  });

  it('rejects a late admission retry for an already finalized request and releases the reservation', async () => {
    const { service, reservations, insertedAttempts } = createHarness({ claimEmpty: true });
    await expect(service.admitCoreAttempt(ADMISSION)).rejects.toMatchObject({
      statusCode: 409,
      code: 'core_request_finalized',
    });
    expect(reservations.release).toHaveBeenCalledWith({ id: `${REQUEST.id}:att_1`, userId: 'user-1' });
    expect(insertedAttempts).toHaveLength(0);
  });
});
