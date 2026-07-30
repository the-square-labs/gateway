import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { __testOnly } from './inference-provider.service.js';

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
});
