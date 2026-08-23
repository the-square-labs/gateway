import { z } from 'zod';
import { CliError } from './errors.js';
import type { Fetch } from './http.js';
import { requestJson } from './http.js';

const percentageWindowSchema = z.object({
  configured: z.boolean(),
  percentage: z.number().min(0).max(100),
  recoveryAt: z.string().datetime(),
});

export const gatewayUsageSchema = z.object({
  enabled: z.boolean(),
  api: percentageWindowSchema,
  subscription: z.object({
    '5h': percentageWindowSchema,
    '7d': percentageWindowSchema,
    '30d': percentageWindowSchema,
  }),
  tokens: z.object({
    lifetime: z.number().int().nonnegative(),
    daily: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tokens: z.number().int().nonnegative() })),
  }),
});

export type GatewayUsage = z.infer<typeof gatewayUsageSchema>;

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  planType: null;
  rateLimitReachedType: 'rate_limit_reached' | null;
  spendControlReached: null;
  individualLimit: null;
}

export interface CodexRateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot>;
  rateLimitResetCredits: null;
}

export interface CodexAccountUsageResponse {
  summary: {
    lifetimeTokens: number;
    peakDailyTokens: number;
    currentStreakDays: null;
    longestStreakDays: null;
    longestRunningTurnSec: null;
  };
  dailyUsageBuckets: Array<{ startDate: string; tokens: number }>;
  threadUsage: null;
}

export function projectCodexRateLimits(usage: GatewayUsage): CodexRateLimitsResponse {
  if (!usage.enabled) {
    const disabled = snapshot(
      'gateway-disabled',
      'Gateway inference disabled',
      { usedPercent: 100, windowDurationMins: null, resetsAt: null },
      null,
      false
    );
    disabled.rateLimitReachedType = 'rate_limit_reached';
    return {
      rateLimits: disabled,
      rateLimitsByLimitId: { 'gateway-disabled': disabled },
      rateLimitResetCredits: null,
    };
  }
  const fiveHour = configuredWindow(usage.subscription['5h'], 5 * 60);
  const sevenDay = configuredWindow(usage.subscription['7d'], 7 * 24 * 60);
  const thirtyDay = configuredWindow(usage.subscription['30d'], 30 * 24 * 60);
  const apiMonthly = configuredWindow(usage.api, null);
  const unlimited = !fiveHour && !sevenDay && !thirtyDay && !apiMonthly;
  const legacy = snapshot('gateway-subscription', 'Gateway subscription', fiveHour, sevenDay, unlimited);
  const byLimitId: Record<string, RateLimitSnapshot> = {};
  if (fiveHour || sevenDay) byLimitId['gateway-subscription'] = legacy;
  if (thirtyDay) {
    byLimitId['gateway-subscription-30d'] = snapshot(
      'gateway-subscription-30d',
      'Gateway subscription · 30 days',
      thirtyDay,
      null,
      false
    );
  }
  if (apiMonthly) {
    byLimitId['gateway-api-monthly'] = snapshot(
      'gateway-api-monthly',
      'Gateway API · monthly',
      apiMonthly,
      null,
      false
    );
  }
  return { rateLimits: legacy, rateLimitsByLimitId: byLimitId, rateLimitResetCredits: null };
}

export function projectCodexAccountUsage(usage: GatewayUsage): CodexAccountUsageResponse {
  return {
    summary: {
      lifetimeTokens: usage.tokens.lifetime,
      peakDailyTokens: usage.tokens.daily.reduce((peak, bucket) => Math.max(peak, bucket.tokens), 0),
      currentStreakDays: null,
      longestStreakDays: null,
      longestRunningTurnSec: null,
    },
    dailyUsageBuckets: usage.tokens.daily.map((bucket) => ({ startDate: bucket.date, tokens: bucket.tokens })),
    threadUsage: null,
  };
}

export class GatewayUsageSource {
  private lastGood?: GatewayUsage;
  private lastSerialized?: string;

  constructor(private readonly input: { usageUrl: string; token: string; fetch?: Fetch; timeoutMs?: number }) {}

  async read(): Promise<GatewayUsage> {
    try {
      const payload = await requestJson<unknown>(
        this.input.usageUrl,
        {},
        {
          fetch: this.input.fetch,
          accessToken: this.input.token,
          timeoutMs: this.input.timeoutMs ?? 3_000,
        }
      );
      const usage = gatewayUsageSchema.parse(payload);
      this.lastGood = usage;
      return usage;
    } catch (error) {
      if (this.lastGood) return this.lastGood;
      throw new CliError('CODEX_USAGE_UNAVAILABLE', 'Gateway usage is unavailable.', { cause: error });
    }
  }

  changed(usage: GatewayUsage): boolean {
    const serialized = JSON.stringify(usage);
    if (serialized === this.lastSerialized) return false;
    this.lastSerialized = serialized;
    return true;
  }
}

export function gatewayUsageUrl(openAiBaseUrl: string): string {
  const url = new URL(openAiBaseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/usage`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function configuredWindow(
  input: { configured: boolean; percentage: number; recoveryAt: string },
  windowDurationMins: number | null
): RateLimitWindow | null {
  if (!input.configured) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, Math.round(input.percentage))),
    windowDurationMins,
    resetsAt: Math.floor(new Date(input.recoveryAt).getTime() / 1000),
  };
}

function snapshot(
  limitId: string,
  limitName: string,
  primary: RateLimitWindow | null,
  secondary: RateLimitWindow | null,
  unlimited: boolean
): RateLimitSnapshot {
  return {
    limitId,
    limitName,
    primary,
    secondary,
    credits: unlimited ? { hasCredits: false, unlimited: true, balance: null } : null,
    planType: null,
    rateLimitReachedType: null,
    spendControlReached: null,
    individualLimit: null,
  };
}
