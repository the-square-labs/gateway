import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { serializeModel } from './inference-provider.service.helpers.js';
import { __testOnly, InferenceProviderService } from './inference-provider.service.js';

describe('InferenceProviderService policy helpers', () => {
  it('classifies quota pressure against routing safety floors', () => {
    expect(__testOnly.classifyStatus([])).toBe('healthy');
    expect(__testOnly.classifyStatus([{ dimension: '5h', remainingFraction: 0.5 }])).toBe('healthy');
    expect(__testOnly.classifyStatus([{ dimension: '5h', remainingFraction: 0.09 }])).toBe('quota_hot');
    expect(__testOnly.classifyStatus([{ dimension: '5h', remainingFraction: 0.029 }])).toBe('unavailable');
  });

  it('validates custom endpoints without accepting embedded credentials', () => {
    expect(__testOnly.validateBaseUrl('https://llm.example.com/v1/', true)).toBe('https://llm.example.com/v1');
    expect(() => __testOnly.validateBaseUrl('', true)).toThrow(/Base URL is required/);
    expect(() => __testOnly.validateBaseUrl('https://user:secret@example.com/v1', true)).toThrow(/without credentials/);
    expect(() => __testOnly.validateBaseUrl('file:///tmp/model', true)).toThrow(/HTTP\(S\)/);
    expect(() => __testOnly.validateBaseUrl('https://api.example.com/{account}/v1', true)).toThrow(/HTTP\(S\)/);
  });

  it('does not reflect arbitrary upstream errors into admin responses', () => {
    expect(__testOnly.redactedError(new Error('Authorization: Bearer secret-token'))).toBe(
      'Provider synchronization failed'
    );
  });

  it('allows quota reserves only for subscription providers', () => {
    expect(() => __testOnly.assertMinimumRemainingAllowed({ subscription: true } as never, 25)).not.toThrow();
    expect(() => __testOnly.assertMinimumRemainingAllowed({ subscription: false } as never, 25)).toThrow(
      /only for subscription providers/
    );
    expect(() => __testOnly.assertMinimumRemainingAllowed({ subscription: false } as never, undefined)).not.toThrow();
  });

  it('allows monthly dollar limits only for API providers', () => {
    expect(() => __testOnly.assertApiMonthlyLimitAllowed({ subscription: false } as never, 25_000_000)).not.toThrow();
    expect(() => __testOnly.assertApiMonthlyLimitAllowed({ subscription: false } as never, null)).not.toThrow();
    expect(() => __testOnly.assertApiMonthlyLimitAllowed({ subscription: true } as never, 25_000_000)).toThrow(
      /only for API providers/
    );
    expect(() => __testOnly.assertApiMonthlyLimitAllowed({ subscription: true } as never, undefined)).not.toThrow();
  });

  it('appends new provider connections after the current routing order', () => {
    expect(__testOnly.nextRoutingOrder(undefined)).toBe(0);
    expect(__testOnly.nextRoutingOrder(0)).toBe(1);
    expect(__testOnly.nextRoutingOrder(7)).toBe(8);
  });

  it('blocks disabling a connection only for published models without another route', () => {
    const affected = [
      { id: 'model-a', displayName: 'Model A' },
      { id: 'model-b', displayName: 'Model B' },
    ];

    expect(__testOnly.connectionDisableBlockers(affected, ['model-b'])).toEqual([affected[0]]);
    expect(__testOnly.connectionDisableBlockers(affected, ['model-a', 'model-b'])).toEqual([]);
  });

  it('keeps catalog fallback compaction within a provider-reported input limit', () => {
    const timestamp = new Date('2026-08-19T12:00:00.000Z');
    const serialized = serializeModel(
      {
        id: 'model-id',
        connectionId: 'connection-id',
        remoteModelId: 'gpt-5.6-luna',
        displayName: null,
        contextWindow: 272_000,
        maxInputTokens: 272_000,
        maxOutputTokens: null,
        autoCompactTokenLimit: null,
        modalities: ['text'],
        capabilities: {},
        reasoningEfforts: [],
        metadata: {},
        available: true,
        lastSeenAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      'openai'
    );

    expect(serialized.maxInputTokens).toBe(272_000);
    expect(serialized.autoCompactTokenLimit).toBe(272_000);
  });

  it('reclaims abandoned running synchronizations without duplicating live ones', async () => {
    const now = new Date('2026-07-30T12:00:00.000Z');
    const where = vi.fn().mockResolvedValue([
      { id: 'healthy-due', syncStatus: 'success', updatedAt: new Date('2026-07-30T11:59:00.000Z') },
      { id: 'live-running', syncStatus: 'running', updatedAt: new Date('2026-07-30T11:51:00.001Z') },
      { id: 'abandoned-running', syncStatus: 'running', updatedAt: new Date('2026-07-30T11:50:00.000Z') },
    ]);
    const from = vi.fn().mockReturnValue({ where });
    const db = { select: vi.fn().mockReturnValue({ from }) };
    const service = new InferenceProviderService(db as never, {} as never, {} as never, {} as never);
    const syncConnection = vi.spyOn(service, 'syncConnection').mockResolvedValue({} as never);

    await service.syncDue(now);

    expect(syncConnection).toHaveBeenCalledTimes(2);
    expect(syncConnection).toHaveBeenCalledWith('healthy-due', true);
    expect(syncConnection).toHaveBeenCalledWith('abandoned-running', true);
    expect(syncConnection).not.toHaveBeenCalledWith('live-running', true);
  });

  it('checks for abandoned synchronizations immediately on scheduler startup', () => {
    const service = new InferenceProviderService({} as never, {} as never, {} as never, {} as never);
    const syncDue = vi.spyOn(service, 'syncDue').mockResolvedValue();

    service.start();
    service.stop();

    expect(syncDue).toHaveBeenCalledOnce();
  });
});
