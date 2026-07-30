import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { __testOnly } from './inference-extended.service.js';
import { InferenceProtocolError } from './protocol/inference-protocol.error.js';

describe('InferenceExtendedService boundaries', () => {
  it('validates models and bounded image units', () => {
    expect(__testOnly.requiredModel(' image-model ')).toBe('image-model');
    expect(__testOnly.positiveUnits(undefined)).toBe(1);
    expect(__testOnly.positiveUnits(4)).toBe(4);
    expect(() => __testOnly.positiveUnits(0)).toThrow(/between 1 and 100/);
  });

  it('normalizes upstream failures without reflecting provider bodies', () => {
    expect(__testOnly.providerFailure(401)).toMatchObject({ status: 502, code: 'provider_reauth_required' });
    expect(__testOnly.providerFailure(429)).toMatchObject({ status: 429, code: 'provider_rate_limited' });
    expect(__testOnly.providerFailure(500)).toBeInstanceOf(InferenceProtocolError);
  });

  it('forwards only public response headers', () => {
    const headers = __testOnly.publicResponseHeaders(
      new Headers({
        'content-type': 'image/png',
        'content-disposition': 'inline',
        authorization: 'Bearer upstream-secret',
        'x-request-id': 'upstream-account-id',
      })
    );
    expect(headers.get('content-type')).toBe('image/png');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-request-id')).toBeNull();
  });

  it('rejects cross-provider and cross-model extended-operation bindings', () => {
    const row = (providerId: string, upstreamModelId: string) => ({
      source: { upstreamModelId },
      connection: { providerId },
    });
    expect(() =>
      __testOnly.assertSingleProviderModel([row('openai', 'image-1'), row('openai', 'image-1')] as never)
    ).not.toThrow();
    expect(() =>
      __testOnly.assertSingleProviderModel([row('openai', 'image-1'), row('openrouter', 'image-1')] as never)
    ).toThrow(/one provider and one upstream model/);
    expect(() =>
      __testOnly.assertSingleProviderModel([row('openai', 'image-1'), row('openai', 'image-2')] as never)
    ).toThrow(/one provider and one upstream model/);
  });
});
