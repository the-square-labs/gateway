import { describe, expect, it } from 'vitest';
import { classifyDeliveryResult, rateLimitWaitMs } from './notification-dispatcher.service.js';

describe('webhook delivery outcomes', () => {
  it('pauses the webhook when its target cannot be reached and moves on when it rejects one delivery', () => {
    const result = (statusCode?: number, error?: string) =>
      classifyDeliveryResult({ statusCode, error, responseTimeMs: 1 });
    expect(result(204)).toEqual({ kind: 'delivered' });
    expect(result(undefined, 'getaddrinfo EAI_AGAIN discord.com')).toEqual({ kind: 'unreachable' });
    expect(result(502)).toEqual({ kind: 'unreachable' });
    expect(result(408)).toEqual({ kind: 'unreachable' });
    expect(result(400)).toEqual({ kind: 'rejected' });
    expect(result(404)).toEqual({ kind: 'rejected' });
    expect(
      result(
        undefined,
        'Webhook target blocked by outbound network policy: Webhook target did not resolve to an IP address'
      )
    ).toEqual({ kind: 'unreachable' });
    expect(
      result(undefined, 'Webhook target blocked by outbound network policy: private network targets are not allowed')
    ).toEqual({ kind: 'rejected' });
  });

  it("waits as long as a 429 asks: Retry-After, Discord's retry_after, or 30 s", () => {
    const now = Date.UTC(2026, 9, 9, 0, 0, 0);
    expect(rateLimitWaitMs({ 'Retry-After': '3' }, undefined, now)).toBe(3000);
    expect(rateLimitWaitMs({ 'retry-after': new Date(now + 10_000).toUTCString() }, undefined, now)).toBe(10_000);
    expect(rateLimitWaitMs({}, '{"message":"You are being rate limited.","retry_after":0.347}', now)).toBe(347);
    expect(rateLimitWaitMs({ 'X-RateLimit-Reset-After': '1.5' }, 'nope', now)).toBe(1500);
    expect(rateLimitWaitMs(undefined, undefined, now)).toBe(30_000);
    expect(classifyDeliveryResult({ statusCode: 429, responseBody: '{"retry_after":2}', responseTimeMs: 1 })).toEqual({
      kind: 'rate_limited',
      waitMs: 2000,
    });
  });
});
