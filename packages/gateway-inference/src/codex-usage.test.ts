import { describe, expect, it, vi } from 'vitest';
import {
  type GatewayUsage,
  GatewayUsageSource,
  gatewayUsageUrl,
  projectCodexAccountUsage,
  projectCodexRateLimits,
} from './codex-usage.js';

const USAGE: GatewayUsage = {
  enabled: true,
  api: { configured: true, percentage: 12.4, recoveryAt: '2026-09-01T00:00:00.000Z' },
  subscription: {
    '5h': { configured: true, percentage: 25.4, recoveryAt: '2026-08-23T15:00:00.000Z' },
    '7d': { configured: true, percentage: 50.6, recoveryAt: '2026-08-30T00:00:00.000Z' },
    '30d': { configured: true, percentage: 75, recoveryAt: '2026-09-22T00:00:00.000Z' },
  },
  tokens: {
    lifetime: 123_456,
    daily: [
      { date: '2026-08-22', tokens: 1000 },
      { date: '2026-08-23', tokens: 2000 },
    ],
  },
};

describe('Codex usage projection', () => {
  it('renders disabled Gateway inference as exhausted rather than unlimited', () => {
    const result = projectCodexRateLimits({ ...USAGE, enabled: false });
    expect(result.rateLimits).toMatchObject({
      limitId: 'gateway-disabled',
      primary: { usedPercent: 100, resetsAt: null },
      rateLimitReachedType: 'rate_limit_reached',
    });
    expect(result.rateLimits.credits).toBeNull();
  });

  it('maps Gateway windows into legacy and multi-bucket Codex rate limits', () => {
    const result = projectCodexRateLimits(USAGE);
    expect(result.rateLimits).toMatchObject({
      limitId: 'gateway-subscription',
      primary: { usedPercent: 25, windowDurationMins: 300 },
      secondary: { usedPercent: 51, windowDurationMins: 10_080 },
      credits: null,
    });
    expect(result.rateLimitsByLimitId['gateway-subscription-30d'].primary).toMatchObject({
      usedPercent: 75,
      windowDurationMins: 43_200,
    });
    expect(result.rateLimitsByLimitId['gateway-api-monthly'].primary).toMatchObject({
      usedPercent: 12,
      windowDurationMins: null,
    });
    expect(result.rateLimitResetCredits).toBeNull();
  });

  it('marks a fully unconfigured Gateway policy as unlimited', () => {
    const result = projectCodexRateLimits({
      ...USAGE,
      api: { ...USAGE.api, configured: false },
      subscription: {
        '5h': { ...USAGE.subscription['5h'], configured: false },
        '7d': { ...USAGE.subscription['7d'], configured: false },
        '30d': { ...USAGE.subscription['30d'], configured: false },
      },
    });
    expect(result.rateLimits.credits).toEqual({ hasCredits: false, unlimited: true, balance: null });
    expect(result.rateLimitsByLimitId).toEqual({});
  });

  it('maps lifetime and daily totals without OpenAI billing fields', () => {
    expect(projectCodexAccountUsage(USAGE)).toEqual({
      summary: {
        lifetimeTokens: 123_456,
        peakDailyTokens: 2000,
        currentStreakDays: null,
        longestStreakDays: null,
        longestRunningTurnSec: null,
      },
      dailyUsageBuckets: [
        { startDate: '2026-08-22', tokens: 1000 },
        { startDate: '2026-08-23', tokens: 2000 },
      ],
      threadUsage: null,
    });
  });

  it('uses the last-good snapshot when a rolling refresh fails', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(USAGE)))
      .mockRejectedValueOnce(new Error('offline'));
    const source = new GatewayUsageSource({
      usageUrl: 'https://gateway.example/api/inference/v1/usage',
      token: 'gwi_test',
      fetch: fetcher,
    });
    await expect(source.read()).resolves.toEqual(USAGE);
    await expect(source.read()).resolves.toEqual(USAGE);
  });

  it('fails closed before any Gateway snapshot succeeds', async () => {
    const source = new GatewayUsageSource({
      usageUrl: 'https://gateway.example/api/inference/v1/usage',
      token: 'gwi_secret',
      fetch: vi.fn().mockRejectedValue(new Error('offline')),
    });
    await expect(source.read()).rejects.toMatchObject({ code: 'CODEX_USAGE_UNAVAILABLE' });
  });

  it('derives the usage endpoint from the data-plane base URL', () => {
    expect(gatewayUsageUrl('https://gateway.example/api/inference/v1')).toBe(
      'https://gateway.example/api/inference/v1/usage'
    );
  });
});
