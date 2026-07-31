import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import type { InferenceAdmission } from './accounting/inference-accounting.service.js';
import { __testOnly, InferenceGatewayExecutor } from './inference-gateway.executor.js';
import { InferenceProtocolError } from './protocol/inference-protocol.error.js';

describe('InferenceGatewayExecutor helpers', () => {
  it('maps client reasoning to a source-specific wire value without changing the public model', () => {
    const request = {
      protocol: 'responses' as const,
      model: 'kimi-k3',
      messages: [],
      tools: [],
      stream: true,
      reasoningEffort: 'ultra',
      isCompaction: false,
      extensions: {},
    };
    const mapped = __testOnly.mapRequestReasoning(
      request,
      { reasoningEfforts: ['high', 'ultra'], defaultReasoningEffort: 'high' },
      { reasoningEffortMap: { high: 'high', ultra: 'max' } } as never
    );
    expect(mapped.model).toBe('kimi-k3');
    expect(mapped.reasoningEffort).toBe('max');
  });

  it('applies an accounting output cap without mutating the client request', () => {
    const request = {
      protocol: 'responses' as const,
      model: 'kimi-k3',
      messages: [],
      tools: [],
      stream: true,
      isCompaction: false,
      extensions: {},
    };
    const admitted = __testOnly.applyAdmissionOutputLimit(request, {
      admittedMaxOutputTokens: 774,
    } as InferenceAdmission);

    expect(admitted.maxOutputTokens).toBe(774);
    expect(request).not.toHaveProperty('maxOutputTokens');
  });

  it('rejects mixed providers, upstream models, and legacy sidecars', () => {
    const candidate = (providerId: string, upstreamModelId: string, metadata = {}) => ({
      source: { upstreamModelId, metadata },
      connection: { providerId },
    });
    const valid = [candidate('kimi', 'k3'), candidate('kimi', 'k3')];
    expect(() => __testOnly.assertSingleProviderModel(valid as never)).not.toThrow();
    expect(() => __testOnly.assertSingleProviderModel([...valid, candidate('openrouter', 'k3')] as never)).toThrow(
      /one provider and one upstream model/
    );
    expect(() => __testOnly.assertSingleProviderModel([...valid, candidate('kimi', 'k2')] as never)).toThrow(
      /one provider and one upstream model/
    );
    expect(() =>
      __testOnly.assertSingleProviderModel([
        ...valid,
        candidate('kimi', 'k3', { composition: { role: 'vision_sidecar' } }),
      ] as never)
    ).toThrow(/one provider and one upstream model/);
  });

  it('preserves application protocol errors instead of retrying them as upstream failures', () => {
    const normalized = __testOnly.normalizeError(
      new AppError(400, 'INFERENCE_REASONING_EFFORT_UNSUPPORTED', 'Reasoning effort is unavailable')
    );

    expect(normalized).toMatchObject({
      status: 400,
      code: 'inference_reasoning_effort_unsupported',
      message: 'Reasoning effort is unavailable',
    });
  });

  it('does not retry an ambiguous failure after dispatching upstream', async () => {
    const model = {
      id: 'model-1',
      publicId: 'logical-model',
      maxOutputTokens: 100,
      subscriptionMultiplier: '1',
      reasoningEfforts: [],
      defaultReasoningEffort: null,
      capabilities: {},
    };
    const source = (id: string) => ({
      id,
      modelId: model.id,
      sourceType: 'subscription' as const,
      upstreamModelId: 'upstream-model',
      subscriptionMultiplierOverride: null,
      reasoningEffortMap: {},
      capabilitiesOverride: {},
      metadata: {},
    });
    const connection = (id: string) => ({
      id,
      providerId: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      metadata: {},
    });
    const firstAccount = { source: source('source-a'), connection: connection('connection-a') };
    const secondAccount = { source: source('source-b'), connection: connection('connection-b') };
    const rows = [firstAccount, secondAccount];
    const db = {
      query: {
        users: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1', groupId: 'group-1', additionalScopes: [] }) },
        permissionGroups: { findFirst: vi.fn().mockResolvedValue({ name: 'Users', scopes: ['inference:use'] }) },
      },
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            leftJoin: vi.fn(() => ({
              where: vi.fn(() => ({ orderBy: vi.fn().mockResolvedValue(rows) })),
            })),
          })),
        })),
      })),
    };
    const admission = (attemptSequence: number, row: typeof firstAccount): InferenceAdmission => ({
      requestId: 'request-1',
      attemptId: `attempt-${attemptSequence}`,
      attemptSequence,
      userId: 'user-1',
      budgetType: row.source.sourceType,
      model: model as never,
      source: row.source as never,
      connection: row.connection as never,
      pricing: null,
      modelMultiplier: 1,
      burnMultiplier: 1,
      serviceTier: null,
      serviceTierMultiplier: 1,
      reservation: {
        id: 'request-1',
        userId: 'user-1',
        amounts: { credits5h: 1, credits7d: 1, credits30d: 1, apiMonthlyMicrodollars: 0 },
        expiresAt: new Date(),
      },
      estimatedUsage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
        totalTokens: 2,
        estimated: true,
      },
      startedAtMs: Date.now(),
    });
    const first = admission(1, firstAccount);
    const accounting = {
      admit: vi.fn().mockResolvedValue(first),
      markDispatched: vi.fn().mockResolvedValue(undefined),
      failForRetry: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
      finishRetry: vi.fn().mockResolvedValue(undefined),
      settle: vi.fn().mockResolvedValue(undefined),
    };
    const connector = {
      execute: vi.fn().mockRejectedValue(new InferenceProtocolError(503, 'provider_unavailable', 'failed')),
    };
    const routing = {
      select: vi.fn(async ({ allowedConnectionIds }) => ({ connectionId: allowedConnectionIds[0] })),
    };
    const executor = new InferenceGatewayExecutor(
      db as never,
      {
        resolveForUser: vi.fn().mockResolvedValue({
          model,
          sources: [firstAccount.source],
        }),
      } as never,
      routing as never,
      accounting as never,
      { get: vi.fn().mockResolvedValue({}) } as never,
      { require: vi.fn().mockReturnValue({ supportedOperations: ['inference'] }) } as never,
      connector as never,
      { assertAllowed: vi.fn().mockResolvedValue(undefined) } as never
    );
    const request = {
      protocol: 'responses' as const,
      model: model.publicId,
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
      tools: [],
      stream: true,
      isCompaction: false,
      extensions: { idempotency_key: 'same-request' },
    };

    await expect(
      executor.execute(request, {
        requestId: 'request-1',
        userId: 'user-1',
        tokenId: 'token-1',
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: 'provider_unavailable' });

    expect(connector.execute).toHaveBeenCalledTimes(1);
    expect(routing.select).toHaveBeenCalledWith(
      expect.objectContaining({ allowedConnectionIds: [firstAccount.connection.id] })
    );
    expect(accounting.admit).toHaveBeenCalledTimes(1);
    expect(accounting.failForRetry).not.toHaveBeenCalled();
    expect(accounting.fail).toHaveBeenCalledWith(first, expect.any(InferenceProtocolError), false);
    expect(accounting.settle).not.toHaveBeenCalled();
  });

  it('includes separated reasoning tokens in inferred totals', () => {
    expect(
      __testOnly.terminalUsage(
        { inputTokens: 10, outputTokens: 4, reasoningTokens: 6 },
        {
          protocol: 'responses',
          model: 'logical-model',
          messages: [],
          tools: [],
          stream: true,
          isCompaction: false,
          extensions: {},
        },
        0
      )
    ).toMatchObject({ outputTokens: 4, reasoningTokens: 6, totalTokens: 20 });
  });
});
